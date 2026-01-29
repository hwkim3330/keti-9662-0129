/**
 * CBS Dashboard - Credit-Based Shaper (IEEE 802.1Qav)
 */

let api, ws, state;
let testRunning = false;
let captureStats = null;
let txPackets = [];
let rxPackets = [];
let startTime = null;

const TC_COLORS = ['#94a3b8', '#64748b', '#475569', '#334155', '#1e3a5f', '#1e40af', '#3730a3', '#4c1d95'];

export function render(appState) {
  state = appState;
  const { config, interfaces } = state;

  return `
    <div class="grid grid-2 mb-4">
      <!-- Test Configuration -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Test Configuration</span>
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

        <div class="grid grid-4" style="gap: 8px;">
          <div class="input-group">
            <label class="input-label">TX Interface</label>
            <select class="select" id="tx-interface">
              <option value="">Select...</option>
              ${interfaces.map(i => `
                <option value="${i.name}" ${i.name === config.txInterface ? 'selected' : ''}>${i.name}</option>
              `).join('')}
            </select>
          </div>
          <div class="input-group">
            <label class="input-label">RX Interface</label>
            <select class="select" id="rx-interface">
              <option value="">Select...</option>
              ${interfaces.map(i => `
                <option value="${i.name}" ${i.name === config.rxInterface ? 'selected' : ''}>${i.name}</option>
              `).join('')}
            </select>
          </div>
          <div class="input-group">
            <label class="input-label">VLAN ID</label>
            <input type="number" class="input" id="vlan-id" value="${config.vlanId}" min="1" max="4094">
          </div>
          <div class="input-group">
            <label class="input-label">PPS/TC</label>
            <input type="number" class="input" id="pps" value="${config.pps}" min="1" max="10000">
          </div>
        </div>

        <div class="grid grid-2" style="gap: 8px;">
          <div class="input-group">
            <label class="input-label">Duration (sec)</label>
            <input type="number" class="input" id="duration" value="${config.duration}" min="1" max="60">
          </div>
          <div class="input-group">
            <label class="input-label">Output Port</label>
            <input type="text" class="input" id="output-port" value="1">
          </div>
        </div>

        <button class="btn btn-primary" id="run-test-btn" style="width: 100%; margin-top: 8px;">
          Run Test
        </button>
      </div>

      <!-- Network Path -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Network Path</span>
          <span class="badge badge-info" id="test-status">Ready</span>
        </div>

        <div class="network-path">
          <div class="path-node" id="tx-node">
            <div class="text-xs text-muted">TX</div>
            <div class="mono text-sm" id="tx-label">${config.txInterface || 'Not set'}</div>
          </div>
          <div class="path-arrow">→</div>
          <div class="path-node active">
            <div class="text-sm font-bold">LAN9662</div>
            <div class="text-xs text-muted">CBS Port <span id="port-label">1</span></div>
          </div>
          <div class="path-arrow">→</div>
          <div class="path-node" id="rx-node">
            <div class="text-xs text-muted">RX</div>
            <div class="mono text-sm" id="rx-label">${config.rxInterface || 'Not set'}</div>
          </div>
        </div>

        <div class="grid grid-3 mt-4" style="text-align: center;">
          <div class="metric">
            <div class="metric-value" id="tx-count">0</div>
            <div class="metric-label">TX Packets</div>
          </div>
          <div class="metric">
            <div class="metric-value" id="rx-count">0</div>
            <div class="metric-label">RX Packets</div>
          </div>
          <div class="metric">
            <div class="metric-value" id="loss-rate">0%</div>
            <div class="metric-label">Loss</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Packet Timelines -->
    <div class="grid grid-2 mb-4">
      <div class="card">
        <div class="card-header">
          <span class="card-title">TX Timeline</span>
          <span class="text-xs text-muted mono" id="tx-iface-label">${config.txInterface || ''}</span>
        </div>
        <div class="timeline" id="tx-timeline">
          ${renderTimelineGrid()}
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">RX Timeline</span>
          <span class="text-xs text-muted mono" id="rx-iface-label">${config.rxInterface || ''}</span>
        </div>
        <div class="timeline" id="rx-timeline">
          ${renderTimelineGrid()}
        </div>
      </div>
    </div>

    <!-- Results -->
    <div class="card" id="results-card" style="display: none;">
      <div class="card-header">
        <span class="card-title">Results</span>
      </div>
      <div class="grid grid-4" id="results-grid"></div>
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
    </style>
  `;
}

function renderTimelineGrid() {
  const rows = [0,1,2,3,4,5,6,7].map((tc, i) => `
    <div class="timeline-row" style="top: ${12 + i * 12}px;">
      <span class="timeline-label" style="top: 0; color: ${TC_COLORS[tc]}">TC${tc}</span>
    </div>
  `).join('');

  return rows + `
    <div style="position: absolute; bottom: 4px; left: 48px; right: 16px; display: flex; justify-content: space-between;">
      ${[0,1,2,3,4,5].map(s => `<span class="text-xs text-muted">${s}s</span>`).join('')}
    </div>
  `;
}

export function init(appState, deps) {
  state = appState;
  api = deps.api;
  ws = deps.ws;

  // Setup event listeners
  setupEventListeners();

  // Listen for WebSocket events
  ws.on('c-capture-stats', handleCaptureStats);
  ws.on('c-capture-stopped', handleCaptureStopped);
}

function setupEventListeners() {
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

  // Interface selectors
  document.getElementById('tx-interface')?.addEventListener('change', (e) => {
    state.config.txInterface = e.target.value;
    document.getElementById('tx-label').textContent = e.target.value || 'Not set';
    document.getElementById('tx-iface-label').textContent = e.target.value;
  });

  document.getElementById('rx-interface')?.addEventListener('change', (e) => {
    state.config.rxInterface = e.target.value;
    document.getElementById('rx-label').textContent = e.target.value || 'Not set';
    document.getElementById('rx-iface-label').textContent = e.target.value;
  });

  // Other inputs
  document.getElementById('vlan-id')?.addEventListener('change', (e) => {
    state.config.vlanId = parseInt(e.target.value) || 100;
  });

  document.getElementById('pps')?.addEventListener('change', (e) => {
    state.config.pps = parseInt(e.target.value) || 100;
  });

  document.getElementById('duration')?.addEventListener('change', (e) => {
    state.config.duration = parseInt(e.target.value) || 5;
  });

  // Run test button
  document.getElementById('run-test-btn')?.addEventListener('click', runTest);
}

async function runTest() {
  if (testRunning) return;

  const { config } = state;
  if (!config.txInterface || !config.rxInterface) {
    alert('Please select TX and RX interfaces');
    return;
  }

  if (config.tcList.length === 0) {
    alert('Please select at least one Traffic Class');
    return;
  }

  testRunning = true;
  startTime = Date.now();
  txPackets = [];
  rxPackets = [];
  captureStats = null;

  updateUI('running');

  try {
    // Stop any existing capture
    await api.capture.stop().catch(() => {});
    await sleep(300);

    // Start capture on RX interface
    await api.capture.start(config.rxInterface, {
      duration: config.duration + 3,
      vlanId: config.vlanId
    });

    await sleep(500);

    // Get RX interface MAC for destination
    const rxIface = state.interfaces.find(i => i.name === config.rxInterface);
    const dstMac = rxIface?.addresses?.find(a => a.includes(':')) ||
                   await getMacFromSys(config.rxInterface);

    // Generate simulated TX packets
    simulateTxPackets();

    // Start traffic
    await api.traffic.start(config.txInterface, {
      dstMac,
      vlanId: config.vlanId,
      tcList: config.tcList,
      packetsPerSecond: config.pps * config.tcList.length,
      duration: config.duration
    });

    // Wait for test to complete
    setTimeout(async () => {
      const status = await api.capture.status();
      if (status?.stats?.tc) {
        displayResults(status.stats.tc);
      }
      testRunning = false;
      updateUI('done');
    }, (config.duration + 2) * 1000);

  } catch (err) {
    console.error('Test error:', err);
    testRunning = false;
    updateUI('error', err.message);
  }
}

async function getMacFromSys(ifaceName) {
  try {
    const res = await fetch(`/api/system/mac/${ifaceName}`);
    const data = await res.json();
    return data.mac;
  } catch (e) {
    return '00:00:00:00:00:00';
  }
}

function simulateTxPackets() {
  const { config } = state;
  const intervalMs = 1000 / config.pps;
  const totalPackets = config.pps * config.duration * config.tcList.length;

  txPackets = [];
  let time = 0;

  for (let i = 0; i < totalPackets; i++) {
    const tc = config.tcList[i % config.tcList.length];
    txPackets.push({ tc, time });
    time += intervalMs;
  }

  renderTimeline('tx-timeline', txPackets);
  document.getElementById('tx-count').textContent = txPackets.length;
}

function handleCaptureStats(data) {
  if (!testRunning || !startTime) return;

  captureStats = data;
  const elapsed = Date.now() - startTime;

  // Convert stats to packets for timeline
  if (data.tc) {
    const newRxPackets = [];
    Object.entries(data.tc).forEach(([tc, tcData]) => {
      const tcNum = parseInt(tc);
      const count = tcData.count || 0;
      const prevCount = rxPackets.filter(p => p.tc === tcNum).length;
      const newCount = count - prevCount;

      for (let i = 0; i < newCount; i++) {
        newRxPackets.push({ tc: tcNum, time: elapsed - (newCount - i) * 2 });
      }
    });

    rxPackets = [...rxPackets, ...newRxPackets];
    renderTimeline('rx-timeline', rxPackets);
    document.getElementById('rx-count').textContent = data.total || rxPackets.length;

    // Update loss rate
    const loss = txPackets.length > 0 ?
      ((txPackets.length - (data.total || 0)) / txPackets.length * 100) : 0;
    document.getElementById('loss-rate').textContent =
      loss <= 0 ? '0%' : loss.toFixed(1) + '%';
  }
}

function handleCaptureStopped(data) {
  if (data?.stats?.tc) {
    displayResults(data.stats.tc);
  }
}

function renderTimeline(elementId, packets) {
  const container = document.getElementById(elementId);
  if (!container) return;

  const { config } = state;
  const maxTime = (config.duration + 1) * 1000;
  const width = container.clientWidth - 64;

  // Clear existing packets (keep grid)
  container.querySelectorAll('.timeline-packet').forEach(el => el.remove());

  packets.forEach(pkt => {
    const x = 48 + Math.min(pkt.time / maxTime, 1) * width;
    const y = 12 + pkt.tc * 12 + 2;

    const el = document.createElement('div');
    el.className = 'timeline-packet';
    el.style.cssText = `left: ${x}px; top: ${y}px; background: ${TC_COLORS[pkt.tc]};`;
    container.appendChild(el);
  });
}

function displayResults(tcStats) {
  const { config } = state;
  const card = document.getElementById('results-card');
  const grid = document.getElementById('results-grid');

  if (!card || !grid) return;

  card.style.display = 'block';
  grid.innerHTML = config.tcList.map(tc => {
    const s = tcStats[tc];
    if (!s) return '';

    const kbps = s.kbps || 0;
    return `
      <div class="card" style="margin: 0; padding: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span class="font-bold" style="color: ${TC_COLORS[tc]}">TC${tc}</span>
          <span class="badge badge-success">OK</span>
        </div>
        <div class="mono text-sm">${kbps.toFixed(1)} kbps</div>
        <div class="text-xs text-muted">${s.count} packets</div>
        <div class="text-xs text-muted">Avg: ${(s.avg_us / 1000).toFixed(2)} ms</div>
      </div>
    `;
  }).join('');
}

function updateUI(status, message = '') {
  const btn = document.getElementById('run-test-btn');
  const statusBadge = document.getElementById('test-status');

  if (status === 'running') {
    btn.disabled = true;
    btn.textContent = 'Testing...';
    statusBadge.className = 'badge badge-warning';
    statusBadge.textContent = 'Running';
  } else if (status === 'done') {
    btn.disabled = false;
    btn.textContent = 'Run Test';
    statusBadge.className = 'badge badge-success';
    statusBadge.textContent = 'Complete';
  } else if (status === 'error') {
    btn.disabled = false;
    btn.textContent = 'Run Test';
    statusBadge.className = 'badge badge-error';
    statusBadge.textContent = message || 'Error';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
