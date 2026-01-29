/**
 * TAS Dashboard - Time-Aware Shaper (IEEE 802.1Qbv)
 * Clean, spacious design
 */

let api, ws, state;
let currentPort = '2';
let refreshTimer = null;
let captureActive = false;
let rxPackets = [];

// TC Colors (grayscale to blue gradient from CSS)
const TC_COLORS = [
  'var(--tc0)', 'var(--tc1)', 'var(--tc2)', 'var(--tc3)',
  'var(--tc4)', 'var(--tc5)', 'var(--tc6)', 'var(--tc7)'
];

const TC_HEX = [
  '#94a3b8', '#64748b', '#475569', '#334155',
  '#1e3a5f', '#1e40af', '#3730a3', '#4c1d95'
];

export function render(appState) {
  state = appState;

  return `
    <div class="tas-page">
      <style>
        .tas-page {
          max-width: 1200px;
          margin: 0 auto;
        }

        .section {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 24px;
        }

        .section-title {
          font-size: 16px;
          font-weight: 600;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .section-title .badge {
          font-size: 11px;
        }

        /* Port Selector */
        .port-selector {
          display: flex;
          gap: 12px;
          margin-bottom: 24px;
        }

        .port-btn {
          padding: 12px 32px;
          border: 2px solid var(--border);
          border-radius: 8px;
          background: var(--bg);
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }

        .port-btn:hover {
          border-color: var(--primary);
        }

        .port-btn.active {
          background: var(--primary);
          border-color: var(--primary);
          color: #fff;
        }

        /* Status Grid */
        .status-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 20px;
        }

        .status-card {
          background: var(--bg);
          border-radius: 8px;
          padding: 20px;
          text-align: center;
        }

        .status-card .label {
          font-size: 12px;
          color: var(--text-muted);
          margin-bottom: 8px;
        }

        .status-card .value {
          font-size: 20px;
          font-weight: 700;
          font-family: 'SF Mono', monospace;
        }

        /* GCL Editor */
        .gcl-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .cycle-input {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .cycle-input input {
          width: 100px;
          padding: 8px 12px;
          border: 1px solid var(--border);
          border-radius: 6px;
          font-size: 14px;
          text-align: center;
        }

        .gcl-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 20px;
        }

        .gcl-entry {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 16px;
          background: var(--bg);
          border-radius: 8px;
        }

        .gcl-entry .index {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-muted);
          width: 30px;
        }

        .gate-buttons {
          display: flex;
          gap: 6px;
        }

        .gate-btn {
          width: 36px;
          height: 36px;
          border: 2px solid var(--border);
          border-radius: 6px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s;
          background: var(--card);
        }

        .gate-btn:hover {
          transform: scale(1.1);
        }

        .gate-btn.open {
          color: #fff;
          border-color: transparent;
        }

        .interval-input {
          width: 80px;
          padding: 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          text-align: center;
        }

        .remove-btn {
          padding: 8px 12px;
          background: none;
          border: 1px solid var(--border);
          border-radius: 6px;
          cursor: pointer;
          color: var(--text-muted);
        }

        .remove-btn:hover {
          background: var(--error);
          color: #fff;
          border-color: var(--error);
        }

        .gcl-actions {
          display: flex;
          gap: 12px;
        }

        /* Timeline */
        .timeline-container {
          background: var(--bg);
          border-radius: 8px;
          padding: 20px;
          overflow-x: auto;
        }

        .timeline-row {
          display: flex;
          align-items: center;
          height: 28px;
          margin-bottom: 4px;
        }

        .timeline-label {
          width: 50px;
          font-size: 12px;
          font-weight: 600;
          color: var(--text-muted);
        }

        .timeline-bar {
          flex: 1;
          height: 20px;
          display: flex;
          border-radius: 4px;
          overflow: hidden;
        }

        .timeline-segment {
          height: 100%;
          transition: all 0.2s;
        }

        .timeline-segment.open {
          opacity: 1;
        }

        .timeline-segment.closed {
          opacity: 0.15;
        }

        /* Traffic Test */
        .test-controls {
          display: grid;
          grid-template-columns: 1fr 1fr 120px 120px auto;
          gap: 16px;
          align-items: end;
          margin-bottom: 20px;
        }

        .form-group label {
          display: block;
          font-size: 12px;
          color: var(--text-muted);
          margin-bottom: 6px;
        }

        .form-group select,
        .form-group input {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: 6px;
          font-size: 14px;
        }

        .tc-chips {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 20px;
        }

        .tc-chip {
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          opacity: 0.4;
          transition: all 0.15s;
          color: #fff;
        }

        .tc-chip.selected {
          opacity: 1;
          transform: scale(1.05);
        }

        /* Stats */
        .stats-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
        }

        .stats-box {
          background: var(--bg);
          border-radius: 8px;
          padding: 20px;
        }

        .stats-box .title {
          font-size: 13px;
          font-weight: 600;
          margin-bottom: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .stats-numbers {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 16px;
        }

        .stat-item {
          text-align: center;
        }

        .stat-item .num {
          font-size: 28px;
          font-weight: 700;
          font-family: 'SF Mono', monospace;
        }

        .stat-item .label {
          font-size: 11px;
          color: var(--text-muted);
        }

        .tc-breakdown {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .tc-stat {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          background: var(--card);
          border-radius: 4px;
          font-size: 12px;
        }

        .tc-stat .dot {
          width: 8px;
          height: 8px;
          border-radius: 2px;
        }

        /* Packet Table */
        .packet-section {
          margin-top: 24px;
        }

        .packet-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .packet-table-wrap {
          max-height: 350px;
          overflow-y: auto;
          border: 1px solid var(--border);
          border-radius: 8px;
        }

        .packet-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          font-family: 'SF Mono', monospace;
        }

        .packet-table th {
          position: sticky;
          top: 0;
          background: var(--bg-dark);
          color: var(--text-light);
          padding: 12px;
          text-align: left;
          font-weight: 500;
        }

        .packet-table td {
          padding: 10px 12px;
          border-bottom: 1px solid var(--border);
        }

        .packet-table tbody tr:hover {
          background: var(--bg);
        }

        .dir-rx { color: var(--success); }
        .interval-ok { color: var(--success); }
        .interval-warn { color: var(--warning); }

        .empty-msg {
          padding: 60px;
          text-align: center;
          color: var(--text-muted);
        }
      </style>

      <!-- TAS Status Section -->
      <div class="section">
        <div class="section-title">
          TAS Status
          <span class="badge badge-info">802.1Qbv</span>
        </div>

        <div class="port-selector">
          <button class="port-btn ${currentPort === '1' ? 'active' : ''}" id="port1-btn">Port 1</button>
          <button class="port-btn ${currentPort === '2' ? 'active' : ''}" id="port2-btn">Port 2</button>
        </div>

        <div class="status-grid" id="status-grid">
          <div class="status-card">
            <div class="label">Gate Enabled</div>
            <div class="value" id="stat-enabled">--</div>
          </div>
          <div class="status-card">
            <div class="label">GCL Entries</div>
            <div class="value" id="stat-entries">--</div>
          </div>
          <div class="status-card">
            <div class="label">Cycle Time</div>
            <div class="value" id="stat-cycle">--</div>
          </div>
          <div class="status-card">
            <div class="label">Gate States</div>
            <div class="value" id="stat-gates">--</div>
          </div>
        </div>
      </div>

      <!-- GCL Configuration Section -->
      <div class="section">
        <div class="section-title">Gate Control List Configuration</div>

        <div class="gcl-header">
          <div class="cycle-input">
            <span>Cycle Time:</span>
            <input type="number" id="cycle-time" value="200" min="10" max="10000">
            <span>ms</span>
          </div>
          <button class="btn" id="add-entry-btn">+ Add Entry</button>
        </div>

        <div class="gcl-list" id="gcl-list"></div>

        <div class="gcl-actions">
          <button class="btn btn-primary" id="apply-btn">Apply GCL</button>
          <button class="btn btn-success" id="enable-btn">Enable TAS</button>
          <button class="btn" id="disable-btn">Disable TAS</button>
        </div>
      </div>

      <!-- Timeline Section -->
      <div class="section">
        <div class="section-title">GCL Timeline</div>
        <div class="timeline-container" id="timeline"></div>
      </div>

      <!-- Traffic Test Section -->
      <div class="section">
        <div class="section-title">Traffic Test</div>

        <div class="test-controls">
          <div class="form-group">
            <label>TX Interface</label>
            <select id="tx-iface"></select>
          </div>
          <div class="form-group">
            <label>RX Interface</label>
            <select id="rx-iface"></select>
          </div>
          <div class="form-group">
            <label>Packets/sec</label>
            <input type="number" id="pps" value="500" min="10" max="10000">
          </div>
          <div class="form-group">
            <label>Duration</label>
            <input type="number" id="duration" value="10" min="1" max="60">
          </div>
          <div class="form-group" style="padding-top: 22px;">
            <button class="btn btn-success" id="start-btn">Start</button>
            <button class="btn" id="stop-btn" disabled>Stop</button>
          </div>
        </div>

        <div class="tc-chips" id="tc-chips">
          ${[0,1,2,3,4,5,6,7].map(i => `
            <span class="tc-chip ${i < 4 ? 'selected' : ''}" data-tc="${i}" style="background: ${TC_HEX[i]}">TC${i}</span>
          `).join('')}
        </div>

        <div class="stats-row">
          <div class="stats-box">
            <div class="title">RX Statistics <span class="badge" id="rx-status">Idle</span></div>
            <div class="stats-numbers">
              <div class="stat-item">
                <div class="num" id="rx-total">0</div>
                <div class="label">PACKETS</div>
              </div>
              <div class="stat-item">
                <div class="num" id="rx-pps">0</div>
                <div class="label">PPS</div>
              </div>
            </div>
            <div class="tc-breakdown" id="tc-breakdown"></div>
          </div>

          <div class="stats-box">
            <div class="title">Latency Analysis</div>
            <div class="stats-numbers">
              <div class="stat-item">
                <div class="num" id="avg-interval">--</div>
                <div class="label">AVG INTERVAL (ms)</div>
              </div>
              <div class="stat-item">
                <div class="num" id="jitter">--</div>
                <div class="label">JITTER (ms)</div>
              </div>
            </div>
          </div>
        </div>

        <div class="packet-section">
          <div class="packet-header">
            <span>Packet Capture</span>
            <span class="text-muted text-sm" id="pkt-count">0 packets</span>
          </div>
          <div class="packet-table-wrap">
            <table class="packet-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time</th>
                  <th>TC</th>
                  <th>VLAN</th>
                  <th>Size</th>
                  <th>Interval</th>
                </tr>
              </thead>
              <tbody id="pkt-body">
                <tr><td colspan="6" class="empty-msg">Start a test to capture packets</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

export async function init(appState, deps) {
  state = appState;
  api = deps.api;
  ws = deps.ws;

  renderGCL();
  setupEvents();
  await loadInterfaces();
  await loadStatus();

  if (ws && ws.on) {
    ws.on('packet', addPacket);
    ws.on('stats', updateStats);
  }

  refreshTimer = setInterval(loadStatus, 5000);
}

export function cleanup() {
  if (refreshTimer) clearInterval(refreshTimer);
}

function renderGCL() {
  const list = document.getElementById('gcl-list');
  if (!list) return;

  const entries = getGCLEntries();
  list.innerHTML = entries.map((e, i) => `
    <div class="gcl-entry" data-idx="${i}">
      <span class="index">#${i}</span>
      <div class="gate-buttons">
        ${[0,1,2,3,4,5,6,7].map(tc => `
          <button class="gate-btn ${(e.gates >> tc) & 1 ? 'open' : ''}"
                  data-tc="${tc}"
                  style="background: ${(e.gates >> tc) & 1 ? TC_HEX[tc] : ''}">${tc}</button>
        `).join('')}
      </div>
      <input type="number" class="interval-input" value="${e.interval}" min="1" max="1000">
      <span class="text-muted">ms</span>
      <button class="remove-btn">×</button>
    </div>
  `).join('');

  renderTimeline();
}

function getGCLEntries() {
  const list = document.getElementById('gcl-list');
  if (!list || !list.children.length) {
    return [
      { gates: 0b00000011, interval: 50 },
      { gates: 0b00000101, interval: 50 },
      { gates: 0b00001001, interval: 50 },
      { gates: 0b00000001, interval: 50 }
    ];
  }

  return Array.from(list.querySelectorAll('.gcl-entry')).map(el => {
    let gates = 0;
    el.querySelectorAll('.gate-btn.open').forEach(btn => {
      gates |= (1 << parseInt(btn.dataset.tc));
    });
    const interval = parseInt(el.querySelector('.interval-input')?.value) || 50;
    return { gates, interval };
  });
}

function renderTimeline() {
  const container = document.getElementById('timeline');
  if (!container) return;

  const entries = getGCLEntries();
  const total = entries.reduce((s, e) => s + e.interval, 0);

  container.innerHTML = [0,1,2,3,4,5,6,7].map(tc => `
    <div class="timeline-row">
      <span class="timeline-label">TC${tc}</span>
      <div class="timeline-bar">
        ${entries.map(e => {
          const w = (e.interval / total) * 100;
          const open = (e.gates >> tc) & 1;
          return `<div class="timeline-segment ${open ? 'open' : 'closed'}" style="width: ${w}%; background: ${TC_HEX[tc]};"></div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

function setupEvents() {
  document.getElementById('port1-btn')?.addEventListener('click', () => selectPort('1'));
  document.getElementById('port2-btn')?.addEventListener('click', () => selectPort('2'));

  document.getElementById('gcl-list')?.addEventListener('click', e => {
    if (e.target.classList.contains('gate-btn')) {
      const open = e.target.classList.toggle('open');
      e.target.style.background = open ? TC_HEX[e.target.dataset.tc] : '';
      renderTimeline();
    }
    if (e.target.classList.contains('remove-btn')) {
      if (document.querySelectorAll('.gcl-entry').length > 1) {
        e.target.closest('.gcl-entry')?.remove();
        reindex();
        renderTimeline();
      }
    }
  });

  document.getElementById('gcl-list')?.addEventListener('change', e => {
    if (e.target.classList.contains('interval-input')) renderTimeline();
  });

  document.getElementById('add-entry-btn')?.addEventListener('click', addEntry);
  document.getElementById('apply-btn')?.addEventListener('click', applyGCL);
  document.getElementById('enable-btn')?.addEventListener('click', () => enableTAS(true));
  document.getElementById('disable-btn')?.addEventListener('click', () => enableTAS(false));

  document.getElementById('tc-chips')?.addEventListener('click', e => {
    if (e.target.classList.contains('tc-chip')) {
      e.target.classList.toggle('selected');
    }
  });

  document.getElementById('start-btn')?.addEventListener('click', startTest);
  document.getElementById('stop-btn')?.addEventListener('click', stopTest);
}

function selectPort(p) {
  currentPort = p;
  document.getElementById('port1-btn')?.classList.toggle('active', p === '1');
  document.getElementById('port2-btn')?.classList.toggle('active', p === '2');
  loadStatus();
}

function addEntry() {
  const entries = document.querySelectorAll('.gcl-entry');
  if (entries.length >= 8) {
    alert('Maximum 8 entries');
    return;
  }
  const list = document.getElementById('gcl-list');
  const div = document.createElement('div');
  div.className = 'gcl-entry';
  div.dataset.idx = entries.length;
  div.innerHTML = `
    <span class="index">#${entries.length}</span>
    <div class="gate-buttons">
      ${[0,1,2,3,4,5,6,7].map(tc => `
        <button class="gate-btn" data-tc="${tc}">${tc}</button>
      `).join('')}
    </div>
    <input type="number" class="interval-input" value="50" min="1" max="1000">
    <span class="text-muted">ms</span>
    <button class="remove-btn">×</button>
  `;
  list?.appendChild(div);
  renderTimeline();
}

function reindex() {
  document.querySelectorAll('.gcl-entry').forEach((el, i) => {
    el.dataset.idx = i;
    el.querySelector('.index').textContent = `#${i}`;
  });
}

async function loadInterfaces() {
  try {
    const list = await api.traffic.getInterfaces();
    const usb = list.filter(i => i.name.startsWith('enx'));
    const opts = (usb.length >= 2 ? usb : list.filter(i => i.name.startsWith('en')))
      .map(i => `<option value="${i.name}">${i.name}</option>`).join('');

    document.getElementById('tx-iface').innerHTML = opts;
    document.getElementById('rx-iface').innerHTML = opts;

    if (usb.length >= 2) {
      document.getElementById('tx-iface').value = usb[0].name;
      document.getElementById('rx-iface').value = usb[1].name;
    }
  } catch (e) {}
}

async function loadStatus() {
  try {
    const data = await api.tas.getStatus(currentPort);
    const cfg = data.config?.['ieee802-dot1q-sched-bridge:gate-parameter-table'] || {};

    document.getElementById('stat-enabled').innerHTML = cfg['gate-enabled']
      ? '<span class="badge badge-success">ON</span>'
      : '<span class="badge">OFF</span>';

    const oper = cfg['oper-control-list']?.['gate-control-entry']?.length || 0;
    const admin = cfg['admin-control-list']?.['gate-control-entry']?.length || 0;
    document.getElementById('stat-entries').textContent = `${oper} / ${admin}`;

    const cycle = cfg['oper-cycle-time'];
    document.getElementById('stat-cycle').textContent = cycle
      ? `${(cycle.numerator / 1000000).toFixed(0)}ms`
      : '--';

    const gates = cfg['oper-gate-states'];
    if (gates !== undefined) {
      document.getElementById('stat-gates').innerHTML = [0,1,2,3,4,5,6,7].map(i =>
        `<span style="display:inline-block;width:18px;height:18px;border-radius:3px;margin:1px;
          background:${(gates >> i) & 1 ? TC_HEX[i] : '#333'};color:${(gates >> i) & 1 ? '#fff' : '#666'};
          font-size:10px;text-align:center;line-height:18px;">${i}</span>`
      ).join('');
    }
  } catch (e) {}
}

async function applyGCL() {
  const btn = document.getElementById('apply-btn');
  btn.disabled = true;
  btn.textContent = 'Applying...';

  try {
    const entries = getGCLEntries();
    if (entries.length === 0) throw new Error('Add at least one entry');

    const totalNs = entries.reduce((s, e) => s + e.interval * 1000000, 0);
    const status = await api.tas.getStatus(currentPort);
    const cfg = status.config?.['ieee802-dot1q-sched-bridge:gate-parameter-table'] || {};
    const baseTime = (cfg['current-time']?.seconds || 0) + 10;

    await api.tas.configure(currentPort, {
      gateEnabled: true,
      baseTime: { seconds: baseTime, nanoseconds: 0 },
      cycleTime: { numerator: totalNs, denominator: 1000000000 },
      entries: entries.map(e => ({ gateStates: e.gates, interval: e.interval * 1000000 }))
    });

    setTimeout(loadStatus, 12000);
    alert('GCL applied! Activating in ~10 seconds.');
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply GCL';
  }
}

async function enableTAS(enabled) {
  try {
    await api.tas.enable(currentPort, enabled);
    await loadStatus();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function startTest() {
  const txIface = document.getElementById('tx-iface')?.value;
  const rxIface = document.getElementById('rx-iface')?.value;
  const pps = parseInt(document.getElementById('pps')?.value) || 500;
  const duration = parseInt(document.getElementById('duration')?.value) || 10;

  const tcList = [];
  document.querySelectorAll('.tc-chip.selected').forEach(el => {
    tcList.push(parseInt(el.dataset.tc));
  });

  if (!txIface || !rxIface) return alert('Select interfaces');
  if (tcList.length === 0) return alert('Select at least one TC');

  let dstMac;
  try {
    const r = await api.system.getMac(rxIface);
    dstMac = r.mac;
  } catch {
    return alert('Could not get MAC address');
  }

  rxPackets = [];
  updatePacketTable();
  captureActive = true;

  document.getElementById('start-btn').disabled = true;
  document.getElementById('stop-btn').disabled = false;
  document.getElementById('rx-status').textContent = 'Running';
  document.getElementById('rx-status').className = 'badge badge-success';

  try {
    try { await api.capture.stop(); await api.traffic.stop(); } catch {}

    await api.capture.start(rxIface, { duration: duration + 5 });
    await api.traffic.start(txIface, { dstMac, vlanId: 100, tcList, packetsPerSecond: pps, duration });

    pollStats();
  } catch (e) {
    alert('Error: ' + e.message);
    stopTest();
  }
}

async function stopTest() {
  captureActive = false;
  try { await api.capture.stop(); await api.traffic.stop(); } catch {}

  document.getElementById('start-btn').disabled = false;
  document.getElementById('stop-btn').disabled = true;
  document.getElementById('rx-status').textContent = 'Done';
  document.getElementById('rx-status').className = 'badge badge-info';
}

async function pollStats() {
  if (!captureActive) return;

  try {
    const s = await api.capture.status();
    if (s.stats) updateStats(s.stats);

    if (s.running) {
      setTimeout(pollStats, 500);
    } else {
      stopTest();
    }
  } catch {
    setTimeout(pollStats, 1000);
  }
}

function updateStats(stats) {
  const total = stats.packets || 0;
  document.getElementById('rx-total').textContent = total.toLocaleString();

  const elapsed = stats.elapsed_ms || 1;
  document.getElementById('rx-pps').textContent = Math.round(total / (elapsed / 1000));

  if (stats.tc) {
    document.getElementById('tc-breakdown').innerHTML = Object.entries(stats.tc).map(([tc, d]) => `
      <div class="tc-stat">
        <span class="dot" style="background: ${TC_HEX[tc]}"></span>
        <span>TC${tc}</span>
        <span class="mono">${d.count}</span>
      </div>
    `).join('');

    const firstTC = Object.values(stats.tc)[0];
    if (firstTC) {
      document.getElementById('avg-interval').textContent = (firstTC.avg_us / 1000).toFixed(2);
      const jitter = (firstTC.max_us - firstTC.min_us) / 1000;
      document.getElementById('jitter').textContent = jitter.toFixed(2);
    }

    // Add packets to table
    Object.entries(stats.tc).forEach(([tc, d]) => {
      if (d.count > rxPackets.filter(p => p.tc == tc).length) {
        addPacket({ tc: parseInt(tc), vlan: 100, size: 100, interval_us: d.avg_us });
      }
    });
  }
}

function addPacket(data) {
  rxPackets.push({
    id: rxPackets.length + 1,
    time: new Date(),
    tc: data.tc,
    vlan: data.vlan || 100,
    size: data.size || 100,
    interval: data.interval_us || 0
  });

  if (rxPackets.length > 200) rxPackets.shift();
  updatePacketTable();
}

function updatePacketTable() {
  const body = document.getElementById('pkt-body');
  document.getElementById('pkt-count').textContent = `${rxPackets.length} packets`;

  if (rxPackets.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-msg">Start a test to capture packets</td></tr>';
    return;
  }

  body.innerHTML = rxPackets.slice(-50).reverse().map((p, i) => `
    <tr>
      <td>${rxPackets.length - i}</td>
      <td>${p.time.toLocaleTimeString()}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${TC_HEX[p.tc]};color:#fff;font-weight:600;">TC${p.tc}</span></td>
      <td>${p.vlan}</td>
      <td>${p.size}B</td>
      <td class="${p.interval < 15000 ? 'interval-ok' : 'interval-warn'}">${(p.interval / 1000).toFixed(2)}ms</td>
    </tr>
  `).join('');
}
