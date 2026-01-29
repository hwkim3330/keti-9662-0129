import express from 'express';
import { SerialPort } from 'serialport';
import { execSync } from 'child_process';
import os from 'os';

const router = express.Router();

// Get available serial ports
router.get('/ports', async (req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json({
      ports: ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || 'Unknown',
        serialNumber: p.serialNumber || 'N/A',
        vendorId: p.vendorId,
        productId: p.productId
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get default configuration
router.get('/defaults', (req, res) => {
  res.json({
    transport: 'serial',
    device: '/dev/ttyACM0',
    host: '192.168.4.1',
    port: 5683
  });
});

// Check if running as hotspot and get connected devices
router.get('/hotspot', async (req, res) => {
  try {
    // Check if we have 10.42.0.1 (GNOME hotspot default)
    const interfaces = os.networkInterfaces();
    let hotspotInterface = null;
    let hotspotIP = null;

    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && addr.address.startsWith('10.42.0.')) {
          hotspotInterface = name;
          hotspotIP = addr.address;
          break;
        }
      }
    }

    if (!hotspotInterface) {
      return res.json({ active: false, devices: [] });
    }

    // Get ARP table for connected devices
    const devices = [];
    try {
      const arpOutput = execSync('ip neigh show', { encoding: 'utf-8' });
      const lines = arpOutput.split('\n');

      for (const line of lines) {
        // Format: 10.42.0.11 dev ap0 lladdr aa:bb:cc:dd:ee:ff REACHABLE
        const match = line.match(/^(10\.42\.0\.\d+)\s+dev\s+(\S+)\s+lladdr\s+([0-9a-f:]+)\s+(\S+)/i);
        if (match) {
          const [, ip, dev, mac, state] = match;
          if (ip !== hotspotIP) { // Exclude self
            devices.push({
              ip,
              mac,
              interface: dev,
              state: state.toLowerCase(),
              reachable: ['reachable', 'stale', 'delay'].includes(state.toLowerCase())
            });
          }
        }
      }
    } catch (e) {
      // ip neigh failed, try arp -a
      try {
        const arpOutput = execSync('arp -a', { encoding: 'utf-8' });
        const lines = arpOutput.split('\n');

        for (const line of lines) {
          const match = line.match(/\(?(10\.42\.0\.\d+)\)?\s+.*?([0-9a-f:]{17})/i);
          if (match) {
            const [, ip, mac] = match;
            if (ip !== hotspotIP) {
              devices.push({ ip, mac, reachable: true });
            }
          }
        }
      } catch (e2) {
        // Both failed
      }
    }

    // Sort by IP
    devices.sort((a, b) => {
      const aNum = parseInt(a.ip.split('.')[3]);
      const bNum = parseInt(b.ip.split('.')[3]);
      return aNum - bNum;
    });

    res.json({
      active: true,
      interface: hotspotInterface,
      hostIP: hotspotIP,
      devices
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle hotspot on/off using nmcli
router.post('/hotspot/toggle', async (req, res) => {
  try {
    // Check current hotspot status
    const interfaces = os.networkInterfaces();
    let isActive = false;

    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && addr.address.startsWith('10.42.0.')) {
          isActive = true;
          break;
        }
      }
    }

    if (isActive) {
      // Turn off hotspot
      execSync('nmcli connection down Hotspot 2>/dev/null || true', { encoding: 'utf-8' });
      res.json({ success: true, action: 'off', message: 'Hotspot turned off' });
    } else {
      // Turn on hotspot
      try {
        execSync('nmcli connection up Hotspot', { encoding: 'utf-8' });
        res.json({ success: true, action: 'on', message: 'Hotspot turned on' });
      } catch (e) {
        // Try to create hotspot if it doesn't exist
        try {
          execSync('nmcli device wifi hotspot ifname wlp0s20f3 ssid KETI-TSN password keti1234', { encoding: 'utf-8' });
          res.json({ success: true, action: 'created', message: 'Hotspot created and turned on' });
        } catch (e2) {
          throw new Error('Failed to start hotspot: ' + e2.message);
        }
      }
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
