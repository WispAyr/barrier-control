export interface BarrierCoils {
  lift: number;   // coil index for OPEN
  stop: number;   // coil index for STOP
  close: number;  // coil index for CLOSE
}

export interface BarrierConfig {
  id: string;
  numericId: number;
  name: string;
  site: string;
  direction: string;
  relay: { host: string; port: number };
  coils: BarrierCoils;
}

export const BARRIERS: BarrierConfig[] = [
  {
    id: 'krs-entry', numericId: 1, name: 'Entry Barrier', site: 'KRS01', direction: 'entry',
    relay: { host: '10.10.10.64', port: 4196 },
    coils: { lift: 0, stop: 1, close: 2 },
  },
  {
    id: 'krs-exit', numericId: 2, name: 'Exit Barrier', site: 'KRS01', direction: 'exit',
    relay: { host: '10.10.10.64', port: 4196 },
    coils: { lift: 3, stop: 4, close: 5 },
  },
  {
    id: 'krs-combo', numericId: 3, name: 'Entry/Exit Barrier', site: 'KRS01', direction: 'both',
    relay: { host: '10.10.10.65', port: 4196 },
    coils: { lift: 4, stop: 5, close: 3 },
  },
];

export const MODBUS_UNIT_ID = 1;
export const API_PORT = 3100;
