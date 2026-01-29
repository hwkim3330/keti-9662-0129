import express from 'express';
import Cap from 'cap';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// C capture process state
let cCaptureProcess = null;
let cCaptureStats = null;
const { Cap: CapLib, decoders } = Cap;

// Multiple captures (one per interface)
let captures = new Map(); // interface name -> { cap, packetCount }
let wsClients = new Set();
let globalPacketCount = 0;

// CoAP message types
const COAP_TYPES = { 0: 'CON', 1: 'NON', 2: 'ACK', 3: 'RST' };

// CoAP method codes
const COAP_METHODS = {
  0: 'EMPTY', 1: 'GET', 2: 'POST', 3: 'PUT', 4: 'DELETE',
  5: 'FETCH', 6: 'PATCH', 7: 'iPATCH'
};

// CoAP response codes
const COAP_RESPONSES = {
  65: '2.01 Created', 66: '2.02 Deleted', 67: '2.03 Valid',
  68: '2.04 Changed', 69: '2.05 Content',
  128: '4.00 Bad Request', 129: '4.01 Unauthorized',
  132: '4.04 Not Found', 133: '4.05 Method Not Allowed',
  160: '5.00 Internal Server Error'
};

// PTP message types (IEEE 1588)
const PTP_MSG_TYPES = {
  0x0: 'Sync',
  0x1: 'Delay_Req',
  0x2: 'Pdelay_Req',
  0x3: 'Pdelay_Resp',
  0x8: 'Follow_Up',
  0x9: 'Delay_Resp',
  0xA: 'Pdelay_Resp_Follow_Up',
  0xB: 'Announce',
  0xC: 'Signaling',
  0xD: 'Management'
};

// Parse PTP packet (IEEE 1588-2008 / IEEE 802.1AS)
function parsePTP(buffer) {
  if (buffer.length < 34) return null;

  const msgType = buffer[0] & 0x0F;
  const version = buffer[1] & 0x0F;

  if (version !== 2) return null; // PTPv2 only

  const msgLength = buffer.readUInt16BE(2);
  const domainNumber = buffer[4];
  const flags = buffer.readUInt16BE(6);
  const correctionNs = buffer.readBigInt64BE(8);

  // Extract flags
  const twoStepFlag = !!(flags & 0x0200); // Bit 9 (two-step)
  const unicastFlag = !!(flags & 0x0400); // Bit 10

  // Source port identity (8 bytes clock ID + 2 bytes port)
  const clockId = buffer.slice(20, 28).toString('hex').match(/.{2}/g).join(':');
  const sourcePort = buffer.readUInt16BE(28);
  const sourcePortId = `${clockId}:${sourcePort}`;

  const sequenceId = buffer.readUInt16BE(30);
  const controlField = buffer[32];
  const logMessageInterval = buffer.readInt8(33); // Signed byte

  // Timestamp (seconds + nanoseconds) - only in some message types
  // Offset 34-43 for Sync, Delay_Req, Pdelay_Req, Pdelay_Resp, Follow_Up, etc.
  let timestamp = null;
  if ([0x0, 0x1, 0x2, 0x3, 0x8, 0x9, 0xA].includes(msgType) && buffer.length >= 44) {
    const seconds = buffer.readUIntBE(34, 6);
    const nanoseconds = buffer.readUInt32BE(40);
    timestamp = { seconds, nanoseconds };
  }

  // requestReceiptTimestamp for Pdelay_Resp (msgType 0x3) at offset 44-53
  let requestReceiptTimestamp = null;
  if (msgType === 0x3 && buffer.length >= 54) {
    const seconds = buffer.readUIntBE(44, 6);
    const nanoseconds = buffer.readUInt32BE(50);
    requestReceiptTimestamp = { seconds, nanoseconds };
  }

  return {
    msgType: PTP_MSG_TYPES[msgType] || `Unknown(${msgType})`,
    msgTypeRaw: msgType,
    version,
    length: msgLength,
    domainNumber,
    flags,
    twoStepFlag,
    unicastFlag,
    correction: Number(correctionNs) / 65536, // Convert to nanoseconds
    clockId,
    sourcePort,
    sourcePortId,
    sequenceId,
    logMessagePeriod: logMessageInterval,
    timestamp,
    requestReceiptTimestamp
  };
}

// Parse CoAP packet
function parseCoAP(buffer, offset = 0) {
  if (buffer.length < offset + 4) return null;

  const firstByte = buffer[offset];
  const version = (firstByte >> 6) & 0x03;
  const type = (firstByte >> 4) & 0x03;
  const tokenLen = firstByte & 0x0f;

  if (version !== 1) return null;

  const code = buffer[offset + 1];
  const codeClass = (code >> 5) & 0x07;
  const codeDetail = code & 0x1f;
  const messageId = buffer.readUInt16BE(offset + 2);

  let codeStr;
  if (codeClass === 0) {
    codeStr = COAP_METHODS[codeDetail] || `0.${codeDetail.toString().padStart(2, '0')}`;
  } else {
    codeStr = COAP_RESPONSES[code] || `${codeClass}.${codeDetail.toString().padStart(2, '0')}`;
  }

  const token = buffer.slice(offset + 4, offset + 4 + tokenLen);

  // Skip options to find payload
  let optionOffset = offset + 4 + tokenLen;
  while (optionOffset < buffer.length && buffer[optionOffset] !== 0xFF) {
    const optByte = buffer[optionOffset++];
    let delta = (optByte >> 4) & 0x0f;
    let length = optByte & 0x0f;
    if (delta === 13) { delta = buffer[optionOffset++] + 13; }
    else if (delta === 14) { delta = buffer.readUInt16BE(optionOffset) + 269; optionOffset += 2; }
    if (length === 13) { length = buffer[optionOffset++] + 13; }
    else if (length === 14) { length = buffer.readUInt16BE(optionOffset) + 269; optionOffset += 2; }
    optionOffset += length;
  }
  if (optionOffset < buffer.length && buffer[optionOffset] === 0xFF) optionOffset++;

  const payload = optionOffset < buffer.length ? buffer.slice(optionOffset) : Buffer.alloc(0);

  return {
    type: COAP_TYPES[type],
    code: codeStr,
    messageId,
    token: token.toString('hex'),
    payloadLen: payload.length,
    payload
  };
}

// Set WebSocket clients
export function setWsClients(clients) {
  wsClients = clients;
}

// Get current capture state for sync
export function getCaptureState() {
  const active = [];
  for (const [name, info] of captures) {
    active.push({ interface: name, packetCount: info.packetCount });
  }
  return {
    running: captures.size > 0,
    activeCaptures: active,
    totalInterfaces: captures.size,
    globalPacketCount
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

function toHex(buffer) {
  return Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function toAscii(buffer) {
  return Array.from(buffer).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
}

// Get available interfaces
router.get('/interfaces', (req, res) => {
  try {
    const devices = CapLib.deviceList();
    res.json(devices.map(d => ({
      name: d.name,
      description: d.description || d.name,
      addresses: d.addresses?.map(a => a.addr).filter(Boolean) || []
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start capture on one or more interfaces
router.post('/start', (req, res) => {
  const { interfaces: ifaces = [], port: portParam = 5683, host = '', captureMode = 'coap', ptpMode } = req.body;
  const port = parseInt(portParam, 10) || 5683; // Ensure port is always a number

  // Support legacy ptpMode parameter
  const mode = ptpMode ? 'ptp' : (captureMode || 'coap');

  // Support single interface (string) or multiple (array)
  const interfaceList = Array.isArray(ifaces) ? ifaces : (ifaces ? [ifaces] : []);

  if (interfaceList.length === 0) {
    // Auto-detect
    const device = CapLib.findDevice();
    if (device) interfaceList.push(device);
  }

  if (interfaceList.length === 0) {
    return res.status(400).json({ error: 'No network interface specified or found' });
  }

  // Check for already running captures
  const alreadyRunning = interfaceList.filter(i => captures.has(i));
  if (alreadyRunning.length > 0) {
    return res.status(400).json({ error: `Capture already running on: ${alreadyRunning.join(', ')}` });
  }

  const started = [];
  const failed = [];

  for (const ifaceName of interfaceList) {
    try {
      const cap = new CapLib();
      const buffer = Buffer.alloc(65535);

      // Build filter based on capture mode
      let filter;
      if (mode === 'all') {
        // Capture all packets
        filter = '';
      } else if (mode === 'ptp') {
        // PTP/gPTP: EtherType 0x88F7 (Layer 2) OR UDP ports 319/320 (Layer 3)
        // gPTP uses multicast 01:80:c2:00:00:0e
        filter = 'ether proto 0x88f7 or udp port 319 or udp port 320';
      } else {
        // CoAP mode
        filter = `udp port ${port}`;
        if (host) filter += ` and host ${host}`;
      }

      const bufSize = 10 * 1024 * 1024;
      const linkType = cap.open(ifaceName, filter, bufSize, buffer);
      cap.setMinBytes && cap.setMinBytes(0);

      const captureInfo = { cap, packetCount: 0, linkType, ifaceName };
      captures.set(ifaceName, captureInfo);

      cap.on('packet', (nbytes, trunc) => {
        if (nbytes <= 0) return;

        const rawPacket = buffer.slice(0, nbytes);
        const captureTime = process.hrtime.bigint(); // High-resolution timestamp

        try {
          // Decode layers
          let ethInfo, ipInfo, udpInfo, tcpInfo;
          let ipOffset = 0;

          // Determine protocol and ports
          let protocol = 'IP';
          let srcPort = 0;
          let dstPort = 0;
          let coap = null;
          let ptp = null;
          let tcp = null;
          let info = '';
          let udpPayload = null;
          let srcMac = '', dstMac = '';
          let source = '', destination = '';

          // VLAN info
          let vlanInfo = null;

          if (linkType === 'ETHERNET') {
            ethInfo = decoders.Ethernet(rawPacket);
            srcMac = ethInfo.info?.srcmac || '';
            dstMac = ethInfo.info?.dstmac || '';

            let etherType = ethInfo.info?.type;
            let payloadOffset = ethInfo.offset;

            // Check for VLAN tag - the library parses it but has buggy PCP extraction
            // So we manually read PCP from raw packet if VLAN is detected
            if (ethInfo.info?.vlan && rawPacket.length >= 18) {
              // TCI is at offset 14-15: PCP(3) + DEI(1) + VID(12)
              const tci = rawPacket.readUInt16BE(14);
              const pcp = (tci >> 13) & 0x07;
              const dei = (tci >> 12) & 0x01;
              const vid = tci & 0x0FFF;
              vlanInfo = { pcp, dei, vid };
              // etherType and payloadOffset already adjusted by the library
            }
            // Also check raw EtherType 0x8100 in case library missed it
            else if (rawPacket.length >= 14 && rawPacket.readUInt16BE(12) === 0x8100 && rawPacket.length >= 18) {
              const tci = rawPacket.readUInt16BE(14);
              const pcp = (tci >> 13) & 0x07;
              const dei = (tci >> 12) & 0x01;
              const vid = tci & 0x0FFF;
              vlanInfo = { pcp, dei, vid };
              etherType = rawPacket.readUInt16BE(16);
              payloadOffset = 18;
            }

            // Check for Layer 2 PTP (gPTP) - EtherType 0x88F7
            if (etherType === 0x88F7) {
              const ptpPayload = rawPacket.slice(payloadOffset);
              ptp = parsePTP(ptpPayload);
              if (ptp) {
                protocol = 'PTP';
                source = srcMac;
                destination = dstMac;
                info = `${ptp.msgType} Seq=${ptp.sequenceId} Domain=${ptp.domainNumber}`;
                if (ptp.timestamp) {
                  info += ` T=${ptp.timestamp.seconds}.${ptp.timestamp.nanoseconds.toString().padStart(9, '0')}`;
                }
                if (ptp.correction !== 0) {
                  info += ` Corr=${ptp.correction.toFixed(0)}ns`;
                }

                captureInfo.packetCount++;
                globalPacketCount++;

                const packetData = {
                  id: globalPacketCount,
                  time: new Date().toISOString(),
                  interface: ifaceName,
                  source,
                  destination,
                  srcPort: 0,
                  dstPort: 0,
                  protocol,
                  info,
                  length: nbytes,
                  ptp: {
                    msgType: ptp.msgType,
                    sequenceId: ptp.sequenceId,
                    domainNumber: ptp.domainNumber,
                    clockId: ptp.clockId,
                    sourcePort: ptp.sourcePort,
                    sourcePortId: ptp.sourcePortId,
                    timestamp: ptp.timestamp,
                    correction: ptp.correction,
                    twoStepFlag: ptp.twoStepFlag,
                    logMessagePeriod: ptp.logMessagePeriod,
                    requestReceiptTimestamp: ptp.requestReceiptTimestamp
                  }
                };

                wsClients.forEach(ws => {
                  if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'packet', data: packetData }));
                  }
                });
              }
              return; // Done processing gPTP packet
            }

            if (etherType !== 0x0800) return; // IPv4 only after this
            ipOffset = payloadOffset;
          }

          ipInfo = decoders.IPV4(rawPacket, ipOffset);
          const ipProtocol = ipInfo.info?.protocol;
          source = ipInfo.info?.srcaddr || '';
          destination = ipInfo.info?.dstaddr || '';

          if (ipProtocol === 17) {
            // UDP
            udpInfo = decoders.UDP(rawPacket, ipInfo.offset);
            srcPort = udpInfo.info.srcport;
            dstPort = udpInfo.info.dstport;
            protocol = 'UDP';
            info = `UDP ${srcPort} -> ${dstPort}`;

            // UDP header is 8 bytes, payload starts after
            const udpPayloadOffset = ipInfo.offset + 8;
            udpPayload = rawPacket.slice(udpPayloadOffset);

            // Check for PTP (ports 319, 320)
            if (srcPort === 319 || srcPort === 320 || dstPort === 319 || dstPort === 320) {
              ptp = parsePTP(udpPayload);
              if (ptp) {
                protocol = 'PTP';
                info = `${ptp.msgType} Seq=${ptp.sequenceId} Domain=${ptp.domainNumber}`;
                if (ptp.timestamp) {
                  info += ` T=${ptp.timestamp.seconds}.${ptp.timestamp.nanoseconds.toString().padStart(9, '0')}`;
                }
                if (ptp.correction !== 0) {
                  info += ` Corr=${ptp.correction.toFixed(0)}ns`;
                }
              }
            }
            // Check for CoAP (port 5683 or custom)
            else if (srcPort === port || dstPort === port) {
              coap = parseCoAP(udpPayload);
              if (coap) {
                protocol = 'CoAP';
                info = `${coap.type} ${coap.code} MID=${coap.messageId}`;
                if (coap.payloadLen > 0) info += ` [${coap.payloadLen} bytes]`;
              }
            }
          } else if (ipProtocol === 6) {
            // TCP
            tcpInfo = decoders.TCP(rawPacket, ipInfo.offset);
            srcPort = tcpInfo.info.srcport;
            dstPort = tcpInfo.info.dstport;
            protocol = 'TCP';

            const flags = [];
            if (tcpInfo.info.flags?.syn) flags.push('SYN');
            if (tcpInfo.info.flags?.ack) flags.push('ACK');
            if (tcpInfo.info.flags?.fin) flags.push('FIN');
            if (tcpInfo.info.flags?.rst) flags.push('RST');
            if (tcpInfo.info.flags?.psh) flags.push('PSH');

            info = `TCP ${srcPort} -> ${dstPort}`;
            if (flags.length > 0) info += ` [${flags.join(',')}]`;
            tcp = { srcPort, dstPort, flags: tcpInfo.info.flags, seq: tcpInfo.info.seqno, ack: tcpInfo.info.ackno };
          } else if (ipProtocol === 1) {
            // ICMP
            protocol = 'ICMP';
            const icmpType = rawPacket[ipInfo.offset];
            const icmpCode = rawPacket[ipInfo.offset + 1];
            const icmpTypes = { 0: 'Echo Reply', 8: 'Echo Request', 3: 'Dest Unreachable', 11: 'Time Exceeded' };
            info = `ICMP ${icmpTypes[icmpType] || `Type ${icmpType}`} Code ${icmpCode}`;
          } else {
            // Other protocols
            const protoNames = { 2: 'IGMP', 47: 'GRE', 50: 'ESP', 51: 'AH', 89: 'OSPF' };
            protocol = protoNames[ipProtocol] || `IP(${ipProtocol})`;
            info = `${protocol} packet`;
          }

          captureInfo.packetCount++;
          globalPacketCount++;

          const packet = {
            id: globalPacketCount,
            time: new Date().toISOString(),
            captureNs: captureTime.toString(),
            interface: ifaceName,
            source: ipInfo.info.srcaddr,
            srcMac,
            srcPort,
            destination: ipInfo.info.dstaddr,
            dstMac,
            dstPort,
            protocol,
            length: nbytes,
            vlan: vlanInfo,
            coap: coap ? {
              type: coap.type,
              code: coap.code,
              messageId: coap.messageId,
              token: coap.token,
              payloadLen: coap.payloadLen
            } : null,
            ptp: ptp ? {
              msgType: ptp.msgType,
              sequenceId: ptp.sequenceId,
              domainNumber: ptp.domainNumber,
              clockId: ptp.clockId,
              sourcePort: ptp.sourcePort,
              sourcePortId: ptp.sourcePortId,
              timestamp: ptp.timestamp,
              correction: ptp.correction,
              twoStepFlag: ptp.twoStepFlag,
              logMessagePeriod: ptp.logMessagePeriod,
              requestReceiptTimestamp: ptp.requestReceiptTimestamp
            } : null,
            tcp: tcp,
            info,
            hex: toHex(rawPacket),
            ascii: toAscii(rawPacket),
            payloadHex: udpPayload ? toHex(udpPayload) : null,
            payloadAscii: udpPayload ? toAscii(udpPayload) : null
          };

          broadcast({ type: 'packet', data: packet });
        } catch (err) {
          // Log decode errors for debugging
          if (!captureInfo.errorCount) captureInfo.errorCount = 0;
          captureInfo.errorCount++;
          if (captureInfo.errorCount <= 5) {
            console.error(`Packet decode error on ${ifaceName}:`, err.message);
          }
        }
      });

      started.push({ interface: ifaceName, filter });
    } catch (err) {
      failed.push({ interface: ifaceName, error: err.message });
    }
  }

  if (started.length === 0) {
    return res.status(500).json({ error: 'Failed to start any capture', failed });
  }

  globalPacketCount = 0;
  res.json({
    success: true,
    message: `Capture started on ${started.length} interface(s)`,
    started,
    failed: failed.length > 0 ? failed : undefined
  });
});

// Stop capture (all or specific interfaces)
router.post('/stop', (req, res) => {
  const { interfaces: ifaces } = req.body;

  let toStop;
  if (ifaces && Array.isArray(ifaces)) {
    toStop = ifaces;
  } else if (ifaces) {
    toStop = [ifaces];
  } else {
    toStop = Array.from(captures.keys());
  }

  const stopped = [];
  for (const ifaceName of toStop) {
    const captureInfo = captures.get(ifaceName);
    if (captureInfo) {
      try {
        captureInfo.cap.close();
      } catch (e) {}
      captures.delete(ifaceName);
      stopped.push(ifaceName);
    }
  }

  broadcast({ type: 'stopped', interfaces: stopped });
  res.json({ success: true, stopped });
});

// Get status
router.get('/status', (req, res) => {
  const active = [];
  for (const [name, info] of captures) {
    active.push({
      interface: name,
      packetCount: info.packetCount,
      errorCount: info.errorCount || 0
    });
  }

  res.json({
    running: captures.size > 0,
    activeCaptures: active,
    totalInterfaces: captures.size,
    clients: wsClients.size,
    globalPacketCount,
    cCapture: cCaptureProcess ? {
      running: true,
      stats: cCaptureStats
    } : null
  });
});

// ============================================
// C Capture Integration (High-precision)
// ============================================

// Start C capture (uses traffic-capture binary)
router.post('/start-c', (req, res) => {
  const { interface: iface, duration = 10, vlanId = 100 } = req.body;

  if (!iface) {
    return res.status(400).json({ error: 'Interface required' });
  }

  if (cCaptureProcess) {
    return res.status(400).json({ error: 'C capture already running' });
  }

  const binaryPath = path.join(__dirname, '..', 'traffic-capture');

  try {
    cCaptureStats = { startTime: Date.now(), interface: iface, vlanId, packets: 0, tc: {} };

    // Spawn the C capture process (requires cap_net_raw capability)
    cCaptureProcess = spawn(binaryPath, [iface, String(duration), String(vlanId), 'json'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let buffer = '';

    cCaptureProcess.stdout.on('data', (data) => {
      buffer += data.toString();

      // Process complete JSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);

          // Update stats
          cCaptureStats.elapsed_ms = json.elapsed_ms;
          cCaptureStats.packets = json.total || 0;

          if (json.tc) {
            cCaptureStats.tc = json.tc;
          }

          if (json.final) {
            cCaptureStats.final = true;
            cCaptureStats.analysis = json.tc;
          }

          // Broadcast to WebSocket clients
          broadcast({
            type: 'c-capture-stats',
            data: {
              elapsed_ms: json.elapsed_ms,
              total: json.total,
              tc: json.tc,
              final: json.final || false
            }
          });
        } catch (e) {
          // Ignore parse errors
        }
      }
    });

    cCaptureProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('password')) {
        console.log('[C-capture]', msg);
      }
    });

    cCaptureProcess.on('close', (code) => {
      console.log(`[C-capture] Process exited with code ${code}`);
      cCaptureProcess = null;
      broadcast({ type: 'c-capture-stopped', stats: cCaptureStats });
    });

    cCaptureProcess.on('error', (err) => {
      console.error('[C-capture] Error:', err.message);
      cCaptureProcess = null;
    });

    res.json({
      success: true,
      message: `C capture started on ${iface}`,
      interface: iface,
      duration,
      vlanId
    });
  } catch (err) {
    cCaptureProcess = null;
    res.status(500).json({ error: err.message });
  }
});

// Stop C capture
router.post('/stop-c', (req, res) => {
  if (!cCaptureProcess) {
    return res.json({ success: true, message: 'No C capture running' });
  }

  try {
    // Send SIGTERM to gracefully stop
    cCaptureProcess.kill('SIGTERM');
    res.json({ success: true, message: 'C capture stopped', stats: cCaptureStats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get C capture status
router.get('/status-c', (req, res) => {
  res.json({
    running: !!cCaptureProcess,
    stats: cCaptureStats
  });
});

export default router;
