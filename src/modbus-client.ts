import ModbusRTU from 'modbus-serial';
import { MODBUS_UNIT_ID } from './config';

const TIMEOUT_MS = 3000;
const RECONNECT_DELAY_MS = 200;
const connections = new Map<string, ModbusRTU>();

function key(host: string, port: number): string {
  return `${host}:${port}`;
}

// ── Per-host mutex ──
// Every Modbus operation on the same relay board MUST be serialised.
// Waveshare boards speak Modbus TCP which is single-transaction.
const queues = new Map<string, Promise<any>>();

function withMutex<T>(host: string, port: number, fn: () => Promise<T>): Promise<T> {
  const k = key(host, port);
  const prev = queues.get(k) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run even if previous rejected
  queues.set(k, next.catch(() => {})); // swallow so chain doesn't break
  return next;
}

// ── Connection management ──
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

  const client = new ModbusRTU();
  client.setTimeout(TIMEOUT_MS);
  await client.connectTCP(host, { port });
  client.setID(MODBUS_UNIT_ID);
  connections.set(k, client);
  console.log(`[modbus] Connected to ${k}`);
  return client;
}

function dropConnection(host: string, port: number): void {
  const k = key(host, port);
  const existing = connections.get(k);
  if (existing) {
    try { existing.close(() => {}); } catch {}
    connections.delete(k);
  }
}

// ── Core operation with retry (MUST be called inside withMutex) ──
async function execOp<T>(host: string, port: number, op: (client: ModbusRTU) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const client = await getConnection(host, port);
      return await op(client);
    } catch (err: any) {
      dropConnection(host, port);
      if (attempt === 0) {
        console.log(`[modbus] ${key(host, port)} failed (${err.message}), reconnecting...`);
        await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// ── Public API (all serialised per host) ──

export async function writeCoil(host: string, port: number, coil: number, value: boolean): Promise<void> {
  return withMutex(host, port, async () => {
    await execOp(host, port, async (client) => {
      await client.writeCoil(coil, value);
    });
    console.log(`[modbus] ${host}:${port} coil ${coil} = ${value ? 'ON' : 'OFF'}`);
  });
}

export async function readCoils(host: string, port: number, start: number, count: number): Promise<boolean[]> {
  return withMutex(host, port, () =>
    execOp(host, port, async (client) => {
      const result = await client.readCoils(start, count);
      return Array.from(result.data).slice(0, count);
    })
  );
}

export async function writeMultipleCoils(host: string, port: number, writes: Array<{ coil: number; value: boolean }>): Promise<void> {
  return withMutex(host, port, () =>
    execOp(host, port, async (client) => {
      for (const w of writes) {
        await client.writeCoil(w.coil, w.value);
        console.log(`[modbus] ${host}:${port} coil ${w.coil} = ${w.value ? 'ON' : 'OFF'}`);
      }
    })
  );
}

// Atomic barrier operation: clear coils then set target, all in one mutex lock.
// This prevents interleaving with other barriers on the same board.
export async function atomicBarrierWrite(
  host: string, port: number,
  clearCoils: number[],
  setCoil: number,
  setValue: boolean,
): Promise<void> {
  return withMutex(host, port, () =>
    execOp(host, port, async (client) => {
      for (const c of clearCoils) {
        await client.writeCoil(c, false);
      }
      await client.writeCoil(setCoil, setValue);
      console.log(`[modbus] ${host}:${port} atomic: cleared [${clearCoils}], set coil ${setCoil} = ${setValue ? 'ON' : 'OFF'}`);
    })
  );
}

// Atomic all-off for a set of coils (emergency, unlatch)
export async function atomicAllOff(host: string, port: number, coils: number[]): Promise<void> {
  return withMutex(host, port, () =>
    execOp(host, port, async (client) => {
      for (const c of coils) {
        await client.writeCoil(c, false);
      }
      console.log(`[modbus] ${host}:${port} all-off: [${coils}]`);
    })
  );
}
