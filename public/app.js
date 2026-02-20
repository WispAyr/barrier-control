// ─── Barrier Control Frontend ────────────────────────────────────────────────
const API_BASE = '';
const POLL_INTERVAL = 2000;
let polling = null;
let actionInProgress = {};

// ─── DOM References ──────────────────────────────────────────────────────────
const connectionBadge = document.getElementById('connectionBadge');
const connectionText = connectionBadge.querySelector('.connection-text');
const channelsGrid = document.getElementById('channelsGrid');
const logEntries = document.getElementById('logEntries');

// ─── Logging ─────────────────────────────────────────────────────────────────
function addLog(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    const now = new Date();
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="log-time">${time}</span>${message}`;
    logEntries.prepend(entry);

    // Keep max 50 entries
    while (logEntries.children.length > 50) {
        logEntries.removeChild(logEntries.lastChild);
    }
}

// ─── Status Polling ──────────────────────────────────────────────────────────
async function fetchStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        updateUI(data);
    } catch (err) {
        updateConnectionState(false);
    }
}

function updateUI(data) {
    updateConnectionState(data.connected);
    updateChannels(data.channels);
    updateBarrierIndicators(data.barriers);
}

function updateConnectionState(connected) {
    connectionBadge.className = `connection-badge ${connected ? 'connected' : 'disconnected'}`;
    connectionText.textContent = connected ? 'Connected' : 'Disconnected';
}

function updateChannels(channels) {
    if (!channels) return;

    // Build channel chips if not yet created
    if (channelsGrid.children.length === 0) {
        channels.forEach(ch => {
            const chip = document.createElement('div');
            chip.className = 'channel-chip';
            chip.id = `channel-chip-${ch.channel}`;
            chip.innerHTML = `<span class="chip-dot"></span>CH${ch.channel}`;
            channelsGrid.appendChild(chip);
        });
    }

    // Update states
    channels.forEach(ch => {
        const chip = document.getElementById(`channel-chip-${ch.channel}`);
        if (chip) {
            chip.classList.toggle('active', ch.active);
        }
    });
}

function updateBarrierIndicators(barriers) {
    if (!barriers) return;

    barriers.forEach(b => {
        const card = document.querySelector(`.barrier-card[data-barrier="${b.id}"]`);
        if (!card) return;

        // Update channel indicators
        const actionMap = { lift: 0, close: 1, stop: 2 };
        const indicators = card.querySelectorAll('.indicator');
        const states = [b.lift, b.close, b.stop];

        indicators.forEach((ind, i) => {
            ind.classList.toggle('active', states[i]);
        });

        // Update barrier status text
        const statusEl = document.getElementById(`barrier${b.id}Status`);
        if (statusEl) {
            if (b.lift) {
                statusEl.textContent = 'Lifting';
                statusEl.className = 'barrier-status active';
            } else if (b.close) {
                statusEl.textContent = 'Closing';
                statusEl.className = 'barrier-status active';
            } else if (b.stop) {
                statusEl.textContent = 'Stopped';
                statusEl.className = 'barrier-status active';
            } else {
                statusEl.textContent = 'Idle';
                statusEl.className = 'barrier-status';
            }
        }
    });
}

// ─── Barrier Actions ─────────────────────────────────────────────────────────
async function barrierAction(barrierId, action) {
    const key = `${barrierId}-${action}`;
    if (actionInProgress[key]) return;

    const btn = document.getElementById(`btn-${barrierId}-${action}`);
    if (!btn) return;

    // Disable all buttons for this barrier during action
    const card = document.querySelector(`.barrier-card[data-barrier="${barrierId}"]`);
    const buttons = card.querySelectorAll('.btn');
    buttons.forEach(b => b.disabled = true);

    actionInProgress[key] = true;
    btn.classList.add('pulsing');

    addLog(`Barrier ${barrierId} → <strong>${action.toUpperCase()}</strong>`, 'info');

    try {
        const res = await fetch(`${API_BASE}/api/barrier/${barrierId}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await res.json();

        if (res.ok && data.success) {
            addLog(`✓ Barrier ${barrierId} ${action} — CH${data.channel} latched`, 'success');
        } else {
            addLog(`✗ Barrier ${barrierId} ${action} failed: ${data.error}`, 'error');
        }
    } catch (err) {
        addLog(`✗ Barrier ${barrierId} ${action} error: ${err.message}`, 'error');
    } finally {
        actionInProgress[key] = false;
        btn.classList.remove('pulsing');
        buttons.forEach(b => b.disabled = false);

        // Immediate status refresh
        fetchStatus();
    }
}

// ─── Init ────────────────────────────────────────────────────────────────────
function init() {
    addLog('Connecting to relay board…', 'info');
    fetchStatus();
    polling = setInterval(fetchStatus, POLL_INTERVAL);
}

// ─── Emergency All Off ───────────────────────────────────────────────────────
async function emergencyOff() {
    const btn = document.getElementById('btn-emergency');
    if (btn.disabled) return;

    // Disable everything
    const allButtons = document.querySelectorAll('.btn, .btn-emergency');
    allButtons.forEach(b => b.disabled = true);

    addLog('⚠ <strong>EMERGENCY ALL OFF</strong>', 'error');

    try {
        const res = await fetch(`${API_BASE}/api/emergency-off`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();

        if (res.ok && data.success) {
            addLog('✓ All relays OFF', 'success');
        } else {
            addLog(`✗ Emergency off failed: ${data.error}`, 'error');
        }
    } catch (err) {
        addLog(`✗ Emergency off error: ${err.message}`, 'error');
    } finally {
        allButtons.forEach(b => b.disabled = false);
        fetchStatus();
    }
}

// Make functions available globally
window.barrierAction = barrierAction;
window.emergencyOff = emergencyOff;

init();
