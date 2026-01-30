import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// rxcap process state
let rxcapProcess = null;
let rxcapStats = null;
let wsClients = new Set();

// Set WebSocket clients
export function setWsClients(clients) {
  wsClients = clients;
}

// Get current capture state for sync
export function getCaptureState() {
  return {
    running: !!rxcapProcess,
    cCapture: rxcapProcess ? {
      running: true,
      stats: rxcapStats
    } : { running: false }
  };
}

function broadcast(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    try {
      if (client.readyState === 1) client.send(message);
    } catch (e) {
      // Ignore send errors
    }
  });
}

// Parse rxcap CSV line to JSON format expected by frontend
function parseRxcapLine(line, headers) {
  const values = line.split(',');
  if (values.length < headers.length) return null;

  const data = {};
  headers.forEach((h, i) => {
    data[h] = values[i];
  });

  // Convert to frontend format
  const timeS = parseFloat(data.time_s) || 0;
  const totalPkts = parseInt(data.total_pkts) || 0;
  const totalPps = parseInt(data.total_pps) || 0;
  const totalMbps = parseFloat(data.total_mbps) || 0;
  const drops = parseInt(data.drops) || 0;

  // Per-TC (PCP) stats
  const tc = {};
  let totalPcpPkts = 0;
  for (let pcp = 0; pcp < 8; pcp++) {
    const pkts = parseInt(data[`pcp${pcp}_pkts`]) || 0;
    totalPcpPkts += pkts;
    if (pkts > 0) {
      // Calculate kbps from proportion of total traffic
      const proportion = totalPkts > 0 ? pkts / totalPkts : 0;
      const kbps = totalMbps * proportion * 1000;  // Mbps to kbps

      tc[pcp] = {
        count: pkts,
        kbps: kbps,
        avg_ms: 0,  // Will be calculated from latency if available
        burst_ratio: 0
      };
    }
  }

  // If no PCP stats (VLAN tags stripped), report all traffic as TC 0
  // This happens with USB NICs that have hardware VLAN offload
  if (totalPcpPkts === 0 && totalPkts > 0) {
    tc[0] = {
      count: totalPkts,
      kbps: totalMbps * 1000,
      avg_ms: 0,
      burst_ratio: 0,
      note: 'VLAN tags stripped by NIC'
    };
  }

  // Latency stats (convert ns to ms)
  const latencyMinNs = parseInt(data.latency_min_ns) || -1;
  const latencyAvgNs = parseInt(data.latency_avg_ns) || -1;
  const latencyMaxNs = parseInt(data.latency_max_ns) || -1;

  // Update avg_ms for each TC if we have latency data
  if (latencyAvgNs > 0) {
    const avgMs = latencyAvgNs / 1000000;
    Object.keys(tc).forEach(tcNum => {
      tc[tcNum].avg_ms = avgMs;
    });
  }

  return {
    elapsed_ms: Math.round(timeS * 1000),
    total: totalPkts,
    total_pps: totalPps,
    total_mbps: totalMbps,
    drops: drops,
    tc: tc,
    latency: latencyAvgNs > 0 ? {
      min_ns: latencyMinNs,
      avg_ns: latencyAvgNs,
      max_ns: latencyMaxNs
    } : null
  };
}

// Get available interfaces
router.get('/interfaces', (req, res) => {
  try {
    const fs = require('fs');
    const ifaces = fs.readdirSync('/sys/class/net')
      .filter(name => !name.startsWith('lo') && !name.startsWith('docker') && !name.startsWith('veth'))
      .map(name => ({
        name,
        description: name,
        addresses: []
      }));
    res.json(ifaces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start capture using rxcap
router.post('/start-c', (req, res) => {
  const { interface: iface, duration = 30, vlanId = 100 } = req.body;

  if (!iface) {
    return res.status(400).json({ error: 'Interface required' });
  }

  if (rxcapProcess) {
    return res.status(400).json({ error: 'Capture already running' });
  }

  const rxcapPath = path.join(__dirname, '..', 'rxcap');

  // Build rxcap arguments
  // rxcap <interface> --duration <sec> --pcp-stats --seq --seq-only --latency --csv -
  // Note: --csv - outputs CSV to stdout for parsing
  // --seq-only filters non-txgen packets (noise) using magic byte verification
  const args = [
    iface,
    '--duration', String(duration),
    '--pcp-stats',
    '--seq',
    '--seq-only',  // Filter noise packets - only count txgen packets with valid header
    '--latency',
    '--csv', '-'   // Output CSV to stdout for real-time parsing
  ];

  // Note: rxcap uses --vlan for filtering, but USB NICs strip VLAN tags
  // So we don't filter by VLAN, just capture all and analyze by PCP
  // The VLAN tags are expected to be preserved when going through 9662 switch

  console.log(`[rxcap] Starting: ${rxcapPath} ${args.join(' ')}`);

  try {
    rxcapStats = {
      startTime: Date.now(),
      interface: iface,
      vlanId,
      duration,
      packets: 0,
      tc: {}
    };

    // Use sudo for raw socket access
    const sudoArgs = ['-S', rxcapPath, ...args];
    rxcapProcess = spawn('sudo', sudoArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Send sudo password
    rxcapProcess.stdin.write('1\n');
    rxcapProcess.stdin.end();

    let headerLine = null;
    let headers = [];
    let buffer = '';

    rxcapProcess.stdout.on('data', (data) => {
      buffer += data.toString();

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop();  // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        // First non-empty line is header
        if (!headerLine) {
          headerLine = line;
          headers = line.split(',').map(h => h.trim());
          console.log('[rxcap] Headers:', headers.join(', '));
          continue;
        }

        // Parse data line
        const stats = parseRxcapLine(line, headers);
        if (stats) {
          rxcapStats.packets = stats.total;
          rxcapStats.tc = stats.tc;
          rxcapStats.elapsed_ms = stats.elapsed_ms;

          // Broadcast to WebSocket clients
          broadcast({
            type: 'c-capture-stats',
            data: stats
          });
        }
      }
    });

    rxcapProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.log('[rxcap]', msg);
      }
    });

    rxcapProcess.on('close', (code) => {
      console.log(`[rxcap] Process exited with code ${code}`);

      // Send final stats
      if (rxcapStats) {
        broadcast({
          type: 'c-capture-stats',
          data: {
            elapsed_ms: rxcapStats.elapsed_ms || 0,
            total: rxcapStats.packets,
            tc: rxcapStats.tc,
            final: true
          }
        });
      }

      broadcast({ type: 'c-capture-stopped', stats: rxcapStats });
      rxcapProcess = null;
    });

    rxcapProcess.on('error', (err) => {
      console.error('[rxcap] Error:', err.message);
      rxcapProcess = null;
    });

    res.json({
      success: true,
      message: `rxcap started on ${iface}`,
      interface: iface,
      duration,
      vlanId
    });
  } catch (err) {
    rxcapProcess = null;
    res.status(500).json({ error: err.message });
  }
});

// Stop rxcap
router.post('/stop-c', async (req, res) => {
  if (!rxcapProcess) {
    return res.json({ success: true, message: 'No capture running' });
  }

  try {
    const proc = rxcapProcess;

    // Create promise to wait for process to exit
    const waitForExit = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (rxcapProcess === proc) {
          try { proc.kill('SIGKILL'); } catch {}
          rxcapProcess = null;
        }
        resolve();
      }, 1000);

      proc.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Send SIGTERM to gracefully stop (rxcap handles this)
    proc.kill('SIGTERM');

    // Also kill any orphan processes
    spawn('pkill', ['-f', 'rxcap'], { stdio: 'ignore' });

    // Wait up to 1 second for graceful shutdown
    await waitForExit;

    res.json({ success: true, message: 'rxcap stopped', stats: rxcapStats });
  } catch (err) {
    rxcapProcess = null;
    res.status(500).json({ error: err.message });
  }
});

// Get rxcap status
router.get('/status-c', (req, res) => {
  res.json({
    running: !!rxcapProcess,
    stats: rxcapStats
  });
});

// Legacy endpoints for compatibility
router.post('/start', (req, res) => {
  // Redirect to start-c
  return router.handle({ ...req, url: '/start-c', body: req.body }, res, () => {});
});

router.post('/stop', (req, res) => {
  // Stop rxcap
  if (rxcapProcess) {
    try {
      rxcapProcess.kill('SIGTERM');
    } catch (e) {}
    rxcapProcess = null;
  }
  spawn('pkill', ['-f', 'rxcap'], { stdio: 'ignore' });
  res.json({ success: true, stopped: [] });
});

router.get('/status', (req, res) => {
  res.json({
    running: !!rxcapProcess,
    activeCaptures: rxcapProcess ? [{
      interface: rxcapStats?.interface,
      packetCount: rxcapStats?.packets || 0
    }] : [],
    totalInterfaces: rxcapProcess ? 1 : 0,
    clients: wsClients.size,
    globalPacketCount: rxcapStats?.packets || 0,
    cCapture: rxcapProcess ? {
      running: true,
      stats: rxcapStats
    } : null
  });
});

export default router;
