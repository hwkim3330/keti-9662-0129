import fs from 'fs';
import path from 'path';

const NET_PATH = '/sys/class/net';

/**
 * InterfaceDetector - Detects and manages network interfaces
 */
export class InterfaceDetector {
  constructor() {
    this.cache = null;
    this.cacheTime = 0;
    this.cacheTTL = 5000; // 5 seconds
  }

  /**
   * Get all network interfaces with details
   */
  async getInterfaces(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.cache && (now - this.cacheTime) < this.cacheTTL) {
      return this.cache;
    }

    const interfaces = [];

    try {
      const dirs = fs.readdirSync(NET_PATH);

      for (const name of dirs) {
        // Skip virtual interfaces
        if (name === 'lo' || name.startsWith('docker') || name.startsWith('br-') ||
            name.startsWith('veth') || name.startsWith('virbr')) {
          continue;
        }

        const ifacePath = path.join(NET_PATH, name);
        const iface = {
          name,
          mac: this.readFile(path.join(ifacePath, 'address')),
          status: this.readFile(path.join(ifacePath, 'operstate')),
          type: this.getInterfaceType(name, ifacePath),
          speed: this.readFile(path.join(ifacePath, 'speed'), '0'),
          mtu: this.readFile(path.join(ifacePath, 'mtu'), '1500'),
        };

        // Get IP addresses
        iface.addresses = await this.getAddresses(name);

        interfaces.push(iface);
      }
    } catch (err) {
      console.error('[InterfaceDetector] Error:', err.message);
    }

    // Sort: USB NICs first (enx*), then regular (enp*, eth*), then others
    interfaces.sort((a, b) => {
      const order = (n) => {
        if (n.startsWith('enx')) return 0;  // USB NICs
        if (n.startsWith('enp') || n.startsWith('eth')) return 1;  // Built-in
        if (n.startsWith('wl')) return 2;  // WiFi
        return 3;
      };
      return order(a.name) - order(b.name);
    });

    this.cache = interfaces;
    this.cacheTime = now;
    return interfaces;
  }

  /**
   * Get USB NICs (typically used for TSN testing)
   */
  async getUsbNics() {
    const all = await this.getInterfaces();
    return all.filter(i => i.name.startsWith('enx') && i.status === 'up');
  }

  /**
   * Auto-detect TX/RX interfaces for TSN testing
   * Returns the first two USB NICs or ethernet interfaces that are up
   */
  async autoDetectTxRx() {
    const all = await this.getInterfaces();
    const candidates = all.filter(i =>
      (i.name.startsWith('enx') || i.name.startsWith('enp') || i.name.startsWith('eth')) &&
      i.status === 'up' &&
      i.mac !== '00:00:00:00:00:00'
    );

    if (candidates.length >= 2) {
      return {
        tx: candidates[0],
        rx: candidates[1],
        detected: true
      };
    } else if (candidates.length === 1) {
      return {
        tx: candidates[0],
        rx: null,
        detected: false,
        message: 'Only one interface found'
      };
    }

    return {
      tx: null,
      rx: null,
      detected: false,
      message: 'No suitable interfaces found'
    };
  }

  /**
   * Get interface type
   */
  getInterfaceType(name, ifacePath) {
    if (name.startsWith('enx')) return 'usb-ethernet';
    if (name.startsWith('enp') || name.startsWith('eth')) return 'ethernet';
    if (name.startsWith('wl')) return 'wifi';
    if (name.startsWith('tailscale')) return 'vpn';

    // Check if wireless
    if (fs.existsSync(path.join(ifacePath, 'wireless'))) {
      return 'wifi';
    }

    return 'other';
  }

  /**
   * Get IP addresses for an interface
   */
  async getAddresses(ifaceName) {
    const addresses = [];
    try {
      const { networkInterfaces } = await import('os');
      const interfaces = networkInterfaces();
      const addrs = interfaces[ifaceName] || [];

      for (const addr of addrs) {
        if (addr.family === 'IPv4') {
          addresses.push({
            address: addr.address,
            netmask: addr.netmask,
            family: 'IPv4'
          });
        }
      }
    } catch (e) {}
    return addresses;
  }

  /**
   * Read a file safely
   */
  readFile(filePath, defaultValue = '') {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8').trim();
      }
    } catch (e) {}
    return defaultValue;
  }

  /**
   * Get MAC address of a specific interface
   */
  getMac(ifaceName) {
    return this.readFile(path.join(NET_PATH, ifaceName, 'address'));
  }

  /**
   * Check if an interface exists and is up
   */
  isUp(ifaceName) {
    const status = this.readFile(path.join(NET_PATH, ifaceName, 'operstate'));
    return status === 'up';
  }
}

// Singleton
export const interfaceDetector = new InterfaceDetector();
export default interfaceDetector;
