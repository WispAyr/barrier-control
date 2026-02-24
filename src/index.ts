import express from 'express';
import fs from 'fs';
import path from 'path';
import { BARRIERS, API_PORT, BarrierConfig } from './config';
import { writeCoil, readCoils, writeMultipleCoils } from './modbus-client';

const app = express();
app.use(express.json());

// ── Event Log (ring buffer) ──
interface LogEntry {
  time: string;
  type: string;
  barrier: string;
  details: string;
  latencyMs?: number;
}
const MAX_LOG = 1000;
const eventLog: LogEntry[] = [];

function log(type: string, barrier: string, details: string, latencyMs?: number) {
  const entry: LogEntry = { time: new Date().toISOString(), type, barrier, details, latencyMs };
  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.pop();
  console.log(`[barrier] [${type}] ${barrier}: ${details}${latencyMs ? ` (${latencyMs}ms)` : ''}`);
}

// ── Barrier state tracking ──
interface BarrierState {
  locked: boolean;
  lastAction: string | null;
  lastActionTime: string | null;
}
const barrierStates = new Map<string, BarrierState>();
BARRIERS.forEach(b => barrierStates.set(b.id, { locked: false, lastAction: null, lastActionTime: null }));

function findBarrier(barrierId: string): BarrierConfig | undefined {
  const num = parseInt(barrierId);
  if (!isNaN(num)) return BARRIERS.find(b => b.numericId === num);
  return BARRIERS.find(b => b.id === barrierId);
}

async function activateCoil(barrier: BarrierConfig, action: 'lift' | 'stop' | 'close'): Promise<void> {
  const { host, port } = barrier.relay;
  const coils = barrier.coils;
  const writes = [
    { coil: coils.lift, value: action === 'lift' },
    { coil: coils.stop, value: action === 'stop' },
    { coil: coils.close, value: action === 'close' },
  ];
  await writeMultipleCoils(host, port, writes);
}

// ── Dashboard ──
app.get('/', (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf-8');
  res.type('html').send(html);
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

// ── Status - all barriers ──
app.get('/api/status', async (_req, res) => {
  try {
    const results = await Promise.allSettled(
      BARRIERS.map(async (b) => {
        const t0 = Date.now();
        const { host, port } = b.relay;
        const minCoil = Math.min(b.coils.lift, b.coils.stop, b.coils.close);
        const maxCoil = Math.max(b.coils.lift, b.coils.stop, b.coils.close);
        const count = maxCoil - minCoil + 1;
        const coilStates = await readCoils(host, port, minCoil, count);
        const ms = Date.now() - t0;
        const state = barrierStates.get(b.id)!;
        return {
          id: b.id, numericId: b.numericId, name: b.name, site: b.site, direction: b.direction,
          coils: {
            lift: coilStates[b.coils.lift - minCoil],
            stop: coilStates[b.coils.stop - minCoil],
            close: coilStates[b.coils.close - minCoil],
          },
          locked: state.locked,
          lastAction: state.lastAction,
          lastActionTime: state.lastActionTime,
          latencyMs: ms,
        };
      })
    );
    const barriers = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      log('error', BARRIERS[i].id, `Status read failed: ${(r.reason as Error).message}`);
      return { id: BARRIERS[i].id, numericId: BARRIERS[i].numericId, name: BARRIERS[i].name, error: (r.reason as Error).message };
    });
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

// ── Barrier actions ──
for (const action of ['lift', 'close', 'stop'] as const) {
  app.post(`/api/barrier/:barrierId/${action}`, async (req, res) => {
    const barrier = findBarrier(req.params.barrierId);
    if (!barrier) return res.status(404).json({ error: 'Barrier not found' });
    const state = barrierStates.get(barrier.id)!;
    if (state.locked && action !== 'stop') {
      log('error', barrier.id, `Action ${action} denied — barrier locked`);
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
  barrierStates.get(barrier.id)!.locked = false;
  log('unlock', barrier.id, 'Barrier UNLOCKED');
  res.json({ ok: true, barrierId: barrier.id, locked: false });
});

// ── Emergency off ──
app.post('/api/emergency-off', async (_req, res) => {
  log('emergency-off', 'ALL', '⚠️ EMERGENCY OFF — all coils OFF');
  try {
    const seen = new Set<string>();
    for (const b of BARRIERS) {
      const k = `${b.relay.host}:${b.relay.port}`;
      if (seen.has(k)) continue;
      seen.add(k);
      for (let coil = 0; coil < 8; coil++) {
        await writeCoil(b.relay.host, b.relay.port, coil, false);
      }
    }
    res.json({ ok: true, action: 'emergency-off' });
  } catch (err: any) {
    log('error', 'ALL', `Emergency off failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(API_PORT, '0.0.0.0', () => {
  log('startup', 'system', `Barrier Control listening on port ${API_PORT}, ${BARRIERS.length} barriers configured`);
});
