/**
 * CBS Dashboard - IEEE 802.1Qav Credit-Based Shaper
 * Professional TSN Traffic Analysis Interface
 *
 * Features:
 * - Real-time traffic visualization with Chart.js
 * - Wireshark-style packet list
 * - CBS configuration and monitoring
 */

let api, ws, state;
let currentPort = '2';
let testRunning = false;
let refreshTimer = null;

// Charts
let bandwidthChart = null;
let throughputChart = null;

// Data
let rxTcStats = {};
let txTcStats = {};
let packetList = [];
let throughputHistory = [];
const MAX_PACKETS = 200;
const MAX_HISTORY = 60;

// Link speed (1 Gbps)
const LINK_SPEED_MBPS = 1000;
const LINK_SPEED_KBPS = LINK_SPEED_MBPS * 1000;

// TC Colors
const TC_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'
];

// CBS Configuration
let cbsConfig = {};
for (let i = 0; i < 8; i++) {
  cbsConfig[i] = { idleSlope: 0, measured: 0, enabled: false };
}

// Selected TCs for test
let selectedTCs = [0, 1, 2, 3, 4, 5, 6, 7];

export function render(appState) {
  state = appState;

  return `
    <!-- Chart.js CDN -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>

    <div class="cbs-dashboard">
      <!-- Header -->
      <div class="dash-header">
        <div class="header-title">
          <h1>CBS Traffic Shaper</h1>
          <span class="subtitle">IEEE 802.1Qav Credit-Based Shaper | LAN9662</span>
        </div>
        <div class="header-controls">
          <select id="port-select" class="port-select">
            <option value="1">Port 1</option>
            <option value="2" selected>Port 2</option>
          </select>
          <div class="link-badge">
            <span class="link-icon">●</span>
            <span>${LINK_SPEED_MBPS} Mbps</span>
          </div>
        </div>
      </div>

      <!-- Top Section: Config + Test -->
      <div class="top-grid">
        <!-- CBS Configuration -->
        <div class="panel">
          <div class="panel-header">
            <h2>CBS Configuration</h2>
            <div class="panel-actions">
              <button class="btn btn-sm" id="load-device-btn">Load from Device</button>
              <button class="btn btn-primary" id="apply-btn">Apply</button>
            </div>
          </div>
          <div class="config-table">
            <div class="config-head">
              <span>TC</span>
              <span>Idle Slope (kbps)</span>
              <span>Limit %</span>
              <span>Measured</span>
              <span>Status</span>
            </div>
            <div class="config-body" id="config-body">
              ${renderConfigRows()}
            </div>
          </div>
          <div class="preset-row">
            <span class="preset-label">Presets:</span>
            <button class="btn btn-xs" data-preset="low">Low (0.5-4 Mbps)</button>
            <button class="btn btn-xs" data-preset="mid">Medium (5-40 Mbps)</button>
            <button class="btn btn-xs" data-preset="high">High (50-400 Mbps)</button>
            <button class="btn btn-xs" data-preset="clear">Clear</button>
          </div>
        </div>

        <!-- Traffic Test -->
        <div class="panel">
          <div class="panel-header">
            <h2>Traffic Generator</h2>
            <div class="test-status" id="test-status">
              <span class="status-dot"></span>
              <span>Ready</span>
            </div>
          </div>
          <div class="test-form">
            <div class="form-row">
              <div class="form-group">
                <label>TX Interface</label>
                <select id="tx-iface"></select>
              </div>
              <div class="form-group">
                <label>RX Interface</label>
                <select id="rx-iface"></select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Packets/sec</label>
                <input type="number" id="pps" value="8000" min="100" max="100000">
              </div>
              <div class="form-group">
                <label>Duration (s)</label>
                <input type="number" id="duration" value="10" min="1" max="120">
              </div>
            </div>
            <div class="tc-select">
              <label>Traffic Classes:</label>
              <div class="tc-buttons">
                ${[0,1,2,3,4,5,6,7].map(tc => `
                  <button class="tc-btn ${selectedTCs.includes(tc) ? 'active' : ''}" data-tc="${tc}" style="--tc-color: ${TC_COLORS[tc]}">
                    TC${tc}
                  </button>
                `).join('')}
              </div>
            </div>
            <div class="test-actions">
              <button class="btn btn-success btn-lg" id="start-btn">▶ Start Test</button>
              <button class="btn btn-danger btn-lg" id="stop-btn" disabled>■ Stop</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Charts Section -->
      <div class="charts-grid">
        <div class="panel">
          <div class="panel-header">
            <h2>Bandwidth Allocation</h2>
            <span class="chart-legend">Config (solid) vs Measured (striped)</span>
          </div>
          <div class="chart-container">
            <canvas id="bandwidth-chart"></canvas>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2>Real-time Throughput</h2>
            <span class="chart-legend" id="throughput-total">Total: 0 kbps</span>
          </div>
          <div class="chart-container">
            <canvas id="throughput-chart"></canvas>
          </div>
        </div>
      </div>

      <!-- Packet List (Wireshark style) -->
      <div class="panel packet-panel">
        <div class="panel-header">
          <h2>Packet Capture</h2>
          <div class="panel-actions">
            <span class="pkt-count" id="pkt-count">0 packets</span>
            <button class="btn btn-xs" id="clear-pkts">Clear</button>
            <button class="btn btn-xs" id="export-pkts">Export CSV</button>
          </div>
        </div>
        <div class="packet-list-container">
          <table class="packet-list">
            <thead>
              <tr>
                <th class="col-no">No.</th>
                <th class="col-time">Time</th>
                <th class="col-tc">TC</th>
                <th class="col-src">Source</th>
                <th class="col-dst">Destination</th>
                <th class="col-proto">Protocol</th>
                <th class="col-len">Length</th>
                <th class="col-info">Info</th>
              </tr>
            </thead>
            <tbody id="packet-body"></tbody>
          </table>
        </div>
      </div>

      <!-- Results Summary -->
      <div class="panel results-panel">
        <div class="panel-header">
          <h2>Shaping Analysis</h2>
          <button class="btn btn-xs" id="analyze-btn">Analyze</button>
        </div>
        <div class="results-grid" id="results-grid">
          ${renderResultsGrid()}
        </div>
      </div>
    </div>

    <style>
      .cbs-dashboard {
        padding: 16px;
        max-width: 1600px;
        margin: 0 auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
        font-size: 13px;
        color: #1f2937;
      }

      /* Header */
      .dash-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
        padding-bottom: 12px;
        border-bottom: 2px solid #e5e7eb;
      }
      .header-title h1 {
        font-size: 20px;
        font-weight: 600;
        margin: 0 0 2px 0;
        color: #111827;
      }
      .header-title .subtitle {
        font-size: 11px;
        color: #6b7280;
      }
      .header-controls {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .port-select {
        padding: 6px 12px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        font-size: 13px;
        background: white;
      }
      .link-badge {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: #ecfdf5;
        border: 1px solid #a7f3d0;
        border-radius: 6px;
        color: #059669;
        font-weight: 500;
        font-size: 12px;
      }
      .link-icon { color: #10b981; }

      /* Panels */
      .panel {
        background: white;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        margin-bottom: 16px;
      }
      .panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid #f3f4f6;
      }
      .panel-header h2 {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        color: #374151;
      }
      .panel-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      /* Grid layouts */
      .top-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        margin-bottom: 16px;
      }
      .charts-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }

      /* Buttons */
      .btn {
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
      }
      .btn-primary { background: #3b82f6; color: white; }
      .btn-primary:hover { background: #2563eb; }
      .btn-success { background: #10b981; color: white; }
      .btn-success:hover:not(:disabled) { background: #059669; }
      .btn-danger { background: #ef4444; color: white; }
      .btn-danger:hover:not(:disabled) { background: #dc2626; }
      .btn-sm { padding: 6px 12px; font-size: 11px; }
      .btn-xs { padding: 4px 8px; font-size: 10px; background: #f3f4f6; color: #374151; }
      .btn-xs:hover { background: #e5e7eb; }
      .btn-lg { padding: 10px 20px; font-size: 13px; }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }

      /* Config Table */
      .config-table {
        padding: 0 16px;
      }
      .config-head, .config-row {
        display: grid;
        grid-template-columns: 50px 1fr 70px 80px 70px;
        gap: 8px;
        align-items: center;
        padding: 8px 0;
      }
      .config-head {
        font-size: 10px;
        font-weight: 600;
        color: #6b7280;
        text-transform: uppercase;
        border-bottom: 1px solid #e5e7eb;
      }
      .config-row {
        border-bottom: 1px solid #f3f4f6;
      }
      .config-row:last-child { border-bottom: none; }
      .tc-label {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 22px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        color: white;
      }
      .slope-input {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid #d1d5db;
        border-radius: 4px;
        font-size: 12px;
        font-family: 'SF Mono', Monaco, monospace;
        text-align: right;
      }
      .slope-input:focus {
        outline: none;
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
      }
      .limit-pct, .measured-val {
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 11px;
        text-align: center;
      }
      .status-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 3px;
        text-align: center;
      }
      .status-badge.shaped { background: #dcfce7; color: #166534; }
      .status-badge.unlimited { background: #f3f4f6; color: #6b7280; }

      .preset-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        border-top: 1px solid #f3f4f6;
      }
      .preset-label {
        font-size: 11px;
        color: #6b7280;
      }

      /* Test Form */
      .test-form {
        padding: 16px;
      }
      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-bottom: 12px;
      }
      .form-group label {
        display: block;
        font-size: 11px;
        font-weight: 500;
        color: #6b7280;
        margin-bottom: 4px;
      }
      .form-group select, .form-group input {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        font-size: 12px;
      }
      .tc-select {
        margin-bottom: 16px;
      }
      .tc-select label {
        display: block;
        font-size: 11px;
        font-weight: 500;
        color: #6b7280;
        margin-bottom: 8px;
      }
      .tc-buttons {
        display: flex;
        gap: 6px;
      }
      .tc-btn {
        padding: 6px 12px;
        border: 2px solid #e5e7eb;
        border-radius: 4px;
        background: white;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
        color: #6b7280;
      }
      .tc-btn:hover { border-color: var(--tc-color); }
      .tc-btn.active {
        background: var(--tc-color);
        border-color: var(--tc-color);
        color: white;
      }
      .test-actions {
        display: flex;
        gap: 12px;
      }
      .test-actions .btn { flex: 1; }
      .test-status {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #6b7280;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #d1d5db;
      }
      .test-status.running .status-dot {
        background: #10b981;
        animation: pulse 1s infinite;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      /* Charts */
      .chart-container {
        padding: 16px;
        height: 200px;
      }
      .chart-legend {
        font-size: 10px;
        color: #9ca3af;
      }

      /* Packet List - Wireshark Style */
      .packet-panel {
        margin-bottom: 16px;
        background: #fefefe;
      }
      .packet-list-container {
        max-height: 300px;
        overflow-y: auto;
        background: #fff;
        border-top: 2px solid #1f2937;
      }
      .packet-list {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
        font-family: 'SF Mono', Monaco, Consolas, monospace;
      }
      .packet-list th {
        position: sticky;
        top: 0;
        background: linear-gradient(180deg, #374151 0%, #1f2937 100%);
        color: #e5e7eb;
        font-weight: 600;
        text-align: left;
        padding: 10px 12px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 2px solid #4f46e5;
      }
      .packet-list td {
        padding: 7px 12px;
        border-bottom: 1px solid #e5e7eb;
        white-space: nowrap;
        color: #374151;
      }
      .packet-list tbody tr:nth-child(even) td {
        background: #f8fafc;
      }
      .packet-list tbody tr:hover td {
        background: #e0f2fe !important;
      }
      .packet-list tr.selected td {
        background: #dbeafe !important;
        font-weight: 500;
      }
      .col-no {
        width: 55px;
        color: #6b7280;
        font-weight: 500;
      }
      .col-time {
        width: 90px;
        color: #059669;
      }
      .col-tc { width: 45px; }
      .col-src {
        width: 130px;
        color: #1d4ed8;
      }
      .col-dst {
        width: 130px;
        color: #7c3aed;
      }
      .col-proto {
        width: 65px;
        font-weight: 600;
        color: #0891b2;
      }
      .col-len {
        width: 60px;
        text-align: right;
        color: #6b7280;
      }
      .col-info {
        color: #374151;
      }
      .pkt-count {
        font-size: 11px;
        color: #6b7280;
        font-weight: 500;
      }
      .pkt-tc {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 700;
        color: white;
        box-shadow: 0 1px 2px rgba(0,0,0,0.2);
      }

      /* Results Grid - Enhanced Visual Style */
      .results-panel {
        background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
        border: none;
      }
      .results-panel .panel-header {
        border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      .results-panel .panel-header h2 {
        color: white;
      }
      .results-panel .btn-xs {
        background: rgba(255,255,255,0.1);
        color: white;
        border: 1px solid rgba(255,255,255,0.2);
      }
      .results-grid {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: 12px;
        padding: 20px 16px;
      }
      .result-card {
        text-align: center;
        padding: 16px 10px;
        background: rgba(255,255,255,0.05);
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.1);
        transition: all 0.3s ease;
        position: relative;
        overflow: hidden;
      }
      .result-card::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 3px;
        background: var(--tc-color, #6b7280);
        opacity: 0.5;
      }
      .result-card:hover {
        transform: translateY(-2px);
        background: rgba(255,255,255,0.08);
        box-shadow: 0 8px 20px rgba(0,0,0,0.3);
      }
      .result-card.shaped {
        background: linear-gradient(180deg, rgba(34,197,94,0.15) 0%, rgba(34,197,94,0.05) 100%);
        border-color: rgba(34,197,94,0.3);
      }
      .result-card.shaped::before {
        background: linear-gradient(90deg, #22c55e, #10b981);
        opacity: 1;
      }
      .result-tc {
        font-size: 12px;
        font-weight: 700;
        margin-bottom: 8px;
        color: white;
        text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      }
      .result-value {
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 20px;
        font-weight: 700;
        color: white;
        text-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      .result-label {
        font-size: 10px;
        color: rgba(255,255,255,0.6);
        margin-top: 4px;
      }
      .result-bar {
        height: 4px;
        background: rgba(255,255,255,0.1);
        border-radius: 2px;
        margin-top: 8px;
        overflow: hidden;
      }
      .result-bar-fill {
        height: 100%;
        border-radius: 2px;
        transition: width 0.5s ease;
      }
      .result-status {
        font-size: 10px;
        font-weight: 600;
        margin-top: 8px;
        padding: 3px 8px;
        border-radius: 4px;
        display: inline-block;
      }
      .result-status.shaped {
        background: rgba(34,197,94,0.2);
        color: #4ade80;
      }
      .result-status.unlimited {
        background: rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.5);
      }
    </style>
  `;
}

function renderConfigRows() {
  let html = '';
  for (let tc = 0; tc < 8; tc++) {
    const cfg = cbsConfig[tc];
    const limitPct = cfg.idleSlope > 0 ? (cfg.idleSlope / LINK_SPEED_KBPS * 100).toFixed(2) : '--';
    const measured = rxTcStats[tc]?.kbps || 0;
    const isShaped = cfg.idleSlope > 0;

    html += `
      <div class="config-row" data-tc="${tc}">
        <span class="tc-label" style="background: ${TC_COLORS[tc]}">TC${tc}</span>
        <input type="number" class="slope-input" value="${cfg.idleSlope}" min="0" max="${LINK_SPEED_KBPS}" step="100" data-tc="${tc}">
        <span class="limit-pct">${limitPct}%</span>
        <span class="measured-val">${measured > 0 ? measured.toFixed(0) + ' kbps' : '--'}</span>
        <span class="status-badge ${isShaped ? 'shaped' : 'unlimited'}">${isShaped ? 'SHAPED' : 'OFF'}</span>
      </div>
    `;
  }
  return html;
}

function renderResultsGrid() {
  let html = '';
  for (let tc = 0; tc < 8; tc++) {
    const cfg = cbsConfig[tc];
    const measured = rxTcStats[tc]?.kbps || 0;
    const limit = cfg.idleSlope || 0;
    const isShaped = limit > 0 && measured > 0;
    const bwPct = measured > 0 ? (measured / LINK_SPEED_KBPS * 100).toFixed(2) : '0.00';

    // Calculate bar fill percentage (relative to limit if shaped, or just a visual indicator)
    const barPct = limit > 0 && measured > 0
      ? Math.min(100, (measured / limit) * 100)
      : (measured > 0 ? 50 : 0);

    // Status logic
    let statusText, statusClass;
    if (limit > 0) {
      if (measured > 0) {
        const ratio = measured / limit;
        if (ratio >= 0.9) {
          statusText = '✓ SHAPED';
          statusClass = 'shaped';
        } else {
          statusText = `${(ratio * 100).toFixed(0)}% LIMIT`;
          statusClass = 'shaped';
        }
      } else {
        statusText = `LIMIT ${limit}`;
        statusClass = 'unlimited';
      }
    } else {
      statusText = measured > 0 ? 'UNLIMITED' : 'OFF';
      statusClass = 'unlimited';
    }

    html += `
      <div class="result-card ${isShaped ? 'shaped' : ''}" style="--tc-color: ${TC_COLORS[tc]}">
        <div class="result-tc">TC${tc}</div>
        <div class="result-value">${measured > 0 ? measured.toFixed(0) : '--'}</div>
        <div class="result-label">kbps (${bwPct}%)</div>
        <div class="result-bar">
          <div class="result-bar-fill" style="width: ${barPct}%; background: ${TC_COLORS[tc]}"></div>
        </div>
        <div class="result-status ${statusClass}">${statusText}</div>
      </div>
    `;
  }
  return html;
}

function updateConfigUI() {
  const body = document.getElementById('config-body');
  if (body) body.innerHTML = renderConfigRows();
}

function updateResultsUI() {
  const grid = document.getElementById('results-grid');
  if (grid) grid.innerHTML = renderResultsGrid();
}

// Initialize Chart.js charts
function initCharts() {
  // Wait for Chart.js to load
  if (typeof Chart === 'undefined') {
    setTimeout(initCharts, 100);
    return;
  }

  // Bandwidth allocation chart (bar)
  const bwCtx = document.getElementById('bandwidth-chart')?.getContext('2d');
  if (bwCtx) {
    bandwidthChart = new Chart(bwCtx, {
      type: 'bar',
      data: {
        labels: ['TC0', 'TC1', 'TC2', 'TC3', 'TC4', 'TC5', 'TC6', 'TC7'],
        datasets: [
          {
            label: 'Configured Limit',
            data: [0, 0, 0, 0, 0, 0, 0, 0],
            backgroundColor: TC_COLORS.map(c => c + '60'),
            borderColor: TC_COLORS,
            borderWidth: 2
          },
          {
            label: 'Measured',
            data: [0, 0, 0, 0, 0, 0, 0, 0],
            backgroundColor: TC_COLORS,
            borderColor: TC_COLORS,
            borderWidth: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, font: { size: 10 } } }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'kbps', font: { size: 10 } }
          }
        }
      }
    });
  }

  // Throughput chart (line)
  const tpCtx = document.getElementById('throughput-chart')?.getContext('2d');
  if (tpCtx) {
    throughputChart = new Chart(tpCtx, {
      type: 'line',
      data: {
        labels: [],
        datasets: TC_COLORS.map((color, tc) => ({
          label: `TC${tc}`,
          data: [],
          borderColor: color,
          backgroundColor: color + '20',
          borderWidth: 1.5,
          fill: false,
          tension: 0.2,
          pointRadius: 0
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 8, font: { size: 9 } } }
        },
        scales: {
          x: { display: true, title: { display: false } },
          y: { beginAtZero: true, title: { display: true, text: 'kbps', font: { size: 10 } } }
        }
      }
    });
  }
}

function updateCharts() {
  if (!bandwidthChart || !throughputChart) return;

  // Update bandwidth chart
  const configData = [];
  const measuredData = [];
  for (let tc = 0; tc < 8; tc++) {
    configData.push(cbsConfig[tc].idleSlope || 0);
    measuredData.push(rxTcStats[tc]?.kbps || 0);
  }
  bandwidthChart.data.datasets[0].data = configData;
  bandwidthChart.data.datasets[1].data = measuredData;
  bandwidthChart.update('none');

  // Update total throughput display
  const total = measuredData.reduce((a, b) => a + b, 0);
  const totalEl = document.getElementById('throughput-total');
  if (totalEl) totalEl.textContent = `Total: ${total.toFixed(0)} kbps`;
}

function addThroughputSample() {
  if (!throughputChart) return;

  const now = new Date().toLocaleTimeString('en-US', { hour12: false });
  throughputChart.data.labels.push(now);

  for (let tc = 0; tc < 8; tc++) {
    const kbps = rxTcStats[tc]?.kbps || 0;
    throughputChart.data.datasets[tc].data.push(kbps);
  }

  // Keep only last MAX_HISTORY points
  if (throughputChart.data.labels.length > MAX_HISTORY) {
    throughputChart.data.labels.shift();
    throughputChart.data.datasets.forEach(ds => ds.data.shift());
  }

  throughputChart.update('none');
}

// Packet list functions
function addPacket(pkt) {
  packetList.unshift(pkt);
  if (packetList.length > MAX_PACKETS) packetList.pop();
  renderPacketList();
}

function renderPacketList() {
  const body = document.getElementById('packet-body');
  if (!body) return;

  body.innerHTML = packetList.slice(0, 100).map((p, i) => `
    <tr>
      <td class="col-no">${packetList.length - i}</td>
      <td class="col-time">${p.time}</td>
      <td class="col-tc"><span class="pkt-tc" style="background: ${TC_COLORS[p.tc]}">${p.tc}</span></td>
      <td class="col-src">${p.src}</td>
      <td class="col-dst">${p.dst}</td>
      <td class="col-proto">${p.proto}</td>
      <td class="col-len">${p.len}</td>
      <td class="col-info">${p.info}</td>
    </tr>
  `).join('');

  const countEl = document.getElementById('pkt-count');
  if (countEl) countEl.textContent = `${packetList.length} packets`;
}

// API functions
async function loadStatus() {
  try {
    const data = await api.cbs.getStatus(currentPort);
    if (data.tcConfigs) {
      for (const [tc, cfg] of Object.entries(data.tcConfigs)) {
        cbsConfig[parseInt(tc)].idleSlope = cfg.idleSlopeKbps || 0;
      }
    }
    updateConfigUI();
    updateCharts();
  } catch (e) {
    console.error('[CBS] Load status failed:', e);
  }
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
  } catch (e) {
    console.error('[CBS] Load interfaces failed:', e);
  }
}

async function applyConfig() {
  const btn = document.getElementById('apply-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying...'; }

  try {
    let count = 0;
    for (let tc = 0; tc < 8; tc++) {
      if (cbsConfig[tc].idleSlope > 0) {
        await api.cbs.configure(currentPort, {
          tc: tc,
          idleSlope: cbsConfig[tc].idleSlope
        });
        count++;
      }
    }
    console.log(`[CBS] Applied ${count} TC configurations`);
    await loadStatus();
  } catch (e) {
    alert('Apply failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
  }
}

async function startTest() {
  const txIface = document.getElementById('tx-iface')?.value;
  const rxIface = document.getElementById('rx-iface')?.value;
  const pps = parseInt(document.getElementById('pps')?.value) || 8000;
  const duration = parseInt(document.getElementById('duration')?.value) || 10;

  if (!txIface || !rxIface) return alert('Select interfaces');
  if (selectedTCs.length === 0) return alert('Select at least one TC');

  let dstMac;
  try {
    const r = await api.system.getMac(rxIface);
    dstMac = r.mac;
  } catch { return alert('Could not get MAC address'); }

  // Reset stats
  rxTcStats = {};
  txTcStats = {};
  packetList = [];
  throughputHistory = [];
  if (throughputChart) {
    throughputChart.data.labels = [];
    throughputChart.data.datasets.forEach(ds => ds.data = []);
  }

  testRunning = true;
  updateTestUI();

  try {
    try { await api.capture.stop(); await api.traffic.stop(); } catch {}
    await new Promise(r => setTimeout(r, 200));

    await api.capture.start(rxIface, { duration: duration + 3, vlanId: 100 });
    await api.traffic.start(txIface, {
      dstMac,
      vlanId: 100,
      tcList: selectedTCs,
      packetsPerSecond: pps,
      duration,
      frameSize: 1000
    });

    // Stop after duration
    setTimeout(() => {
      if (testRunning) stopTest();
    }, (duration + 2) * 1000);

  } catch (e) {
    console.error('[CBS] Start test failed:', e);
    testRunning = false;
    updateTestUI();
  }
}

async function stopTest() {
  testRunning = false;
  try { await api.capture.stop(); await api.traffic.stop(); } catch {}
  updateTestUI();
  updateResultsUI();
}

function updateTestUI() {
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const statusEl = document.getElementById('test-status');

  if (startBtn) startBtn.disabled = testRunning;
  if (stopBtn) stopBtn.disabled = !testRunning;
  if (statusEl) {
    statusEl.className = `test-status ${testRunning ? 'running' : ''}`;
    statusEl.querySelector('span:last-child').textContent = testRunning ? 'Running' : 'Ready';
  }
}

function handleStats(data) {
  if (!testRunning) return;

  // Update RX stats
  if (data.tc) {
    for (const [tc, s] of Object.entries(data.tc)) {
      const tcNum = parseInt(tc);
      rxTcStats[tcNum] = {
        count: s.count || 0,
        kbps: s.kbps || 0
      };

      // Add to packet list (simulated based on stats)
      if (s.count > 0) {
        const now = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
        addPacket({
          time: now,
          tc: tcNum,
          src: '192.168.100.1',
          dst: '192.168.100.2',
          proto: 'UDP',
          len: 1000,
          info: `VLAN 100, PCP ${tcNum}, ${(s.kbps || 0).toFixed(0)} kbps`
        });
      }
    }
  }

  updateConfigUI();
  updateCharts();
  addThroughputSample();
  updateResultsUI();
}

function setPreset(type) {
  const presets = {
    low: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000],
    mid: [5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000],
    high: [50000, 100000, 150000, 200000, 250000, 300000, 350000, 400000],
    clear: [0, 0, 0, 0, 0, 0, 0, 0]
  };

  const values = presets[type];
  if (values) {
    for (let tc = 0; tc < 8; tc++) {
      cbsConfig[tc].idleSlope = values[tc];
    }
    updateConfigUI();
    updateCharts();
  }
}

function setupEvents() {
  // Port select
  document.getElementById('port-select')?.addEventListener('change', async (e) => {
    currentPort = e.target.value;
    await loadStatus();
  });

  // Config inputs
  document.getElementById('config-body')?.addEventListener('input', (e) => {
    if (e.target.classList.contains('slope-input')) {
      const tc = parseInt(e.target.dataset.tc);
      cbsConfig[tc].idleSlope = parseInt(e.target.value) || 0;
      updateConfigUI();
      updateCharts();
    }
  });

  // Buttons
  document.getElementById('apply-btn')?.addEventListener('click', applyConfig);
  document.getElementById('load-device-btn')?.addEventListener('click', loadStatus);
  document.getElementById('start-btn')?.addEventListener('click', startTest);
  document.getElementById('stop-btn')?.addEventListener('click', stopTest);
  document.getElementById('clear-pkts')?.addEventListener('click', () => {
    packetList = [];
    renderPacketList();
  });
  document.getElementById('analyze-btn')?.addEventListener('click', updateResultsUI);

  // Presets
  document.querySelector('.preset-row')?.addEventListener('click', (e) => {
    const preset = e.target.dataset?.preset;
    if (preset) setPreset(preset);
  });

  // TC selection
  document.querySelector('.tc-buttons')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('tc-btn')) {
      const tc = parseInt(e.target.dataset.tc);
      const idx = selectedTCs.indexOf(tc);
      if (idx > -1) {
        selectedTCs.splice(idx, 1);
        e.target.classList.remove('active');
      } else {
        selectedTCs.push(tc);
        selectedTCs.sort((a, b) => a - b);
        e.target.classList.add('active');
      }
    }
  });

  // Export packets
  document.getElementById('export-pkts')?.addEventListener('click', () => {
    const csv = 'No,Time,TC,Source,Destination,Protocol,Length,Info\n' +
      packetList.map((p, i) => `${i + 1},${p.time},${p.tc},${p.src},${p.dst},${p.proto},${p.len},"${p.info}"`).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cbs-capture-${Date.now()}.csv`;
    a.click();
  });
}

let statsHandler = null;
let stopHandler = null;

export async function init(appState, deps) {
  state = appState;
  api = deps.api;
  ws = deps.ws;

  setupEvents();
  await loadInterfaces();
  await loadStatus();

  // Initialize charts after DOM is ready
  setTimeout(initCharts, 200);

  // WebSocket handlers
  if (ws) {
    statsHandler = handleStats;
    stopHandler = () => { if (testRunning) stopTest(); };
    ws.on('c-capture-stats', statsHandler);
    ws.on('c-capture-stopped', stopHandler);
  }

  // Auto refresh
  refreshTimer = setInterval(loadStatus, 10000);
}

export function cleanup() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (ws) {
    if (statsHandler) ws.off('c-capture-stats', statsHandler);
    if (stopHandler) ws.off('c-capture-stopped', stopHandler);
  }
  if (bandwidthChart) { bandwidthChart.destroy(); bandwidthChart = null; }
  if (throughputChart) { throughputChart.destroy(); throughputChart = null; }
  testRunning = false;
}
