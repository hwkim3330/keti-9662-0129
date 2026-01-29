import express from 'express';
import Cap from 'cap';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const { Cap: CapLib } = Cap;

// Active C sender process
let cSenderProcess = null;

// Active traffic generators
const generators = new Map();

// Build Ethernet frame with optional VLAN tag
function buildFrame(options) {
  const {
    dstMac,
    srcMac,
    vlanId = 0,
    pcp = 0,
    etherType = 0x0800, // IPv4
    payloadSize = 64
  } = options;

  // Parse MAC addresses
  const parseMac = (mac) => {
    return Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
  };

  const dstMacBuf = parseMac(dstMac);
  const srcMacBuf = parseMac(srcMac);

  let frame;
  let headerSize;

  if (vlanId > 0) {
    // 802.1Q tagged frame
    // Dst(6) + Src(6) + TPID(2) + TCI(2) + EtherType(2) = 18 bytes header
    headerSize = 18;
    const totalSize = Math.max(headerSize + payloadSize, 64); // Min 64 bytes
    frame = Buffer.alloc(totalSize);

    let offset = 0;
    dstMacBuf.copy(frame, offset); offset += 6;
    srcMacBuf.copy(frame, offset); offset += 6;

    // TPID (802.1Q tag)
    frame.writeUInt16BE(0x8100, offset); offset += 2;

    // TCI: PCP(3) + DEI(1) + VID(12)
    const tci = ((pcp & 0x07) << 13) | (vlanId & 0x0FFF);
    frame.writeUInt16BE(tci, offset); offset += 2;

    // EtherType
    frame.writeUInt16BE(etherType, offset); offset += 2;

    // Fill payload with pattern
    for (let i = offset; i < totalSize; i++) {
      frame[i] = i & 0xFF;
    }
  } else {
    // Untagged frame
    // Dst(6) + Src(6) + EtherType(2) = 14 bytes header
    headerSize = 14;
    const totalSize = Math.max(headerSize + payloadSize, 64);
    frame = Buffer.alloc(totalSize);

    let offset = 0;
    dstMacBuf.copy(frame, offset); offset += 6;
    srcMacBuf.copy(frame, offset); offset += 6;
    frame.writeUInt16BE(etherType, offset); offset += 2;

    // Fill payload with pattern
    for (let i = offset; i < totalSize; i++) {
      frame[i] = i & 0xFF;
    }
  }

  return frame;
}

// Get interface MAC address
function getInterfaceMac(ifaceName) {
  const devices = CapLib.deviceList();
  const device = devices.find(d => d.name === ifaceName);
  if (device && device.addresses) {
    // Find hardware address (MAC)
    for (const addr of device.addresses) {
      if (addr.addr && addr.addr.includes(':') && addr.addr.length === 17) {
        // Looks like a MAC address
        return addr.addr;
      }
    }
  }
  // Return a default if not found
  return '00:00:00:00:00:00';
}

// Get available interfaces
router.get('/interfaces', (req, res) => {
  try {
    const devices = CapLib.deviceList();
    const interfaces = devices
      .filter(d => d.name && !d.name.startsWith('any') && !d.name.startsWith('nf') && !d.name.startsWith('dbus'))
      .map(d => ({
        name: d.name,
        description: d.description || d.name,
        addresses: d.addresses?.map(a => a.addr).filter(Boolean) || []
      }));
    res.json(interfaces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start traffic generation
router.post('/start', (req, res) => {
  const {
    interface: ifaceName,
    dstMac,
    srcMac,
    vlanId = 0,
    pcp = 0,  // Can be single number or array
    pcpList,  // Alternative: array of PCPs to send
    packetSize = 100,
    packetsPerSecond = 100,
    duration = 0, // 0 = unlimited
    count = 0 // 0 = unlimited (use duration)
  } = req.body;

  if (!ifaceName) {
    return res.status(400).json({ error: 'Interface name required' });
  }

  if (!dstMac) {
    return res.status(400).json({ error: 'Destination MAC required' });
  }

  // Use interface+pcp as key to allow multiple TCs on same interface
  const pcpValue = parseInt(pcp) || 0;
  const generatorKey = `${ifaceName}:${pcpValue}`;

  if (generators.has(generatorKey)) {
    return res.status(400).json({ error: `Generator already running for ${generatorKey}` });
  }

  try {
    const cap = new CapLib();
    const buffer = Buffer.alloc(65535);
    const linkType = cap.open(ifaceName, '', 10 * 1024 * 1024, buffer);

    if (linkType !== 'ETHERNET') {
      cap.close();
      return res.status(400).json({ error: `Interface ${ifaceName} is not Ethernet` });
    }

    // Get source MAC if not provided
    const sourceMac = srcMac || getInterfaceMac(ifaceName);

    // Build the frame
    const frame = buildFrame({
      dstMac,
      srcMac: sourceMac,
      vlanId: parseInt(vlanId) || 0,
      pcp: pcpValue,
      payloadSize: Math.max(46, parseInt(packetSize) - 18) // Min payload for 64 byte frame
    });

    const pps = Math.max(1, Math.min(100000, parseInt(packetsPerSecond) || 100));
    const interval = Math.floor(1000 / pps); // ms between packets

    const stats = {
      sent: 0,
      errors: 0,
      startTime: Date.now(),
      running: true
    };

    const maxPackets = parseInt(count) || 0;
    const maxDuration = (parseInt(duration) || 0) * 1000; // Convert to ms

    // Send packets at specified rate
    const sendPacket = () => {
      if (!stats.running) return;

      // Check limits
      if (maxPackets > 0 && stats.sent >= maxPackets) {
        stopGenerator(generatorKey);
        return;
      }

      if (maxDuration > 0 && (Date.now() - stats.startTime) >= maxDuration) {
        stopGenerator(generatorKey);
        return;
      }

      try {
        cap.send(frame, frame.length);
        stats.sent++;
      } catch (err) {
        stats.errors++;
      }
    };

    // Use setInterval for rate control
    const timer = setInterval(sendPacket, interval);

    generators.set(generatorKey, {
      cap,
      timer,
      stats,
      ifaceName,
      config: { dstMac, srcMac: sourceMac, vlanId, pcp: pcpValue, packetSize, packetsPerSecond: pps }
    });

    res.json({
      success: true,
      message: `Traffic generator started: ${generatorKey}`,
      generatorKey,
      config: {
        interface: ifaceName,
        dstMac,
        srcMac: sourceMac,
        vlanId,
        pcp: pcpValue,
        packetSize: frame.length,
        packetsPerSecond: pps,
        duration: duration || 'unlimited',
        count: count || 'unlimited'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop generator helper
function stopGenerator(generatorKey) {
  const gen = generators.get(generatorKey);
  if (gen) {
    gen.stats.running = false;
    clearInterval(gen.timer);
    try {
      gen.cap.close();
    } catch (e) {}
    generators.delete(generatorKey);
    return gen.stats;
  }
  return null;
}

// Stop traffic generation
router.post('/stop', (req, res) => {
  const { interface: ifaceName, pcp, generatorKey } = req.body;

  if (generatorKey) {
    // Stop specific generator by key
    const stats = stopGenerator(generatorKey);
    if (stats) {
      res.json({
        success: true,
        message: `Traffic generator stopped: ${generatorKey}`,
        stats: { sent: stats.sent, errors: stats.errors, duration: Date.now() - stats.startTime }
      });
    } else {
      res.status(404).json({ error: `No generator: ${generatorKey}` });
    }
  } else if (ifaceName) {
    // Stop all generators for this interface (any PCP)
    const results = [];
    for (const [key, gen] of generators) {
      if (key.startsWith(ifaceName + ':')) {
        const stats = stopGenerator(key);
        results.push({
          generatorKey: key,
          sent: stats.sent,
          errors: stats.errors,
          duration: Date.now() - stats.startTime
        });
      }
    }
    if (results.length > 0) {
      res.json({ success: true, message: `Stopped ${results.length} generator(s) on ${ifaceName}`, stopped: results });
    } else {
      res.status(404).json({ error: `No generators running on ${ifaceName}` });
    }
  } else {
    // Stop all
    const results = [];
    for (const [key, gen] of generators) {
      const stats = stopGenerator(key);
      results.push({
        generatorKey: key,
        sent: stats.sent,
        errors: stats.errors,
        duration: Date.now() - stats.startTime
      });
    }
    res.json({ success: true, stopped: results });
  }
});

// Get status
router.get('/status', (req, res) => {
  const status = [];
  for (const [name, gen] of generators) {
    status.push({
      interface: name,
      running: gen.stats.running,
      sent: gen.stats.sent,
      errors: gen.stats.errors,
      duration: Date.now() - gen.stats.startTime,
      config: gen.config
    });
  }
  res.json({
    active: generators.size,
    generators: status
  });
});

// Start precision traffic using C sender
router.post('/start-precision', (req, res) => {
  const {
    interface: ifaceName,
    dstMac,
    srcMac,
    vlanId = 100,
    tcList = [1, 2, 3, 4, 5, 6, 7],
    packetsPerSecond = 100,
    duration = 7
  } = req.body;

  if (!ifaceName || !dstMac) {
    return res.status(400).json({ error: 'Interface and dstMac required' });
  }

  // Stop existing C sender if running
  if (cSenderProcess) {
    try {
      cSenderProcess.kill('SIGTERM');
    } catch (e) {}
    cSenderProcess = null;
  }

  // Get source MAC if not provided
  const sourceMac = srcMac || getInterfaceMac(ifaceName);

  // Build TC list string
  const tcListStr = Array.isArray(tcList) ? tcList.join(',') : String(tcList);

  // Path to C binary
  const senderPath = path.join(__dirname, '..', 'traffic-sender');

  const args = [
    ifaceName,
    dstMac,
    sourceMac,
    String(vlanId),
    tcListStr,
    String(packetsPerSecond),
    String(duration)
  ];

  console.log(`Starting C sender: sudo ${senderPath} ${args.join(' ')}`);

  try {
    // Use sudo for raw socket access
    cSenderProcess = spawn('sudo', [senderPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    cSenderProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    cSenderProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('C sender:', data.toString().trim());
    });

    cSenderProcess.on('close', (code) => {
      console.log(`C sender exited with code ${code}`);
      cSenderProcess = null;

      // Try to parse JSON result
      try {
        if (stdout.trim()) {
          const result = JSON.parse(stdout.trim());
          console.log('C sender result:', result);
        }
      } catch (e) {
        console.log('C sender output:', stdout);
      }
    });

    cSenderProcess.on('error', (err) => {
      console.error('C sender error:', err);
      cSenderProcess = null;
    });

    res.json({
      success: true,
      message: 'Precision traffic generator started (C)',
      config: {
        interface: ifaceName,
        dstMac,
        srcMac: sourceMac,
        vlanId,
        tcList,
        packetsPerSecond,
        duration
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop precision traffic (C sender)
router.post('/stop-precision', (req, res) => {
  if (cSenderProcess) {
    try {
      cSenderProcess.kill('SIGTERM');
      // Also kill via sudo
      spawn('sudo', ['pkill', '-f', 'traffic-sender'], { stdio: 'ignore' });
    } catch (e) {}
    cSenderProcess = null;
    res.json({ success: true, message: 'Precision traffic stopped' });
  } else {
    // Try to kill anyway in case it's orphaned
    spawn('sudo', ['pkill', '-f', 'traffic-sender'], { stdio: 'ignore' });
    res.json({ success: true, message: 'No active precision traffic' });
  }
});

// Send single packet (for testing)
router.post('/send', (req, res) => {
  const {
    interface: ifaceName,
    dstMac,
    srcMac,
    vlanId = 0,
    pcp = 0,
    packetSize = 100
  } = req.body;

  if (!ifaceName || !dstMac) {
    return res.status(400).json({ error: 'Interface and dstMac required' });
  }

  try {
    const cap = new CapLib();
    const buffer = Buffer.alloc(65535);
    cap.open(ifaceName, '', 10 * 1024 * 1024, buffer);

    const sourceMac = srcMac || getInterfaceMac(ifaceName);
    const frame = buildFrame({
      dstMac,
      srcMac: sourceMac,
      vlanId: parseInt(vlanId) || 0,
      pcp: parseInt(pcp) || 0,
      payloadSize: Math.max(46, parseInt(packetSize) - 18)
    });

    cap.send(frame, frame.length);
    cap.close();

    res.json({
      success: true,
      message: 'Packet sent',
      frameSize: frame.length,
      frameHex: frame.toString('hex').match(/.{2}/g).join(' ').substring(0, 100) + '...'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
