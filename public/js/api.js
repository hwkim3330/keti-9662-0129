/**
 * API Client for TSN Dashboard
 */
const API_BASE = '';  // Same origin

export const api = {
  /**
   * Make HTTP request
   */
  async request(method, path, data = null) {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (data) {
      options.body = JSON.stringify(data);
    }
    const res = await fetch(`${API_BASE}${path}`, options);
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json;
  },

  get: (path) => api.request('GET', path),
  post: (path, data) => api.request('POST', path, data),

  // ========== System ==========
  health: () => api.get('/api/health'),

  getInterfaces: () => api.get('/api/system/interfaces'),

  getPorts: () => api.get('/api/config/ports'),

  system: {
    getInterfaces: (refresh = false) => api.get(`/api/system/interfaces${refresh ? '?refresh=true' : ''}`),
    getMac: (iface) => api.get(`/api/system/mac/${iface}`),
    autoDetect: () => api.get('/api/system/interfaces/auto')
  },

  // ========== Board Communication ==========
  fetch: (paths, options = {}) => api.post('/api/fetch', { paths, ...options }),

  patch: (patches, options = {}) => api.post('/api/patch', { patches, ...options }),

  // ========== Capture ==========
  capture: {
    start: (iface, options = {}) => api.post('/api/capture/start-c', {
      interface: iface,
      ...options
    }),
    stop: () => api.post('/api/capture/stop-c'),
    status: () => api.get('/api/capture/status-c')
  },

  // ========== Traffic ==========
  traffic: {
    start: (iface, options = {}) => api.post('/api/traffic/start-precision', {
      interface: iface,
      ...options
    }),
    stop: () => api.post('/api/traffic/stop-precision'),
    status: () => api.get('/api/traffic/status'),
    getInterfaces: () => api.get('/api/traffic/interfaces')
  },

  // ========== PTP ==========
  ptp: {
    getStatus: () => api.get('/api/ptp/status'),
    getDataSet: (dataset) => api.get(`/api/ptp/dataset/${dataset}`)
  },

  // ========== TAS ==========
  tas: {
    getStatus: (port) => api.get(`/api/tas/status/${port}`),
    getPorts: () => api.get('/api/tas/ports'),
    configure: (port, config) => api.post(`/api/tas/configure/${port}`, config),
    enable: (port, enabled = true) => api.post(`/api/tas/enable/${port}`, { enabled })
  },

  // ========== CBS ==========
  cbs: {
    getStatus: (port) => api.get(`/api/cbs/status/${port}`),
    getPorts: () => api.get('/api/cbs/ports'),
    configure: (port, config) => api.post(`/api/cbs/configure/${port}`, config),
    estimate: (options) => api.post('/api/cbs/estimate', options)
  }
};

export default api;
