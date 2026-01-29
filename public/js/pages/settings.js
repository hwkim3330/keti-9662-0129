/**
 * Settings Page
 */

let api, state;

export function render(appState) {
  state = appState;
  const { config, interfaces } = state;

  return `
    <div class="grid grid-2">
      <!-- Interface Configuration -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Network Interfaces</span>
          <button class="btn btn-sm" id="refresh-interfaces">Refresh</button>
        </div>

        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>MAC</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="interfaces-table">
            ${interfaces.map(i => `
              <tr>
                <td class="mono">${i.name}</td>
                <td>${i.type || 'ethernet'}</td>
                <td class="mono text-sm">${i.mac || '-'}</td>
                <td>
                  <span class="badge ${i.status === 'up' ? 'badge-success' : 'badge-error'}">
                    ${i.status || 'unknown'}
                  </span>
                </td>
              </tr>
            `).join('') || '<tr><td colspan="4" class="text-muted">No interfaces found</td></tr>'}
          </tbody>
        </table>
      </div>

      <!-- Test Defaults -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Test Defaults</span>
        </div>

        <div class="input-group">
          <label class="input-label">Default TX Interface</label>
          <select class="select" id="default-tx">
            <option value="">Auto-detect</option>
            ${interfaces.map(i => `
              <option value="${i.name}" ${i.name === config.txInterface ? 'selected' : ''}>${i.name}</option>
            `).join('')}
          </select>
        </div>

        <div class="input-group">
          <label class="input-label">Default RX Interface</label>
          <select class="select" id="default-rx">
            <option value="">Auto-detect</option>
            ${interfaces.map(i => `
              <option value="${i.name}" ${i.name === config.rxInterface ? 'selected' : ''}>${i.name}</option>
            `).join('')}
          </select>
        </div>

        <div class="input-group">
          <label class="input-label">Default VLAN ID</label>
          <input type="number" class="input" id="default-vlan" value="${config.vlanId}" min="1" max="4094">
        </div>

        <div class="input-group">
          <label class="input-label">Default PPS</label>
          <input type="number" class="input" id="default-pps" value="${config.pps}" min="1" max="10000">
        </div>

        <div class="input-group">
          <label class="input-label">Default Duration (sec)</label>
          <input type="number" class="input" id="default-duration" value="${config.duration}" min="1" max="60">
        </div>

        <button class="btn btn-primary" id="save-defaults" style="width: 100%;">
          Save Defaults
        </button>
      </div>
    </div>

    <!-- Board Connection -->
    <div class="card mt-4">
      <div class="card-header">
        <span class="card-title">Board Connection</span>
        <span class="badge" id="board-status">Unknown</span>
      </div>

      <div class="grid grid-3">
        <div class="input-group">
          <label class="input-label">Transport</label>
          <select class="select" id="transport">
            <option value="serial">Serial (USB)</option>
            <option value="wifi">WiFi (ESP32)</option>
          </select>
        </div>

        <div class="input-group" id="serial-device-group">
          <label class="input-label">Device</label>
          <select class="select" id="serial-device">
            <option value="/dev/ttyACM0">/dev/ttyACM0</option>
            <option value="/dev/ttyACM1">/dev/ttyACM1</option>
            <option value="/dev/ttyUSB0">/dev/ttyUSB0</option>
          </select>
        </div>

        <div class="input-group" id="wifi-host-group" style="display: none;">
          <label class="input-label">Host</label>
          <input type="text" class="input" id="wifi-host" value="192.168.4.1">
        </div>

        <div>
          <label class="input-label">&nbsp;</label>
          <button class="btn btn-primary" id="test-connection">Test Connection</button>
        </div>
      </div>
    </div>

    <!-- System Info -->
    <div class="card mt-4">
      <div class="card-header">
        <span class="card-title">System Info</span>
      </div>
      <div class="grid grid-4">
        <div class="metric">
          <div class="metric-value" id="server-status">OK</div>
          <div class="metric-label">Server</div>
        </div>
        <div class="metric">
          <div class="metric-value" id="ws-conn">--</div>
          <div class="metric-label">WebSocket</div>
        </div>
        <div class="metric">
          <div class="metric-value">${interfaces.length}</div>
          <div class="metric-label">Interfaces</div>
        </div>
        <div class="metric">
          <div class="metric-value" id="uptime">--</div>
          <div class="metric-label">Uptime</div>
        </div>
      </div>
    </div>
  `;
}

export async function init(appState, deps) {
  state = appState;
  api = deps.api;

  // Refresh interfaces button
  document.getElementById('refresh-interfaces')?.addEventListener('click', async () => {
    try {
      const data = await api.traffic.getInterfaces();
      state.interfaces = data || [];
      location.reload();
    } catch (e) {
      alert('Failed to refresh interfaces: ' + e.message);
    }
  });

  // Save defaults
  document.getElementById('save-defaults')?.addEventListener('click', () => {
    state.config.txInterface = document.getElementById('default-tx').value;
    state.config.rxInterface = document.getElementById('default-rx').value;
    state.config.vlanId = parseInt(document.getElementById('default-vlan').value) || 100;
    state.config.pps = parseInt(document.getElementById('default-pps').value) || 100;
    state.config.duration = parseInt(document.getElementById('default-duration').value) || 5;

    localStorage.setItem('tsn-config', JSON.stringify(state.config));
    alert('Defaults saved');
  });

  // Transport toggle
  document.getElementById('transport')?.addEventListener('change', (e) => {
    const isWifi = e.target.value === 'wifi';
    document.getElementById('serial-device-group').style.display = isWifi ? 'none' : 'block';
    document.getElementById('wifi-host-group').style.display = isWifi ? 'block' : 'none';
  });

  // Test connection
  document.getElementById('test-connection')?.addEventListener('click', async () => {
    const transport = document.getElementById('transport').value;
    const statusEl = document.getElementById('board-status');

    statusEl.textContent = 'Testing...';
    statusEl.className = 'badge badge-warning';

    try {
      const result = await api.fetch(['/ietf-system:system-state/platform'], {
        transport,
        device: document.getElementById('serial-device').value,
        host: document.getElementById('wifi-host').value
      });

      statusEl.textContent = 'Connected';
      statusEl.className = 'badge badge-success';
    } catch (e) {
      statusEl.textContent = 'Failed';
      statusEl.className = 'badge badge-error';
    }
  });

  // Check health
  try {
    await api.health();
    document.getElementById('server-status').textContent = 'OK';
    document.getElementById('server-status').className = 'metric-value text-success';
  } catch (e) {
    document.getElementById('server-status').textContent = 'Error';
    document.getElementById('server-status').className = 'metric-value text-error';
  }

  // Load saved config
  const saved = localStorage.getItem('tsn-config');
  if (saved) {
    try {
      Object.assign(state.config, JSON.parse(saved));
    } catch (e) {}
  }
}
