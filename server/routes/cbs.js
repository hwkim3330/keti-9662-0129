/**
 * CBS (Credit-Based Shaper) API Routes
 *
 * IEEE 802.1Qav CBS configuration for LAN9662
 * Uses Microchip VelocitySP YANG model (mchp-velocitysp-port)
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
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');
const CBS_ESTIMATOR = path.resolve(__dirname, '../cbs-estimator');

const router = express.Router();

// Default transport settings
const DEFAULT_DEVICE = '/dev/ttyACM0';
const DEFAULT_TRANSPORT = 'serial';
const DEFAULT_LINK_SPEED_MBPS = 100;

/**
 * Find YANG cache directory
 */
async function findYangCache() {
  const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/yang-catalog/yang-catalog.js`);
  const yangCatalog = new YangCatalogManager();
  const catalogs = yangCatalog.listCachedCatalogs();
  if (catalogs.length === 0) {
    throw new Error('No YANG catalog found');
  }
  return catalogs[0].path;
}

/**
 * Create transport connection
 */
async function createConnection(options = {}) {
  const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
  const transportType = options.transport || DEFAULT_TRANSPORT;
  const transport = createTransport(transportType, { verbose: false });

  if (transportType === 'wifi') {
    await transport.connect({ host: options.host, port: options.port || 5683 });
  } else {
    await transport.connect({ device: options.device || DEFAULT_DEVICE });
  }
  await transport.waitForReady(5000);
  return transport;
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
  const { transport, device, host, port } = req.query;

  try {
    const yangCacheDir = await findYangCache();
    const { loadYangInputs } = await import(`${TSC2CBOR_LIB}/common/input-loader.js`);
    const { extractSidsFromInstanceIdentifier } = await import(`${TSC2CBOR_LIB}/encoder/transformer-instance-id.js`);
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const { sidInfo } = await loadYangInputs(yangCacheDir, false);
    const transportInstance = await createConnection({ transport, device, host, port });

    // Query CBS traffic-class-shapers using Microchip YANG model
    const queryPath = buildCbsPath(portNum);
    const queries = extractSidsFromInstanceIdentifier(
      [{ [queryPath]: null }],
      sidInfo,
      { verbose: false }
    );

    const response = await transportInstance.sendiFetchRequest(queries);
    await transportInstance.disconnect();

    if (!response.isSuccess()) {
      return res.status(500).json({ error: `CoAP code ${response.code}` });
    }

    const decoder = new Cbor2TscConverter(yangCacheDir);
    const result = await decoder.convertBuffer(response.payload, {
      verbose: false,
      outputFormat: 'rfc7951'
    });

    const cbsData = yaml.load(result.yaml);

    // Parse the response to extract TC configurations
    const tcConfigs = {};

    // Handle different response formats
    let shapers = [];
    if (cbsData) {
      if (cbsData['traffic-class-shapers']) {
        shapers = cbsData['traffic-class-shapers'];
      } else if (cbsData['mchp-velocitysp-port:traffic-class-shapers']) {
        shapers = cbsData['mchp-velocitysp-port:traffic-class-shapers'];
      } else if (Array.isArray(cbsData)) {
        // Handle array format from some responses
        for (const item of cbsData) {
          const itemShapers = item?.['traffic-class-shapers'] ||
                             item?.['mchp-velocitysp-port:traffic-class-shapers'] || [];
          shapers = shapers.concat(itemShapers);
        }
      }
    }

    // Ensure shapers is an array
    if (!Array.isArray(shapers)) {
      shapers = shapers ? [shapers] : [];
    }

    for (const shaper of shapers) {
      const tc = shaper['traffic-class'];
      if (shaper['credit-based']) {
        tcConfigs[tc] = {
          idleSlopeKbps: shaper['credit-based']['idle-slope'],
          idleSlopeBps: shaper['credit-based']['idle-slope'] * 1000,
          bandwidthPercent: (shaper['credit-based']['idle-slope'] * 1000) / (DEFAULT_LINK_SPEED_MBPS * 1000000) * 100
        };
      } else if (shaper['single-leaky-bucket']) {
        tcConfigs[tc] = {
          type: 'leaky-bucket',
          cirKbps: shaper['single-leaky-bucket']['committed-information-rate'],
          cbs: shaper['single-leaky-bucket']['committed-burst-size']
        };
      }
    }

    res.json({
      port: portNum,
      raw: result.yaml,
      tcConfigs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cbs/configure/:port
 * Configure CBS or Single Leaky Bucket shaper for a specific port
 *
 * Body:
 * {
 *   tc: number (0-7),
 *   idleSlope: number (bits/sec) - for CBS mode,
 *   cir: number (bits/sec) - for Single Leaky Bucket mode,
 *   cbs: number (bytes) - burst size for SLB mode,
 *   mode: 'cbs' | 'slb' - shaper mode (default: 'cbs'),
 *   linkSpeed?: number (Mbps, default 100),
 *   transport?: 'serial' | 'wifi',
 *   device?: string
 * }
 */
router.post('/configure/:port', async (req, res) => {
  const portNum = req.params.port;
  const {
    tc,
    idleSlope,  // For CBS mode (bps)
    cir,        // For SLB mode (bps)
    cbs: burstSize,  // For SLB mode (bytes)
    mode = 'cbs',
    linkSpeed = DEFAULT_LINK_SPEED_MBPS,
    transport,
    device,
    host,
    port
  } = req.body;

  if (tc === undefined || tc < 0 || tc > 7) {
    return res.status(400).json({ error: 'tc must be 0-7' });
  }

  const linkSpeedBps = linkSpeed * 1000000;
  const useSLB = mode === 'slb' || cir !== undefined;

  // Validate parameters based on mode
  if (useSLB) {
    if (!cir || cir <= 0) {
      return res.status(400).json({ error: 'cir (bps) is required for SLB mode' });
    }
  } else {
    if (!idleSlope || idleSlope <= 0) {
      return res.status(400).json({ error: 'idleSlope (bps) is required for CBS mode' });
    }
  }

  // Convert bps to kbps for device (LAN9662 uses kbps)
  const idleSlopeKbps = idleSlope ? Math.round(idleSlope / 1000) : 0;
  const cirKbps = cir ? Math.round(cir / 1000) : 0;
  const cbsBytes = burstSize || 16000;  // Default 16KB burst

  try {
    const yangCacheDir = await findYangCache();
    const { Tsc2CborConverter } = await import('../../tsc2cbor/tsc2cbor.js');
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const encoder = new Tsc2CborConverter(yangCacheDir);
    const decoder = new Cbor2TscConverter(yangCacheDir);
    const transportInstance = await createConnection({ transport, device, host, port });

    // Build shaper configuration using Microchip YANG model
    const shaperPath = buildCbsPath(portNum);

    let shaperConfig;
    if (useSLB) {
      // Single Leaky Bucket mode
      shaperConfig = {
        [shaperPath]: {
          'traffic-class': tc,
          'single-leaky-bucket': {
            'committed-information-rate': cirKbps,
            'committed-burst-size': cbsBytes
          }
        }
      };
    } else {
      // Credit-Based Shaper mode
      shaperConfig = {
        [shaperPath]: {
          'traffic-class': tc,
          'credit-based': {
            'idle-slope': idleSlopeKbps
          }
        }
      };
    }

    const cbsConfig = shaperConfig;

    const configYaml = yaml.dump([cbsConfig]);
    console.log('CBS Config YAML:', configYaml);

    const encodeResult = await encoder.convertString(configYaml, { verbose: false });

    const response = await transportInstance.sendiPatchRequest(encodeResult.cbor);
    await transportInstance.disconnect();

    if (!response.isSuccess()) {
      let errorDetail = `CoAP code ${response.code}`;
      if (response.payload && response.payload.length > 0) {
        try {
          const errorResult = await decoder.convertBuffer(response.payload, {
            verbose: false,
            outputFormat: 'rfc7951'
          });
          errorDetail = errorResult.yaml;
        } catch {
          errorDetail = `Payload: ${response.payload.toString('hex')}`;
        }
      }
      return res.status(500).json({ error: errorDetail });
    }

    const rateKbps = useSLB ? cirKbps : idleSlopeKbps;
    res.json({
      success: true,
      port: portNum,
      tc,
      mode: useSLB ? 'slb' : 'cbs',
      rateKbps,
      rateBps: rateKbps * 1000,
      bandwidthPercent: (rateKbps * 1000 / linkSpeedBps) * 100,
      ...(useSLB ? { cirKbps, cbsBytes } : { idleSlopeKbps })
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/cbs/configure/:port/:tc
 * Remove CBS configuration for a specific TC (disable shaper)
 */
router.delete('/configure/:port/:tc', async (req, res) => {
  const portNum = req.params.port;
  const tc = parseInt(req.params.tc);
  const { transport, device, host, port } = req.query;

  if (isNaN(tc) || tc < 0 || tc > 7) {
    return res.status(400).json({ error: 'tc must be 0-7' });
  }

  try {
    const yangCacheDir = await findYangCache();
    const { Tsc2CborConverter } = await import('../../tsc2cbor/tsc2cbor.js');
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const encoder = new Tsc2CborConverter(yangCacheDir);
    const decoder = new Cbor2TscConverter(yangCacheDir);
    const transportInstance = await createConnection({ transport, device, host, port });

    // Delete the traffic-class-shaper entry
    const deletePath = `/ietf-interfaces:interfaces/interface[name='${portNum}']/mchp-velocitysp-port:eth-qos/config/traffic-class-shapers[traffic-class=${tc}]`;

    const deleteConfig = {
      [deletePath]: null  // null indicates deletion
    };

    const configYaml = yaml.dump([deleteConfig]);
    const encodeResult = await encoder.convertString(configYaml, { verbose: false, operation: 'delete' });

    // Use DELETE operation
    const response = await transportInstance.sendiDeleteRequest(encodeResult.cbor);
    await transportInstance.disconnect();

    if (!response.isSuccess()) {
      let errorDetail = `CoAP code ${response.code}`;
      if (response.payload && response.payload.length > 0) {
        try {
          const errorResult = await decoder.convertBuffer(response.payload, {
            verbose: false,
            outputFormat: 'rfc7951'
          });
          errorDetail = errorResult.yaml;
        } catch {
          errorDetail = `Payload: ${response.payload.toString('hex')}`;
        }
      }
      return res.status(500).json({ error: errorDetail });
    }

    res.json({
      success: true,
      port: portNum,
      tc,
      message: `CBS disabled for TC${tc}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cbs/estimate
 * Run CBS idle slope estimation on captured traffic
 *
 * Body:
 * {
 *   interface: string,
 *   duration: number (seconds),
 *   vlanId?: number (default 100),
 *   linkSpeed?: number (Mbps, default 100)
 * }
 */
router.post('/estimate', async (req, res) => {
  const {
    interface: ifaceName,
    duration = 5,
    vlanId = 100,
    linkSpeed = DEFAULT_LINK_SPEED_MBPS
  } = req.body;

  if (!ifaceName) {
    return res.status(400).json({ error: 'interface is required' });
  }

  try {
    const args = [ifaceName, String(duration), String(vlanId), String(linkSpeed)];

    const estimator = spawn(CBS_ESTIMATOR, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    estimator.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    estimator.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    estimator.on('close', (code) => {
      if (code !== 0) {
        return res.status(500).json({
          error: `Estimator exited with code ${code}`,
          stderr
        });
      }

      try {
        const result = JSON.parse(stdout);
        res.json(result);
      } catch (e) {
        res.json({
          raw: stdout,
          stderr
        });
      }
    });

    estimator.on('error', (err) => {
      res.status(500).json({ error: err.message });
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
  const { transport, device, host, port } = req.query;
  const results = {};

  try {
    const yangCacheDir = await findYangCache();
    const { loadYangInputs } = await import(`${TSC2CBOR_LIB}/common/input-loader.js`);
    const { extractSidsFromInstanceIdentifier } = await import(`${TSC2CBOR_LIB}/encoder/transformer-instance-id.js`);
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const { sidInfo } = await loadYangInputs(yangCacheDir, false);
    const transportInstance = await createConnection({ transport, device, host, port });
    const decoder = new Cbor2TscConverter(yangCacheDir);

    for (const portNum of ['1', '2']) {
      try {
        const queryPath = buildCbsPath(portNum);
        const queries = extractSidsFromInstanceIdentifier(
          [{ [queryPath]: null }],
          sidInfo,
          { verbose: false }
        );

        const response = await transportInstance.sendiFetchRequest(queries);

        if (response.isSuccess() && response.payload && response.payload.length > 0) {
          const result = await decoder.convertBuffer(response.payload, {
            verbose: false,
            outputFormat: 'rfc7951'
          });
          const cbsData = yaml.load(result.yaml);

          // Parse TC configurations
          const tcConfigs = {};
          let shapers = [];

          if (cbsData) {
            if (cbsData['traffic-class-shapers']) {
              shapers = cbsData['traffic-class-shapers'];
            } else if (cbsData['mchp-velocitysp-port:traffic-class-shapers']) {
              shapers = cbsData['mchp-velocitysp-port:traffic-class-shapers'];
            } else if (Array.isArray(cbsData)) {
              for (const item of cbsData) {
                const itemShapers = item?.['traffic-class-shapers'] ||
                                   item?.['mchp-velocitysp-port:traffic-class-shapers'] || [];
                shapers = shapers.concat(itemShapers);
              }
            }
          }

          if (!Array.isArray(shapers)) {
            shapers = shapers ? [shapers] : [];
          }

          for (const shaper of shapers) {
            const tc = shaper['traffic-class'];
            if (shaper['credit-based']) {
              tcConfigs[tc] = {
                idleSlopeKbps: shaper['credit-based']['idle-slope'],
                bandwidthPercent: (shaper['credit-based']['idle-slope'] * 1000) / (DEFAULT_LINK_SPEED_MBPS * 1000000) * 100
              };
            }
          }
          results[portNum] = { tcConfigs, raw: result.yaml };
        } else {
          results[portNum] = { tcConfigs: {}, message: 'No CBS configuration' };
        }
      } catch (e) {
        results[portNum] = { error: e.message };
      }
    }

    await transportInstance.disconnect();
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
