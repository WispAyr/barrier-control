import express from 'express';
import fs from 'fs';
import path from 'path';
import { BARRIERS, API_PORT, BarrierConfig } from './config';
import { writeCoil, readCoils, atomicBarrierWrite, atomicAllOff } from './modbus-client';

const app = express();
app.use(express.json());

// ── CORS ──
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── Event Log (ring buffer + rotating file) ──
interface LogEntry {
  time: string;
  type: string;
  barrier: string;
  details: string;
  latencyMs?: number;
}
const MAX_LOG = 2000;
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024; // 2MB before rotation
const eventLog: LogEntry[] = [];
const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'activity.jsonl');

// Load persisted log on startup
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines.slice(-MAX_LOG)) {
      try { eventLog.push(JSON.parse(line)); } catch {}
    }
    eventLog.reverse(); // newest first
  }
} catch {}

function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_FILE_BYTES) {
      const rotated = LOG_FILE + '.1';
      try { fs.unlinkSync(rotated); } catch {}
      fs.renameSync(LOG_FILE, rotated);
    }
  } catch {}
}

function log(type: string, barrier: string, details: string, latencyMs?: number) {
  const entry: LogEntry = { time: new Date().toISOString(), type, barrier, details, latencyMs };
  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.pop();
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    rotateLogIfNeeded();
  } catch {}
  console.log(`[barrier] [${type}] ${barrier}: ${details}${latencyMs ? ` (${latencyMs}ms)` : ''}`);
}

// ── Barrier state tracking ──
interface BarrierState {
  locked: boolean;
  lastAction: string | null;
  lastActionTime: string | null;
  latchedAction: 'lift' | 'close' | null; // track what's latched
}
const barrierStates = new Map<string, BarrierState>();
BARRIERS.forEach(b => barrierStates.set(b.id, { locked: false, lastAction: null, lastActionTime: null, latchedAction: null }));

function findBarrier(barrierId: string): BarrierConfig | undefined {
  const num = parseInt(barrierId);
  if (!isNaN(num)) return BARRIERS.find(b => b.numericId === num);
  return BARRIERS.find(b => b.id === barrierId);
}

const PULSE_MS = 1500;

// Track active pulse timeouts so they can be cancelled
const pulseTimeouts = new Map<string, NodeJS.Timeout>();

async function activateCoil(barrier: BarrierConfig, action: 'lift' | 'stop' | 'close', hold = false): Promise<void> {
  const { host, port } = barrier.relay;
  const coils = barrier.coils;

  // Cancel any pending pulse-off for THIS barrier
  const existingPulse = pulseTimeouts.get(barrier.id);
  if (existingPulse) {
    clearTimeout(existingPulse);
    pulseTimeouts.delete(barrier.id);
  }

  const targetCoil = coils[action];
  const barrierCoils = [coils.lift, coils.stop, coils.close];

  // Atomic: clear this barrier's coils then set the target — single mutex lock
  await atomicBarrierWrite(host, port, barrierCoils, targetCoil, true);

  if (hold) {
    // Latch: coil stays on, no auto-release
    log('latch', barrier.id, `${action} coil HELD ON (latched)`);
  } else {
    // Pulse: auto-release after PULSE_MS
    const timeout = setTimeout(async () => {
      pulseTimeouts.delete(barrier.id);
      try {
        await writeCoil(host, port, targetCoil, false);
        log('pulse-off', barrier.id, `${action} coil released after ${PULSE_MS}ms`);
      } catch (err: any) {
        log('error', barrier.id, `PULSE-OFF FAILED for ${action} coil ${targetCoil} — coil may be stuck ON: ${err.message}`);
        // Retry once after a short delay
        setTimeout(async () => {
          try {
            await writeCoil(host, port, targetCoil, false);
            log('pulse-off-retry', barrier.id, `${action} coil released on retry`);
          } catch (err2: any) {
            log('error', barrier.id, `PULSE-OFF RETRY FAILED — coil ${targetCoil} STUCK ON: ${err2.message}`);
          }
        }, 500);
      }
    }, PULSE_MS);
    pulseTimeouts.set(barrier.id, timeout);
  }
}

async function releaseLatch(barrier: BarrierConfig): Promise<void> {
  const { host, port } = barrier.relay;
  const coils = barrier.coils;

  // Cancel any pending pulse
  const existingPulse = pulseTimeouts.get(barrier.id);
  if (existingPulse) {
    clearTimeout(existingPulse);
    pulseTimeouts.delete(barrier.id);
  }

  // Atomic: turn off all this barrier's coils
  await atomicAllOff(host, port, [coils.lift, coils.stop, coils.close]);
  log('unlatch', barrier.id, 'All coils released');
}

// ── Dashboard ──
app.get('/', (_req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf-8');
    res.type('html').send(html);
  } catch {
    res.status(404).send('Dashboard not found');
  }
});

// ── Service health proxy endpoints (for dashboard) ──
app.get('/api/svc/sentryflow', async (_req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const r = await fetch('http://localhost:3890/api/health', { signal: controller.signal });
    clearTimeout(timeout);
    res.json({ ok: r.ok, status: r.status });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/svc/relay/:host', async (req, res) => {
  const host = req.params.host;
  const port = 4196;
  try {
    const t0 = Date.now();
    const coils = await readCoils(host, port, 0, 1);
    const ms = Date.now() - t0;
    res.json({ ok: true, ms, host });
  } catch (e: any) {
    res.json({ ok: false, error: e.message, host });
  }
});

// ── Health ──
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), barriers: BARRIERS.length, logSize: eventLog.length });
});

// ── Event log endpoint ──
app.get('/api/log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 200, MAX_LOG);
  const type = req.query.type as string;
  const barrier = req.query.barrier as string;
  let entries = eventLog;
  if (type) entries = entries.filter(e => e.type === type);
  if (barrier) entries = entries.filter(e => e.barrier === barrier);
  res.json({ entries: entries.slice(0, limit), total: entries.length });
});

// ── Status - all barriers (serialized per relay board) ──
app.get('/api/status', async (_req, res) => {
  try {
    const results = new Map<string, any>();

    // Read barriers sequentially per board (mutex handles serialisation,
    // but we avoid unnecessary parallel pressure on the same board)
    for (const b of BARRIERS) {
      const t0 = Date.now();
      try {
        const { host, port } = b.relay;
        const minCoil = Math.min(b.coils.lift, b.coils.stop, b.coils.close);
        const maxCoil = Math.max(b.coils.lift, b.coils.stop, b.coils.close);
        const count = maxCoil - minCoil + 1;
        const coilStates = await readCoils(host, port, minCoil, count);
        const ms = Date.now() - t0;
        const state = barrierStates.get(b.id)!;
        results.set(b.id, {
          id: b.id, numericId: b.numericId, name: b.name, site: b.site, direction: b.direction,
          coils: {
            lift: coilStates[b.coils.lift - minCoil],
            stop: coilStates[b.coils.stop - minCoil],
            close: coilStates[b.coils.close - minCoil],
          },
          locked: state.locked,
          latchedAction: state.latchedAction,
          lastAction: state.lastAction,
          lastActionTime: state.lastActionTime,
          latencyMs: ms,
        });
      } catch (err: any) {
        log('error', b.id, `Status read failed: ${err.message}`);
        results.set(b.id, { id: b.id, numericId: b.numericId, name: b.name, error: err.message });
      }
    }

    const barriers = BARRIERS.map(b => results.get(b.id) || { id: b.id, error: 'Unknown' });
    res.json({ barriers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Relay status for single barrier ──
app.get('/api/barrier/:barrierId/relay-status', async (req, res) => {
  const barrier = findBarrier(req.params.barrierId);
  if (!barrier) return res.status(404).json({ error: 'Barrier not found' });
  try {
    const { host, port } = barrier.relay;
    const minCoil = Math.min(barrier.coils.lift, barrier.coils.stop, barrier.coils.close);
    const maxCoil = Math.max(barrier.coils.lift, barrier.coils.stop, barrier.coils.close);
    const count = maxCoil - minCoil + 1;
    const coilStates = await readCoils(host, port, minCoil, count);
    res.json({
      id: barrier.id,
      coils: {
        lift: coilStates[barrier.coils.lift - minCoil],
        stop: coilStates[barrier.coils.stop - minCoil],
        close: coilStates[barrier.coils.close - minCoil],
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Barrier actions (pulse) ──
for (const action of ['lift', 'close', 'stop'] as const) {
  app.post(`/api/barrier/:barrierId/${action}`, async (req, res) => {
    const barrier = findBarrier(req.params.barrierId);
    if (!barrier) return res.status(404).json({ error: 'Barrier not found' });
    const state = barrierStates.get(barrier.id)!;
    if (state.locked && action !== 'stop') {
      log('blocked', barrier.id, `Action ${action} denied — barrier locked`);
      return res.status(423).json({ error: 'Barrier is locked', barrierId: barrier.id });
    }
    const t0 = Date.now();
    try {
      await activateCoil(barrier, action);
      const ms = Date.now() - t0;
      state.lastAction = action;
      state.lastActionTime = new Date().toISOString();
      log(action, barrier.id, `${action.toUpperCase()} activated`, ms);
      res.json({ ok: true, barrierId: barrier.id, action });
    } catch (err: any) {
      const ms = Date.now() - t0;
      log('error', barrier.id, `${action} failed: ${err.message}`, ms);
      res.status(500).json({ error: err.message });
    }
  });
}

// ── Latch endpoints (hold coil on) ──
app.post('/api/barrier/:barrierId/latch-open', async (req, res) => {
  const barrier = findBarrier(req.params.barrierId);
  if (!barrier) return res.status(404).json({ error: 'Barrier not found' });
  const state = barrierStates.get(barrier.id)!;

  // Must unlatch first if already latched to something different
  if (state.latchedAction && state.latchedAction !== 'lift') {
    return res.status(409).json({ error: `Already latched ${state.latchedAction} — unlatch first`, barrierId: barrier.id });
  }

  try {
    await activateCoil(barrier, 'lift', true);
    state.lastAction = 'latch-open';
    state.lastActionTime = new Date().toISOString();
    state.locked = true;
    state.latchedAction = 'lift';
    log('latch-open', barrier.id, 'Barrier LATCHED OPEN — coil held, commands locked');
    res.json({ ok: true, barrierId: barrier.id, action: 'latch-open' });
  } catch (err: any) {
    log('error', barrier.id, `Latch open failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/barrier/:barrierId/latch-close', async (req, res) => {
  const barrier = findBarrier(req.params.barrierId);
  if (!barrier) return res.status(404).json({ error: 'Barrier not found' });
  const state = barrierStates.get(barrier.id)!;

  if (state.latchedAction && state.latchedAction !== 'close') {
    return res.status(409).json({ error: `Already latched ${state.latchedAction} — unlatch first`, barrierId: barrier.id });
  }

  try {
    await activateCoil(barrier, 'close', true);
    state.lastAction = 'latch-close';
    state.lastActionTime = new Date().toISOString();
    state.locked = true;
    state.latchedAction = 'close';
    log('latch-close', barrier.id, 'Barrier LATCHED CLOSED — coil held, commands locked');
    res.json({ ok: true, barrierId: barrier.id, action: 'latch-close' });
  } catch (err: any) {
    log('error', barrier.id, `Latch close failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/barrier/:barrierId/unlatch', async (req, res) => {
  const barrier = findBarrier(req.params.barrierId);
  if (!barrier) return res.status(404).json({ error: 'Barrier not found' });
  try {
    await releaseLatch(barrier);
    const state = barrierStates.get(barrier.id)!;
    state.lastAction = 'unlatch';
    state.lastActionTime = new Date().toISOString();
    state.locked = false;
    state.latchedAction = null;
    log('unlatch', barrier.id, 'Barrier UNLATCHED — coils released, commands unlocked');
    res.json({ ok: true, barrierId: barrier.id, action: 'unlatch' });
  } catch (err: any) {
    log('error', barrier.id, `Unlatch failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Lock/unlock ──
app.post('/api/barrier/:barrierId/lock', (req, res) => {
  const barrier = findBarrier(req.params.barrierId);
  if (!barrier) return res.status(404).json({ error: 'Barrier not found' });
  barrierStates.get(barrier.id)!.locked = true;
  log('lock', barrier.id, 'Barrier LOCKED');
  res.json({ ok: true, barrierId: barrier.id, locked: true });
});

app.post('/api/barrier/:barrierId/unlock', (req, res) => {
  const barrier = findBarrier(req.params.barrierId);
  if (!barrier) return res.status(404).json({ error: 'Barrier not found' });
  const state = barrierStates.get(barrier.id)!;
  state.locked = false;
  log('unlock', barrier.id, 'Barrier UNLOCKED');
  res.json({ ok: true, barrierId: barrier.id, locked: false });
});

// ── Emergency off ──
app.post('/api/emergency-off', async (_req, res) => {
  log('emergency-off', 'ALL', '⚠️ EMERGENCY OFF — all coils OFF');
  try {
    // Collect unique relay boards and turn off all 8 coils atomically per board
    const seen = new Set<string>();
    for (const b of BARRIERS) {
      const k = `${b.relay.host}:${b.relay.port}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await atomicAllOff(b.relay.host, b.relay.port, [0, 1, 2, 3, 4, 5, 6, 7]);
    }
    // Clear all state
    for (const b of BARRIERS) {
      const state = barrierStates.get(b.id)!;
      state.locked = false;
      state.latchedAction = null;
      const pulse = pulseTimeouts.get(b.id);
      if (pulse) { clearTimeout(pulse); pulseTimeouts.delete(b.id); }
    }
    res.json({ ok: true, action: 'emergency-off' });
  } catch (err: any) {
    log('error', 'ALL', `Emergency off failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(API_PORT, '0.0.0.0', () => {
  log('startup', 'system', `Barrier Control v1.1 listening on port ${API_PORT}, ${BARRIERS.length} barriers configured`);
});
