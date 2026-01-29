/**
 * Port Status - LAN9662 Switch Port Monitoring
 */

let api, ws, state;
let pollInterval = null;

export function render(appState) {
  state = appState;
  const { interfaces } = state;

  return `
    <div class="card mb-4">
      <div class="card-header">
        <span class="card-title">LAN9662 Switch Ports</span>
        <button class="btn btn-sm" id="refresh-ports">Refresh</button>
      </div>

      <div class="port-grid" id="port-grid">
        ${[1, 2, 3, 4].map(port => `
          <div class="port-card" id="port-${port}">
            <div class="port-header">
              <span class="port-name">Port ${port}</span>
              <span class="port-status badge badge-muted" id="port-${port}-status">Unknown</span>
            </div>
            <div class="port-stats">
              <div class="port-stat">
                <span class="port-stat-label">Speed</span>
                <span class="port-stat-value" id="port-${port}-speed">--</span>
              </div>
              <div class="port-stat">
                <span class="port-stat-label">Duplex</span>
                <span class="port-stat-value" id="port-${port}-duplex">--</span>
              </div>
              <div class="port-stat">
                <span class="port-stat-label">TX</span>
                <span class="port-stat-value mono" id="port-${port}-tx">0</span>
              </div>
              <div class="port-stat">
                <span class="port-stat-label">RX</span>
                <span class="port-stat-value mono" id="port-${port}-rx">0</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Host Interfaces -->
    <div class="card mb-4">
      <div class="card-header">
        <span class="card-title">Host Network Interfaces</span>
        <button class="btn btn-sm" id="refresh-interfaces">Refresh</button>
      </div>

      <table class="table">
        <thead>
          <tr>
            <th>Interface</th>
            <th>Type</th>
            <th>MAC Address</th>
            <th>IP Address</th>
            <th>Speed</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="interfaces-tbody">
          ${interfaces.map(i => `
            <tr>
              <td class="mono">${i.name}</td>
              <td>${i.type || 'ethernet'}</td>
              <td class="mono text-sm">${i.mac || '--'}</td>
              <td class="mono text-sm">${i.addresses?.[0]?.address || '--'}</td>
              <td>${i.speed ? i.speed + ' Mbps' : '--'}</td>
              <td>
                <span class="badge ${i.status === 'up' ? 'badge-success' : 'badge-error'}">
                  ${i.status || 'unknown'}
                </span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Interface Details -->
    <div class="grid grid-2">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Interface Statistics</span>
        </div>
        <div id="interface-stats">
          <p class="text-muted">Select an interface to view statistics</p>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Quick Actions</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <button class="btn" id="fetch-board-info">Fetch Board Info</button>
          <button class="btn" id="fetch-port-config">Fetch Port Config</button>
          <button class="btn" id="reset-counters">Reset Counters</button>
        </div>
        <div id="action-result" class="mt-4"></div>
      </div>
    </div>

    <style>
      .port-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
      }
      .port-card {
        background: var(--bg);
        border-radius: 8px;
        padding: 12px;
        border: 1px solid var(--border);
      }
      .port-card.up { border-color: var(--success); }
      .port-card.down { border-color: var(--error); opacity: 0.6; }
      .port-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      .port-name {
        font-weight: 600;
        font-size: 14px;
      }
      .port-stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .port-stat {
        display: flex;
        flex-direction: column;
      }
      .port-stat-label {
        font-size: 10px;
        color: var(--text-muted);
        text-transform: uppercase;
      }
      .port-stat-value {
        font-size: 13px;
        font-weight: 500;
      }

      @media (max-width: 768px) {
        .port-grid {
          grid-template-columns: repeat(2, 1fr);
        }
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
  document.getElementById('refresh-ports')?.addEventListener('click', fetchPortStatus);
  document.getElementById('refresh-interfaces')?.addEventListener('click', refreshInterfaces);
  document.getElementById('fetch-board-info')?.addEventListener('click', fetchBoardInfo);
  document.getElementById('fetch-port-config')?.addEventListener('click', fetchPortConfig);
  document.getElementById('reset-counters')?.addEventListener('click', resetCounters);

  // Interface row click
  document.querySelectorAll('#interfaces-tbody tr').forEach(row => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      const iface = row.querySelector('td')?.textContent;
      if (iface) showInterfaceStats(iface);
    });
  });
}

function startPolling() {
  fetchPortStatus();
  pollInterval = setInterval(fetchPortStatus, 2000);
}

async function fetchPortStatus() {
  // Try to fetch from board via API
  try {
    const res = await fetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/ieee802-dot1q-bridge:bridges/bridge/component/port'],
        transport: 'serial'
      })
    });

    if (res.ok) {
      const data = await res.json();
      updatePortsFromData(data);
      return;
    }
  } catch (e) {}

  // Fallback: simulate port status
  updateWithSimulatedData();
}

function updatePortsFromData(data) {
  // Parse YANG data and update ports
  // This depends on actual response format from board
  if (data?.ports) {
    data.ports.forEach((port, idx) => {
      const portNum = idx + 1;
      updatePort(portNum, port);
    });
  }
}

function updateWithSimulatedData() {
  // Simulate port status for demo
  [1, 2, 3, 4].forEach(port => {
    const isUp = port <= 2; // Ports 1,2 up, 3,4 down for demo
    updatePort(port, {
      status: isUp ? 'up' : 'down',
      speed: isUp ? '1000' : '--',
      duplex: isUp ? 'Full' : '--',
      tx: isUp ? Math.floor(Math.random() * 100000) : 0,
      rx: isUp ? Math.floor(Math.random() * 100000) : 0
    });
  });
}

function updatePort(portNum, data) {
  const card = document.getElementById(`port-${portNum}`);
  const statusEl = document.getElementById(`port-${portNum}-status`);
  const speedEl = document.getElementById(`port-${portNum}-speed`);
  const duplexEl = document.getElementById(`port-${portNum}-duplex`);
  const txEl = document.getElementById(`port-${portNum}-tx`);
  const rxEl = document.getElementById(`port-${portNum}-rx`);

  if (!card) return;

  const isUp = data.status === 'up';

  card.className = `port-card ${isUp ? 'up' : 'down'}`;
  statusEl.textContent = data.status || 'Unknown';
  statusEl.className = `port-status badge ${isUp ? 'badge-success' : 'badge-error'}`;
  speedEl.textContent = data.speed ? data.speed + ' Mbps' : '--';
  duplexEl.textContent = data.duplex || '--';
  txEl.textContent = formatNumber(data.tx || 0);
  rxEl.textContent = formatNumber(data.rx || 0);
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

async function refreshInterfaces() {
  try {
    const data = await api.system.getInterfaces(true);
    state.interfaces = data || [];
    location.reload();
  } catch (e) {
    alert('Failed to refresh interfaces: ' + e.message);
  }
}

function showInterfaceStats(ifaceName) {
  const iface = state.interfaces.find(i => i.name === ifaceName);
  if (!iface) return;

  const statsEl = document.getElementById('interface-stats');
  statsEl.innerHTML = `
    <h4 class="mb-2">${iface.name}</h4>
    <table class="table">
      <tr><td class="text-muted">Type</td><td>${iface.type || 'ethernet'}</td></tr>
      <tr><td class="text-muted">MAC</td><td class="mono">${iface.mac || '--'}</td></tr>
      <tr><td class="text-muted">Speed</td><td>${iface.speed ? iface.speed + ' Mbps' : '--'}</td></tr>
      <tr><td class="text-muted">MTU</td><td>${iface.mtu || '--'}</td></tr>
      <tr><td class="text-muted">Status</td><td>${iface.status || '--'}</td></tr>
      ${(iface.addresses || []).map(a => `
        <tr><td class="text-muted">IP (${a.family})</td><td class="mono">${a.address}/${a.netmask}</td></tr>
      `).join('')}
    </table>
  `;
}

async function fetchBoardInfo() {
  const resultEl = document.getElementById('action-result');
  resultEl.innerHTML = '<span class="text-muted">Fetching...</span>';

  try {
    const res = await fetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/ietf-system:system-state/platform'],
        transport: 'serial'
      })
    });

    if (res.ok) {
      const data = await res.json();
      resultEl.innerHTML = `<pre class="mono text-sm">${JSON.stringify(data, null, 2)}</pre>`;
    } else {
      resultEl.innerHTML = '<span class="text-error">Failed to fetch</span>';
    }
  } catch (e) {
    resultEl.innerHTML = `<span class="text-error">${e.message}</span>`;
  }
}

async function fetchPortConfig() {
  const resultEl = document.getElementById('action-result');
  resultEl.innerHTML = '<span class="text-muted">Fetching...</span>';

  try {
    const res = await fetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/ieee802-dot1q-bridge:bridges'],
        transport: 'serial'
      })
    });

    if (res.ok) {
      const data = await res.json();
      resultEl.innerHTML = `<pre class="mono text-sm" style="max-height: 200px; overflow: auto;">${JSON.stringify(data, null, 2)}</pre>`;
    } else {
      resultEl.innerHTML = '<span class="text-error">Failed to fetch</span>';
    }
  } catch (e) {
    resultEl.innerHTML = `<span class="text-error">${e.message}</span>`;
  }
}

async function resetCounters() {
  // This would send a command to reset port counters
  const resultEl = document.getElementById('action-result');
  resultEl.innerHTML = '<span class="text-success">Counters reset (simulated)</span>';
}
