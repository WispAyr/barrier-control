# Barrier Control

Priority service for controlling car park barriers via Waveshare Modbus relay boards. Provides a REST API for barrier operations (lift/stop/close) and a real-time status dashboard.

**⚠️ This is critical infrastructure — barriers depend on this service to open.**

## Architecture

```
SentryFlow (automation brain)
    │
    ▼  HTTP REST
Barrier Control (:3100)  ←── this service
    │
    ▼  Modbus TCP
Waveshare Relay Boards (.64, .65)
    │
    ▼  Dry contacts
Physical Boom Barriers
```

## Barriers

| ID | Name | Relay Board | Coils (lift/stop/close) | Direction |
|----|------|-------------|------------------------|-----------|
| krs-entry | Entry Barrier | 10.10.10.64:4196 | 0 / 1 / 2 | entry |
| krs-exit | Exit Barrier | 10.10.10.64:4196 | 3 / 4 / 5 | exit |
| krs-combo | Entry/Exit Barrier | 10.10.10.65:4196 | 4 / 5 / 3 | both |

> **Note:** krs-combo uses channels 4-6, NOT 0-2. Confirmed by physical testing 2026-02-24.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Status dashboard (HTML) |
| GET | `/api/health` | Health check |
| GET | `/api/status` | All barriers with coil states |
| GET | `/api/log` | Activity log (query: `?limit=&type=&barrier=`) |
| GET | `/api/barrier/:id/relay-status` | Single barrier coil states |
| POST | `/api/barrier/:id/lift` | Open barrier |
| POST | `/api/barrier/:id/stop` | Stop barrier |
| POST | `/api/barrier/:id/close` | Close barrier |
| POST | `/api/barrier/:id/lock` | Lock barrier (prevents lift/close) |
| POST | `/api/barrier/:id/unlock` | Unlock barrier |
| POST | `/api/emergency-off` | Kill ALL coils on ALL relay boards |

Barrier ID accepts both string (`krs-entry`) and numeric (`1`) identifiers.

## Dashboard

Self-contained HTML dashboard at `/` with:
- **Service health** — barrier-control, SentryFlow, both relay boards (with latency)
- **Barrier cards** — live coil states, lock status, last action, heartbeat history (last 30 polls)
- **Activity log** — filterable by barrier, type, free-text search. 1000 entries in-memory ring buffer.

Auto-refreshes every 3 seconds.

## Deployment

Runs on **Skynet Delta** (10.10.10.238) as a PM2 service.

```bash
# Build
npm install
npx tsc

# Run
pm2 start ecosystem.config.js
```

### PM2 Config (ecosystem.config.js)
- Fast restart: 1s delay with exponential backoff
- Memory cap: 200MB (restart if exceeded)
- Max 50 restarts before giving up

### Network Access
- Direct: `http://10.10.10.238:3100`
- Proxy: `https://barriers.skynet` (via Caddy on PU2)
- DNS: `barriers.skynet` → 192.168.195.33 (dnsmasq on PU2)

## Development

```bash
npm install
npx tsc --watch   # in one terminal
node dist/index.js # in another
```

## Dependencies

- `express` — HTTP server
- `modbus-serial` — Modbus TCP client for Waveshare relay boards
