import ModbusRTU from 'modbus-serial';
import { MODBUS_UNIT_ID } from './config';

const TIMEOUT_MS = 2000;
const connections = new Map<string, ModbusRTU>();
const connectPromises = new Map<string, Promise<ModbusRTU>>();

function key(host: string, port: number): string {
  return `${host}:${port}`;
}

async function getConnection(host: string, port: number): Promise<ModbusRTU> {
  const k = key(host, port);
  const existing = connections.get(k);

  if (existing?.isOpen) {
    existing.setID(MODBUS_UNIT_ID);
    return existing;
  }

  // Clean up stale
  if (existing) {
    try { existing.close(() => {}); } catch {}
    connections.delete(k);
  }

  // If already connecting, wait for the same promise
  const pending = connectPromises.get(k);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const client = new ModbusRTU();
      client.setTimeout(TIMEOUT_MS);
      await client.connectTCP(host, { port });
      client.setID(MODBUS_UNIT_ID);
      connections.set(k, client);
      console.log(`[modbus] Connected to ${k}`);
      return client;
    } catch (err: any) {
      console.error(`[modbus] Connect failed ${k}: ${err.message}`);
      throw err;
    } finally {
      connectPromises.delete(k);
    }
  })();

  connectPromises.set(k, promise);
  return promise;
}

async function withRetry<T>(host: string, port: number, op: (client: ModbusRTU) => Promise<T>): Promise<T> {
  const k = key(host, port);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const client = await getConnection(host, port);
      return await op(client);
    } catch (err: any) {
      // Kill stale connection on any error, retry once
      const existing = connections.get(k);
      if (existing) {
        try { existing.close(() => {}); } catch {}
        connections.delete(k);
      }
      if (attempt === 0) {
        console.log(`[modbus] ${k} failed (${err.message}), reconnecting...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Unreachable`);
}

export async function writeCoil(host: string, port: number, coil: number, value: boolean): Promise<void> {
  await withRetry(host, port, async (client) => {
    await client.writeCoil(coil, value);
    console.log(`[modbus] ${host}:${port} coil ${coil} = ${value ? 'ON' : 'OFF'}`);
  });
}

export async function readCoils(host: string, port: number, start: number, count: number): Promise<boolean[]> {
  return withRetry(host, port, async (client) => {
    const result = await client.readCoils(start, count);
    return Array.from(result.data).slice(0, count);
  });
}

export async function writeMultipleCoils(host: string, port: number, writes: Array<{ coil: number; value: boolean }>): Promise<void> {
  await withRetry(host, port, async (client) => {
    for (const w of writes) {
      await client.writeCoil(w.coil, w.value);
      console.log(`[modbus] ${host}:${port} coil ${w.coil} = ${w.value ? 'ON' : 'OFF'}`);
    }
  });
}
