/**
 * CBS (Credit-Based Shaper) API Routes
 *
 * IEEE 802.1Qav CBS configuration for LAN9662
 *
 * CBS Parameters:
 *   - idleSlope: Credit accumulation rate (bits/sec) - determines bandwidth allocation
 *   - sendSlope: Credit consumption rate = -(linkSpeed - idleSlope)
 *   - hiCredit: Maximum credit (bytes)
 *   - loCredit: Minimum credit (bytes, negative)
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

    // Query CBS traffic-class-bandwidth-table
    const queryPath = `/ietf-interfaces:interfaces/interface[name='${portNum}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-stream-filters-gates:stream-filters/ieee802-dot1q-sched-bridge:traffic-class-bandwidth-table`;
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

    res.json({
      port: portNum,
      raw: result.yaml,
      config: cbsData
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
 *   idleSlope: number (bits/sec),
 *   sendSlope?: number (auto-calculated if not provided),
 *   hiCredit?: number (bytes),
 *   loCredit?: number (bytes),
 *   linkSpeed?: number (Mbps, default 100),
 *   transport?: 'serial' | 'wifi',
 *   device?: string
 * }
 */
router.post('/configure/:port', async (req, res) => {
  const portNum = req.params.port;
  const {
    tc,
    idleSlope,
    sendSlope,
    hiCredit,
    loCredit,
    linkSpeed = DEFAULT_LINK_SPEED_MBPS,
    transport,
    device,
    host,
    port
  } = req.body;

  if (tc === undefined || tc < 0 || tc > 7) {
    return res.status(400).json({ error: 'tc must be 0-7' });
  }

  if (!idleSlope || idleSlope <= 0) {
    return res.status(400).json({ error: 'idleSlope (bps) is required and must be positive' });
  }

  // Calculate sendSlope if not provided: sendSlope = -(linkSpeed - idleSlope)
  const linkSpeedBps = linkSpeed * 1000000;
  const calculatedSendSlope = sendSlope || -(linkSpeedBps - idleSlope);

  // Default hi/lo credit if not provided
  const calculatedHiCredit = hiCredit || 1600 * 8; // 1 max frame * 8 bits
  const calculatedLoCredit = loCredit || -calculatedHiCredit;

  try {
    const yangCacheDir = await findYangCache();
    const { Tsc2CborConverter } = await import('../../tsc2cbor/tsc2cbor.js');
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const encoder = new Tsc2CborConverter(yangCacheDir);
    const decoder = new Cbor2TscConverter(yangCacheDir);
    const transportInstance = await createConnection({ transport, device, host, port });

    // Build CBS configuration path
    // IEEE 802.1Qav uses traffic-class-bandwidth-table for CBS
    const cbsPath = `/ietf-interfaces:interfaces/interface[name='${portNum}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-stream-filters-gates:stream-filters/ieee802-dot1q-sched-bridge:traffic-class-bandwidth-table`;

    const cbsConfig = {
      [cbsPath]: {
        'traffic-class': tc,
        'idle-slope': Math.round(idleSlope),
        'send-slope': Math.round(calculatedSendSlope),
        'hi-credit': Math.round(calculatedHiCredit),
        'lo-credit': Math.round(calculatedLoCredit)
      }
    };

    const configYaml = yaml.dump([cbsConfig]);
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

    res.json({
      success: true,
      port: portNum,
      tc,
      idleSlope: Math.round(idleSlope),
      sendSlope: Math.round(calculatedSendSlope),
      hiCredit: Math.round(calculatedHiCredit),
      loCredit: Math.round(calculatedLoCredit),
      bandwidthPercent: (idleSlope / linkSpeedBps) * 100
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
        const queryPath = `/ietf-interfaces:interfaces/interface[name='${portNum}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-stream-filters-gates:stream-filters/ieee802-dot1q-sched-bridge:traffic-class-bandwidth-table`;
        const queries = extractSidsFromInstanceIdentifier(
          [{ [queryPath]: null }],
          sidInfo,
          { verbose: false }
        );

        const response = await transportInstance.sendiFetchRequest(queries);

        if (response.isSuccess()) {
          const result = await decoder.convertBuffer(response.payload, {
            verbose: false,
            outputFormat: 'rfc7951'
          });
          const cbsData = yaml.load(result.yaml);
          results[portNum] = cbsData;
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
