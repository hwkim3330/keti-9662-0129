/**
 * TAS (Time-Aware Shaper) API Routes
 *
 * IEEE 802.1Qbv Gate Control List configuration for LAN9662
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');

const router = express.Router();

// Default transport settings
const DEFAULT_DEVICE = '/dev/ttyACM0';
const DEFAULT_TRANSPORT = 'serial';

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
 * GET /api/tas/status/:port
 * Get TAS status for a specific port
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

    // Query TAS gate-parameter-table
    const queryPath = `/ietf-interfaces:interfaces/interface[name='${portNum}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-sched-bridge:gate-parameter-table`;
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

    // Parse YAML to JSON
    const tasData = yaml.load(result.yaml);

    res.json({
      port: portNum,
      raw: result.yaml,
      config: tasData
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tas/configure/:port
 * Configure TAS GCL for a specific port
 *
 * Body:
 * {
 *   gateEnabled: boolean,
 *   baseTime: { seconds: number, nanoseconds: number },
 *   cycleTime: { numerator: number, denominator: number },
 *   entries: [{ gateStates: number, interval: number }],
 *   transport?: 'serial' | 'wifi',
 *   device?: string,
 *   host?: string
 * }
 */
router.post('/configure/:port', async (req, res) => {
  const portNum = req.params.port;
  const {
    gateEnabled = true,
    baseTime,
    cycleTime,
    entries,
    transport,
    device,
    host,
    port
  } = req.body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries array is required' });
  }

  // Note: LAN9662 may have issues with 8 entries, but allowing user to try
  if (entries.length > 8) {
    return res.status(400).json({ error: 'Maximum 8 GCL entries supported' });
  }

  try {
    const yangCacheDir = await findYangCache();
    const { Tsc2CborConverter } = await import('../../tsc2cbor/tsc2cbor.js');
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const encoder = new Tsc2CborConverter(yangCacheDir);
    const decoder = new Cbor2TscConverter(yangCacheDir);
    const transportInstance = await createConnection({ transport, device, host, port });

    // Build TAS configuration
    const tasPath = `/ietf-interfaces:interfaces/interface[name='${portNum}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-sched-bridge:gate-parameter-table`;

    // Calculate total interval and cycle time
    const totalInterval = entries.reduce((sum, e) => sum + e.interval, 0);

    // Build GCL entries
    const gclEntries = entries.map((entry, idx) => ({
      index: idx,
      'operation-name': 'set-gate-states',
      'gate-states-value': entry.gateStates,
      'time-interval-value': entry.interval
    }));

    // Build complete config
    const tasConfig = {
      [tasPath]: {
        'gate-enabled': gateEnabled,
        'admin-base-time': baseTime || { seconds: Math.floor(Date.now() / 1000) + 10, nanoseconds: 0 },
        'admin-cycle-time': cycleTime || { numerator: totalInterval, denominator: 1000000000 },
        'admin-control-list': {
          'gate-control-entry': gclEntries
        },
        'config-change': true
      }
    };

    // Convert to YAML and encode
    const configYaml = yaml.dump([tasConfig]);
    const encodeResult = await encoder.convertString(configYaml, { verbose: false });

    // Send iPATCH
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
      entriesCount: entries.length,
      cycleTimeNs: totalInterval
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tas/enable/:port
 * Enable or disable TAS on a specific port
 */
router.post('/enable/:port', async (req, res) => {
  const portNum = req.params.port;
  const { enabled = true, transport, device, host, port } = req.body;

  try {
    const yangCacheDir = await findYangCache();
    const { Tsc2CborConverter } = await import('../../tsc2cbor/tsc2cbor.js');

    const encoder = new Tsc2CborConverter(yangCacheDir);
    const transportInstance = await createConnection({ transport, device, host, port });

    const tasPath = `/ietf-interfaces:interfaces/interface[name='${portNum}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-sched-bridge:gate-parameter-table`;
    const config = { [tasPath]: { 'gate-enabled': enabled } };

    const configYaml = yaml.dump([config]);
    const encodeResult = await encoder.convertString(configYaml, { verbose: false });

    const response = await transportInstance.sendiPatchRequest(encodeResult.cbor);
    await transportInstance.disconnect();

    if (!response.isSuccess()) {
      return res.status(500).json({ error: `CoAP code ${response.code}` });
    }

    res.json({ success: true, port: portNum, gateEnabled: enabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tas/ports
 * Get TAS status for all ports (1 and 2)
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
        const queryPath = `/ietf-interfaces:interfaces/interface[name='${portNum}']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-sched-bridge:gate-parameter-table`;
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
          const tasData = yaml.load(result.yaml);
          const gpt = tasData?.['ieee802-dot1q-sched-bridge:gate-parameter-table'] || tasData;

          results[portNum] = {
            gateEnabled: gpt['gate-enabled'] || false,
            operGateStates: gpt['oper-gate-states'],
            configPending: gpt['config-pending'] || false,
            adminEntries: gpt['admin-control-list']?.['gate-control-entry']?.length || 0,
            operEntries: gpt['oper-control-list']?.['gate-control-entry']?.length || 0,
            cycleTime: gpt['oper-cycle-time'] || gpt['admin-cycle-time']
          };
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
