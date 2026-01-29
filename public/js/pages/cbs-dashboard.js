/**
 * CBS Dashboard - Credit-Based Shaper (IEEE 802.1Qav)
 *
 * Features:
 * - Traffic test with per-TC capture
 * - Real-time TX/RX visualization
 * - CBS configuration (idleSlope per TC)
 * - Idle slope estimation from captured traffic
 */

let api, ws, state;
let currentPort = '2';
let refreshTimer = null;
let captureActive = false;
let testRunning = false;
let estimating = false;
let statsHandler = null;
let stoppedHandler = null;
let syncHandler = null;
let testStartTime = 0;

// Data
let txHistory = [];
let rxHistory = [];
let lastRxCounts = {};
let rxTcStats = {};
let txTcStats = {};

// Link speed (must be defined first)
let linkSpeedMbps = 100;

// Estimation results
let estimationResults = null;


// CBS Configuration per TC - 기본값: TC별로 다른 대역폭 할당
// TC0-1: 낮음 (5%), TC2-3: 중간 (10%), TC4-5: 높음 (15%), TC6-7: 최고 (20%)
const DEFAULT_BW_PERCENT = [5, 5, 10, 10, 15, 15, 20, 20];
let cbsConfig = {};
for (let i = 0; i < 8; i++) {
  const bwPercent = DEFAULT_BW_PERCENT[i];
  cbsConfig[i] = {
    enabled: false,
    idleSlope: (bwPercent / 100) * linkSpeedMbps * 1000000,  // bps
    bandwidthPercent: bwPercent,
    estimated: false
  };
}

// TC Colors
const TC_HEX = [
  '#94a3b8', '#64748b', '#475569', '#334155',
  '#1e3a5f', '#1e40af', '#3730a3', '#4c1d95'
];

// Select all TCs by default for traffic test
let selectedTCs = [0, 1, 2, 3, 4, 5, 6, 7];

export function render(appState) {
  state = appState;

  return `
    <!-- Status Bar -->
    <div class="cbs-status-bar">
      <div class="status-item">
        <span class="status-label">PORT</span>
        <span class="status-value">${currentPort}</span>
      </div>
      <div class="status-item">
        <span class="status-label">CBS</span>
        <span class="status-value" id="cbs-status">--</span>
      </div>
      <div class="status-item">
        <span class="status-label">LINK</span>
        <span class="status-value">${linkSpeedMbps} Mbps</span>
      </div>
      <div class="status-item">
        <span class="status-label">ACTIVE TCs</span>
        <span class="status-value" id="active-tc-count">--</span>
      </div>
      <button class="btn btn-sm" id="refresh-cbs">Refresh</button>
      <button class="btn btn-sm" id="reset-cbs">Reset</button>
    </div>

    <!-- Traffic Test -->
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
            <label>PPS (Total)</label>
            <input type="number" id="pps" value="4000" class="input input-sm" style="width:80px">
          </div>
          <div class="input-group">
            <label>Duration</label>
            <input type="number" id="duration" value="10" class="input input-sm" style="width:60px">
          </div>
        </div>
      </div>
    </div>

    <!-- 3 Graphs: Idle Slope Comparison / TX / RX -->
    <div class="grid-3-graphs">
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem">Idle Slope (Config vs Measured)</span>
          <span class="mono text-xs text-muted">BW%</span>
        </div>
        <canvas id="slope-canvas" height="140"></canvas>
      </div>
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem">TX Packets</span>
          <span class="mono text-xs text-muted" id="tx-count">0</span>
        </div>
        <canvas id="tx-canvas" height="140"></canvas>
      </div>
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem">RX Packets</span>
          <span class="mono text-xs text-muted" id="rx-count">0</span>
        </div>
        <canvas id="rx-canvas" height="140"></canvas>
      </div>
    </div>

    <!-- CBS Configuration & Estimation -->
    <div class="grid-2">
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem">CBS Configuration</span>
          <button class="btn btn-sm btn-primary" id="apply-cbs">Apply</button>
        </div>
        <div class="cbs-config-table">
          <div class="cbs-header-row">
            <span>TC</span>
            <span>IdleSlope(kbps)</span>
            <span>Cfg%</span>
            <span>Meas%</span>
            <span>En</span>
          </div>
          <div id="cbs-config-rows">
            ${[0,1,2,3,4,5,6,7].map(tc => renderCBSRow(tc)).join('')}
          </div>
        </div>
      </div>
      <div class="card card-compact">
        <div class="card-header">
          <span class="card-title" style="font-size:0.8rem">Idle Slope Estimator</span>
          <div style="display:flex;gap:4px;align-items:center">
            <span class="badge" id="estimate-badge" style="font-size:0.6rem">Auto</span>
            <button class="btn btn-sm ${estimating ? '' : 'btn-primary'}" id="run-estimate" ${estimating ? 'disabled' : ''}>
              ${estimating ? 'Estimating...' : 'Manual'}
            </button>
          </div>
        </div>
        <div class="estimate-info">
          <span class="text-xs text-muted">테스트 완료 후 자동으로 아이들 슬로프 예측 및 적용</span>
        </div>
        <div id="estimate-results">
          ${renderEstimationResults()}
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
                <th>BW%</th>
                <th>IdleSlope</th>
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
                <th>kbps</th>
                <th>Shaped</th>
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
      .cbs-status-bar {
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

      .grid-3-graphs {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 12px;
        margin-bottom: 16px;
      }

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

      canvas {
        width: 100%;
        background: var(--bg);
        border-radius: 4px;
      }

      .cbs-config-table {
        font-size: 0.75rem;
      }
      .cbs-header-row, .cbs-config-row {
        display: grid;
        grid-template-columns: 32px 1fr 40px 45px 26px;
        gap: 4px;
        align-items: center;
        padding: 4px 0;
      }
      .cbs-header-row {
        border-bottom: 1px solid var(--border);
        font-weight: 600;
        color: var(--text-muted);
        font-size: 0.65rem;
      }
      .cbs-config-row input[type="number"] {
        width: 100%;
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 3px;
        font-size: 0.75rem;
        text-align: right;
      }
      .cbs-config-row input[type="checkbox"] {
        width: 16px;
        height: 16px;
      }
      .cbs-config-row .bw-percent,
      .cbs-config-row .measured-percent {
        font-family: ui-monospace, monospace;
        font-size: 0.65rem;
        text-align: center;
      }
      .cbs-config-row .bw-percent { color: var(--text-muted); }
      .cbs-config-row .measured-percent { font-weight: 500; }
      .cbs-config-row .tc-label {
        font-weight: 600;
      }
      .cbs-config-row.estimated input[type="number"] {
        background: #fef3c7;
        border-color: #f59e0b;
      }

      .estimate-info {
        padding: 4px 8px;
        background: #eff6ff;
        border-radius: 4px;
        margin-bottom: 8px;
      }
      #estimate-results {
        padding: 8px;
        min-height: 100px;
      }
      .estimate-empty {
        padding: 30px;
        text-align: center;
        color: var(--text-light);
        font-size: 0.8rem;
      }
      .estimate-grid-full {
        display: grid;
        grid-template-columns: 36px 60px 70px 50px 45px 50px;
        gap: 2px;
        font-size: 0.65rem;
      }
      .estimate-grid-full .header {
        font-weight: 600;
        color: var(--text-muted);
        padding: 4px 2px;
        border-bottom: 1px solid var(--border);
        text-align: center;
      }
      .estimate-grid-full .cell {
        padding: 3px 2px;
        font-family: ui-monospace, monospace;
        text-align: center;
      }
      .estimate-grid-full .shaped-yes { color: var(--success); font-weight: 600; }
      .estimate-grid-full .shaped-no { color: var(--text-muted); }
      .estimate-summary {
        display: flex;
        justify-content: space-between;
        margin-top: 8px;
        padding: 6px 8px;
        background: var(--bg);
        border-radius: 4px;
        font-size: 0.7rem;
      }

      .packet-table-container {
        max-height: 200px;
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
      }
      .packet-table .tc-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 2px;
        color: #fff;
        font-size: 0.65rem;
        font-weight: 600;
      }
    </style>
  `;
}

function renderCBSRow(tc) {
  const cfg = cbsConfig[tc];
  const idleSlopeKbps = cfg.idleSlope / 1000;
  const bwPercent = cfg.bandwidthPercent || 0;
  const measuredPercent = cfg.measuredPercent || 0;

  return `
    <div class="cbs-config-row ${cfg.estimated ? 'estimated' : ''}" data-tc="${tc}">
      <span class="tc-label" style="color:${TC_HEX[tc]}">TC${tc}</span>
      <input type="number" class="idle-slope-input" value="${idleSlopeKbps.toFixed(0)}" min="0" max="${linkSpeedMbps * 1000}" step="100">
      <span class="bw-percent">${bwPercent.toFixed(0)}%</span>
      <span class="measured-percent" style="color:${measuredPercent > 0 ? '#10b981' : '#cbd5e1'}">${measuredPercent > 0 ? measuredPercent.toFixed(1) + '%' : '-'}</span>
      <input type="checkbox" class="cbs-enable" ${cfg.enabled ? 'checked' : ''}>
    </div>
  `;
}

function renderEstimationResults() {
  if (!estimationResults || !estimationResults.tc) {
    return '<div class="estimate-empty">테스트 시작하면 자동 예측됩니다</div>';
  }

  const tcs = Object.keys(estimationResults.tc).map(Number).sort((a, b) => a - b);
  if (tcs.length === 0) {
    return '<div class="estimate-empty">캡처된 트래픽 없음</div>';
  }

  let html = '<div class="estimate-grid-full">';
  html += `
    <div class="header">TC</div>
    <div class="header">Measured</div>
    <div class="header">IdleSlope</div>
    <div class="header">BW%</div>
    <div class="header">Bursts</div>
    <div class="header">Shaped</div>
  `;

  for (const tc of tcs) {
    const data = estimationResults.tc[tc];
    const shaped = data.is_shaped;
    const bwPercent = data.bandwidth_percent || 0;
    html += `
      <div class="cell" style="color:${TC_HEX[tc]};font-weight:600">TC${tc}</div>
      <div class="cell">${data.measured_kbps.toFixed(0)}</div>
      <div class="cell">${(data.estimated_idle_slope_bps / 1000).toFixed(0)}</div>
      <div class="cell">${bwPercent.toFixed(1)}%</div>
      <div class="cell">${data.bursts || '-'}</div>
      <div class="cell ${shaped ? 'shaped-yes' : 'shaped-no'}">${shaped ? 'YES' : 'NO'}</div>
    `;
  }

  html += '</div>';

  // Summary
  const totalBw = tcs.reduce((sum, tc) => sum + (estimationResults.tc[tc].bandwidth_percent || 0), 0);
  html += `<div class="estimate-summary">
    <span>Total BW: <strong>${totalBw.toFixed(1)}%</strong></span>
    <span>TCs: <strong>${tcs.length}</strong></span>
  </div>`;

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
      if (Date.now() - testStartTime < 2000) return;
      if (testRunning) stopTest();
    };
    syncHandler = (data) => {
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

  // Check if a capture is already running
  try {
    const status = await api.capture.status();
    if (status && status.running) {
      captureActive = true;
      testRunning = true;
      testStartTime = Date.now() - 5000;
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
  estimating = false;

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
  // Refresh CBS status
  document.getElementById('refresh-cbs')?.addEventListener('click', loadStatus);

  // Reset CBS
  document.getElementById('reset-cbs')?.addEventListener('click', async () => {
    if (!confirm('Reset all CBS configuration?')) return;
    for (let i = 0; i < 8; i++) {
      cbsConfig[i] = { enabled: false, idleSlope: 0, bandwidthPercent: 0, estimated: false };
    }
    document.getElementById('cbs-config-rows').innerHTML =
      [0,1,2,3,4,5,6,7].map(tc => renderCBSRow(tc)).join('');
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

  // CBS config inputs
  document.getElementById('cbs-config-rows')?.addEventListener('input', e => {
    if (e.target.classList.contains('idle-slope-input')) {
      const row = e.target.closest('.cbs-config-row');
      const tc = parseInt(row.dataset.tc);
      const kbps = parseFloat(e.target.value) || 0;
      cbsConfig[tc].idleSlope = kbps * 1000;
      cbsConfig[tc].bandwidthPercent = (cbsConfig[tc].idleSlope / (linkSpeedMbps * 1000000)) * 100;
      cbsConfig[tc].estimated = false;
      row.classList.remove('estimated');
      row.querySelector('.bw-percent').textContent = cbsConfig[tc].bandwidthPercent.toFixed(1) + '%';
    }
  });

  document.getElementById('cbs-config-rows')?.addEventListener('change', e => {
    if (e.target.classList.contains('cbs-enable')) {
      const row = e.target.closest('.cbs-config-row');
      const tc = parseInt(row.dataset.tc);
      cbsConfig[tc].enabled = e.target.checked;
    }
  });

  // Apply CBS
  document.getElementById('apply-cbs')?.addEventListener('click', applyCBS);

  // Run estimation
  document.getElementById('run-estimate')?.addEventListener('click', runEstimate);

  // Apply estimate results
  document.getElementById('estimate-results')?.addEventListener('click', e => {
    if (e.target.id === 'apply-estimate') {
      applyEstimateToConfig();
    }
  });

  // Clear packets
  document.getElementById('clear-pkts')?.addEventListener('click', () => {
    txHistory = [];
    rxHistory = [];
    lastRxCounts = {};
    rxTcStats = {};
    txTcStats = {};
    updatePacketTables();
    drawGraphs();
  });
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
    const data = await api.cbs.getStatus(currentPort);
    // Update status display
    const statusEl = document.getElementById('cbs-status');
    if (statusEl) {
      statusEl.textContent = data.config ? 'Active' : '--';
    }
  } catch (e) {
    const statusEl = document.getElementById('cbs-status');
    if (statusEl) statusEl.textContent = '--';
  }

  // Update active TC count
  const activeTcs = Object.values(cbsConfig).filter(c => c.enabled).length;
  const tcCountEl = document.getElementById('active-tc-count');
  if (tcCountEl) tcCountEl.textContent = activeTcs;
}

async function applyCBS() {
  const btn = document.getElementById('apply-cbs');
  btn.disabled = true;
  btn.textContent = 'Applying...';

  try {
    const enabledTcs = Object.entries(cbsConfig)
      .filter(([tc, cfg]) => cfg.enabled && cfg.idleSlope > 0)
      .map(([tc, cfg]) => ({ tc: parseInt(tc), ...cfg }));

    if (enabledTcs.length === 0) {
      alert('No TCs enabled with idle slope configured');
      return;
    }

    for (const tcCfg of enabledTcs) {
      await api.cbs.configure(currentPort, {
        tc: tcCfg.tc,
        idleSlope: tcCfg.idleSlope,
        linkSpeed: linkSpeedMbps
      });
    }

    alert(`Applied CBS config for ${enabledTcs.length} TCs`);
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
}

async function runEstimate() {
  // Use current RX stats to estimate
  if (Object.keys(rxTcStats).length === 0) {
    alert('Run traffic test first');
    return;
  }

  const btn = document.getElementById('run-estimate');
  btn.disabled = true;
  estimating = true;
  btn.textContent = 'Analyzing...';

  try {
    // Use captured RX stats
    estimationResults = { tc: {} };

    for (const [tc, stats] of Object.entries(rxTcStats)) {
      const tcNum = parseInt(tc);
      const measuredKbps = stats.kbps || 0;
      const measuredBps = measuredKbps * 1000;
      const bwPercent = (measuredBps / (linkSpeedMbps * 1000000)) * 100;

      estimationResults.tc[tcNum] = {
        packets: stats.count,
        measured_kbps: measuredKbps,
        estimated_idle_slope_bps: measuredBps,
        bandwidth_percent: bwPercent,
        bursts: '-',
        is_shaped: bwPercent < (cbsConfig[tcNum]?.bandwidthPercent || 100) * 1.1
      };

      // Update config with measured values
      cbsConfig[tcNum] = {
        ...cbsConfig[tcNum],
        measuredSlope: measuredBps,
        measuredPercent: bwPercent,
        estimated: true
      };
    }

    document.getElementById('estimate-results').innerHTML = renderEstimationResults();
    document.getElementById('cbs-config-rows').innerHTML =
      [0,1,2,3,4,5,6,7].map(tc => renderCBSRow(tc)).join('');
    drawGraphs();

  } catch (e) {
    alert('Estimation error: ' + e.message);
  } finally {
    btn.disabled = false;
    estimating = false;
    btn.textContent = 'Manual';
  }
}

function applyEstimateToConfig() {
  if (!estimationResults || !estimationResults.tc) return;

  for (const [tc, data] of Object.entries(estimationResults.tc)) {
    const tcNum = parseInt(tc);
    cbsConfig[tcNum] = {
      enabled: true,
      idleSlope: data.estimated_idle_slope_bps,
      bandwidthPercent: data.bandwidth_percent,
      estimated: true
    };
  }

  // Re-render config rows
  document.getElementById('cbs-config-rows').innerHTML =
    [0,1,2,3,4,5,6,7].map(tc => renderCBSRow(tc)).join('');

  loadStatus();
}

async function startTest() {
  const txIface = document.getElementById('tx-iface')?.value;
  const rxIface = document.getElementById('rx-iface')?.value;
  const pps = parseInt(document.getElementById('pps')?.value) || 2000;  // Higher default PPS
  const duration = parseInt(document.getElementById('duration')?.value) || 10;

  if (!txIface || !rxIface) return alert('Select interfaces');
  if (selectedTCs.length === 0) return alert('Select at least one TC');

  let dstMac;
  try {
    const r = await api.system.getMac(rxIface);
    dstMac = r.mac;
  } catch { return alert('Could not get MAC'); }

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

  // CBS 테스트용 설정
  // 프레임 크기 1000바이트 = 8000비트
  // 1000 pps/TC → 8 Mbps/TC
  // 2000 pps/TC → 16 Mbps/TC
  const frameSize = 1000;  // bytes
  const bitsPerFrame = frameSize * 8;
  const ppsPerTC = Math.floor(pps / selectedTCs.length);
  const expectedMbpsPerTC = (ppsPerTC * bitsPerFrame) / 1000000;

  // CBS 한도를 보낸 트래픽의 50-80%로 설정 (shaping 효과 확인용)
  // TC별로 다른 한도 설정
  const cbsLimitRatios = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8];

  selectedTCs.forEach(tc => {
    const limitRatio = cbsLimitRatios[tc];
    const targetMbps = expectedMbpsPerTC * limitRatio;
    const idleSlope = targetMbps * 1000000;  // bps
    const bwPercent = (idleSlope / (linkSpeedMbps * 1000000)) * 100;

    cbsConfig[tc] = {
      enabled: true,
      idleSlope: idleSlope,
      bandwidthPercent: bwPercent,
      expectedTxMbps: expectedMbpsPerTC,
      estimated: false
    };
  });

  console.log(`[CBS Test] PPS=${pps}, PPS/TC=${ppsPerTC}, Expected TX=${expectedMbpsPerTC.toFixed(1)} Mbps/TC`);
  console.log(`[CBS Test] Frame size=${frameSize}B, Selected TCs:`, selectedTCs);

  // Update config UI
  document.getElementById('cbs-config-rows').innerHTML =
    [0,1,2,3,4,5,6,7].map(tc => renderCBSRow(tc)).join('');
  loadStatus();

  // Start TX tracking timer
  let elapsed = 0;
  const interval = 200;
  const pktsPerIntervalPerTC = ppsPerTC * (interval / 1000);

  const txTimer = setInterval(() => {
    if (!testRunning || elapsed > duration * 1000) {
      clearInterval(txTimer);
      return;
    }
    elapsed += interval;
    const txEntry = { time: elapsed, tc: {} };

    selectedTCs.forEach(tc => {
      const cfg = cbsConfig[tc];
      const packetsToSend = Math.floor(pktsPerIntervalPerTC);

      txEntry.tc[tc] = packetsToSend;

      if (!txTcStats[tc]) {
        const txMbps = (ppsPerTC * bitsPerFrame) / 1000000;
        txTcStats[tc] = { count: 0, pps: ppsPerTC, bwPercent: cfg.bandwidthPercent, txMbps };
      }
      txTcStats[tc].count += packetsToSend;
    });

    txHistory.push(txEntry);
    if (txHistory.length > 200) txHistory.shift();

    updatePacketTables();
    drawGraphs();
  }, interval);

  try {
    try { await api.capture.stop(); await api.traffic.stop(); } catch {}
    await new Promise(r => setTimeout(r, 200));

    await api.capture.start(rxIface, { duration: duration + 3, vlanId: 100 });
    await api.traffic.start(txIface, {
      dstMac,
      vlanId: 100,
      tcList: selectedTCs,
      packetsPerSecond: pps,  // Total PPS (divided among TCs by C sender)
      duration,
      frameSize
    });

    // Schedule automatic estimation after traffic completes
    setTimeout(async () => {
      await runAutoEstimate(rxIface, duration);
    }, (duration + 1) * 1000);

  } catch (e) {
    console.error('[CBS] API error:', e.message);
  }
}

// Auto-run estimation after traffic test using capture stats
async function runAutoEstimate(rxIface, duration) {
  if (!testRunning && !captureActive) return;

  const btn = document.getElementById('run-estimate');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
  }
  estimating = true;

  try {
    // Use captured RX stats to estimate idle slope (no sudo needed)
    estimationResults = { tc: {} };

    for (const [tc, stats] of Object.entries(rxTcStats)) {
      const tcNum = parseInt(tc);
      const measuredKbps = stats.kbps || 0;
      const measuredBps = measuredKbps * 1000;
      const bwPercent = (measuredBps / (linkSpeedMbps * 1000000)) * 100;

      estimationResults.tc[tcNum] = {
        packets: stats.count,
        measured_kbps: measuredKbps,
        estimated_idle_slope_bps: measuredBps,
        bandwidth_percent: bwPercent,
        bursts: '-',
        is_shaped: bwPercent < (cbsConfig[tcNum]?.bandwidthPercent || 100) * 1.1
      };
    }

    // Update estimation results display
    document.getElementById('estimate-results').innerHTML = renderEstimationResults();

    // Auto-apply estimation to CBS config
    if (Object.keys(estimationResults.tc).length > 0) {
      for (const [tc, data] of Object.entries(estimationResults.tc)) {
        const tcNum = parseInt(tc);
        cbsConfig[tcNum] = {
          ...cbsConfig[tcNum],
          measuredSlope: data.estimated_idle_slope_bps,
          measuredPercent: data.bandwidth_percent,
          estimated: true
        };
      }

      // Re-render config rows with estimated values
      document.getElementById('cbs-config-rows').innerHTML =
        [0,1,2,3,4,5,6,7].map(tc => renderCBSRow(tc)).join('');

      loadStatus();
      drawGraphs();  // Redraw with estimation data
      console.log('[CBS] Auto-applied estimation from capture stats');
    }
  } catch (e) {
    console.error('[CBS] Auto estimation error:', e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Manual';
    }
    estimating = false;
    testRunning = false;
    captureActive = false;
    updateUI();
  }
}

async function stopTest() {
  testRunning = false;
  captureActive = false;
  try { await api.capture.stop(); await api.traffic.stop(); } catch {}
  updateUI();
}

function updateUI() {
  document.getElementById('start-btn').disabled = testRunning;
  document.getElementById('stop-btn').disabled = !testRunning;
  const badge = document.getElementById('test-badge');
  badge.textContent = testRunning ? 'Running' : 'Ready';
  badge.className = `badge ${testRunning ? 'badge-success' : ''}`;
}

function handleStats(data) {
  if (!captureActive) return;

  const elapsedMs = data.elapsed_ms || 0;
  const entry = { time: elapsedMs, tc: {} };

  if (data.tc) {
    for (const [tc, s] of Object.entries(data.tc)) {
      const tcNum = parseInt(tc);
      const count = s.count || 0;
      const lastCount = lastRxCounts[tcNum] || 0;
      const delta = Math.max(0, count - lastCount);
      lastRxCounts[tcNum] = count;
      entry.tc[tcNum] = delta;

      rxTcStats[tcNum] = {
        count: count,
        kbps: s.kbps || 0,
        avgMs: s.avg_ms ? s.avg_ms : (s.avg_us ? s.avg_us / 1000 : 0),
        burstRatio: s.burst_ratio || 0
      };
    }
  }

  rxHistory.push(entry);
  if (rxHistory.length > 200) rxHistory.shift();

  const txTotal = txHistory.reduce((s, d) => s + Object.values(d.tc).reduce((a, b) => a + b, 0), 0);
  document.getElementById('tx-count').textContent = txTotal;
  document.getElementById('rx-count').textContent = data.total || 0;

  updatePacketTables();
  drawGraphs();
}

function updatePacketTables() {
  // TX table
  const txBody = document.getElementById('tx-pkt-body');
  const txPktCount = document.getElementById('tx-pkt-count');
  const totalTx = Object.values(txTcStats).reduce((s, tc) => s + tc.count, 0);
  if (txPktCount) txPktCount.textContent = totalTx;

  if (txBody) {
    const tcKeys = Object.keys(txTcStats).map(Number).sort((a, b) => a - b);
    if (tcKeys.length === 0) {
      txBody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text-muted)">No TX data</td></tr>';
    } else {
      txBody.innerHTML = tcKeys.map(tc => {
        const s = txTcStats[tc];
        const cfg = cbsConfig[tc] || {};
        const bwPercent = cfg.bandwidthPercent || 0;
        const idleSlopeKbps = (cfg.idleSlope || 0) / 1000;
        return `
        <tr>
          <td><span class="tc-badge" style="background:${TC_HEX[tc]}">TC${tc}</span></td>
          <td class="mono">${s.count}</td>
          <td class="mono" style="color:${TC_HEX[tc]}">${bwPercent.toFixed(0)}%</td>
          <td class="mono">${idleSlopeKbps.toFixed(0)}</td>
        </tr>
      `}).join('');
    }
  }

  // RX table
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
        // Detect shaping based on burst ratio or estimated config
        const isConfigured = cbsConfig[tc].enabled && cbsConfig[tc].idleSlope > 0;
        return `
        <tr>
          <td><span class="tc-badge" style="background:${TC_HEX[tc]}">TC${tc}</span></td>
          <td class="mono">${s.count}</td>
          <td class="mono">${s.kbps.toFixed(1)}</td>
          <td>${isConfigured ? '<span style="color:var(--success)">CBS</span>' : '-'}</td>
        </tr>
      `}).join('');
    }
  }
}

function drawGraphs() {
  drawSlopeGraph('slope-canvas');
  drawPacketGraph('tx-canvas', txHistory);
  drawPacketGraph('rx-canvas', rxHistory);
}

// Draw Idle Slope comparison bar graph (Config vs Measured)
function drawSlopeGraph(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = 140 * dpr;
  ctx.scale(dpr, dpr);

  const displayW = canvas.offsetWidth;
  const displayH = 140;
  const pad = { top: 16, right: 8, bottom: 20, left: 28 };
  const chartW = displayW - pad.left - pad.right;
  const chartH = displayH - pad.top - pad.bottom;

  ctx.clearRect(0, 0, displayW, displayH);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, displayW, displayH);

  const maxBW = 30;  // Max 30% bandwidth
  const barGroupWidth = chartW / 8;
  const barWidth = barGroupWidth * 0.35;

  // Y axis lines
  for (let bw = 0; bw <= maxBW; bw += 10) {
    const y = pad.top + chartH - (bw / maxBW) * chartH;
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartW, y);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '7px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(bw + '%', pad.left - 3, y + 3);
  }

  // Draw bars for each TC
  for (let tc = 0; tc < 8; tc++) {
    const cfg = cbsConfig[tc] || {};
    const configBW = cfg.bandwidthPercent || 0;
    const measuredBW = cfg.measuredPercent || 0;
    const x = pad.left + tc * barGroupWidth + barGroupWidth * 0.15;

    // Config bar (left, darker)
    const configH = Math.min(configBW / maxBW, 1) * chartH;
    ctx.fillStyle = TC_HEX[tc];
    ctx.fillRect(x, pad.top + chartH - configH, barWidth, configH);

    // Measured bar (right, lighter with border)
    if (measuredBW > 0) {
      const measuredH = Math.min(measuredBW / maxBW, 1) * chartH;
      ctx.fillStyle = TC_HEX[tc] + '60';
      ctx.strokeStyle = TC_HEX[tc];
      ctx.lineWidth = 1;
      ctx.fillRect(x + barWidth + 2, pad.top + chartH - measuredH, barWidth, measuredH);
      ctx.strokeRect(x + barWidth + 2, pad.top + chartH - measuredH, barWidth, measuredH);
    }

    // TC label
    ctx.fillStyle = selectedTCs.includes(tc) ? TC_HEX[tc] : '#94a3b8';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(tc, x + barWidth, displayH - 5);
  }

  // Legend
  ctx.font = '7px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#64748b';
  ctx.fillRect(pad.left + 2, 3, 8, 8);
  ctx.fillStyle = '#333';
  ctx.fillText('Config', pad.left + 14, 10);
  ctx.fillStyle = '#64748b80';
  ctx.fillRect(pad.left + 50, 3, 8, 8);
  ctx.strokeStyle = '#64748b';
  ctx.strokeRect(pad.left + 50, 3, 8, 8);
  ctx.fillStyle = '#333';
  ctx.fillText('Measured', pad.left + 62, 10);
}

// Draw packet raster graph with 1px lines
function drawPacketGraph(canvasId, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = 140 * dpr;
  ctx.scale(dpr, dpr);

  const displayW = canvas.offsetWidth;
  const displayH = 140;
  const pad = { top: 6, right: 4, bottom: 16, left: 20 };
  const chartW = displayW - pad.left - pad.right;
  const chartH = displayH - pad.top - pad.bottom;
  const rowH = chartH / 8;

  ctx.clearRect(0, 0, displayW, displayH);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, displayW, displayH);

  const maxTime = 8000;

  // TC rows (minimal)
  for (let tc = 0; tc < 8; tc++) {
    const y = pad.top + tc * rowH;
    ctx.fillStyle = selectedTCs.includes(tc) ? TC_HEX[tc] + '08' : '#fff';
    ctx.fillRect(pad.left, y, chartW, rowH);
    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.left, y + rowH);
    ctx.lineTo(pad.left + chartW, y + rowH);
    ctx.stroke();

    // TC number
    ctx.fillStyle = selectedTCs.includes(tc) ? TC_HEX[tc] : '#cbd5e1';
    ctx.font = '7px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(tc, pad.left - 2, y + rowH / 2 + 2);
  }

  // X axis (minimal)
  ctx.fillStyle = '#94a3b8';
  ctx.font = '6px sans-serif';
  ctx.textAlign = 'center';
  for (let t = 0; t <= maxTime; t += 2000) {
    const x = pad.left + (t / maxTime) * chartW;
    ctx.fillText((t / 1000) + 's', x, displayH - 3);
  }

  // Draw packets as 1px vertical lines
  data.forEach(d => {
    const x = Math.floor(pad.left + (d.time / maxTime) * chartW);
    [0,1,2,3,4,5,6,7].forEach(tc => {
      const count = d.tc[tc] || 0;
      if (count === 0) return;
      const y = pad.top + tc * rowH;

      // 1px line
      ctx.strokeStyle = TC_HEX[tc];
      ctx.lineWidth = 1;
      ctx.globalAlpha = Math.min(0.4 + count * 0.1, 1);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, y + 1);
      ctx.lineTo(x + 0.5, y + rowH - 1);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  });

  // Border
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, chartW, chartH);
}

