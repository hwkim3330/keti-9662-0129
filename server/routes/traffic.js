import express from 'express';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// Active txgen process
let txgenProcess = null;
let txgenStats = null;

// Get interface MAC address
function getInterfaceMac(ifaceName) {
  try {
    const macPath = `/sys/class/net/${ifaceName}/address`;
    if (fs.existsSync(macPath)) {
      return fs.readFileSync(macPath, 'utf8').trim();
    }
  } catch (e) {}
  return '00:00:00:00:00:00';
}

// Get interface IP address
function getInterfaceIP(ifaceName) {
  try {
    const result = execSync(`ip -4 addr show ${ifaceName} | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}'`, { encoding: 'utf8' });
    return result.trim().split('\n')[0] || '10.0.0.1';
  } catch (e) {
    return '10.0.0.1';  // Fallback dummy IP
  }
}

// Get available interfaces
router.get('/interfaces', (req, res) => {
  try {
    const ifaces = fs.readdirSync('/sys/class/net')
      .filter(name => !name.startsWith('lo') && !name.startsWith('docker') && !name.startsWith('veth'))
      .map(name => {
        const mac = getInterfaceMac(name);
        const ip = getInterfaceIP(name);
        return { name, addresses: [mac, ip].filter(Boolean) };
      });
    res.json(ifaces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start traffic generation using txgen
router.post('/start-precision', (req, res) => {
  const {
    interface: ifaceName,
    dstMac,
    dstIp,
    srcMac,
    vlanId = 100,
    tcList = [0, 1, 2, 3, 4, 5, 6, 7],
    packetsPerSecond = 1000,
    duration = 10,
    frameSize = 1000
  } = req.body;

  if (!ifaceName) {
    return res.status(400).json({ error: 'Interface required' });
  }

  // Stop existing txgen if running
  if (txgenProcess) {
    try {
      txgenProcess.kill('SIGTERM');
    } catch (e) {}
    txgenProcess = null;
  }

  // Get MAC addresses
  const sourceMac = srcMac || getInterfaceMac(ifaceName);

  // Destination IP - use provided or generate from MAC (last 4 bytes as IP)
  let destIp = dstIp;
  if (!destIp && dstMac) {
    // Generate dummy IP from MAC for Layer 2 testing
    const macParts = dstMac.split(':').map(h => parseInt(h, 16));
    destIp = `10.${macParts[3] || 0}.${macParts[4] || 0}.${macParts[5] || 1}`;
  }
  if (!destIp) destIp = '10.0.0.2';

  // Calculate rate in Mbps from pps and frame size
  // Total rate = pps * frameSize * 8 bits / 1,000,000
  const tcArray = Array.isArray(tcList) ? tcList : [parseInt(tcList) || 0];
  const totalRateMbps = Math.ceil((packetsPerSecond * frameSize * 8) / 1000000);

  // Build txgen arguments for multi-TC mode
  // --multi-tc format: "pcp1,pcp2,...:vlanId" sends traffic with all specified PCPs
  const tcListStr = tcArray.join(',');
  const multiTcSpec = `${tcListStr}:${vlanId}`;

  const txgenPath = path.join(__dirname, '..', 'txgen');

  const args = [
    ifaceName,
    '-B', destIp,
    '-b', dstMac || 'ff:ff:ff:ff:ff:ff',
    '-a', sourceMac,
    '--multi-tc', multiTcSpec,
    '-r', String(totalRateMbps),
    '-l', String(frameSize),  // Packet length
    '--seq',
    '--timestamp',
    '--duration', String(duration)
  ];

  console.log(`[txgen] Starting: ${txgenPath} ${args.join(' ')}`);

  try {
    txgenStats = {
      startTime: Date.now(),
      interface: ifaceName,
      tcList: tcArray,
      vlanId,
      pps: packetsPerSecond,
      rateMbps: totalRateMbps,
      duration,
      frameSize,
      sent: 0,
      errors: 0
    };

    // Use sudo for raw socket access
    const sudoArgs = ['-S', txgenPath, ...args];
    txgenProcess = spawn('sudo', sudoArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Send sudo password
    txgenProcess.stdin.write('1\n');
    txgenProcess.stdin.end();

    let stdout = '';
    let stderr = '';

    txgenProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      // Parse txgen output for stats
      const lines = data.toString().split('\n');
      for (const line of lines) {
        // txgen prints stats like: "TX: 10000 pkts, 10.5 Mbps, 0 errors"
        const match = line.match(/TX:\s*(\d+)\s*pkts.*?(\d+)\s*errors/i);
        if (match) {
          txgenStats.sent = parseInt(match[1]);
          txgenStats.errors = parseInt(match[2]);
        }
      }
    });

    txgenProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('[txgen]', data.toString().trim());
    });

    txgenProcess.on('close', (code) => {
      console.log(`[txgen] Process exited with code ${code}`);
      txgenProcess = null;
    });

    txgenProcess.on('error', (err) => {
      console.error('[txgen] Error:', err.message);
      txgenProcess = null;
    });

    res.json({
      success: true,
      message: 'Traffic generator started (txgen)',
      config: {
        interface: ifaceName,
        dstMac: dstMac || 'ff:ff:ff:ff:ff:ff',
        dstIp: destIp,
        srcMac: sourceMac,
        vlanId,
        tcList: tcArray,
        packetsPerSecond,
        rateMbps: totalRateMbps,
        duration,
        frameSize
      }
    });
  } catch (err) {
    txgenProcess = null;
    res.status(500).json({ error: err.message });
  }
});

// Stop txgen
router.post('/stop-precision', (req, res) => {
  if (txgenProcess) {
    try {
      txgenProcess.kill('SIGTERM');
      // Also try to kill any orphan txgen processes
      spawn('pkill', ['-f', 'txgen'], { stdio: 'ignore' });
    } catch (e) {}
    txgenProcess = null;
    res.json({ success: true, message: 'txgen stopped', stats: txgenStats });
  } else {
    spawn('pkill', ['-f', 'txgen'], { stdio: 'ignore' });
    res.json({ success: true, message: 'No active txgen' });
  }
});

// Legacy endpoints for compatibility
router.post('/start', (req, res) => {
  // Redirect to precision endpoint
  const {
    interface: ifaceName,
    dstMac,
    srcMac,
    vlanId = 0,
    pcp = 0,
    packetSize = 100,
    packetsPerSecond = 100,
    duration = 0
  } = req.body;

  // Forward to start-precision with single TC
  req.body = {
    interface: ifaceName,
    dstMac,
    srcMac,
    vlanId: vlanId || 100,
    tcList: [parseInt(pcp) || 0],
    packetsPerSecond,
    duration: duration || 10,
    frameSize: packetSize
  };

  // Call start-precision handler
  return router.handle(req, res, () => {});
});

router.post('/stop', (req, res) => {
  // Stop all traffic
  if (txgenProcess) {
    try {
      txgenProcess.kill('SIGTERM');
    } catch (e) {}
    txgenProcess = null;
  }
  spawn('pkill', ['-f', 'txgen'], { stdio: 'ignore' });
  res.json({ success: true, stopped: [] });
});

// Get status
router.get('/status', (req, res) => {
  res.json({
    active: txgenProcess ? 1 : 0,
    generators: txgenProcess ? [{
      type: 'txgen',
      running: true,
      stats: txgenStats
    }] : []
  });
});

// Send single packet (for testing)
router.post('/send', (req, res) => {
  const {
    interface: ifaceName,
    dstMac,
    dstIp,
    srcMac,
    vlanId = 0,
    pcp = 0,
    packetSize = 100
  } = req.body;

  if (!ifaceName) {
    return res.status(400).json({ error: 'Interface required' });
  }

  const txgenPath = path.join(__dirname, '..', 'txgen');
  const sourceMac = srcMac || getInterfaceMac(ifaceName);
  const destIp = dstIp || '10.0.0.2';

  const args = [
    ifaceName,
    '-B', destIp,
    '-b', dstMac || 'ff:ff:ff:ff:ff:ff',
    '-a', sourceMac,
    '-c', '1',  // Single packet
    '-s', String(packetSize)
  ];

  if (vlanId > 0) {
    args.push('-Q', `${pcp}:${vlanId}`);
  }

  try {
    const result = execSync(`${txgenPath} ${args.join(' ')}`, { encoding: 'utf8', timeout: 5000 });
    res.json({
      success: true,
      message: 'Packet sent',
      output: result.trim()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
