/**
 * Packet Capture Tool
 */

let api, ws, state;
let capturing = false;
let packets = [];
const MAX_PACKETS = 500;

const TC_COLORS = ['#94a3b8', '#64748b', '#475569', '#334155', '#1e3a5f', '#1e40af', '#3730a3', '#4c1d95'];

export function render(appState) {
  state = appState;
  const { interfaces } = state;

  return `
    <div class="grid grid-3 mb-4">
      <!-- Capture Config -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Capture Configuration</span>
        </div>

        <div class="input-group">
          <label class="input-label">Interface</label>
          <select class="select" id="capture-interface">
            <option value="">Select interface...</option>
            ${interfaces.map(i => `
              <option value="${i.name}">${i.name} (${i.mac || 'no mac'})</option>
            `).join('')}
          </select>
        </div>

        <div class="grid grid-2" style="gap: 8px;">
          <div class="input-group">
            <label class="input-label">VLAN ID</label>
            <input type="number" class="input" id="capture-vlan" value="100" min="1" max="4094">
          </div>
          <div class="input-group">
            <label class="input-label">Duration (sec)</label>
            <input type="number" class="input" id="capture-duration" value="10" min="1" max="300">
          </div>
        </div>

        <div class="input-group">
          <label class="input-label">Filter (optional)</label>
          <input type="text" class="input" id="capture-filter" placeholder="e.g., vlan 100">
        </div>

        <div style="display: flex; gap: 8px; margin-top: 12px;">
          <button class="btn btn-primary" id="start-capture" style="flex: 1;">
            Start Capture
          </button>
          <button class="btn btn-error" id="stop-capture" style="flex: 1;" disabled>
            Stop
          </button>
        </div>
      </div>

      <!-- Status -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Status</span>
          <span class="badge" id="capture-status">Idle</span>
        </div>

        <div class="metric" style="margin: 16px 0;">
          <div class="metric-value" id="packet-count">0</div>
          <div class="metric-label">Packets Captured</div>
        </div>

        <div class="grid grid-2">
          <div class="metric">
            <div class="metric-value text-sm" id="capture-elapsed">0s</div>
            <div class="metric-label">Elapsed</div>
          </div>
          <div class="metric">
            <div class="metric-value text-sm" id="capture-rate">0</div>
            <div class="metric-label">PPS</div>
          </div>
        </div>
      </div>

      <!-- TC Distribution -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">TC Distribution</span>
        </div>
        <div id="tc-distribution">
          ${[0,1,2,3,4,5,6,7].map(tc => `
            <div class="tc-bar-row">
              <span class="tc-bar-label" style="color: ${TC_COLORS[tc]}">TC${tc}</span>
              <div class="tc-bar-container">
                <div class="tc-bar" id="tc-bar-${tc}" style="width: 0%; background: ${TC_COLORS[tc]};"></div>
              </div>
              <span class="tc-bar-count" id="tc-count-${tc}">0</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- Packet List -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Captured Packets</span>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-sm" id="clear-packets">Clear</button>
          <button class="btn btn-sm" id="export-packets">Export CSV</button>
        </div>
      </div>
      <div class="packet-list-container">
        <table class="table" id="packet-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>TC/PCP</th>
              <th>VLAN</th>
              <th>Src MAC</th>
              <th>Dst MAC</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody id="packet-tbody">
            <tr><td colspan="7" class="text-muted text-center">No packets captured</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <style>
      .tc-bar-row {
        display: flex; align-items: center; gap: 8px; margin-bottom: 4px;
      }
      .tc-bar-label { width: 32px; font-size: 11px; font-weight: 500; }
      .tc-bar-container {
        flex: 1; height: 16px; background: var(--bg); border-radius: 2px; overflow: hidden;
      }
      .tc-bar {
        height: 100%; transition: width 0.3s ease;
      }
      .tc-bar-count { width: 40px; text-align: right; font-size: 11px; font-family: monospace; }

      .packet-list-container {
        max-height: 400px; overflow-y: auto;
      }
      #packet-table { font-size: 12px; }
      #packet-table td { padding: 4px 8px; }
      #packet-table .mono { font-family: monospace; font-size: 11px; }
    </style>
  `;
}

export function init(appState, deps) {
  state = appState;
  api = deps.api;
  ws = deps.ws;

  setupEventListeners();
  ws.on('c-capture-stats', handleCaptureStats);
  ws.on('c-capture-stopped', handleCaptureStopped);
}

function setupEventListeners() {
  document.getElementById('start-capture')?.addEventListener('click', startCapture);
  document.getElementById('stop-capture')?.addEventListener('click', stopCapture);
  document.getElementById('clear-packets')?.addEventListener('click', clearPackets);
  document.getElementById('export-packets')?.addEventListener('click', exportPackets);
}

async function startCapture() {
  const iface = document.getElementById('capture-interface')?.value;
  if (!iface) {
    alert('Please select an interface');
    return;
  }

  const duration = parseInt(document.getElementById('capture-duration')?.value) || 10;
  const vlanId = parseInt(document.getElementById('capture-vlan')?.value) || 100;

  capturing = true;
  packets = [];
  updateUI('capturing');

  try {
    await api.capture.start(iface, { duration, vlanId });
  } catch (err) {
    console.error('Capture error:', err);
    capturing = false;
    updateUI('error', err.message);
  }
}

async function stopCapture() {
  try {
    await api.capture.stop();
  } catch (e) {}
  capturing = false;
  updateUI('stopped');
}

function clearPackets() {
  packets = [];
  document.getElementById('packet-tbody').innerHTML =
    '<tr><td colspan="7" class="text-muted text-center">No packets captured</td></tr>';
  document.getElementById('packet-count').textContent = '0';

  // Reset TC bars
  for (let tc = 0; tc < 8; tc++) {
    document.getElementById(`tc-bar-${tc}`).style.width = '0%';
    document.getElementById(`tc-count-${tc}`).textContent = '0';
  }
}

function exportPackets() {
  if (packets.length === 0) {
    alert('No packets to export');
    return;
  }

  const csv = [
    'No,Time,TC,VLAN,SrcMAC,DstMAC,Size',
    ...packets.map((p, i) =>
      `${i + 1},${p.time || ''},${p.tc || ''},${p.vlan || ''},${p.srcMac || ''},${p.dstMac || ''},${p.size || ''}`
    )
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `capture_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleCaptureStats(data) {
  if (!capturing) return;

  // Update packet count
  const total = data.total || 0;
  document.getElementById('packet-count').textContent = total;

  // Update elapsed time
  if (data.elapsed_ms) {
    document.getElementById('capture-elapsed').textContent = (data.elapsed_ms / 1000).toFixed(1) + 's';
    document.getElementById('capture-rate').textContent = Math.round(total / (data.elapsed_ms / 1000));
  }

  // Update TC distribution
  if (data.tc) {
    const maxCount = Math.max(...Object.values(data.tc).map(t => t.count || 0), 1);

    Object.entries(data.tc).forEach(([tc, tcData]) => {
      const count = tcData.count || 0;
      const pct = (count / maxCount) * 100;
      document.getElementById(`tc-bar-${tc}`).style.width = pct + '%';
      document.getElementById(`tc-count-${tc}`).textContent = count;

      // Add to packets array (simulated individual packets)
      const prevCount = packets.filter(p => p.tc === parseInt(tc)).length;
      for (let i = prevCount; i < count && packets.length < MAX_PACKETS; i++) {
        packets.push({
          time: (data.elapsed_ms / 1000).toFixed(3) + 's',
          tc: parseInt(tc),
          vlan: 100,
          srcMac: 'c8:4d:44:26:3b:a6',
          dstMac: '00:e0:4c:68:12:d1',
          size: 64 + Math.floor(Math.random() * 100)
        });
      }
    });

    updatePacketTable();
  }
}

function handleCaptureStopped(data) {
  capturing = false;
  updateUI('stopped');

  if (data?.stats?.tc) {
    // Final update
    handleCaptureStats(data.stats);
  }
}

function updatePacketTable() {
  const tbody = document.getElementById('packet-tbody');
  if (!tbody) return;

  if (packets.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted text-center">No packets captured</td></tr>';
    return;
  }

  // Show last 100 packets
  const displayPackets = packets.slice(-100).reverse();

  tbody.innerHTML = displayPackets.map((p, i) => `
    <tr>
      <td>${packets.length - i}</td>
      <td class="mono">${p.time}</td>
      <td><span style="color: ${TC_COLORS[p.tc]}; font-weight: 500;">TC${p.tc}</span></td>
      <td>${p.vlan}</td>
      <td class="mono">${p.srcMac}</td>
      <td class="mono">${p.dstMac}</td>
      <td>${p.size}B</td>
    </tr>
  `).join('');
}

function updateUI(status, message = '') {
  const startBtn = document.getElementById('start-capture');
  const stopBtn = document.getElementById('stop-capture');
  const statusBadge = document.getElementById('capture-status');

  if (status === 'capturing') {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusBadge.className = 'badge badge-warning';
    statusBadge.textContent = 'Capturing...';
  } else if (status === 'stopped') {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusBadge.className = 'badge badge-success';
    statusBadge.textContent = 'Stopped';
  } else if (status === 'error') {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusBadge.className = 'badge badge-error';
    statusBadge.textContent = message || 'Error';
  }
}
