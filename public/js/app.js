/**
 * TSN Dashboard - Main Application
 */
import api from './api.js';
import ws from './websocket.js';

// State
const state = {
  currentPage: 'cbs-dashboard',
  interfaces: [],
  config: {
    txInterface: null,
    rxInterface: null,
    vlanId: 100,
    pps: 100,
    duration: 5,
    tcList: [1, 2, 3]
  }
};

// Page modules
const pages = {};

// DOM Elements
const contentEl = document.getElementById('content');
const pageTitleEl = document.getElementById('page-title');
const wsStatusEl = document.getElementById('ws-status');
const connectionStatusEl = document.getElementById('connection-status');
const refreshBtn = document.getElementById('refresh-btn');

/**
 * Initialize application
 */
async function init() {
  console.log('[App] Initializing...');

  // Connect WebSocket
  ws.connect();
  ws.on('connected', () => updateWsStatus(true));
  ws.on('disconnected', () => updateWsStatus(false));

  // Setup navigation
  setupNavigation();

  // Setup refresh button
  refreshBtn?.addEventListener('click', () => loadPage(state.currentPage));

  // Load interfaces
  await loadInterfaces();

  // Load initial page
  const hash = location.hash.slice(1) || 'cbs-dashboard';
  navigate(hash);

  console.log('[App] Ready');
}

/**
 * Setup navigation click handlers
 */
function setupNavigation() {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      navigate(page);
    });
  });

  // Handle browser back/forward
  window.addEventListener('hashchange', () => {
    const page = location.hash.slice(1) || 'cbs-dashboard';
    if (page !== state.currentPage) {
      navigate(page, false);
    }
  });
}

/**
 * Navigate to a page
 */
function navigate(page, updateHash = true) {
  // Update active nav item
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });

  // Update URL hash
  if (updateHash) {
    location.hash = page;
  }

  // Update title
  const titles = {
    'ptp-dashboard': 'PTP Dashboard',
    'tas-dashboard': 'TAS Dashboard',
    'cbs-dashboard': 'CBS Dashboard',
    'ptp-config': 'PTP Configuration',
    'tas-config': 'TAS Configuration',
    'cbs-config': 'CBS Configuration',
    'port-status': 'Port Status',
    'packet-capture': 'Packet Capture',
    'traffic-gen': 'Traffic Generator',
    'settings': 'Settings'
  };
  pageTitleEl.textContent = titles[page] || page;

  state.currentPage = page;
  loadPage(page);
}

/**
 * Load a page module dynamically
 */
async function loadPage(page) {
  contentEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    // Check if module is cached
    if (!pages[page]) {
      const module = await import(`./pages/${page}.js`);
      pages[page] = module;
    }

    // Render page
    if (pages[page].render) {
      const html = await pages[page].render(state);
      contentEl.innerHTML = html;
    }

    // Initialize page
    if (pages[page].init) {
      await pages[page].init(state, { api, ws });
    }
  } catch (err) {
    console.error(`[App] Failed to load page ${page}:`, err);
    contentEl.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title text-error">Page Not Found</span>
        </div>
        <p class="text-muted">The page "${page}" could not be loaded.</p>
        <p class="text-sm text-muted">${err.message}</p>
      </div>
    `;
  }
}

/**
 * Load available network interfaces
 */
async function loadInterfaces() {
  try {
    const data = await api.traffic.getInterfaces();
    state.interfaces = data || [];

    // Auto-select first two USB NICs
    const usbNics = state.interfaces.filter(i => i.name.startsWith('enx'));
    if (usbNics.length >= 2) {
      state.config.txInterface = usbNics[0].name;
      state.config.rxInterface = usbNics[1].name;
    } else if (usbNics.length === 1) {
      state.config.txInterface = usbNics[0].name;
    }

    console.log('[App] Interfaces loaded:', state.interfaces.length);
  } catch (err) {
    console.error('[App] Failed to load interfaces:', err);
  }
}

/**
 * Update WebSocket status indicator
 */
function updateWsStatus(connected) {
  if (wsStatusEl) {
    wsStatusEl.textContent = connected ? 'WS: OK' : 'WS: --';
    wsStatusEl.classList.toggle('connected', connected);
  }

  const dot = connectionStatusEl?.querySelector('.status-dot');
  const text = connectionStatusEl?.querySelector('.status-text');
  if (dot) dot.classList.toggle('connected', connected);
  if (text) text.textContent = connected ? 'Connected' : 'Disconnected';
}

/**
 * Get interface MAC address
 */
export function getInterfaceMac(ifaceName) {
  const iface = state.interfaces.find(i => i.name === ifaceName);
  return iface?.addresses?.find(a => a.includes(':')) || null;
}

/**
 * Format number with units
 */
export function formatNumber(num, decimals = 1) {
  if (num >= 1000000) return (num / 1000000).toFixed(decimals) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
}

// Export state and utilities for pages
export { state, api, ws };

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
