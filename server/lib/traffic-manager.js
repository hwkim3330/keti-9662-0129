import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BINARY_DIR = path.resolve(__dirname, '..');

/**
 * TrafficManager - Manages traffic-sender and traffic-capture processes
 * Handles process lifecycle, cleanup, and status tracking
 */
export class TrafficManager extends EventEmitter {
  constructor() {
    super();
    this.processes = new Map();  // key → { process, type, config, stats }
    this.setupCleanup();
  }

  setupCleanup() {
    const cleanup = () => {
      console.log('[TrafficManager] Cleaning up processes...');
      this.stopAll();
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('beforeExit', cleanup);
  }

  /**
   * Start a capture process
   * @param {string} iface - Network interface name
   * @param {object} options - { duration, vlanId, outputMode }
   * @returns {object} - { success, key, error }
   */
  startCapture(iface, options = {}) {
    const { duration = 10, vlanId = 100, outputMode = 'json' } = options;
    const key = `capture:${iface}`;

    // Stop existing capture on same interface
    if (this.processes.has(key)) {
      this.stop(key);
    }

    const binaryPath = path.join(BINARY_DIR, 'traffic-capture');
    const args = [iface, String(duration), String(vlanId), outputMode];

    try {
      const proc = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const stats = {
        startTime: Date.now(),
        interface: iface,
        vlanId,
        packets: 0,
        tc: {}
      };

      let buffer = '';

      proc.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            stats.elapsed_ms = json.elapsed_ms;
            stats.packets = json.total || 0;
            if (json.tc) stats.tc = json.tc;
            if (json.final) stats.final = true;

            this.emit('capture-stats', { key, iface, data: json });
          } catch (e) {}
        }
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[Capture:${iface}]`, msg);
      });

      proc.on('close', (code) => {
        console.log(`[Capture:${iface}] Exited with code ${code}`);
        this.emit('capture-stopped', { key, iface, stats, code });
        this.processes.delete(key);
      });

      proc.on('error', (err) => {
        console.error(`[Capture:${iface}] Error:`, err.message);
        this.processes.delete(key);
      });

      this.processes.set(key, { process: proc, type: 'capture', config: options, stats });

      return { success: true, key, interface: iface, duration, vlanId };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Start a traffic sender process
   * @param {string} iface - Network interface name
   * @param {object} options - { dstMac, srcMac, vlanId, tcList, pps, duration }
   * @returns {object} - { success, key, error }
   */
  startSender(iface, options = {}) {
    const {
      dstMac,
      srcMac,
      vlanId = 100,
      tcList = [1, 2, 3],
      pps = 100,
      duration = 5
    } = options;

    if (!dstMac) {
      return { success: false, error: 'dstMac is required' };
    }

    const key = `sender:${iface}`;

    // Stop existing sender on same interface
    if (this.processes.has(key)) {
      this.stop(key);
    }

    // Get source MAC if not provided
    const sourceMac = srcMac || this.getInterfaceMac(iface);
    const tcListStr = Array.isArray(tcList) ? tcList.join(',') : String(tcList);

    const binaryPath = path.join(BINARY_DIR, 'traffic-sender');
    const args = [iface, dstMac, sourceMac, String(vlanId), tcListStr, String(pps), String(duration)];

    try {
      const proc = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const stats = {
        startTime: Date.now(),
        interface: iface,
        dstMac,
        srcMac: sourceMac,
        vlanId,
        tcList,
        pps,
        duration,
        sent: {}
      };

      proc.stdout.on('data', (data) => {
        const output = data.toString().trim();
        try {
          const json = JSON.parse(output);
          if (json.success) {
            stats.sent = json.sent;
            stats.total = json.total;
            stats.actual_pps = json.actual_pps;
          }
          this.emit('sender-result', { key, iface, data: json });
        } catch (e) {}
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[Sender:${iface}]`, msg);
      });

      proc.on('close', (code) => {
        console.log(`[Sender:${iface}] Exited with code ${code}`);
        this.emit('sender-stopped', { key, iface, stats, code });
        this.processes.delete(key);
      });

      proc.on('error', (err) => {
        console.error(`[Sender:${iface}] Error:`, err.message);
        this.processes.delete(key);
      });

      this.processes.set(key, { process: proc, type: 'sender', config: options, stats });

      return { success: true, key, interface: iface, srcMac: sourceMac, config: options };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Get MAC address of an interface
   */
  getInterfaceMac(iface) {
    try {
      const macPath = `/sys/class/net/${iface}/address`;
      if (fs.existsSync(macPath)) {
        return fs.readFileSync(macPath, 'utf8').trim();
      }
    } catch (e) {}
    return '00:00:00:00:00:00';
  }

  /**
   * Stop a specific process
   */
  stop(key) {
    const entry = this.processes.get(key);
    if (entry) {
      try {
        entry.process.kill('SIGTERM');
      } catch (e) {}
      this.processes.delete(key);
      return { success: true, key, stats: entry.stats };
    }
    return { success: false, error: 'Process not found' };
  }

  /**
   * Stop all processes
   */
  stopAll() {
    const results = [];
    for (const [key, entry] of this.processes) {
      try {
        entry.process.kill('SIGTERM');
        results.push({ key, stopped: true });
      } catch (e) {
        results.push({ key, stopped: false, error: e.message });
      }
    }
    this.processes.clear();
    return results;
  }

  /**
   * Get status of all processes
   */
  getStatus() {
    const status = [];
    for (const [key, entry] of this.processes) {
      status.push({
        key,
        type: entry.type,
        config: entry.config,
        stats: entry.stats,
        running: true
      });
    }
    return {
      active: this.processes.size,
      processes: status
    };
  }

  /**
   * Get stats for a specific capture
   */
  getCaptureStats(iface) {
    const key = `capture:${iface}`;
    const entry = this.processes.get(key);
    if (entry && entry.type === 'capture') {
      return { running: true, stats: entry.stats };
    }
    return { running: false, stats: null };
  }
}

// Singleton instance
export const trafficManager = new TrafficManager();
export default trafficManager;
