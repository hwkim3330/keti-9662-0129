/**
 * Traffic Generator Tool
 */

let api, ws, state;
let sending = false;

const TC_COLORS = ['#94a3b8', '#64748b', '#475569', '#334155', '#1e3a5f', '#1e40af', '#3730a3', '#4c1d95'];

export function render(appState) {
  state = appState;
  const { interfaces, config } = state;

  return `
    <div class="grid grid-2 mb-4">
      <!-- Generator Config -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Traffic Generator</span>
          <span class="badge" id="gen-status">Ready</span>
        </div>

        <div class="input-group">
          <label class="input-label">TX Interface</label>
          <select class="select" id="tx-interface">
            <option value="">Select interface...</option>
            ${interfaces.map(i => `
              <option value="${i.name}" data-mac="${i.mac}">${i.name} (${i.mac || 'no mac'})</option>
            `).join('')}
          </select>
        </div>

        <div class="grid grid-2" style="gap: 8px;">
          <div class="input-group">
            <label class="input-label">Source MAC</label>
            <input type="text" class="input mono" id="src-mac" value="" placeholder="Auto-detect">
          </div>
          <div class="input-group">
            <label class="input-label">Destination MAC</label>
            <input type="text" class="input mono" id="dst-mac" value="" placeholder="00:e0:4c:68:12:d1">
          </div>
        </div>

        <div class="grid grid-3" style="gap: 8px;">
          <div class="input-group">
            <label class="input-label">VLAN ID</label>
            <input type="number" class="input" id="vlan-id" value="${config.vlanId}" min="1" max="4094">
          </div>
          <div class="input-group">
            <label class="input-label">PPS (per TC)</label>
            <input type="number" class="input" id="pps" value="${config.pps}" min="1" max="10000">
          </div>
          <div class="input-group">
            <label class="input-label">Duration (sec)</label>
            <input type="number" class="input" id="duration" value="${config.duration}" min="1" max="300">
          </div>
        </div>

        <div class="input-group">
          <label class="input-label">Traffic Classes</label>
          <div class="tc-selector" id="tc-selector">
            ${[0,1,2,3,4,5,6,7].map(tc => `
              <button class="tc-btn ${config.tcList.includes(tc) ? 'active' : ''}" data-tc="${tc}"
                style="--tc-color: ${TC_COLORS[tc]}">TC${tc}</button>
            `).join('')}
          </div>
        </div>

        <div style="display: flex; gap: 8px; margin-top: 12px;">
          <button class="btn btn-primary" id="start-gen" style="flex: 1;">
            Start Traffic
          </button>
          <button class="btn btn-error" id="stop-gen" style="flex: 1;" disabled>
            Stop
          </button>
        </div>
      </div>

      <!-- Status -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Status</span>
        </div>

        <div class="metric" style="margin: 16px 0;">
          <div class="metric-value" id="total-sent">0</div>
          <div class="metric-label">Total Packets Sent</div>
        </div>

        <div class="grid grid-3">
          <div class="metric">
            <div class="metric-value text-sm" id="actual-pps">0</div>
            <div class="metric-label">Actual PPS</div>
          </div>
          <div class="metric">
            <div class="metric-value text-sm" id="elapsed">0s</div>
            <div class="metric-label">Elapsed</div>
          </div>
          <div class="metric">
            <div class="metric-value text-sm" id="throughput">0</div>
            <div class="metric-label">kbps</div>
          </div>
        </div>

        <!-- Per-TC sent count -->
        <div class="mt-4">
          <label class="input-label">Per-TC Sent</label>
          <div id="tc-sent-bars">
            ${[0,1,2,3,4,5,6,7].map(tc => `
              <div class="tc-bar-row">
                <span class="tc-bar-label" style="color: ${TC_COLORS[tc]}">TC${tc}</span>
                <div class="tc-bar-container">
                  <div class="tc-bar" id="tc-sent-bar-${tc}" style="width: 0%; background: ${TC_COLORS[tc]};"></div>
                </div>
                <span class="tc-bar-count" id="tc-sent-${tc}">0</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>

    <!-- Quick Send -->
    <div class="card mb-4">
      <div class="card-header">
        <span class="card-title">Quick Send</span>
        <span class="text-xs text-muted">Send individual packets for testing</span>
      </div>

      <div class="grid grid-4" style="gap: 8px; align-items: end;">
        <div class="input-group">
          <label class="input-label">TC/PCP</label>
          <select class="select" id="quick-tc">
            ${[0,1,2,3,4,5,6,7].map(tc => `<option value="${tc}">TC${tc}</option>`).join('')}
          </select>
        </div>
        <div class="input-group">
          <label class="input-label">Count</label>
          <input type="number" class="input" id="quick-count" value="10" min="1" max="1000">
        </div>
        <div class="input-group">
          <label class="input-label">Packet Size</label>
          <input type="number" class="input" id="quick-size" value="64" min="64" max="1500">
        </div>
        <button class="btn btn-primary" id="quick-send">Send</button>
      </div>
    </div>

    <!-- Presets -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Presets</span>
      </div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="btn" data-preset="low-rate">Low Rate (10 pps)</button>
        <button class="btn" data-preset="medium-rate">Medium (100 pps)</button>
        <button class="btn" data-preset="high-rate">High Rate (1000 pps)</button>
        <button class="btn" data-preset="burst">Burst (5000 pps, 1s)</button>
        <button class="btn" data-preset="all-tc">All TCs</button>
        <button class="btn" data-preset="priority-only">Priority Only (TC6,7)</button>
      </div>
    </div>

    <style>
      .tc-selector { display: flex; gap: 4px; flex-wrap: wrap; }
      .tc-btn {
        padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; font-weight: 500;
        border: 1px solid var(--border); background: var(--card); color: var(--text-muted);
        cursor: pointer; transition: all 0.15s;
      }
      .tc-btn:hover { border-color: var(--tc-color); }
      .tc-btn.active { background: var(--tc-color); color: #fff; border-color: var(--tc-color); }

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
      .tc-bar-count { width: 50px; text-align: right; font-size: 11px; font-family: monospace; }
    </style>
  `;
}

export function init(appState, deps) {
  state = appState;
  api = deps.api;
  ws = deps.ws;

  setupEventListeners();
}

function setupEventListeners() {
  // Interface selector - auto-fill MAC
  document.getElementById('tx-interface')?.addEventListener('change', (e) => {
    const option = e.target.selectedOptions[0];
    const mac = option?.dataset?.mac;
    if (mac) {
      document.getElementById('src-mac').value = mac;
    }
    state.config.txInterface = e.target.value;
  });

  // TC selector
  document.querySelectorAll('.tc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tc = parseInt(btn.dataset.tc);
      const idx = state.config.tcList.indexOf(tc);
      if (idx >= 0) {
        state.config.tcList.splice(idx, 1);
      } else {
        state.config.tcList.push(tc);
        state.config.tcList.sort();
      }
      btn.classList.toggle('active');
    });
  });

  // Start/Stop
  document.getElementById('start-gen')?.addEventListener('click', startGenerator);
  document.getElementById('stop-gen')?.addEventListener('click', stopGenerator);

  // Quick send
  document.getElementById('quick-send')?.addEventListener('click', quickSend);

  // Presets
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });
}

async function startGenerator() {
  const iface = document.getElementById('tx-interface')?.value;
  const dstMac = document.getElementById('dst-mac')?.value;

  if (!iface) {
    alert('Please select TX interface');
    return;
  }

  if (!dstMac) {
    alert('Please enter destination MAC');
    return;
  }

  if (state.config.tcList.length === 0) {
    alert('Please select at least one Traffic Class');
    return;
  }

  sending = true;
  updateUI('sending');

  const pps = parseInt(document.getElementById('pps')?.value) || 100;
  const duration = parseInt(document.getElementById('duration')?.value) || 5;
  const vlanId = parseInt(document.getElementById('vlan-id')?.value) || 100;

  try {
    const result = await api.traffic.start(iface, {
      dstMac,
      srcMac: document.getElementById('src-mac')?.value || undefined,
      vlanId,
      tcList: state.config.tcList,
      packetsPerSecond: pps * state.config.tcList.length,
      duration
    });

    // Poll for results
    setTimeout(async () => {
      const status = await api.traffic.status();
      updateResults(status);
      sending = false;
      updateUI('done');
    }, (duration + 1) * 1000);

  } catch (err) {
    console.error('Traffic error:', err);
    sending = false;
    updateUI('error', err.message);
  }
}

async function stopGenerator() {
  try {
    await api.traffic.stop();
  } catch (e) {}
  sending = false;
  updateUI('stopped');
}

async function quickSend() {
  const iface = document.getElementById('tx-interface')?.value;
  const dstMac = document.getElementById('dst-mac')?.value;

  if (!iface || !dstMac) {
    alert('Please select interface and enter destination MAC');
    return;
  }

  const tc = parseInt(document.getElementById('quick-tc')?.value) || 0;
  const count = parseInt(document.getElementById('quick-count')?.value) || 10;
  const size = parseInt(document.getElementById('quick-size')?.value) || 64;
  const vlanId = parseInt(document.getElementById('vlan-id')?.value) || 100;

  try {
    // Send multiple packets
    for (let i = 0; i < count; i++) {
      await fetch('/api/traffic/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interface: iface,
          dstMac,
          srcMac: document.getElementById('src-mac')?.value || undefined,
          vlanId,
          pcp: tc,
          packetSize: size
        })
      });
    }
    alert(`Sent ${count} packets (TC${tc})`);
  } catch (err) {
    alert('Failed to send: ' + err.message);
  }
}

function applyPreset(preset) {
  switch (preset) {
    case 'low-rate':
      document.getElementById('pps').value = 10;
      break;
    case 'medium-rate':
      document.getElementById('pps').value = 100;
      break;
    case 'high-rate':
      document.getElementById('pps').value = 1000;
      break;
    case 'burst':
      document.getElementById('pps').value = 5000;
      document.getElementById('duration').value = 1;
      break;
    case 'all-tc':
      state.config.tcList = [0, 1, 2, 3, 4, 5, 6, 7];
      document.querySelectorAll('.tc-btn').forEach(btn => btn.classList.add('active'));
      break;
    case 'priority-only':
      state.config.tcList = [6, 7];
      document.querySelectorAll('.tc-btn').forEach(btn => {
        const tc = parseInt(btn.dataset.tc);
        btn.classList.toggle('active', tc === 6 || tc === 7);
      });
      break;
  }
}

function updateResults(status) {
  if (!status) return;

  // Find our generator
  const gen = status.generators?.find(g => g.running === false) || status.generators?.[0];
  if (gen) {
    document.getElementById('total-sent').textContent = gen.sent || 0;
    document.getElementById('actual-pps').textContent = Math.round(gen.sent / (gen.duration / 1000));
    document.getElementById('elapsed').textContent = (gen.duration / 1000).toFixed(1) + 's';
    document.getElementById('throughput').textContent = Math.round((gen.sent * 64 * 8) / (gen.duration / 1000) / 1000);
  }
}

function updateUI(status, message = '') {
  const startBtn = document.getElementById('start-gen');
  const stopBtn = document.getElementById('stop-gen');
  const statusBadge = document.getElementById('gen-status');

  if (status === 'sending') {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusBadge.className = 'badge badge-warning';
    statusBadge.textContent = 'Sending...';
  } else if (status === 'done' || status === 'stopped') {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusBadge.className = 'badge badge-success';
    statusBadge.textContent = status === 'done' ? 'Complete' : 'Stopped';
  } else if (status === 'error') {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusBadge.className = 'badge badge-error';
    statusBadge.textContent = message || 'Error';
  }
}
