/**
 * CBS (Credit-Based Shaper) API Routes
 *
 * IEEE 802.1Qav CBS configuration for LAN9662
 * Uses keti-tsn CLI for reliable device communication
 *
 * CBS Parameters:
 *   - idleSlope: Credit accumulation rate (kilobits/sec) - determines bandwidth allocation
 *
 * YANG Path:
 *   /ietf-interfaces:interfaces/interface[name='X']/mchp-velocitysp-port:eth-qos/config/traffic-class-shapers[traffic-class=Y]/credit-based/idle-slope
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();

// keti-tsn CLI path
const KETI_TSN_CLI = '/home/kim/keti-tsn-cli-new/bin/keti-tsn.js';

// Default settings
const DEFAULT_DEVICE = '/dev/ttyACM0';
const DEFAULT_LINK_SPEED_MBPS = 1000;  // 1 Gbps (actual link speed)

// Serial port mutex to prevent concurrent access
let isLocked = false;
const waitQueue = [];

async function acquireLock() {
  if (!isLocked) {
    isLocked = true;
    return;
  }
  return new Promise(resolve => waitQueue.push(resolve));
}

function releaseLock() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift();
    next();
  } else {
    isLocked = false;
  }
}

/**
 * Execute keti-tsn CLI command with mutex
 */
async function executeKetiTsn(command, yamlContent, options = {}) {
  await acquireLock();
  try {
    const result = await executeKetiTsnInternal(command, yamlContent, options);
    await new Promise(r => setTimeout(r, 100)); // Small delay
    return result;
  } finally {
    releaseLock();
  }
}

async function executeKetiTsnInternal(command, yamlContent, options = {}) {
  return new Promise((resolve, reject) => {
    // Write YAML to temp file
    const tmpFile = path.join(os.tmpdir(), `cbs-${Date.now()}.yaml`);
    fs.writeFileSync(tmpFile, yamlContent, 'utf-8');

    const args = [KETI_TSN_CLI, command, tmpFile];
    if (options.device) {
      args.push('-d', options.device);
    }

    console.log(`[CBS] Running: node ${args.join(' ')}`);
    console.log(`[CBS] YAML content:\n${yamlContent}`);

    const proc = spawn('node', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }

      if (code === 0) {
        console.log(`[CBS] Success: ${stdout.trim()}`);
        resolve({ success: true, output: stdout.trim() });
      } else {
        console.error(`[CBS] Failed (code ${code}): ${stderr}`);
        resolve({ success: false, output: stdout, error: stderr || `Exit code ${code}` });
      }
    });

    proc.on('error', (err) => {
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
      console.error(`[CBS] Process error: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Build CBS YANG path for Microchip VelocitySP
 */
function buildCbsPath(portNum) {
  return `/ietf-interfaces:interfaces/interface[name='${portNum}']/mchp-velocitysp-port:eth-qos/config/traffic-class-shapers`;
}

/**
 * GET /api/cbs/status/:port
 * Get CBS status for a specific port
 */
router.get('/status/:port', async (req, res) => {
  const portNum = req.params.port;
  const device = req.query.device || DEFAULT_DEVICE;

  try {
    const queryPath = buildCbsPath(portNum);
    const yamlContent = `- ${queryPath}`;

    const result = await executeKetiTsn('fetch', yamlContent, { device });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    // Parse YAML output
    const lines = result.output.split('\n');
    const tcConfigs = {};
    let currentTc = null;
    let inCreditBased = false;

    for (const line of lines) {
      const tcMatch = line.match(/traffic-class:\s*(\d+)/);
      if (tcMatch) {
        currentTc = parseInt(tcMatch[1]);
        tcConfigs[currentTc] = {};
      }

      if (line.includes('credit-based:')) {
        inCreditBased = true;
      }

      const slopeMatch = line.match(/idle-slope:\s*(\d+)/);
      if (slopeMatch && currentTc !== null) {
        const idleSlopeKbps = parseInt(slopeMatch[1]);
        tcConfigs[currentTc] = {
          idleSlopeKbps,
          idleSlopeBps: idleSlopeKbps * 1000,
          bandwidthPercent: (idleSlopeKbps / (DEFAULT_LINK_SPEED_MBPS * 1000)) * 100
        };
      }
    }

    res.json({
      port: portNum,
      linkSpeedMbps: DEFAULT_LINK_SPEED_MBPS,
      raw: result.output,
      tcConfigs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cbs/configure/:port
 * Configure CBS for a specific port
 *
 * Body:
 * {
 *   tc: number (0-7),
 *   idleSlope: number (kbps) - idle slope in kilobits per second,
 *   linkSpeed?: number (Mbps, default 1000)
 * }
 */
router.post('/configure/:port', async (req, res) => {
  const portNum = req.params.port;
  const {
    tc,
    idleSlope,  // Now in kbps directly (simplified)
    linkSpeed = DEFAULT_LINK_SPEED_MBPS,
    device
  } = req.body;

  if (tc === undefined || tc < 0 || tc > 7) {
    return res.status(400).json({ error: 'tc must be 0-7' });
  }

  if (!idleSlope || idleSlope <= 0) {
    return res.status(400).json({ error: 'idleSlope (kbps) is required' });
  }

  const idleSlopeKbps = Math.round(idleSlope);
  const bandwidthPercent = (idleSlopeKbps / (linkSpeed * 1000)) * 100;

  console.log(`[CBS] Configure Port ${portNum} TC${tc}: ${idleSlopeKbps} kbps (${bandwidthPercent.toFixed(2)}%)`);

  try {
    // Build YAML for keti-tsn patch
    const yamlContent = `- ${buildCbsPath(portNum)}:
    traffic-class: ${tc}
    credit-based:
      idle-slope: ${idleSlopeKbps}`;

    const result = await executeKetiTsn('patch', yamlContent, { device: device || DEFAULT_DEVICE });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({
      success: true,
      port: portNum,
      tc,
      idleSlopeKbps,
      bandwidthPercent,
      linkSpeedMbps: linkSpeed
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cbs/configure-all/:port
 * Configure CBS for multiple TCs on a port at once
 *
 * Body:
 * {
 *   configs: [{ tc: number, idleSlope: number (kbps) }, ...],
 *   linkSpeed?: number (Mbps, default 1000)
 * }
 */
router.post('/configure-all/:port', async (req, res) => {
  const portNum = req.params.port;
  const {
    configs,
    linkSpeed = DEFAULT_LINK_SPEED_MBPS,
    device
  } = req.body;

  if (!Array.isArray(configs) || configs.length === 0) {
    return res.status(400).json({ error: 'configs array is required' });
  }

  try {
    const results = [];

    // Build YAML with all configs
    const yamlLines = configs.map(cfg => {
      if (cfg.tc === undefined || cfg.tc < 0 || cfg.tc > 7) {
        throw new Error(`Invalid tc: ${cfg.tc}`);
      }
      if (!cfg.idleSlope || cfg.idleSlope <= 0) {
        throw new Error(`Invalid idleSlope for tc ${cfg.tc}`);
      }

      const idleSlopeKbps = Math.round(cfg.idleSlope);
      const bandwidthPercent = (idleSlopeKbps / (linkSpeed * 1000)) * 100;

      console.log(`[CBS] Configure Port ${portNum} TC${cfg.tc}: ${idleSlopeKbps} kbps (${bandwidthPercent.toFixed(2)}%)`);

      results.push({
        tc: cfg.tc,
        idleSlopeKbps,
        bandwidthPercent
      });

      return `- ${buildCbsPath(portNum)}:
    traffic-class: ${cfg.tc}
    credit-based:
      idle-slope: ${idleSlopeKbps}`;
    });

    const yamlContent = yamlLines.join('\n');
    const result = await executeKetiTsn('patch', yamlContent, { device: device || DEFAULT_DEVICE });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({
      success: true,
      port: portNum,
      linkSpeedMbps: linkSpeed,
      configs: results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/cbs/configure/:port/:tc
 * Remove CBS configuration for a specific TC
 */
router.delete('/configure/:port/:tc', async (req, res) => {
  const portNum = req.params.port;
  const tc = parseInt(req.params.tc);
  const device = req.query.device || DEFAULT_DEVICE;

  if (isNaN(tc) || tc < 0 || tc > 7) {
    return res.status(400).json({ error: 'tc must be 0-7' });
  }

  console.log(`[CBS] Delete Port ${portNum} TC${tc}`);

  try {
    // To disable CBS for a TC, we set idle-slope to 0 (or remove the entry)
    // For simplicity, we'll set it to a very high value (effectively unlimited)
    const yamlContent = `- ${buildCbsPath(portNum)}:
    traffic-class: ${tc}
    credit-based:
      idle-slope: 1000000`;  // 1 Gbps = effectively unlimited

    const result = await executeKetiTsn('patch', yamlContent, { device });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({
      success: true,
      port: portNum,
      tc,
      message: `CBS disabled for TC${tc} (set to unlimited)`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cbs/ports
 * Get CBS status for all ports (1 and 2)
 */
router.get('/ports', async (req, res) => {
  const device = req.query.device || DEFAULT_DEVICE;
  const results = {};

  try {
    for (const portNum of ['1', '2']) {
      const queryPath = buildCbsPath(portNum);
      const yamlContent = `- ${queryPath}`;

      try {
        const result = await executeKetiTsn('fetch', yamlContent, { device });

        if (result.success) {
          // Parse YAML output
          const lines = result.output.split('\n');
          const tcConfigs = {};
          let currentTc = null;

          for (const line of lines) {
            const tcMatch = line.match(/traffic-class:\s*(\d+)/);
            if (tcMatch) {
              currentTc = parseInt(tcMatch[1]);
              tcConfigs[currentTc] = {};
            }

            const slopeMatch = line.match(/idle-slope:\s*(\d+)/);
            if (slopeMatch && currentTc !== null) {
              const idleSlopeKbps = parseInt(slopeMatch[1]);
              tcConfigs[currentTc] = {
                idleSlopeKbps,
                bandwidthPercent: (idleSlopeKbps / (DEFAULT_LINK_SPEED_MBPS * 1000)) * 100
              };
            }
          }

          results[portNum] = { tcConfigs, raw: result.output };
        } else {
          results[portNum] = { tcConfigs: {}, error: result.error };
        }
      } catch (e) {
        results[portNum] = { error: e.message };
      }
    }

    res.json({
      linkSpeedMbps: DEFAULT_LINK_SPEED_MBPS,
      ports: results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cbs/link-speed
 * Get actual link speed
 */
router.get('/link-speed', (req, res) => {
  res.json({
    linkSpeedMbps: DEFAULT_LINK_SPEED_MBPS,
    linkSpeedKbps: DEFAULT_LINK_SPEED_MBPS * 1000,
    linkSpeedBps: DEFAULT_LINK_SPEED_MBPS * 1000000
  });
});

export default router;
