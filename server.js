const express = require('express');
const cors = require('cors');
const net = require('net');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────
const MODBUS_HOST = process.env.MODBUS_HOST || '10.10.10.64';
const MODBUS_PORT = parseInt(process.env.MODBUS_PORT || '4196', 10);
const MODBUS_ID = parseInt(process.env.MODBUS_ID || '1', 10);
const PULSE_MS = parseInt(process.env.PULSE_MS || '500', 10);
const SERVER_PORT = parseInt(process.env.PORT || '3000', 10);
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '5000', 10);
const MODBUS_TIMEOUT = parseInt(process.env.MODBUS_TIMEOUT || '5000', 10);

// Channel mapping (0-indexed coil addresses)
const BARRIERS = {
  1: { lift: 0, close: 1, stop: 2, name: 'Barrier 1' },
  2: { lift: 3, close: 4, stop: 5, name: 'Barrier 2' }
};

// ─── CRC-16 for Modbus RTU ──────────────────────────────────────────────────
function crc16(buffer) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

function appendCRC(buffer) {
  const crc = crc16(buffer);
  const out = Buffer.alloc(buffer.length + 2);
  buffer.copy(out);
  out.writeUInt16LE(crc, buffer.length); // CRC is little-endian in Modbus RTU
  return out;
}

function verifyCRC(buffer) {
  if (buffer.length < 4) return false;
  const data = buffer.slice(0, buffer.length - 2);
  const received = buffer.readUInt16LE(buffer.length - 2);
  return crc16(data) === received;
}

// ─── Dual-mode Modbus: tries TCP framing first, falls back to RTU-over-TCP ─
let useRTUMode = false; // auto-detected on first successful exchange

// Modbus TCP frame (MBAP header + PDU, no CRC)
let transactionId = 0;
function buildTCPFrame(unitId, functionCode, data) {
  const tid = (++transactionId) & 0xFFFF;
  const pdu = Buffer.concat([Buffer.from([functionCode]), data]);
  const mbap = Buffer.alloc(7);
  mbap.writeUInt16BE(tid, 0);
  mbap.writeUInt16BE(0, 2);
  mbap.writeUInt16BE(pdu.length + 1, 4);
  mbap.writeUInt8(unitId, 6);
  return Buffer.concat([mbap, pdu]);
}

// Modbus RTU frame (Unit + FC + Data + CRC16)
function buildRTUFrame(unitId, functionCode, data) {
  const frame = Buffer.concat([Buffer.from([unitId, functionCode]), data]);
  return appendCRC(frame);
}

// Send a modbus request over a fresh TCP socket
function modbusRequest(functionCode, data) {
  return new Promise((resolve, reject) => {
    const frame = useRTUMode
      ? buildRTUFrame(MODBUS_ID, functionCode, data)
      : buildTCPFrame(MODBUS_ID, functionCode, data);

    const socket = new net.Socket();
    let responded = false;
    let chunks = [];

    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        socket.destroy();
        reject(new Error('Modbus request timed out'));
      }
    }, MODBUS_TIMEOUT);

    socket.connect(MODBUS_PORT, MODBUS_HOST, () => {
      socket.write(frame);
    });

    socket.on('data', (chunk) => {
      if (responded) return;
      chunks.push(chunk);
      const response = Buffer.concat(chunks);

      // Try to parse based on current mode
      try {
        let pdu;
        if (useRTUMode) {
          pdu = parseRTUResponse(response, functionCode);
        } else {
          pdu = parseTCPResponse(response, functionCode);
        }
        if (pdu) {
          responded = true;
          clearTimeout(timeout);
          socket.end();
          resolve(pdu);
        }
      } catch (err) {
        responded = true;
        clearTimeout(timeout);
        socket.end();
        reject(err);
      }
    });

    socket.on('error', (err) => {
      if (!responded) {
        responded = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    socket.on('close', () => {
      if (!responded) {
        responded = true;
        clearTimeout(timeout);
        reject(new Error('Socket closed before response'));
      }
    });
  });
}

function parseTCPResponse(response, expectedFC) {
  if (response.length < 9) return null; // incomplete
  const respFc = response.readUInt8(7);
  if (respFc & 0x80) {
    throw new Error(`Modbus exception: FC=${respFc & 0x7F}, code=${response.readUInt8(8)}`);
  }
  return response.slice(7); // PDU: FC + data
}

function parseRTUResponse(response, expectedFC) {
  // RTU minimum: UnitID(1) + FC(1) + at least 1 byte data + CRC(2) = 5
  if (response.length < 5) return null; // incomplete

  // For read coils (FC01): UnitID + FC + byteCount + data... + CRC
  // For write coil (FC05): UnitID + FC + addr(2) + value(2) + CRC = 8
  const fc = response.readUInt8(1);
  if (fc & 0x80) {
    // Exception response: UnitID + FC + ExCode + CRC = 5 bytes
    if (response.length >= 5 && verifyCRC(response.slice(0, 5))) {
      throw new Error(`Modbus exception: FC=${fc & 0x7F}, code=${response.readUInt8(2)}`);
    }
    return null; // incomplete
  }

  let expectedLen;
  if (fc === 0x01 || fc === 0x02) {
    // Read coils/inputs: UnitID + FC + byteCount + data + CRC
    if (response.length < 4) return null;
    const byteCount = response.readUInt8(2);
    expectedLen = 3 + byteCount + 2; // header + data + CRC
  } else if (fc === 0x05 || fc === 0x06) {
    // Write coil/register echo: UnitID + FC + addr(2) + val(2) + CRC = 8
    expectedLen = 8;
  } else {
    expectedLen = response.length; // best guess
  }

  if (response.length < expectedLen) return null; // incomplete

  const fullFrame = response.slice(0, expectedLen);
  if (!verifyCRC(fullFrame)) {
    throw new Error('CRC mismatch in RTU response');
  }

  return fullFrame.slice(1, expectedLen - 2); // Strip unit ID and CRC, return FC + data
}

// Auto-detect: try Modbus TCP first, if it times out, switch to RTU
async function autoDetectMode() {
  const testData = Buffer.alloc(4);
  testData.writeUInt16BE(0, 0); // start addr 0
  testData.writeUInt16BE(8, 2); // quantity 8

  // Try TCP mode first
  console.log('  Trying Modbus TCP mode...');
  useRTUMode = false;
  try {
    const pdu = await modbusRequest(0x01, testData);
    console.log('  ✓ Modbus TCP mode works');
    return true;
  } catch (e) {
    console.log(`  ✗ TCP mode failed: ${e.message}`);
  }

  // Try RTU-over-TCP mode
  console.log('  Trying Modbus RTU-over-TCP mode...');
  useRTUMode = true;
  try {
    const pdu = await modbusRequest(0x01, testData);
    console.log('  ✓ Modbus RTU-over-TCP mode works');
    return true;
  } catch (e) {
    console.log(`  ✗ RTU mode failed: ${e.message}`);
  }

  console.log('  ✗ Neither mode worked — will keep retrying');
  return false;
}

// ─── Modbus Operations ──────────────────────────────────────────────────────

async function readCoils(startAddr, quantity) {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(startAddr, 0);
  data.writeUInt16BE(quantity, 2);

  const pdu = await modbusRequest(0x01, data);
  // PDU: FC(1) + byteCount(1) + coilData(N)
  const coils = [];
  for (let i = 0; i < quantity; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    coils.push(!!(pdu[2 + byteIndex] & (1 << bitIndex)));
  }
  return coils;
}

async function writeCoil(coilAddr, value) {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(coilAddr, 0);
  data.writeUInt16BE(value ? 0xFF00 : 0x0000, 2);
  await modbusRequest(0x05, data);
}

// ─── Connection State & Heartbeat ───────────────────────────────────────────
let modbusReachable = false;
let modeDetected = false;
let lastCoilState = [false, false, false, false, false, false];
let heartbeatTimer = null;
let commandLock = false;

async function heartbeat() {
  if (commandLock) return;

  // First time: auto-detect protocol mode
  if (!modeDetected) {
    modeDetected = await autoDetectMode();
    if (!modeDetected) return;
  }

  try {
    const coils = await readCoils(0, 6);
    lastCoilState = coils;
    if (!modbusReachable) {
      modbusReachable = true;
      console.log(`✓ Relay board online — ${useRTUMode ? 'RTU' : 'TCP'} mode`);
      console.log(`  Coils: [${coils.map((c, i) => `CH${i + 1}:${c ? 'ON' : 'off'}`).join(', ')}]`);
    }
  } catch (err) {
    if (modbusReachable) {
      modbusReachable = false;
      console.log(`✗ Relay board offline: ${err.message}`);
    }
    // Reset detection so we re-try on next heartbeat
    modeDetected = false;
  }
}

function startHeartbeat() {
  heartbeat();
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
}

// ─── Relay Helpers ──────────────────────────────────────────────────────────

// Track close auto-release timers per barrier so Stop can cancel them
const closeTimers = {};

// Latch a barrier action: turns ON the target relay, turns OFF conflicting relays
async function latchBarrierAction(barrierId, action) {
  if (!modbusReachable) throw new Error('Relay board not connected');
  const barrier = BARRIERS[barrierId];
  if (!barrier) throw new Error('Unknown barrier');

  commandLock = true;
  try {
    if (action === 'lift') {
      // Cancel any pending close timer
      if (closeTimers[barrierId]) { clearTimeout(closeTimers[barrierId]); closeTimers[barrierId] = null; }
      await writeCoil(barrier.close, false); // turn off close first
      await writeCoil(barrier.lift, true);   // latch lift on
    } else if (action === 'close') {
      // Cancel any existing close timer
      if (closeTimers[barrierId]) { clearTimeout(closeTimers[barrierId]); closeTimers[barrierId] = null; }
      await writeCoil(barrier.lift, false);  // turn off lift first
      await writeCoil(barrier.close, true);  // latch close on
      // Auto-release after 4 seconds
      closeTimers[barrierId] = setTimeout(async () => {
        try {
          await writeCoil(barrier.close, false);
          console.log(`  ${barrier.name} close auto-released after 4s`);
        } catch (e) {
          console.log(`  ${barrier.name} close auto-release failed: ${e.message}`);
        }
        closeTimers[barrierId] = null;
      }, 4000);
    } else if (action === 'stop') {
      // Cancel any pending close timer
      if (closeTimers[barrierId]) { clearTimeout(closeTimers[barrierId]); closeTimers[barrierId] = null; }
      await writeCoil(barrier.lift, false);  // turn off lift
      await writeCoil(barrier.close, false); // turn off close
      await writeCoil(barrier.stop, true);   // latch stop on
    }
  } finally {
    commandLock = false;
  }
}

// Pulse a single relay (used by raw channel endpoint)
async function pulseRelay(coilAddress) {
  if (!modbusReachable) throw new Error('Relay board not connected');
  commandLock = true;
  try {
    await writeCoil(coilAddress, true);
    await new Promise(r => setTimeout(r, PULSE_MS));
    await writeCoil(coilAddress, false);
  } finally {
    commandLock = false;
  }
}

async function readAllCoils() {
  const coils = await readCoils(0, 6);
  lastCoilState = coils;
  return coils;
}

// ─── Express App ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', async (req, res) => {
  try {
    let coils = lastCoilState;
    if (modbusReachable && !commandLock) {
      try { coils = await readAllCoils(); } catch (e) { modbusReachable = false; }
    }
    res.json({
      connected: modbusReachable,
      host: MODBUS_HOST,
      port: MODBUS_PORT,
      mode: useRTUMode ? 'RTU-over-TCP' : 'Modbus TCP',
      channels: coils.map((state, i) => ({ channel: i + 1, active: state })),
      barriers: Object.entries(BARRIERS).map(([id, b]) => ({
        id: parseInt(id),
        name: b.name,
        lift: coils[b.lift] || false,
        close: coils[b.close] || false,
        stop: coils[b.stop] || false
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/relay/:channel/pulse', async (req, res) => {
  const channel = parseInt(req.params.channel);
  if (isNaN(channel) || channel < 1 || channel > 6) {
    return res.status(400).json({ error: 'Channel must be 1-6' });
  }
  try {
    await pulseRelay(channel - 1);
    res.json({ success: true, channel, action: 'pulsed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/barrier/:id/:action', async (req, res) => {
  const barrierId = parseInt(req.params.id);
  const action = req.params.action.toLowerCase();

  const barrier = BARRIERS[barrierId];
  if (!barrier) return res.status(400).json({ error: `Unknown barrier: ${barrierId}` });
  if (!['lift', 'close', 'stop'].includes(action)) return res.status(400).json({ error: `Unknown action: ${action}` });

  try {
    await latchBarrierAction(barrierId, action);
    res.json({ success: true, barrier: barrier.name, action, channel: barrier[action] + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Emergency: all relays OFF
app.post('/api/emergency-off', async (req, res) => {
  try {
    if (!modbusReachable) throw new Error('Relay board not connected');
    commandLock = true;
    try {
      for (let i = 0; i < 6; i++) {
        await writeCoil(i, false);
      }
    } finally {
      commandLock = false;
    }
    console.log('⚠ EMERGENCY ALL OFF triggered');
    res.json({ success: true, action: 'emergency-off' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`\n🚧 Barrier Control Server`);
  console.log(`   Web UI:     http://localhost:${SERVER_PORT}`);
  console.log(`   Relay:      ${MODBUS_HOST}:${MODBUS_PORT} (unit ${MODBUS_ID})`);
  console.log(`   Heartbeat:  every ${HEARTBEAT_MS / 1000}s`);
  console.log(`   Pulse:      ${PULSE_MS}ms`);
  console.log(`   Auto-detecting protocol mode...\n`);
  startHeartbeat();
});
