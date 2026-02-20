// ─── Barrier Control Frontend ────────────────────────────────────────────────
const API_BASE = '';
const POLL_INTERVAL = 2000;
let polling = null;
let actionInProgress = {};
let eventSource = null;
let lastStatus = null;

// ─── DOM References ──────────────────────────────────────────────────────────
const boardBadges = document.getElementById('boardBadges');
const barriersGrid = document.getElementById('barriersGrid');
const boardsOverview = document.getElementById('boardsOverview');
const logEntries = document.getElementById('logEntries');

// ─── Logging ─────────────────────────────────────────────────────────────────
function addLog(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="log-time">${time}</span>${message}`;
    logEntries.prepend(entry);
    while (logEntries.children.length > 50) logEntries.removeChild(logEntries.lastChild);
}

// ─── SSE — Real-Time Events ─────────────────────────────────────────────────
function connectSSE() {
    eventSource = new EventSource(`${API_BASE}/api/events`);
    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'connected') return;
            // Audit event from server
            if (data.action) {
                const src = data.source === 'ui' ? '' : ` [${data.source}]`;
                const detail = data.details?.barrier || data.action;
                addLog(`${src} <strong>${data.action}</strong> — ${detail}`, 'success');
                // Refresh status immediately
                fetchStatus();
            }
        } catch (e) { /* ignore */ }
    };
    eventSource.onerror = () => {
        eventSource.close();
        setTimeout(connectSSE, 3000);
    };
}

// ─── Status Polling ──────────────────────────────────────────────────────────
async function fetchStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        lastStatus = data;
        updateUI(data);
    } catch (err) {
        // Server unreachable
        if (lastStatus) {
            lastStatus.boards?.forEach(b => b.connected = false);
            updateUI(lastStatus);
        }
    }
}

function updateUI(data) {
    updateBoardBadges(data.boards);
    updateBarrierCards(data.barriers, data.boards);
    updateBoardsOverview(data.boards);
}

// ─── Board Connection Badges ─────────────────────────────────────────────────
function updateBoardBadges(boards) {
    if (!boards) return;
    boardBadges.innerHTML = boards.map(b => `
    <div class="connection-badge ${b.connected ? 'connected' : 'disconnected'}">
      <span class="connection-dot"></span>
      <span class="connection-text">${b.name.replace(/Board \d+ \(/, '').replace(')', '')}</span>
    </div>
  `).join('');
}

// ─── Dynamic Barrier Cards ───────────────────────────────────────────────────
function updateBarrierCards(barriers, boards) {
    if (!barriers) return;

    // Build cards if not yet created
    if (barriersGrid.children.length === 0) {
        barriers.forEach(b => {
            const card = document.createElement('section');
            card.className = 'barrier-card';
            card.dataset.barrier = b.id;
            card.innerHTML = `
        <div class="barrier-header">
          <div class="barrier-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="4" height="18" rx="1"/>
              <path d="M7 12h14"/>
              <path d="M17 8l4 4-4 4"/>
            </svg>
          </div>
          <div>
            <h2>${b.name}</h2>
            <span class="barrier-status" id="barrier${b.id}Status">Idle</span>
          </div>
        </div>
        <div class="channel-indicators" id="barrier${b.id}Channels">
          <div class="indicator" data-action="lift"><span class="ind-dot"></span>Lift</div>
          <div class="indicator" data-action="close"><span class="ind-dot"></span>Close</div>
          <div class="indicator" data-action="stop"><span class="ind-dot"></span>Stop</div>
        </div>
        <div class="barrier-controls">
          <button class="btn btn-lift" onclick="barrierAction(${b.id}, 'lift')" id="btn-${b.id}-lift">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            Lift
          </button>
          <button class="btn btn-stop" onclick="barrierAction(${b.id}, 'stop')" id="btn-${b.id}-stop">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            Stop
          </button>
          <button class="btn btn-close" onclick="barrierAction(${b.id}, 'close')" id="btn-${b.id}-close">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5V19M5 12l7 7 7-7"/></svg>
            Close
          </button>
        </div>
      `;
            barriersGrid.appendChild(card);
        });
    }

    // Update state indicators
    barriers.forEach(b => {
        const statusEl = document.getElementById(`barrier${b.id}Status`);
        if (statusEl) {
            if (b.lift) { statusEl.textContent = 'Lifting'; statusEl.className = 'barrier-status active'; }
            else if (b.close) { statusEl.textContent = 'Closing'; statusEl.className = 'barrier-status active'; }
            else if (b.stop) { statusEl.textContent = 'Stopped'; statusEl.className = 'barrier-status active'; }
            else { statusEl.textContent = 'Idle'; statusEl.className = 'barrier-status'; }
        }

        const indicators = document.querySelectorAll(`.barrier-card[data-barrier="${b.id}"] .indicator`);
        const states = [b.lift, b.close, b.stop];
        indicators.forEach((ind, i) => ind.classList.toggle('active', states[i]));
    });
}

// ─── Boards Overview ─────────────────────────────────────────────────────────
function updateBoardsOverview(boards) {
    if (!boards) return;
    boardsOverview.innerHTML = boards.map(b => `
    <div class="board-section">
      <div class="board-label">
        <span class="board-status-dot ${b.connected ? 'online' : 'offline'}"></span>
        ${b.name} — ${b.host}:${b.port}
        <span class="board-mode">${b.connected ? b.mode : 'Offline'}</span>
      </div>
      <div class="channels-grid">
        ${b.channels.map(ch => `
          <div class="channel-chip ${ch.active ? 'active' : ''}">
            <span class="chip-dot"></span>CH${ch.channel}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

// ─── Barrier Actions ─────────────────────────────────────────────────────────
async function barrierAction(barrierId, action) {
    const key = `${barrierId}-${action}`;
    if (actionInProgress[key]) return;

    const btn = document.getElementById(`btn-${barrierId}-${action}`);
    if (!btn) return;

    const card = document.querySelector(`.barrier-card[data-barrier="${barrierId}"]`);
    const buttons = card.querySelectorAll('.btn');
    buttons.forEach(b => b.disabled = true);

    actionInProgress[key] = true;
    btn.classList.add('pulsing');
    addLog(`Barrier ${barrierId} → <strong>${action.toUpperCase()}</strong>`, 'info');

    try {
        const res = await fetch(`${API_BASE}/api/barrier/${barrierId}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Source': 'ui' }
        });
        const data = await res.json();
        if (res.ok && data.success) {
            addLog(`✓ ${data.barrier} ${action} — CH${data.channel}`, 'success');
        } else {
            addLog(`✗ Barrier ${barrierId} ${action} failed: ${data.error}`, 'error');
        }
    } catch (err) {
        addLog(`✗ Barrier ${barrierId} ${action} error: ${err.message}`, 'error');
    } finally {
        actionInProgress[key] = false;
        btn.classList.remove('pulsing');
        buttons.forEach(b => b.disabled = false);
        fetchStatus();
    }
}

// ─── Emergency All Off ───────────────────────────────────────────────────────
async function emergencyOff() {
    const btn = document.getElementById('btn-emergency');
    if (btn.disabled) return;

    const allButtons = document.querySelectorAll('.btn, .btn-emergency');
    allButtons.forEach(b => b.disabled = true);
    addLog('⚠ <strong>EMERGENCY ALL OFF</strong>', 'error');

    try {
        const res = await fetch(`${API_BASE}/api/emergency-off`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Source': 'ui' }
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

// ─── Init ────────────────────────────────────────────────────────────────────
function init() {
    addLog('Connecting to relay boards…', 'info');
    fetchStatus();
    connectSSE();
    polling = setInterval(fetchStatus, POLL_INTERVAL);
}

window.barrierAction = barrierAction;
window.emergencyOff = emergencyOff;

init();
