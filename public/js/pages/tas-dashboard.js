/**
 * TAS Dashboard - Time-Aware Shaper (IEEE 802.1Qbv)
 */

let api, ws, state;
let currentPort = '2';
let refreshTimer = null;
let captureActive = false;
let testRunning = false;
let statsHandler = null;
let stoppedHandler = null;
let syncHandler = null;
let testStartTime = 0;

// Data
let txHistory = [];
let rxHistory = [];
let txPackets = [];
let rxPackets = [];
let lastRxCounts = {};  // Track last known count per TC for delta calculation
let rxTcStats = {};     // Per-TC statistics from capture
let txTcStats = {};     // TX statistics (mirror of what's being sent)

// TC Colors
const TC_HEX = [
  '#94a3b8', '#64748b', '#475569', '#334155',
  '#1e3a5f', '#1e40af', '#3730a3', '#4c1d95'
];

// GCL - 8 slots, TC0 always open + each TC gets its slot (125ms each = 1s cycle)
let gclEntries = [];
for (let i = 0; i < 8; i++) {
  // TC0 (bit 0) always open + current TC
  gclEntries.push({ gates: 0x01 | (1 << i), interval: 125 });
}
let cycleTimeMs = 1000;

// Select all TCs by default for traffic test
let selectedTCs = [0, 1, 2, 3, 4, 5, 6, 7];

export function render(appState) {
  state = appState;
  const enabled = state?.tas?.enabled ?? false;

  return `
    <!-- Status Bar -->
    <div class="tas-status-bar">
      <div class="status-item">
        <span class="status-label">PORT</span>
        <span class="status-value">${currentPort}</span>
      </div>
      <div class="status-item">
        <span class="status-label">TAS</span>
        <span class="status-value ${enabled ? 'active' : ''}">${enabled ? 'ON' : 'OFF'}</span>
      </div>
      <div class="status-item">
        <span class="status-label">CYCLE</span>
        <span class="status-value">${cycleTimeMs}ms</span>
      </div>
      <div class="status-item">
        <span class="status-label">ENTRIES</span>
        <span class="status-value" id="entry-count">${gclEntries.length}</span>
      </div>
      <div class="status-item">
        <span class="status-label">OPER</span>
        <span class="status-value" id="oper-count">--</span>
      </div>
      <button class="btn btn-sm ${enabled ? 'btn-danger' : 'btn-success'}" id="toggle-tas">${enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn btn-sm" id="reset-tas">Reset</button>
    </div>

    <!-- Traffic Test (moved up) -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Traffic Test</span>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge ${testRunning ? 'badge-success' : ''}" id="test-badge">${testRunning ? 'Running' : 'Ready'}</span>
          <button class="btn btn-sm btn-success" id="start-btn" ${testRunning ? 'disabled' : ''}>Start</button>
          <button class="btn btn-sm btn-danger" id="stop-btn" ${!testRunning ? 'disabled' : ''}>Stop</button>
        </div>
      </div>
      <div class="test-config">
        <div class="tc-selector">
          ${[0,1,2,3,4,5,6,7].map(tc => `
            <button class="tc-btn ${selectedTCs.includes(tc) ? 'selected' : ''}" data-tc="${tc}"
              style="--tc-color:${TC_HEX[tc]}" ${testRunning ? 'disabled' : ''}>TC${tc}</button>
          `).join('')}
        </div>
        <div class="test-inputs">
          <div class="input-group">
            <label>TX</label>
            <select id="tx-iface" class="input input-sm"></select>
          </div>
          <div class="input-group">
            <label>RX</label>
            <select id="rx-iface" class="input input-sm"></select>
          </div>
          <div class="input-group">
            <label>PPS</label>
            <input type="number" id="pps" value="200" class="input input-sm" style="width:70px">
          </div>
          <div class="input-group">
            <label>Duration</label>
            <input type="number" id="duration" value="8" class="input input-sm" style="width:60px">
          </div>
        </div>
      </div>
    </div>

    <!-- Raster Graphs (smaller) -->
    <div class="grid-2">
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem">TX Packets</span>
          <span class="mono text-xs text-muted" id="tx-count">0</span>
        </div>
        <canvas id="tx-canvas" height="180"></canvas>
      </div>
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem">RX Packets (Shaped)</span>
          <span class="mono text-xs text-muted" id="rx-count">0</span>
        </div>
        <canvas id="rx-canvas" height="180"></canvas>
      </div>
    </div>

    <!-- GCL Configuration -->
    <div class="grid-2">
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem">GCL Configuration</span>
          <button class="btn btn-sm btn-primary" id="apply-gcl">Apply</button>
        </div>
        <div class="gcl-editor">
          <div class="gcl-header-row">
            <span class="gcl-slot-label"></span>
            ${[0,1,2,3,4,5,6,7].map(tc => `<span class="gcl-tc-label" style="color:${TC_HEX[tc]}">T${tc}</span>`).join('')}
            <span class="gcl-interval-label">ms</span>
          </div>
          <div id="gcl-rows">
            ${gclEntries.map((e, i) => renderGCLRow(i, e)).join('')}
          </div>
          <div class="gcl-footer">
            <button class="btn btn-sm" id="add-row" ${gclEntries.length >= 8 ? 'disabled' : ''}>+ Add</button>
            <span class="text-xs text-muted">Cycle: <input type="number" id="cycle-input" value="${cycleTimeMs}" class="input input-xs" style="width:60px">ms</span>
          </div>
        </div>
      </div>
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem">RX Analysis</span>
          <span class="badge" id="analysis-badge">--</span>
        </div>
        <div id="rx-analysis">
          <div class="analysis-empty">Run traffic test to analyze</div>
        </div>
      </div>
    </div>

    <!-- TX / RX Statistics -->
    <div class="grid-2">
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem;color:#3b82f6">TX (Sent)</span>
          <span class="text-xs text-muted" id="tx-pkt-count">0</span>
        </div>
        <div class="packet-table-container" style="max-height:200px">
          <table class="packet-table">
            <thead>
              <tr>
                <th>TC</th>
                <th>Sent</th>
                <th>Rate</th>
              </tr>
            </thead>
            <tbody id="tx-pkt-body"></tbody>
          </table>
        </div>
      </div>
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem;color:#10b981">RX (Received)</span>
          <span class="text-xs text-muted" id="rx-pkt-count">0</span>
        </div>
        <div class="packet-table-container" style="max-height:200px">
          <table class="packet-table">
            <thead>
              <tr>
                <th>TC</th>
                <th>Recv</th>
                <th>Avg</th>
                <th>Jitter</th>
              </tr>
            </thead>
            <tbody id="rx-pkt-body"></tbody>
          </table>
        </div>
      </div>
    </div>
    <div style="text-align:right;margin-bottom:16px">
      <button class="btn btn-sm" id="clear-pkts">Clear All</button>
    </div>

    <style>
      .tas-status-bar {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 12px 16px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 8px;
        margin-bottom: 16px;
      }
      .status-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .status-label {
        font-size: 0.6rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .status-value {
        font-size: 0.85rem;
        font-weight: 600;
        font-family: ui-monospace, monospace;
      }
      .status-value.active { color: var(--success); }

      .card-compact { padding: 12px; margin-bottom: 16px; }
      .card-compact .card-header { margin-bottom: 8px; }

      .test-config {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .tc-selector {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .tc-btn {
        padding: 4px 10px;
        border: 2px solid var(--border);
        border-radius: 4px;
        background: var(--card);
        font-size: 0.7rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
        color: var(--text-muted);
      }
      .tc-btn:hover { border-color: var(--tc-color); }
      .tc-btn.selected {
        border-color: var(--tc-color);
        background: var(--tc-color);
        color: #fff;
      }
      .tc-btn:disabled { opacity: 0.5; cursor: not-allowed; }

      .test-inputs {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: flex-end;
      }
      .input-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .input-group label {
        font-size: 0.65rem;
        color: var(--text-muted);
        text-transform: uppercase;
      }
      .input-sm { padding: 6px 10px; font-size: 0.8rem; }
      .input-xs { padding: 4px 8px; font-size: 0.75rem; }

      canvas {
        width: 100%;
        background: var(--bg);
        border-radius: 4px;
      }

      .gcl-editor {
        font-size: 0.75rem;
      }
      .gcl-header-row, .gcl-row {
        display: grid;
        grid-template-columns: 30px repeat(8, 1fr) 50px 24px;
        gap: 3px;
        align-items: center;
        padding: 4px 0;
      }
      .gcl-header-row {
        border-bottom: 1px solid var(--border);
        padding-bottom: 6px;
        margin-bottom: 4px;
      }
      .gcl-slot-label, .gcl-tc-label, .gcl-interval-label {
        text-align: center;
        font-size: 0.6rem;
        font-weight: 600;
      }
      .gcl-row-num {
        font-size: 0.65rem;
        color: var(--text-muted);
        text-align: center;
      }
      .gcl-gate {
        width: 100%;
        height: 20px;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--bg);
        cursor: pointer;
        transition: all 0.1s;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .gcl-gate.open {
        border-color: transparent;
      }
      .gcl-interval {
        width: 100%;
        padding: 2px 4px;
        border: 1px solid var(--border);
        border-radius: 2px;
        text-align: center;
        font-size: 0.7rem;
      }
      .gcl-del {
        background: none;
        border: none;
        color: var(--text-light);
        cursor: pointer;
        font-size: 0.9rem;
        padding: 0;
      }
      .gcl-del:hover { color: var(--error); }
      .gcl-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--border);
      }

      .analysis-empty {
        padding: 30px;
        text-align: center;
        color: var(--text-light);
        font-size: 0.8rem;
      }
      .analysis-grid {
        display: grid;
        grid-template-columns: 30px repeat(8, 1fr);
        gap: 2px;
        font-size: 0.65rem;
      }
      .analysis-cell {
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 2px;
        font-weight: 600;
      }
      .analysis-cell.has-data { color: #fff; }
      .analysis-cell.empty { background: var(--bg); color: var(--text-light); }
      .analysis-legend {
        margin-top: 8px;
        font-size: 0.6rem;
        color: var(--text-muted);
      }

      .packet-table-container {
        max-height: 280px;
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: 4px;
      }
      .packet-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.7rem;
        font-family: ui-monospace, monospace;
      }
      .packet-table th {
        position: sticky;
        top: 0;
        background: var(--bg-dark);
        color: #fff;
        padding: 6px 8px;
        text-align: left;
        font-weight: 500;
        font-size: 0.65rem;
      }
      .packet-table td {
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .packet-table tbody tr:hover {
        background: var(--bg);
      }
      .packet-table .tc-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 2px;
        color: #fff;
        font-size: 0.65rem;
        font-weight: 600;
      }
      .interval-ok { color: var(--success); }
      .interval-warn { color: var(--warning); }
    </style>
  `;
}

function renderGCLRow(idx, entry) {
  // Ensure TC0 is always open
  entry.gates |= 0x01;

  return `
    <div class="gcl-row" data-idx="${idx}">
      <span class="gcl-row-num">${idx}</span>
      ${[0,1,2,3,4,5,6,7].map(tc => {
        const open = (entry.gates >> tc) & 1;
        return `<div class="gcl-gate ${open ? 'open' : ''}" data-tc="${tc}"
          style="background:${open ? TC_HEX[tc] : ''}"></div>`;
      }).join('')}
      <input type="number" class="gcl-interval" value="${entry.interval}" min="1" max="1000">
      <button class="gcl-del" data-idx="${idx}">&times;</button>
    </div>
  `;
}

function renderAnalysis() {
  if (rxHistory.length === 0) {
    return '<div class="analysis-empty">Run traffic test to analyze</div>';
  }

  // Calculate packets per slot per TC
  const slotData = Array(8).fill(null).map(() => Array(8).fill(0));
  const slotDuration = cycleTimeMs / 8;

  rxHistory.forEach(entry => {
    const slot = Math.floor((entry.time % cycleTimeMs) / slotDuration) % 8;
    for (let tc = 0; tc < 8; tc++) {
      if (entry.tc[tc]) slotData[slot][tc] += entry.tc[tc];
    }
  });

  let maxCount = 1;
  slotData.forEach(row => row.forEach(v => { if (v > maxCount) maxCount = v; }));

  let html = '<div class="analysis-grid">';
  html += '<div></div>';
  for (let tc = 0; tc < 8; tc++) {
    html += `<div style="text-align:center;font-weight:600;color:${TC_HEX[tc]}">T${tc}</div>`;
  }

  for (let slot = 0; slot < 8; slot++) {
    html += `<div style="color:var(--text-muted)">S${slot}</div>`;
    for (let tc = 0; tc < 8; tc++) {
      const count = slotData[slot][tc];
      if (count > 0) {
        const intensity = 0.5 + (count / maxCount) * 0.5;
        const expected = gclEntries[slot] && ((gclEntries[slot].gates >> tc) & 1);
        const color = expected ? '#059669' : '#d97706';
        html += `<div class="analysis-cell has-data" style="background:${color};opacity:${intensity}">${count}</div>`;
      } else {
        html += `<div class="analysis-cell empty">-</div>`;
      }
    }
  }
  html += '</div>';
  html += '<div class="analysis-legend"><span style="color:#059669">&#9632;</span> Expected &nbsp; <span style="color:#d97706">&#9632;</span> Unexpected</div>';
  return html;
}

export async function init(appState, deps) {
  state = appState;
  api = deps.api;
  ws = deps.ws;

  setupEvents();
  await loadInterfaces();
  await loadStatus();

  if (ws && ws.on) {
    // Remove old handlers first
    if (statsHandler) ws.off('c-capture-stats', statsHandler);
    if (stoppedHandler) ws.off('c-capture-stopped', stoppedHandler);
    if (syncHandler) ws.off('sync', syncHandler);

    // Create and register new handlers
    statsHandler = handleStats;
    stoppedHandler = () => {
      // Ignore if event comes within 2 seconds of test start (stale event from previous capture)
      if (Date.now() - testStartTime < 2000) {
        return;
      }
      if (testRunning) stopTest();
    };
    syncHandler = (data) => {
      // When a new client connects, check if capture is running
      if (data && data.cCapture && data.cCapture.running) {
        captureActive = true;
        testRunning = true;
        updateUI();
      }
    };

    ws.on('c-capture-stats', statsHandler);
    ws.on('c-capture-stopped', stoppedHandler);
    ws.on('sync', syncHandler);
  }

  // Check if a capture is already running (for late-joining clients)
  try {
    const status = await api.capture.status();
    if (status && status.running) {
      captureActive = true;
      testRunning = true;
      testStartTime = Date.now() - 5000; // Assume started 5s ago
      updateUI();
    }
  } catch (e) {}

  refreshTimer = setInterval(loadStatus, 5000);
  drawGraphs();
  updatePacketTables();
}

export function cleanup() {
  if (refreshTimer) clearInterval(refreshTimer);
  testRunning = false;
  captureActive = false;

  // Remove WebSocket handlers
  if (ws && ws.off) {
    if (statsHandler) ws.off('c-capture-stats', statsHandler);
    if (stoppedHandler) ws.off('c-capture-stopped', stoppedHandler);
    if (syncHandler) ws.off('sync', syncHandler);
  }
  statsHandler = null;
  stoppedHandler = null;
  syncHandler = null;
}

function setupEvents() {
  // Toggle TAS
  document.getElementById('toggle-tas')?.addEventListener('click', async () => {
    const enabled = state?.tas?.enabled ?? false;
    try {
      await api.tas.enable(currentPort, !enabled);
      await loadStatus();
    } catch (e) { alert('Error: ' + e.message); }
  });

  // Reset TAS - disable and clear GCL
  document.getElementById('reset-tas')?.addEventListener('click', async () => {
    if (!confirm('Reset TAS configuration?')) return;
    try {
      await api.tas.enable(currentPort, false);
      // Reset GCL to default
      gclEntries = [];
      for (let i = 0; i < 8; i++) {
        gclEntries.push({ gates: 0x01 | (1 << i), interval: 125 });
      }
      cycleTimeMs = 1000;
      renderGCLEditor();
      await loadStatus();
    } catch (e) { alert('Error: ' + e.message); }
  });

  // TC selection
  document.querySelector('.tc-selector')?.addEventListener('click', e => {
    if (e.target.classList.contains('tc-btn') && !testRunning) {
      const tc = parseInt(e.target.dataset.tc);
      const idx = selectedTCs.indexOf(tc);
      if (idx > -1) selectedTCs.splice(idx, 1);
      else selectedTCs.push(tc);
      selectedTCs.sort((a, b) => a - b);
      e.target.classList.toggle('selected');
    }
  });

  // Test buttons
  document.getElementById('start-btn')?.addEventListener('click', startTest);
  document.getElementById('stop-btn')?.addEventListener('click', stopTest);

  // GCL editor
  document.getElementById('gcl-rows')?.addEventListener('click', e => {
    // Gate toggle
    if (e.target.classList.contains('gcl-gate')) {
      const row = e.target.closest('.gcl-row');
      const idx = parseInt(row.dataset.idx);
      const tc = parseInt(e.target.dataset.tc);

      // TC0 is always open for stability - cannot toggle off
      if (tc === 0) {
        return; // TC0 locked
      }

      gclEntries[idx].gates ^= (1 << tc);
      // Ensure TC0 always stays open
      gclEntries[idx].gates |= 0x01;

      const open = (gclEntries[idx].gates >> tc) & 1;
      e.target.classList.toggle('open', open);
      e.target.style.background = open ? TC_HEX[tc] : '';
    }
    // Delete row
    if (e.target.classList.contains('gcl-del')) {
      const idx = parseInt(e.target.dataset.idx);
      if (gclEntries.length > 1) {
        gclEntries.splice(idx, 1);
        renderGCLEditor();
      }
    }
  });

  document.getElementById('gcl-rows')?.addEventListener('change', e => {
    if (e.target.classList.contains('gcl-interval')) {
      const row = e.target.closest('.gcl-row');
      const idx = parseInt(row.dataset.idx);
      gclEntries[idx].interval = Math.max(1, parseInt(e.target.value) || 50);
    }
  });

  document.getElementById('add-row')?.addEventListener('click', () => {
    if (gclEntries.length < 8) {
      // New entry with TC0 always open
      gclEntries.push({ gates: 0x01, interval: 50 });
      renderGCLEditor();
    }
  });

  document.getElementById('cycle-input')?.addEventListener('change', e => {
    cycleTimeMs = Math.max(100, Math.min(10000, parseInt(e.target.value) || 400));
  });

  document.getElementById('apply-gcl')?.addEventListener('click', applyGCL);
  document.getElementById('clear-pkts')?.addEventListener('click', () => {
    txPackets = [];
    rxPackets = [];
    txHistory = [];
    rxHistory = [];
    lastRxCounts = {};
    rxTcStats = {};
    txTcStats = {};
    updatePacketTables();
    document.getElementById('rx-analysis').innerHTML = renderAnalysis();
    drawGraphs();
  });
}

function renderGCLEditor() {
  document.getElementById('gcl-rows').innerHTML = gclEntries.map((e, i) => renderGCLRow(i, e)).join('');
  document.getElementById('add-row').disabled = gclEntries.length >= 8;
  document.getElementById('entry-count').textContent = gclEntries.length;
}

async function loadInterfaces() {
  try {
    const list = await api.traffic.getInterfaces();
    const usb = list.filter(i => i.name.startsWith('enx'));
    const opts = (usb.length >= 2 ? usb : list.filter(i => i.name.startsWith('en')))
      .map(i => `<option value="${i.name}">${i.name}</option>`).join('');

    const tx = document.getElementById('tx-iface');
    const rx = document.getElementById('rx-iface');
    if (tx) tx.innerHTML = opts;
    if (rx) rx.innerHTML = opts;

    if (usb.length >= 2) {
      if (tx) tx.value = usb[0].name;
      if (rx) rx.value = usb[1].name;
    }
  } catch (e) {}
}

async function loadStatus() {
  try {
    const data = await api.tas.getStatus(currentPort);
    const cfg = data.config?.['ieee802-dot1q-sched-bridge:gate-parameter-table'] || {};

    state.tas = state.tas || {};
    state.tas.enabled = cfg['gate-enabled'] || false;

    // Update UI
    const statusVal = document.querySelector('.status-value:nth-child(2)');
    if (statusVal) {
      statusVal.textContent = state.tas.enabled ? 'ON' : 'OFF';
      statusVal.classList.toggle('active', state.tas.enabled);
    }

    const toggleBtn = document.getElementById('toggle-tas');
    if (toggleBtn) {
      toggleBtn.textContent = state.tas.enabled ? 'Disable' : 'Enable';
      toggleBtn.className = `btn btn-sm ${state.tas.enabled ? 'btn-danger' : 'btn-success'}`;
    }

    const operCount = cfg['oper-control-list']?.['gate-control-entry']?.length || 0;
    const operEl = document.getElementById('oper-count');
    if (operEl) operEl.textContent = operCount;

  } catch (e) {}
}

async function applyGCL() {
  const btn = document.getElementById('apply-gcl');
  btn.disabled = true;
  btn.textContent = 'Applying...';

  try {
    // Ensure TC0 is always open in all entries for stability
    gclEntries.forEach(e => { e.gates |= 0x01; });

    const totalNs = gclEntries.reduce((s, e) => s + e.interval * 1000000, 0);
    const status = await api.tas.getStatus(currentPort);
    const cfg = status.config?.['ieee802-dot1q-sched-bridge:gate-parameter-table'] || {};
    const baseTime = (cfg['current-time']?.seconds || Math.floor(Date.now() / 1000)) + 10;

    await api.tas.configure(currentPort, {
      gateEnabled: true,
      baseTime: { seconds: baseTime, nanoseconds: 0 },
      cycleTime: { numerator: totalNs, denominator: 1000000000 },
      entries: gclEntries.map(e => ({ gateStates: e.gates | 0x01, interval: e.interval * 1000000 }))
    });

    setTimeout(loadStatus, 12000);
    alert(`Applied ${gclEntries.length} entries, ${cycleTimeMs}ms cycle. Activating in ~10s.`);
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
}

async function startTest() {
  const txIface = document.getElementById('tx-iface')?.value;
  const rxIface = document.getElementById('rx-iface')?.value;
  const pps = parseInt(document.getElementById('pps')?.value) || 200;
  const duration = parseInt(document.getElementById('duration')?.value) || 8;

  if (!txIface || !rxIface) return alert('Select interfaces');
  if (selectedTCs.length === 0) return alert('Select at least one TC');

  let dstMac;
  try {
    const r = await api.system.getMac(rxIface);
    dstMac = r.mac;
  } catch { return alert('Could not get MAC'); }

  txPackets = [];
  rxPackets = [];
  txHistory = [];
  rxHistory = [];
  lastRxCounts = {};
  rxTcStats = {};
  txTcStats = {};
  testRunning = true;
  captureActive = true;
  testStartTime = Date.now();
  updateUI();
  updatePacketTables();

  // Start TX tracking timer (tracks what's being sent)
  // C sender sends pps packets/sec total across all TCs
  let elapsed = 0;
  const interval = 200;  // Update every 200ms
  const totalPps = pps * selectedTCs.length;  // Total PPS (matches API call)
  const ppsPerTC = pps;  // Each TC gets 'pps' packets per second
  const pktsPerIntervalPerTC = ppsPerTC * (interval / 1000);

  const txTimer = setInterval(() => {
    if (!testRunning || elapsed > duration * 1000) {
      clearInterval(txTimer);
      return;
    }
    elapsed += interval;
    const entry = { time: elapsed, tc: {} };

    selectedTCs.forEach(tc => {
      const count = Math.floor(pktsPerIntervalPerTC);
      entry.tc[tc] = count;
      // Update TX stats
      if (!txTcStats[tc]) {
        txTcStats[tc] = { count: 0, pps: ppsPerTC };
      }
      txTcStats[tc].count += count;
    });

    txHistory.push(entry);
    if (txHistory.length > 200) txHistory.shift();
    updatePacketTables();
    drawGraphs();
  }, interval);

  // Start capture and traffic (errors won't stop TX simulation)
  try {
    try { await api.capture.stop(); await api.traffic.stop(); } catch {}
    await new Promise(r => setTimeout(r, 200));

    await api.capture.start(rxIface, { duration: duration + 3, vlanId: 100 });
    await api.traffic.start(txIface, {
      dstMac,
      vlanId: 100,
      tcList: selectedTCs,
      packetsPerSecond: pps * selectedTCs.length,
      duration
    });
  } catch (e) {
    console.error('[TAS] API error:', e.message);
  }
}

async function stopTest() {
  testRunning = false;
  captureActive = false;
  try { await api.capture.stop(); await api.traffic.stop(); } catch {}
  updateUI();
  document.getElementById('rx-analysis').innerHTML = renderAnalysis();
}

function updateUI() {
  document.getElementById('start-btn').disabled = testRunning;
  document.getElementById('stop-btn').disabled = !testRunning;
  const badge = document.getElementById('test-badge');
  badge.textContent = testRunning ? 'Running' : 'Ready';
  badge.className = `badge ${testRunning ? 'badge-success' : ''}`;
}

function handleStats(data) {
  if (!captureActive) {
    return;
  }

  const elapsedMs = data.elapsed_ms || 0;
  const entry = { time: elapsedMs, tc: {} };

  if (data.tc) {
    for (const [tc, s] of Object.entries(data.tc)) {
      const tcNum = parseInt(tc);
      const count = s.count || 0;

      // Calculate delta (new packets since last update)
      const lastCount = lastRxCounts[tcNum] || 0;
      const delta = Math.max(0, count - lastCount);
      lastRxCounts[tcNum] = count;

      // Record for graph (use delta for this interval)
      entry.tc[tcNum] = delta;

      // Save full TC stats for display
      rxTcStats[tcNum] = {
        count: count,
        avgMs: s.avg_ms ? s.avg_ms : (s.avg_us ? s.avg_us / 1000 : 0),
        minMs: s.min_ms ? s.min_ms : (s.min_us ? s.min_us / 1000 : 0),
        maxMs: s.max_ms ? s.max_ms : (s.max_us ? s.max_us / 1000 : 0),
        kbps: s.kbps || 0
      };
    }
  }

  rxHistory.push(entry);
  if (rxHistory.length > 200) rxHistory.shift();

  // Update counts
  const txTotal = txHistory.reduce((s, d) => s + Object.values(d.tc).reduce((a, b) => a + b, 0), 0);
  document.getElementById('tx-count').textContent = txTotal;
  document.getElementById('rx-count').textContent = data.total || 0;

  updatePacketTables();
  drawGraphs();
  document.getElementById('rx-analysis').innerHTML = renderAnalysis();
}

function updatePacketTables() {
  // TX table - show per-TC statistics
  const txBody = document.getElementById('tx-pkt-body');
  const txPktCount = document.getElementById('tx-pkt-count');
  const totalTx = Object.values(txTcStats).reduce((s, tc) => s + tc.count, 0);
  if (txPktCount) txPktCount.textContent = totalTx;

  if (txBody) {
    const tcKeys = Object.keys(txTcStats).map(Number).sort((a, b) => a - b);
    if (tcKeys.length === 0) {
      txBody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:16px;color:var(--text-muted)">No TX data</td></tr>';
    } else {
      txBody.innerHTML = tcKeys.map(tc => {
        const s = txTcStats[tc];
        return `
        <tr>
          <td><span class="tc-badge" style="background:${TC_HEX[tc]}">TC${tc}</span></td>
          <td class="mono">${s.count}</td>
          <td class="mono">${s.pps.toFixed(0)} pps</td>
        </tr>
      `}).join('');
    }
  }

  // RX table - show per-TC statistics with comparison to TX
  const rxBody = document.getElementById('rx-pkt-body');
  const rxPktCount = document.getElementById('rx-pkt-count');
  const totalRx = Object.values(rxTcStats).reduce((s, tc) => s + tc.count, 0);
  const totalTxForLoss = Object.values(txTcStats).reduce((s, tc) => s + tc.count, 0);
  const lossPercent = totalTxForLoss > 0 ? ((totalTxForLoss - totalRx) / totalTxForLoss * 100) : 0;
  if (rxPktCount) {
    rxPktCount.textContent = `${totalRx}`;
    if (totalTxForLoss > 0 && lossPercent > 1) {
      rxPktCount.textContent += ` (${lossPercent.toFixed(1)}% loss)`;
    }
  }

  if (rxBody) {
    const tcKeys = Object.keys(rxTcStats).map(Number).sort((a, b) => a - b);
    if (tcKeys.length === 0) {
      rxBody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text-muted)">No RX packets</td></tr>';
    } else {
      rxBody.innerHTML = tcKeys.map(tc => {
        const s = rxTcStats[tc];
        const jitter = s.maxMs - s.minMs;
        return `
        <tr>
          <td><span class="tc-badge" style="background:${TC_HEX[tc]}">TC${tc}</span></td>
          <td class="mono">${s.count}</td>
          <td class="mono ${s.avgMs < 20 ? 'interval-ok' : ''}">${s.avgMs.toFixed(1)}</td>
          <td class="mono ${jitter < 1 ? 'interval-ok' : 'interval-warn'}">${jitter.toFixed(2)}</td>
        </tr>
      `}).join('');
    }
  }
}

function drawGraphs() {
  drawGraph('tx-canvas', txHistory, false, false);
  drawGraph('rx-canvas', rxHistory, true, true);  // Show GCL slots on RX
}

function drawGraph(canvasId, data, isRx, showGclSlots = false) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width = canvas.offsetWidth * dpr;
  const h = canvas.height = 180 * dpr;
  ctx.scale(dpr, dpr);

  const displayW = canvas.offsetWidth;
  const displayH = 180;
  const pad = { top: 8, right: 8, bottom: 20, left: 32 };
  const chartW = displayW - pad.left - pad.right;
  const chartH = displayH - pad.top - pad.bottom;
  const rowH = chartH / 8;

  ctx.clearRect(0, 0, displayW, displayH);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, displayW, displayH);

  const maxTime = 8000;

  // Draw GCL cycle boundaries if enabled
  if (showGclSlots && cycleTimeMs > 0) {
    for (let t = 0; t <= maxTime; t += cycleTimeMs) {
      const x = pad.left + (t / maxTime) * chartW;
      ctx.strokeStyle = '#3b82f680';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, displayH - pad.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // TC rows
  for (let tc = 0; tc < 8; tc++) {
    const y = pad.top + tc * rowH;
    ctx.fillStyle = selectedTCs.includes(tc) ? TC_HEX[tc] + '08' : '#fff';
    ctx.fillRect(pad.left, y, chartW, rowH);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(pad.left, y, chartW, rowH);

    ctx.fillStyle = selectedTCs.includes(tc) ? TC_HEX[tc] : '#94a3b8';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(tc, pad.left - 4, y + rowH / 2 + 3);
  }

  // X axis
  for (let t = 0; t <= maxTime; t += 2000) {
    const x = pad.left + (t / maxTime) * chartW;
    ctx.strokeStyle = '#e2e8f0';
    ctx.setLineDash([1, 2]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, displayH - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#64748b';
    ctx.font = '7px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((t / 1000) + 's', x, displayH - 4);
  }

  // Packets
  data.forEach(d => {
    const x = pad.left + (d.time / maxTime) * chartW;
    [0,1,2,3,4,5,6,7].forEach(tc => {
      const count = d.tc[tc] || 0;
      if (count === 0) return;
      const y = pad.top + tc * rowH;
      ctx.beginPath();
      ctx.moveTo(x, y + 1);
      ctx.lineTo(x, y + rowH - 1);
      ctx.strokeStyle = TC_HEX[tc];
      ctx.lineWidth = Math.min(1.5 + count * 0.03, 3);
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  });

  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, chartW, chartH);
}
