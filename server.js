const express = require('express');
const cors = require('cors');
const net = require('net');
const path = require('path');
const fs = require('fs');

// ─── Configuration ──────────────────────────────────────────────────────────
const SERVER_PORT = parseInt(process.env.PORT || '3000', 10);
const PULSE_MS = parseInt(process.env.PULSE_MS || '500', 10);
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '5000', 10);
const MODBUS_TIMEOUT = parseInt(process.env.MODBUS_TIMEOUT || '5000', 10);
const CLOSE_RELEASE_MS = parseInt(process.env.CLOSE_RELEASE_MS || '4000', 10);
const API_KEY = process.env.API_KEY || null;  // Optional API key for remote access
const AUDIT_LOG_FILE = process.env.AUDIT_LOG || path.join(__dirname, 'audit.log');

// ─── Board Registry ─────────────────────────────────────────────────────────
// Each board has its own Modbus connection, heartbeat, and state
const BOARDS = {
  board1: {
    host: process.env.BOARD1_HOST || '10.10.10.64',
    port: parseInt(process.env.BOARD1_PORT || '4196', 10),
    unitId: parseInt(process.env.BOARD1_UNIT || '1', 10),
    channels: 6,
    name: 'Board 1 (Main)'
  },
  board2: {
    host: process.env.BOARD2_HOST || '10.10.10.65',
    port: parseInt(process.env.BOARD2_PORT || '4196', 10),
    unitId: parseInt(process.env.BOARD2_UNIT || '1', 10),
    channels: 3,
    name: 'Board 2 (Barrier 3)'
  }
};

// ─── Barrier → Board+Channel Mapping ────────────────────────────────────────
const BARRIERS = {
  1: { board: 'board1', lift: 0, close: 1, stop: 2, name: 'Barrier 1' },
  2: { board: 'board1', lift: 3, close: 4, stop: 5, name: 'Barrier 2' },
  3: { board: 'board2', lift: 0, close: 1, stop: 2, name: 'Barrier 3' }
};

// ─── Per-Board Runtime State ────────────────────────────────────────────────
const boardState = {};
for (const [key, cfg] of Object.entries(BOARDS)) {
  boardState[key] = {
    reachable: false,
    modeDetected: false,
    useRTU: false,
    commandLock: false,
    coils: new Array(cfg.channels).fill(false),
    transactionId: 0
  };
}

// Close auto-release timers per barrier
const closeTimers = {};

// ─── CRC-16 for Modbus RTU ──────────────────────────────────────────────────
function crc16(buffer) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
  }
  return crc;
}

function appendCRC(buffer) {
  const out = Buffer.alloc(buffer.length + 2);
  buffer.copy(out);
  out.writeUInt16LE(crc16(buffer), buffer.length);
  return out;
}

function verifyCRC(buffer) {
  if (buffer.length < 4) return false;
  return crc16(buffer.slice(0, -2)) === buffer.readUInt16LE(buffer.length - 2);
}

// ─── Modbus Framing ─────────────────────────────────────────────────────────
function buildTCPFrame(boardKey, unitId, fc, data) {
  const state = boardState[boardKey];
  const tid = (++state.transactionId) & 0xFFFF;
  const pdu = Buffer.concat([Buffer.from([fc]), data]);
  const mbap = Buffer.alloc(7);
  mbap.writeUInt16BE(tid, 0);
  mbap.writeUInt16BE(0, 2);
  mbap.writeUInt16BE(pdu.length + 1, 4);
  mbap.writeUInt8(unitId, 6);
  return Buffer.concat([mbap, pdu]);
}

function buildRTUFrame(unitId, fc, data) {
  return appendCRC(Buffer.concat([Buffer.from([unitId, fc]), data]));
}

function parseTCPResponse(response) {
  if (response.length < 9) return null;
  const fc = response.readUInt8(7);
  if (fc & 0x80) throw new Error(`Modbus exception: FC=${fc & 0x7F}, code=${response.readUInt8(8)}`);
  return response.slice(7);
}

function parseRTUResponse(response) {
  if (response.length < 5) return null;
  const fc = response.readUInt8(1);
  if (fc & 0x80) {
    if (response.length >= 5 && verifyCRC(response.slice(0, 5)))
      throw new Error(`Modbus exception: FC=${fc & 0x7F}, code=${response.readUInt8(2)}`);
    return null;
  }
  let expectedLen;
  if (fc === 0x01 || fc === 0x02) {
    if (response.length < 4) return null;
    expectedLen = 3 + response.readUInt8(2) + 2;
  } else if (fc === 0x05 || fc === 0x06) {
    expectedLen = 8;
  } else {
    expectedLen = response.length;
  }
  if (response.length < expectedLen) return null;
  const frame = response.slice(0, expectedLen);
  if (!verifyCRC(frame)) throw new Error('CRC mismatch');
  return frame.slice(1, expectedLen - 2);
}

// ─── Board-Aware Modbus Request ─────────────────────────────────────────────
function modbusRequest(boardKey, fc, data) {
  const cfg = BOARDS[boardKey];
  const state = boardState[boardKey];
  return new Promise((resolve, reject) => {
    const frame = state.useRTU
      ? buildRTUFrame(cfg.unitId, fc, data)
      : buildTCPFrame(boardKey, cfg.unitId, fc, data);

    const socket = new net.Socket();
    let responded = false;
    let chunks = [];

    const timeout = setTimeout(() => {
      if (!responded) { responded = true; socket.destroy(); reject(new Error('Modbus timeout')); }
    }, MODBUS_TIMEOUT);

    socket.connect(cfg.port, cfg.host, () => socket.write(frame));

    socket.on('data', (chunk) => {
      if (responded) return;
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      try {
        const pdu = state.useRTU ? parseRTUResponse(buf) : parseTCPResponse(buf);
        if (pdu) { responded = true; clearTimeout(timeout); socket.end(); resolve(pdu); }
      } catch (err) { responded = true; clearTimeout(timeout); socket.end(); reject(err); }
    });

    socket.on('error', (err) => { if (!responded) { responded = true; clearTimeout(timeout); reject(err); } });
    socket.on('close', () => { if (!responded) { responded = true; clearTimeout(timeout); reject(new Error('Socket closed')); } });
  });
}

// ─── Board Modbus Operations ────────────────────────────────────────────────
async function readCoils(boardKey, startAddr, qty) {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(startAddr, 0);
  data.writeUInt16BE(qty, 2);
  const pdu = await modbusRequest(boardKey, 0x01, data);
  const coils = [];
  for (let i = 0; i < qty; i++) {
    coils.push(!!(pdu[2 + Math.floor(i / 8)] & (1 << (i % 8))));
  }
  return coils;
}

async function writeCoil(boardKey, addr, value) {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(addr, 0);
  data.writeUInt16BE(value ? 0xFF00 : 0x0000, 2);
  await modbusRequest(boardKey, 0x05, data);
}

// ─── Auto-Detect Protocol Mode Per Board ────────────────────────────────────
async function autoDetectBoard(boardKey) {
  const cfg = BOARDS[boardKey];
  const state = boardState[boardKey];
  const testData = Buffer.alloc(4);
  testData.writeUInt16BE(0, 0);
  testData.writeUInt16BE(cfg.channels, 2);

  // Try TCP first
  state.useRTU = false;
  try { await modbusRequest(boardKey, 0x01, testData); log('INFO', `${cfg.name}: TCP mode`); return true; }
  catch (e) { /* fall through */ }

  // Try RTU
  state.useRTU = true;
  try { await modbusRequest(boardKey, 0x01, testData); log('INFO', `${cfg.name}: RTU mode`); return true; }
  catch (e) { /* fall through */ }

  return false;
}

// ─── Heartbeat Per Board ────────────────────────────────────────────────────
const heartbeatTimers = {};

async function heartbeatBoard(boardKey) {
  const cfg = BOARDS[boardKey];
  const state = boardState[boardKey];
  if (state.commandLock) return;

  if (!state.modeDetected) {
    state.modeDetected = await autoDetectBoard(boardKey);
    if (!state.modeDetected) return;
  }

  try {
    const coils = await readCoils(boardKey, 0, cfg.channels);
    state.coils = coils;
    if (!state.reachable) {
      state.reachable = true;
      log('INFO', `✓ ${cfg.name} online [${coils.map((c, i) => `CH${i + 1}:${c ? 'ON' : 'off'}`).join(', ')}]`);
    }
  } catch (err) {
    if (state.reachable) {
      state.reachable = false;
      log('WARN', `✗ ${cfg.name} offline: ${err.message}`);
    }
    state.modeDetected = false;
  }
}

function startHeartbeats() {
  for (const boardKey of Object.keys(BOARDS)) {
    heartbeatBoard(boardKey);
    heartbeatTimers[boardKey] = setInterval(() => heartbeatBoard(boardKey), HEARTBEAT_MS);
  }
}

// ─── Audit Log ──────────────────────────────────────────────────────────────
const auditEntries = [];          // In-memory ring buffer (last 500)
const MAX_AUDIT_ENTRIES = 500;

function audit(action, details, source = 'ui') {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    source,
    details,
  };
  auditEntries.push(entry);
  if (auditEntries.length > MAX_AUDIT_ENTRIES) auditEntries.shift();

  // Append to file
  try {
    fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) { /* ignore write errors */ }

  // Broadcast via SSE
  sseClients.forEach(res => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  log('AUDIT', `[${source}] ${action}: ${JSON.stringify(details)}`);
}

// ─── SSE for Real-Time UI Updates ───────────────────────────────────────────
const sseClients = new Set();

// ─── Structured Logging ─────────────────────────────────────────────────────
function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} [${level}] ${msg}`);
}

// ─── Barrier Actions ────────────────────────────────────────────────────────
async function latchBarrierAction(barrierId, action, source = 'ui') {
  const barrier = BARRIERS[barrierId];
  if (!barrier) throw new Error(`Unknown barrier: ${barrierId}`);
  const boardKey = barrier.board;
  const state = boardState[boardKey];
  if (!state.reachable) throw new Error(`${BOARDS[boardKey].name} not connected`);

  state.commandLock = true;
  try {
    if (action === 'lift') {
      if (closeTimers[barrierId]) { clearTimeout(closeTimers[barrierId]); closeTimers[barrierId] = null; }
      await writeCoil(boardKey, barrier.close, false);
      await writeCoil(boardKey, barrier.lift, true);
    } else if (action === 'close') {
      if (closeTimers[barrierId]) { clearTimeout(closeTimers[barrierId]); closeTimers[barrierId] = null; }
      await writeCoil(boardKey, barrier.lift, false);
      await writeCoil(boardKey, barrier.close, true);
      closeTimers[barrierId] = setTimeout(async () => {
        try {
          await writeCoil(boardKey, barrier.close, false);
          audit('close_auto_release', { barrier: barrier.name }, 'system');
        } catch (e) {
          log('WARN', `${barrier.name} close auto-release failed: ${e.message}`);
        }
        closeTimers[barrierId] = null;
      }, CLOSE_RELEASE_MS);
    } else if (action === 'stop') {
      if (closeTimers[barrierId]) { clearTimeout(closeTimers[barrierId]); closeTimers[barrierId] = null; }
      await writeCoil(boardKey, barrier.lift, false);
      await writeCoil(boardKey, barrier.close, false);
      await writeCoil(boardKey, barrier.stop, true);
    }
  } finally {
    state.commandLock = false;
  }
  audit(`barrier_${action}`, { barrier: barrier.name, barrierId, channel: barrier[action] + 1 }, source);
}

async function emergencyOff(source = 'ui') {
  for (const [boardKey, cfg] of Object.entries(BOARDS)) {
    const state = boardState[boardKey];
    if (!state.reachable) continue;
    state.commandLock = true;
    try {
      for (let i = 0; i < cfg.channels; i++) {
        await writeCoil(boardKey, i, false);
      }
    } finally {
      state.commandLock = false;
    }
  }
  // Cancel all close timers
  for (const key of Object.keys(closeTimers)) {
    if (closeTimers[key]) { clearTimeout(closeTimers[key]); closeTimers[key] = null; }
  }
  audit('emergency_off', { boards: Object.keys(BOARDS) }, source);
}

function getFullStatus() {
  const barriers = Object.entries(BARRIERS).map(([id, b]) => {
    const coils = boardState[b.board].coils;
    return {
      id: parseInt(id),
      name: b.name,
      board: b.board,
      lift: coils[b.lift] || false,
      close: coils[b.close] || false,
      stop: coils[b.stop] || false
    };
  });

  const boards = Object.entries(BOARDS).map(([key, cfg]) => ({
    key,
    name: cfg.name,
    host: cfg.host,
    port: cfg.port,
    connected: boardState[key].reachable,
    mode: boardState[key].useRTU ? 'RTU-over-TCP' : 'Modbus TCP',
    channels: boardState[key].coils.map((active, i) => ({ channel: i + 1, active }))
  }));

  return { boards, barriers };
}

// ─── Express App ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Optional API key middleware for non-browser clients
function apiAuth(req, res, next) {
  if (!API_KEY) return next();
  // Skip auth for UI assets and SSE
  if (req.path === '/' || req.path.startsWith('/api/events') || !req.path.startsWith('/api/')) return next();
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided === API_KEY) return next();
  res.status(401).json({ error: 'Invalid API key' });
}
app.use(apiAuth);

// SSE endpoint — real-time event stream
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Status
app.get('/api/status', async (req, res) => {
  try {
    // Refresh coils from reachable boards
    for (const [boardKey, cfg] of Object.entries(BOARDS)) {
      const state = boardState[boardKey];
      if (state.reachable && !state.commandLock) {
        try {
          state.coils = await readCoils(boardKey, 0, cfg.channels);
        } catch (e) { state.reachable = false; }
      }
    }
    res.json(getFullStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Barrier action
app.post('/api/barrier/:id/:action', async (req, res) => {
  const barrierId = parseInt(req.params.id);
  const action = req.params.action.toLowerCase();
  const source = req.headers['x-source'] || 'api';

  const barrier = BARRIERS[barrierId];
  if (!barrier) return res.status(400).json({ error: `Unknown barrier: ${barrierId}` });
  if (!['lift', 'close', 'stop'].includes(action)) return res.status(400).json({ error: `Unknown action: ${action}` });

  try {
    await latchBarrierAction(barrierId, action, source);
    res.json({ success: true, barrier: barrier.name, action, channel: barrier[action] + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Emergency off
app.post('/api/emergency-off', async (req, res) => {
  const source = req.headers['x-source'] || 'api';
  try {
    await emergencyOff(source);
    res.json({ success: true, action: 'emergency-off' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit log
app.get('/api/audit', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), MAX_AUDIT_ENTRIES);
  res.json(auditEntries.slice(-limit));
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
async function shutdown(signal) {
  log('INFO', `${signal} received — shutting down`);
  // Stop heartbeats
  for (const timer of Object.values(heartbeatTimers)) clearInterval(timer);
  // Cancel close timers
  for (const key of Object.keys(closeTimers)) {
    if (closeTimers[key]) clearTimeout(closeTimers[key]);
  }
  // Turn off all relays
  try {
    for (const [boardKey, cfg] of Object.entries(BOARDS)) {
      if (boardState[boardKey].reachable) {
        for (let i = 0; i < cfg.channels; i++) {
          try { await writeCoil(boardKey, i, false); } catch (e) { /* best effort */ }
        }
      }
    }
    log('INFO', 'All relays OFF');
  } catch (e) { /* best effort */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(SERVER_PORT, '0.0.0.0', () => {
  log('INFO', '🚧 Barrier Control Server');
  log('INFO', `Web UI: http://localhost:${SERVER_PORT}`);
  for (const [key, cfg] of Object.entries(BOARDS)) {
    log('INFO', `${cfg.name}: ${cfg.host}:${cfg.port} (unit ${cfg.unitId})`);
  }
  log('INFO', `Barriers: ${Object.values(BARRIERS).map(b => b.name).join(', ')}`);
  log('INFO', `Heartbeat: ${HEARTBEAT_MS / 1000}s | Close release: ${CLOSE_RELEASE_MS / 1000}s`);
  if (API_KEY) log('INFO', 'API key auth enabled');
  log('INFO', `Audit log: ${AUDIT_LOG_FILE}`);
  startHeartbeats();
});
