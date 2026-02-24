import ModbusRTU from 'modbus-serial';
import { MODBUS_UNIT_ID } from './config';

interface ConnectionEntry {
  client: ModbusRTU;
  connected: boolean;
  reconnecting: boolean;
}

const connections = new Map<string, ConnectionEntry>();

function key(host: string, port: number): string {
  return `${host}:${port}`;
}

async function getConnection(host: string, port: number): Promise<ModbusRTU> {
  const k = key(host, port);
  let entry = connections.get(k);

  if (entry?.connected) {
    entry.client.setID(MODBUS_UNIT_ID);
    return entry.client;
  }

  if (!entry) {
    entry = { client: new ModbusRTU(), connected: false, reconnecting: false };
    connections.set(k, entry);
  }

  if (entry.reconnecting) {
    throw new Error(`Reconnecting to ${k}`);
  }

  entry.reconnecting = true;
  try {
    // Close existing if any
    try { entry.client.close(() => {}); } catch {}
    entry.client = new ModbusRTU();
    entry.client.setTimeout(3000);
    await entry.client.connectTCP(host, { port });
    entry.client.setID(MODBUS_UNIT_ID);
    entry.connected = true;
    console.log(`[modbus] Connected to ${k}`);

    // Detect disconnection
    const socket = (entry.client as any)._port?._client;
    if (socket) {
      socket.on('close', () => {
        console.log(`[modbus] Disconnected from ${k}`);
        entry!.connected = false;
        scheduleReconnect(host, port);
      });
      socket.on('error', (err: Error) => {
        console.error(`[modbus] Socket error on ${k}:`, err.message);
        entry!.connected = false;
      });
    }

    return entry.client;
  } catch (err: any) {
    entry.connected = false;
    console.error(`[modbus] Failed to connect to ${k}:`, err.message);
    scheduleReconnect(host, port);
    throw err;
  } finally {
    entry.reconnecting = false;
  }
}

function scheduleReconnect(host: string, port: number) {
  const k = key(host, port);
  setTimeout(async () => {
    console.log(`[modbus] Attempting reconnect to ${k}...`);
    try {
      await getConnection(host, port);
    } catch {}
  }, 5000);
}

export async function writeCoil(host: string, port: number, coil: number, value: boolean): Promise<void> {
  const client = await getConnection(host, port);
  await client.writeCoil(coil, value);
  console.log(`[modbus] ${host}:${port} coil ${coil} = ${value ? 'ON' : 'OFF'}`);
}

export async function readCoils(host: string, port: number, start: number, count: number): Promise<boolean[]> {
  const client = await getConnection(host, port);
  const result = await client.readCoils(start, count);
  return Array.from(result.data).slice(0, count);
}

export async function writeMultipleCoils(host: string, port: number, writes: Array<{ coil: number; value: boolean }>): Promise<void> {
  const client = await getConnection(host, port);
  for (const w of writes) {
    await client.writeCoil(w.coil, w.value);
    console.log(`[modbus] ${host}:${port} coil ${w.coil} = ${w.value ? 'ON' : 'OFF'}`);
  }
}
