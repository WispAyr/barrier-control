#!/usr/bin/env node
/**
 * Barrier Control MCP Server
 *
 * Exposes barrier control tools and status resources via the
 * Model Context Protocol (MCP) over stdio transport.
 *
 * Usage:
 *   node mcp-server.js
 *
 * Connects to the barrier control REST API at http://localhost:3000
 * (configurable via BARRIER_API_URL env var).
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const API_URL = process.env.BARRIER_API_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || null;

// ─── HTTP Helper ─────────────────────────────────────────────────────────────
async function apiCall(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json', 'X-Source': 'mcp' };
    if (API_KEY) headers['X-API-Key'] = API_KEY;

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${API_URL}${path}`, opts);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ─── MCP Server Setup ────────────────────────────────────────────────────────
const server = new McpServer({
    name: 'barrier-control',
    version: '1.0.0',
    description: 'Car park barrier control system — lift, close, stop barriers and monitor relay status'
});

// ─── Tools ───────────────────────────────────────────────────────────────────

server.tool(
    'barrier_lift',
    'Lift (open) a car park barrier. The barrier will stay open until stopped or closed.',
    { barrier_id: z.number().int().min(1).max(3).describe('Barrier number (1, 2, or 3)') },
    async ({ barrier_id }) => {
        try {
            const result = await apiCall('POST', `/api/barrier/${barrier_id}/lift`);
            return { content: [{ type: 'text', text: `✓ ${result.barrier} lifted (CH${result.channel})` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `✗ Failed to lift barrier ${barrier_id}: ${err.message}` }], isError: true };
        }
    }
);

server.tool(
    'barrier_close',
    'Close a car park barrier. The close relay auto-releases after 4 seconds.',
    { barrier_id: z.number().int().min(1).max(3).describe('Barrier number (1, 2, or 3)') },
    async ({ barrier_id }) => {
        try {
            const result = await apiCall('POST', `/api/barrier/${barrier_id}/close`);
            return { content: [{ type: 'text', text: `✓ ${result.barrier} closing (CH${result.channel}, auto-release in 4s)` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `✗ Failed to close barrier ${barrier_id}: ${err.message}` }], isError: true };
        }
    }
);

server.tool(
    'barrier_stop',
    'Stop a barrier — cancels any active lift or close operation and releases those relays.',
    { barrier_id: z.number().int().min(1).max(3).describe('Barrier number (1, 2, or 3)') },
    async ({ barrier_id }) => {
        try {
            const result = await apiCall('POST', `/api/barrier/${barrier_id}/stop`);
            return { content: [{ type: 'text', text: `✓ ${result.barrier} stopped (CH${result.channel})` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `✗ Failed to stop barrier ${barrier_id}: ${err.message}` }], isError: true };
        }
    }
);

server.tool(
    'barrier_status',
    'Get the current status of all barriers and relay boards — shows which relays are active and board connectivity.',
    {},
    async () => {
        try {
            const status = await apiCall('GET', '/api/status');
            const lines = [];

            // Boards
            lines.push('## Relay Boards');
            for (const board of status.boards) {
                const icon = board.connected ? '🟢' : '🔴';
                lines.push(`${icon} ${board.name} (${board.host}:${board.port}) — ${board.connected ? board.mode : 'Offline'}`);
                const chs = board.channels.map(ch => `CH${ch.channel}:${ch.active ? 'ON' : 'off'}`).join(' ');
                lines.push(`   Channels: ${chs}`);
            }

            // Barriers
            lines.push('\n## Barriers');
            for (const b of status.barriers) {
                let state = 'Idle';
                if (b.lift) state = '⬆️ Lifting';
                else if (b.close) state = '⬇️ Closing';
                else if (b.stop) state = '⏹ Stopped';
                lines.push(`${b.name}: ${state}`);
            }

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `✗ Failed to get status: ${err.message}` }], isError: true };
        }
    }
);

server.tool(
    'emergency_off',
    'EMERGENCY: Turn off ALL relays on ALL boards immediately. Use this to stop all barrier movement.',
    {},
    async () => {
        try {
            await apiCall('POST', '/api/emergency-off');
            return { content: [{ type: 'text', text: '⚠ EMERGENCY ALL OFF — all relays on all boards turned off' }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `✗ Emergency off failed: ${err.message}` }], isError: true };
        }
    }
);

server.tool(
    'audit_log',
    'View the recent audit log showing all barrier actions, who triggered them, and when.',
    { limit: z.number().int().min(1).max(100).optional().default(20).describe('Number of entries to return (default 20)') },
    async ({ limit }) => {
        try {
            const entries = await apiCall('GET', `/api/audit?limit=${limit}`);
            if (entries.length === 0) {
                return { content: [{ type: 'text', text: 'No audit entries yet.' }] };
            }
            const lines = entries.map(e => {
                const ts = e.timestamp.slice(11, 19);
                return `${ts} [${e.source}] ${e.action} — ${JSON.stringify(e.details)}`;
            });
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `✗ Failed to get audit log: ${err.message}` }], isError: true };
        }
    }
);

// ─── Resources ───────────────────────────────────────────────────────────────

server.resource(
    'status',
    'barrier://status',
    { description: 'Live barrier and relay board status', mimeType: 'application/json' },
    async (uri) => {
        const status = await apiCall('GET', '/api/status');
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(status, null, 2) }] };
    }
);

// ─── Start ───────────────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    console.error('MCP server error:', err);
    process.exit(1);
});
