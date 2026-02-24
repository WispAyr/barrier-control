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
const MAX_LOG = 2000;
const eventLog: LogEntry[] = [];
const LOG_FILE = path.join(__dirname, '..', 'data', 'activity.jsonl');

// Load persisted log on startup
try {
  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines.slice(-MAX_LOG)) {
      try { eventLog.push(JSON.parse(line)); } catch {}
    }
    eventLog.reverse(); // newest first
  }
} catch {}

function log(type: string, barrier: string, details: string, latencyMs?: number) {
  const entry: LogEntry = { time: new Date().toISOString(), type, barrier, details, latencyMs };
  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.pop();
  // Persist
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch {}
  console.log(`[barrier] [${type}] ${barrier}: ${details}${latencyMs ? ` (${latencyMs}ms)` : ''}`);
  // Broadcast to WS clients
  try { broadcast({ type: 'log', entry }); } catch {}
  // Also push full state after actions
  if (type !== 'startup' && type !== 'pulse-off') {
    setTimeout(() => broadcastState(), 200);
  }
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

const PULSE_MS = 1500; // pulse duration for normal operations

// Track which barriers have coils latched (held on)
const latchedCoils = new Map<string, NodeJS.Timeout | null>(); // barrierId -> null means held indefinitely

async function activateCoil(barrier: BarrierConfig, action: 'lift' | 'stop' | 'close', hold = false): Promise<void> {
  const { host, port } = barrier.relay;
  const coils = barrier.coils;

  // Cancel any existing latch timeout for this barrier
  const existingTimeout = latchedCoils.get(barrier.id);
  if (existingTimeout) clearTimeout(existingTimeout);
  latchedCoils.delete(barrier.id);

  // Clear all coils first
  await writeMultipleCoils(host, port, [
    { coil: coils.lift, value: false },
    { coil: coils.stop, value: false },
    { coil: coils.close, value: false },
  ]);

  // Small gap to ensure clean transition
  await new Promise(r => setTimeout(r, 50));

  // Set the target coil
  const targetCoil = coils[action];
  await writeCoil(host, port, targetCoil, true);

  if (hold) {
    // Hold coil on indefinitely (latch mode)
    latchedCoils.set(barrier.id, null);
    log('latch', barrier.id, `${action} coil HELD ON (latched)`);
  } else {
    // Auto-release after pulse duration
    const timeout = setTimeout(async () => {
      try {
        await writeCoil(host, port, targetCoil, false);
        latchedCoils.delete(barrier.id);
        log('pulse-off', barrier.id, `${action} coil auto-released after ${PULSE_MS}ms`);
      } catch (err: any) {
        log('error', barrier.id, `Failed to release ${action} coil: ${err.message}`);
      }
    }, PULSE_MS);
    latchedCoils.set(barrier.id, timeout);
  }
}

// Release a latched coil
async function releaseLatch(barrier: BarrierConfig): Promise<void> {
  const { host, port } = barrier.relay;
  const coils = barrier.coils;
  const existingTimeout = latchedCoils.get(barrier.id);
  if (existingTimeout) clearTimeout(existingTimeout);
  latchedCoils.delete(barrier.id);
  await writeMultipleCoils(host, port, [
    { coil: coils.lift, value: false },
    { coil: coils.stop, value: false },
    { coil: coils.close, value: false },
  ]);
  log('unlatch', barrier.id, 'All coils released');
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

// ── Raw relay board read (all 8 coils) ──
app.get('/api/relay/:host/coils', async (req, res) => {
  const host = req.params.host;
  const port = 4196;
  try {
    const t0 = Date.now();
    const coils = await readCoils(host, port, 0, 8);
    const ms = Date.now() - t0;
    res.json({ host, coils, latencyMs: ms });
  } catch (err: any) {
    res.json({ host, error: err.message });
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
    // Group barriers by relay board to serialize reads on same connection
    const byRelay = new Map<string, typeof BARRIERS>();
    for (const b of BARRIERS) {
      const k = `${b.relay.host}:${b.relay.port}`;
      if (!byRelay.has(k)) byRelay.set(k, []);
      byRelay.get(k)!.push(b);
    }

    const results = new Map<string, any>();

    // Read each relay board's barriers serially, but boards in parallel
    await Promise.allSettled(
      Array.from(byRelay.entries()).map(async ([_relayKey, boardBarriers]) => {
        for (const b of boardBarriers) {
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
              lastAction: state.lastAction,
              lastActionTime: state.lastActionTime,
              latencyMs: ms,
            });
          } catch (err: any) {
            log('error', b.id, `Status read failed: ${err.message}`);
            results.set(b.id, { id: b.id, numericId: b.numericId, name: b.name, error: err.message });
          }
        }
      })
    );

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

// ── Latch endpoints (hold coil on) ──
app.post('/api/barrier/:barrierId/latch-open', async (req, res) => {
  const barrier = findBarrier(req.params.barrierId);
  if (!barrier) return res.status(404).json({ error: 'Barrier not found' });
  try {
    await activateCoil(barrier, 'lift', true);
    const state = barrierStates.get(barrier.id)!;
    state.lastAction = 'latch-open';
    state.lastActionTime = new Date().toISOString();
    state.locked = true;
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
  try {
    await activateCoil(barrier, 'close', true);
    const state = barrierStates.get(barrier.id)!;
    state.lastAction = 'latch-close';
    state.lastActionTime = new Date().toISOString();
    state.locked = true;
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

// ── WebSocket for real-time updates ──
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set<WebSocket>();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  // Send initial state
  broadcastState();
});

function broadcast(data: any) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

async function broadcastState() {
  try {
    // Read all relay boards
    const relayBoards: Record<string, boolean[] | string> = {};
    const relayHosts = [...new Set(BARRIERS.map(b => b.relay.host))];
    
    for (const host of relayHosts) {
      try {
        const coils = await readCoils(host, 4196, 0, 8);
        relayBoards[host] = coils;
      } catch (err: any) {
        relayBoards[host] = err.message;
      }
    }

    // Barrier states
    const barriers = BARRIERS.map(b => {
      const state = barrierStates.get(b.id)!;
      const boardCoils = relayBoards[b.relay.host];
      const coils = Array.isArray(boardCoils) ? {
        lift: boardCoils[b.coils.lift],
        stop: boardCoils[b.coils.stop],
        close: boardCoils[b.coils.close],
      } : null;
      return {
        id: b.id, numericId: b.numericId, name: b.name, site: b.site, direction: b.direction,
        coils, locked: state.locked, lastAction: state.lastAction, lastActionTime: state.lastActionTime,
        error: Array.isArray(boardCoils) ? null : boardCoils,
      };
    });

    broadcast({ type: 'state', barriers, relays: relayBoards, timestamp: new Date().toISOString() });
  } catch {}
}

// Broadcast state every 2 seconds
setInterval(broadcastState, 2000);

// Override log to also broadcast events
const _origLog = log;
// Wrap log to broadcast
const origLogFn = log;

server.listen(API_PORT, '0.0.0.0', () => {
  log('startup', 'system', `Barrier Control listening on port ${API_PORT}, ${BARRIERS.length} barriers configured, WebSocket enabled`);
});
