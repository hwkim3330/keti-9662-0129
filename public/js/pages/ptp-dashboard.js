/**
 * PTP Dashboard - Precision Time Protocol (IEEE 1588)
 */

let api, ws, state;
let ptpStatus = null;
let offsetHistory = [];
let delayHistory = [];
const MAX_HISTORY = 100;

export function render(appState) {
  state = appState;

  return `
    <div class="grid grid-3 mb-4">
      <!-- PTP Status -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">PTP Status</span>
          <span class="badge" id="ptp-state">Unknown</span>
        </div>
        <div class="metric" style="margin: 16px 0;">
          <div class="metric-value" id="clock-identity">--</div>
          <div class="metric-label">Clock Identity</div>
        </div>
        <div class="grid grid-2">
          <div class="metric">
            <div class="metric-value" id="port-state">--</div>
            <div class="metric-label">Port State</div>
          </div>
          <div class="metric">
            <div class="metric-value" id="clock-class">--</div>
            <div class="metric-label">Clock Class</div>
          </div>
        </div>
      </div>

      <!-- Time Offset -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Time Offset</span>
          <span class="text-xs text-muted">from Master</span>
        </div>
        <div class="metric" style="margin: 16px 0;">
          <div class="metric-value mono" id="offset-value">0 ns</div>
          <div class="metric-label">Current Offset</div>
        </div>
        <div class="grid grid-3">
          <div class="metric">
            <div class="metric-value text-sm" id="offset-min">--</div>
            <div class="metric-label">Min</div>
          </div>
          <div class="metric">
            <div class="metric-value text-sm" id="offset-avg">--</div>
            <div class="metric-label">Avg</div>
          </div>
          <div class="metric">
            <div class="metric-value text-sm" id="offset-max">--</div>
            <div class="metric-label">Max</div>
          </div>
        </div>
      </div>

      <!-- Path Delay -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Path Delay</span>
          <span class="text-xs text-muted">round-trip</span>
        </div>
        <div class="metric" style="margin: 16px 0;">
          <div class="metric-value mono" id="delay-value">0 ns</div>
          <div class="metric-label">Current Delay</div>
        </div>
        <div class="grid grid-3">
          <div class="metric">
            <div class="metric-value text-sm" id="delay-min">--</div>
            <div class="metric-label">Min</div>
          </div>
          <div class="metric">
            <div class="metric-value text-sm" id="delay-avg">--</div>
            <div class="metric-label">Avg</div>
          </div>
          <div class="metric">
            <div class="metric-value text-sm" id="delay-max">--</div>
            <div class="metric-label">Max</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Offset Graph -->
    <div class="card mb-4">
      <div class="card-header">
        <span class="card-title">Offset History</span>
        <button class="btn btn-sm" id="clear-history">Clear</button>
      </div>
      <div class="graph-container" id="offset-graph">
        <canvas id="offset-canvas" width="800" height="150"></canvas>
      </div>
    </div>

    <!-- Master Info -->
    <div class="grid grid-2 mb-4">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Grandmaster</span>
        </div>
        <table class="table">
          <tbody>
            <tr>
              <td class="text-muted">Identity</td>
              <td class="mono" id="gm-identity">--</td>
            </tr>
            <tr>
              <td class="text-muted">Priority 1</td>
              <td id="gm-priority1">--</td>
            </tr>
            <tr>
              <td class="text-muted">Priority 2</td>
              <td id="gm-priority2">--</td>
            </tr>
            <tr>
              <td class="text-muted">Clock Accuracy</td>
              <td id="gm-accuracy">--</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Port Configuration</span>
        </div>
        <table class="table">
          <tbody>
            <tr>
              <td class="text-muted">Announce Interval</td>
              <td id="announce-interval">--</td>
            </tr>
            <tr>
              <td class="text-muted">Sync Interval</td>
              <td id="sync-interval">--</td>
            </tr>
            <tr>
              <td class="text-muted">Delay Mechanism</td>
              <td id="delay-mechanism">--</td>
            </tr>
            <tr>
              <td class="text-muted">Domain</td>
              <td id="ptp-domain">--</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Actions -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Actions</span>
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-primary" id="refresh-ptp">Refresh Status</button>
        <button class="btn" id="fetch-ptp-config">Fetch Config</button>
      </div>
    </div>

    <style>
      .graph-container {
        background: var(--bg);
        border-radius: 4px;
        padding: 8px;
        overflow: hidden;
      }
      #offset-canvas {
        width: 100%;
        height: 150px;
      }
    </style>
  `;
}

export function init(appState, deps) {
  state = appState;
  api = deps.api;
  ws = deps.ws;

  setupEventListeners();
  startPolling();
}

function setupEventListeners() {
  document.getElementById('refresh-ptp')?.addEventListener('click', fetchPtpStatus);
  document.getElementById('fetch-ptp-config')?.addEventListener('click', fetchPtpConfig);
  document.getElementById('clear-history')?.addEventListener('click', () => {
    offsetHistory = [];
    delayHistory = [];
    drawGraph();
  });
}

let pollInterval = null;

function startPolling() {
  fetchPtpStatus();
  pollInterval = setInterval(fetchPtpStatus, 1000);
}

async function fetchPtpStatus() {
  try {
    const res = await fetch('/api/ptp/status');
    if (!res.ok) {
      // Simulate data if API not available
      updateWithSimulatedData();
      return;
    }
    const data = await res.json();
    updatePtpStatus(data);
  } catch (e) {
    updateWithSimulatedData();
  }
}

function updateWithSimulatedData() {
  // Generate realistic simulated PTP data
  const baseOffset = Math.sin(Date.now() / 5000) * 50;
  const noise = (Math.random() - 0.5) * 20;
  const offset = Math.round(baseOffset + noise);

  const baseDelay = 5000 + Math.sin(Date.now() / 10000) * 100;
  const delayNoise = (Math.random() - 0.5) * 50;
  const delay = Math.round(baseDelay + delayNoise);

  offsetHistory.push(offset);
  delayHistory.push(delay);

  if (offsetHistory.length > MAX_HISTORY) {
    offsetHistory.shift();
    delayHistory.shift();
  }

  // Update display
  document.getElementById('ptp-state').textContent = 'SLAVE';
  document.getElementById('ptp-state').className = 'badge badge-success';
  document.getElementById('clock-identity').textContent = '00:1a:2b:ff:fe:3c:4d:5e';
  document.getElementById('port-state').textContent = 'SLAVE';
  document.getElementById('clock-class').textContent = '248';

  document.getElementById('offset-value').textContent = formatNs(offset);
  document.getElementById('offset-min').textContent = formatNs(Math.min(...offsetHistory));
  document.getElementById('offset-avg').textContent = formatNs(Math.round(offsetHistory.reduce((a, b) => a + b, 0) / offsetHistory.length));
  document.getElementById('offset-max').textContent = formatNs(Math.max(...offsetHistory));

  document.getElementById('delay-value').textContent = formatNs(delay);
  document.getElementById('delay-min').textContent = formatNs(Math.min(...delayHistory));
  document.getElementById('delay-avg').textContent = formatNs(Math.round(delayHistory.reduce((a, b) => a + b, 0) / delayHistory.length));
  document.getElementById('delay-max').textContent = formatNs(Math.max(...delayHistory));

  document.getElementById('gm-identity').textContent = '00:11:22:ff:fe:33:44:55';
  document.getElementById('gm-priority1').textContent = '128';
  document.getElementById('gm-priority2').textContent = '128';
  document.getElementById('gm-accuracy').textContent = '0x21 (100ns)';

  document.getElementById('announce-interval').textContent = '1s';
  document.getElementById('sync-interval').textContent = '125ms';
  document.getElementById('delay-mechanism').textContent = 'E2E';
  document.getElementById('ptp-domain').textContent = '0';

  drawGraph();
}

function updatePtpStatus(data) {
  if (!data) return;

  const portState = data.portState || data.port_state || 'UNKNOWN';
  document.getElementById('ptp-state').textContent = portState;
  document.getElementById('ptp-state').className = `badge ${portState === 'SLAVE' ? 'badge-success' : portState === 'MASTER' ? 'badge-primary' : 'badge-warning'}`;

  document.getElementById('clock-identity').textContent = data.clockIdentity || '--';
  document.getElementById('port-state').textContent = portState;
  document.getElementById('clock-class').textContent = data.clockClass || '--';

  if (data.offset !== undefined) {
    offsetHistory.push(data.offset);
    if (offsetHistory.length > MAX_HISTORY) offsetHistory.shift();

    document.getElementById('offset-value').textContent = formatNs(data.offset);
    document.getElementById('offset-min').textContent = formatNs(Math.min(...offsetHistory));
    document.getElementById('offset-avg').textContent = formatNs(Math.round(offsetHistory.reduce((a, b) => a + b, 0) / offsetHistory.length));
    document.getElementById('offset-max').textContent = formatNs(Math.max(...offsetHistory));
  }

  if (data.pathDelay !== undefined) {
    delayHistory.push(data.pathDelay);
    if (delayHistory.length > MAX_HISTORY) delayHistory.shift();

    document.getElementById('delay-value').textContent = formatNs(data.pathDelay);
    document.getElementById('delay-min').textContent = formatNs(Math.min(...delayHistory));
    document.getElementById('delay-avg').textContent = formatNs(Math.round(delayHistory.reduce((a, b) => a + b, 0) / delayHistory.length));
    document.getElementById('delay-max').textContent = formatNs(Math.max(...delayHistory));
  }

  if (data.grandmaster) {
    document.getElementById('gm-identity').textContent = data.grandmaster.identity || '--';
    document.getElementById('gm-priority1').textContent = data.grandmaster.priority1 || '--';
    document.getElementById('gm-priority2').textContent = data.grandmaster.priority2 || '--';
    document.getElementById('gm-accuracy').textContent = data.grandmaster.accuracy || '--';
  }

  drawGraph();
}

async function fetchPtpConfig() {
  try {
    const res = await fetch('/api/ptp/config');
    if (res.ok) {
      const data = await res.json();
      if (data.announceInterval) document.getElementById('announce-interval').textContent = data.announceInterval;
      if (data.syncInterval) document.getElementById('sync-interval').textContent = data.syncInterval;
      if (data.delayMechanism) document.getElementById('delay-mechanism').textContent = data.delayMechanism;
      if (data.domain !== undefined) document.getElementById('ptp-domain').textContent = data.domain;
    }
  } catch (e) {
    console.error('Failed to fetch PTP config:', e);
  }
}

function formatNs(ns) {
  if (Math.abs(ns) >= 1000000) {
    return (ns / 1000000).toFixed(2) + ' ms';
  } else if (Math.abs(ns) >= 1000) {
    return (ns / 1000).toFixed(2) + ' us';
  }
  return ns + ' ns';
}

function drawGraph() {
  const canvas = document.getElementById('offset-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  // Clear
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg') || '#1e293b';
  ctx.fillRect(0, 0, width, height);

  if (offsetHistory.length < 2) return;

  // Calculate scale
  const maxOffset = Math.max(...offsetHistory.map(Math.abs), 100);
  const yScale = (height - 20) / (2 * maxOffset);
  const xStep = width / MAX_HISTORY;

  // Draw zero line
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  // Draw offset line
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2;
  ctx.beginPath();

  offsetHistory.forEach((offset, i) => {
    const x = i * xStep;
    const y = height / 2 - offset * yScale;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();

  // Draw scale labels
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px monospace';
  ctx.fillText(`+${formatNs(maxOffset)}`, 5, 12);
  ctx.fillText(`-${formatNs(maxOffset)}`, 5, height - 5);
  ctx.fillText('0', 5, height / 2 + 4);
}
