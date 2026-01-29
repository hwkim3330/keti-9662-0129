import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');

const router = express.Router();

// Board connection state
const boardState = new Map();

// Request queue to prevent overloading ESP32
const pendingRequests = new Map();

// GM (ESP1) can be cached longer since it doesn't change
const GM_CACHE_DURATION = 30000; // 30 seconds
const SLAVE_CACHE_DURATION = 2000; // 2 seconds for debounce only

// Check if we can use cached data
function getCachedIfValid(ip) {
  const cached = boardState.get(ip);
  if (!cached || !cached.online) return null;

  const age = Date.now() - cached.lastCheck;
  const isGM = cached.ptp?.isGM;
  const maxAge = isGM ? GM_CACHE_DURATION : SLAVE_CACHE_DURATION;

  if (age < maxAge) {
    return { ...cached, cached: true, cacheAge: age };
  }
  return null;
}

// Simple request debouncing
function canMakeRequest(ip) {
  const pending = pendingRequests.get(ip);
  if (pending && Date.now() - pending < 2000) {
    return false;
  }
  return true;
}

function markRequestStart(ip) {
  pendingRequests.set(ip, Date.now());
}

function markRequestEnd(ip) {
  pendingRequests.delete(ip);
}

// PTP profile configurations
const PTP_PROFILES = {
  gm: {
    name: 'Grandmaster',
    config: {
      'mchp-velocitysp-ptp:automotive': { profile: 'gm' },
      'default-ds': { 'external-port-config-enable': true },
      'ports': {
        port: [{ 'port-index': 8, 'external-port-config-port-ds': { 'desired-state': 'master' } }]
      }
    }
  },
  bridge: {
    name: 'Slave/Bridge',
    config: {
      'mchp-velocitysp-ptp:automotive': { profile: 'bridge' },
      'default-ds': { 'external-port-config-enable': true },
      'ports': {
        port: [{ 'port-index': 8, 'external-port-config-port-ds': { 'desired-state': 'slave' } }]
      },
      'mchp-velocitysp-ptp:servos': {
        servo: [{ 'servo-index': 0, 'servo-type': 'pi', 'ltc-index': 0 }]
      }
    }
  }
};

async function findYangCache() {
  const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/yang-catalog/yang-catalog.js`);
  const yangCatalog = new YangCatalogManager();
  const catalogs = yangCatalog.listCachedCatalogs();
  if (catalogs.length === 0) throw new Error('No YANG catalog found');
  return catalogs[0].path;
}

async function createTransportConnection(host, port = 5683, timeout = 20000) {
  const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
  const transport = createTransport('wifi', { verbose: false });

  // Add timeout wrapper
  const connectWithTimeout = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Connection timeout'));
    }, timeout);

    transport.connect({ host, port })
      .then(() => transport.waitForReady(5000))
      .then(() => {
        clearTimeout(timer);
        resolve(transport);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });

  return connectWithTimeout;
}

// Health check for a single board
router.get('/health/:ip', async (req, res) => {
  const { ip } = req.params;
  const startTime = Date.now();
  let transport = null;

  // Check if we have valid cached data (especially for GM)
  const cached = getCachedIfValid(ip);
  if (cached) {
    return res.json({
      online: cached.online,
      latency: cached.latency,
      ptp: cached.ptp,
      cached: true,
      cacheAge: cached.cacheAge
    });
  }

  // Check if request is already in progress
  if (!canMakeRequest(ip)) {
    const state = boardState.get(ip);
    if (state) {
      return res.json({
        online: state.online,
        latency: state.latency,
        ptp: state.ptp,
        cached: true
      });
    }
    return res.json({ online: false, error: 'Request in progress', cached: true });
  }

  markRequestStart(ip);

  try {
    const yangCacheDir = await findYangCache();
    const { loadYangInputs } = await import(`${TSC2CBOR_LIB}/common/input-loader.js`);
    const { extractSidsFromInstanceIdentifier } = await import(`${TSC2CBOR_LIB}/encoder/transformer-instance-id.js`);
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const { sidInfo } = await loadYangInputs(yangCacheDir, false);
    transport = await createTransportConnection(ip);

    // Quick fetch of PTP servo status
    const queries = extractSidsFromInstanceIdentifier(
      [{ "/ieee1588-ptp:ptp": null }],
      sidInfo,
      { verbose: false }
    );

    const response = await transport.sendiFetchRequest(queries);
    try { await transport.disconnect(); } catch (e) {}

    if (!response.isSuccess()) {
      throw new Error(`CoAP code ${response.code}`);
    }

    const decoder = new Cbor2TscConverter(yangCacheDir);
    const result = await decoder.convertBuffer(response.payload, { verbose: false, outputFormat: 'rfc7951' });

    // Parse PTP status
    const ptpData = parsePtpYaml(result.yaml);
    const latency = Date.now() - startTime;

    // Update board state
    boardState.set(ip, {
      online: true,
      lastCheck: Date.now(),
      latency,
      ptp: ptpData
    });

    markRequestEnd(ip);
    res.json({
      online: true,
      latency,
      ptp: ptpData
    });
  } catch (error) {
    markRequestEnd(ip);

    // Cleanup transport on error
    if (transport) {
      try { await transport.disconnect(); } catch (e) {}
    }

    boardState.set(ip, {
      online: false,
      lastCheck: Date.now(),
      error: error.message
    });

    res.json({
      online: false,
      error: error.message,
      latency: Date.now() - startTime
    });
  }
});

// Quick offset check - uses full path but only parses offset
router.get('/offset/:ip', async (req, res) => {
  const { ip } = req.params;
  const startTime = Date.now();
  let transport = null;

  try {
    const yangCacheDir = await findYangCache();
    const { loadYangInputs } = await import(`${TSC2CBOR_LIB}/common/input-loader.js`);
    const { extractSidsFromInstanceIdentifier } = await import(`${TSC2CBOR_LIB}/encoder/transformer-instance-id.js`);
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const { sidInfo } = await loadYangInputs(yangCacheDir, false);
    transport = await createTransportConnection(ip, 5683, 15000);

    const queries = extractSidsFromInstanceIdentifier(
      [{ "/ieee1588-ptp:ptp": null }],
      sidInfo,
      { verbose: false }
    );

    const response = await transport.sendiFetchRequest(queries);
    try { await transport.disconnect(); } catch (e) {}

    if (!response.isSuccess()) {
      throw new Error(`CoAP code ${response.code}`);
    }

    const decoder = new Cbor2TscConverter(yangCacheDir);
    const result = await decoder.convertBuffer(response.payload, { verbose: false, outputFormat: 'rfc7951' });

    // Parse PTP data
    const yaml = result.yaml || '';
    const offsetMatch = yaml.match(/offset:\s*(-?\d+)/);
    const stateMatch = yaml.match(/state:\s*(\d+)/);
    const portStateMatch = yaml.match(/port-state:\s*(\w+)/);
    const profileMatch = yaml.match(/profile:\s*(\w+)/);
    const asCapable = yaml.includes('as-capable: true');
    const delayMatch = yaml.match(/mean-link-delay:\s*(\d+)/);

    res.json({
      online: true,
      latency: Date.now() - startTime,
      offset: offsetMatch ? parseInt(offsetMatch[1]) : null,
      servoState: stateMatch ? parseInt(stateMatch[1]) : null,
      portState: portStateMatch ? portStateMatch[1] : null,
      profile: profileMatch ? profileMatch[1] : null,
      asCapable,
      meanLinkDelay: delayMatch ? parseInt(delayMatch[1]) : null
    });
  } catch (error) {
    if (transport) {
      try { await transport.disconnect(); } catch (e) {}
    }
    res.json({
      online: false,
      error: error.message,
      latency: Date.now() - startTime
    });
  }
});

// Get cached board states
router.get('/status', (req, res) => {
  const status = {};
  for (const [ip, state] of boardState) {
    status[ip] = state;
  }
  res.json(status);
});

// Get full PTP configuration
router.get('/config/:ip', async (req, res) => {
  const { ip } = req.params;

  try {
    const yangCacheDir = await findYangCache();
    const { loadYangInputs } = await import(`${TSC2CBOR_LIB}/common/input-loader.js`);
    const { extractSidsFromInstanceIdentifier } = await import(`${TSC2CBOR_LIB}/encoder/transformer-instance-id.js`);
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const { sidInfo } = await loadYangInputs(yangCacheDir, false);
    const transport = await createTransportConnection(ip);

    const queries = extractSidsFromInstanceIdentifier(
      [{ "/ieee1588-ptp:ptp": null }],
      sidInfo,
      { verbose: false }
    );

    const response = await transport.sendiFetchRequest(queries);
    await transport.disconnect();

    if (!response.isSuccess()) {
      return res.status(500).json({ error: `CoAP code ${response.code}` });
    }

    const decoder = new Cbor2TscConverter(yangCacheDir);
    const result = await decoder.convertBuffer(response.payload, { verbose: false, outputFormat: 'rfc7951' });

    res.json({
      raw: result.yaml,
      parsed: parsePtpYaml(result.yaml)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Apply PTP profile (GM or Bridge/Slave)
router.post('/apply/:ip', async (req, res) => {
  const { ip } = req.params;
  const { profile, portIndex = 8 } = req.body;

  if (!profile || !PTP_PROFILES[profile]) {
    return res.status(400).json({ error: 'Invalid profile. Use "gm" or "bridge"' });
  }

  try {
    const yangCacheDir = await findYangCache();
    const { Tsc2CborConverter } = await import('../../tsc2cbor/tsc2cbor.js');
    const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);

    const encoder = new Tsc2CborConverter(yangCacheDir);
    const transport = createTransport('wifi', { verbose: false });
    await transport.connect({ host: ip, port: 5683 });
    await transport.waitForReady(5000);

    // Build configuration YAML
    const profileConfig = PTP_PROFILES[profile].config;
    const configYaml = buildPtpConfigYaml(profileConfig, portIndex);

    // Encode to CBOR
    const encodeResult = await encoder.convertString(configYaml, { verbose: false });

    // Send iPATCH
    const response = await transport.sendiPatchRequest(encodeResult.cbor);
    await transport.disconnect();

    if (!response.isSuccess()) {
      return res.status(500).json({
        error: `Failed to apply profile: CoAP code ${response.code}`,
        code: response.code
      });
    }

    res.json({
      success: true,
      profile,
      message: `Applied ${PTP_PROFILES[profile].name} profile to ${ip}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save configuration to startup-config
router.post('/save/:ip', async (req, res) => {
  const { ip } = req.params;

  try {
    const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
    const { buildMessage, MessageType, MethodCode, OptionNumber, ContentFormat } = await import(`${TSC2CBOR_LIB}/coap/coap.js`);
    const { Encoder } = await import('cbor-x');

    const transport = createTransport('wifi', { verbose: false });
    await transport.connect({ host: ip, port: 5683 });
    await transport.waitForReady(5000);

    const cborEncoder = new Encoder({ useRecords: false, mapsAsObjects: false });
    const rpcPayload = cborEncoder.encode(new Map([[21007, null]])); // save-config SID

    const messageId = Math.floor(Math.random() * 65536);
    const coapFrame = buildMessage({
      type: MessageType.CON,
      code: MethodCode.POST,
      messageId,
      token: Buffer.alloc(0),
      options: [
        { number: OptionNumber.URI_PATH, value: 'c' },
        { number: OptionNumber.CONTENT_FORMAT, value: ContentFormat.YANG_INSTANCES_CBOR },
        { number: OptionNumber.ACCEPT, value: ContentFormat.YANG_DATA_CBOR_SID }
      ],
      payload: rpcPayload
    });

    const response = await transport._sendCoAPRequest(coapFrame, messageId);
    await transport.disconnect();

    if (!response.isSuccess()) {
      return res.status(500).json({ error: `Save failed: CoAP code ${response.code}` });
    }

    res.json({ success: true, message: 'Configuration saved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper: Parse PTP YAML response
function parsePtpYaml(yaml) {
  const result = {
    profile: null,
    clockId: null,
    gmId: null,
    isGM: false,
    portState: null,
    asCapable: false,
    servoState: null,
    offset: null,
    meanLinkDelay: null
  };

  if (!yaml) return result;

  // Profile
  const profileMatch = yaml.match(/profile:\s*(\w+)/);
  if (profileMatch) result.profile = profileMatch[1];

  // Clock identities
  const clockMatch = yaml.match(/clock-identity:\s*([\w-]+)/);
  if (clockMatch) result.clockId = clockMatch[1];

  const gmMatch = yaml.match(/grandmaster-identity:\s*([\w-]+)/);
  if (gmMatch) result.gmId = gmMatch[1];

  result.isGM = result.clockId && result.gmId && result.clockId === result.gmId;

  // Port state
  const portStateMatch = yaml.match(/port-state:\s*(\w+)/);
  if (portStateMatch) result.portState = portStateMatch[1];

  // AS-capable
  result.asCapable = yaml.includes('as-capable: true');

  // Servo
  const servoStateMatch = yaml.match(/state:\s*(\d+)/);
  if (servoStateMatch) result.servoState = parseInt(servoStateMatch[1]);

  const offsetMatch = yaml.match(/offset:\s*(-?\d+)/);
  if (offsetMatch) result.offset = parseInt(offsetMatch[1]);

  // Mean link delay
  const delayMatch = yaml.match(/mean-link-delay:\s*(\d+)/);
  if (delayMatch) result.meanLinkDelay = parseInt(delayMatch[1]);

  return result;
}

// Helper: Build PTP config YAML
function buildPtpConfigYaml(config, portIndex) {
  const lines = ["- /ieee1588-ptp:ptp/instances/instance[instance-index='0']:"];

  if (config['default-ds']) {
    lines.push('    default-ds:');
    for (const [key, val] of Object.entries(config['default-ds'])) {
      lines.push(`      ${key}: ${val}`);
    }
  }

  if (config['mchp-velocitysp-ptp:automotive']) {
    lines.push('    mchp-velocitysp-ptp:automotive:');
    lines.push(`      profile: ${config['mchp-velocitysp-ptp:automotive'].profile}`);
  }

  if (config.ports) {
    lines.push('    ports:');
    lines.push('      port:');
    lines.push(`        - port-index: ${portIndex}`);
    lines.push('          external-port-config-port-ds:');
    lines.push(`            desired-state: ${config.ports.port[0]['external-port-config-port-ds']['desired-state']}`);
  }

  if (config['mchp-velocitysp-ptp:servos']) {
    lines.push('    mchp-velocitysp-ptp:servos:');
    lines.push('      servo:');
    const servo = config['mchp-velocitysp-ptp:servos'].servo[0];
    lines.push(`        - servo-index: ${servo['servo-index']}`);
    lines.push(`          servo-type: ${servo['servo-type']}`);
    lines.push(`          ltc-index: ${servo['ltc-index']}`);
  }

  return lines.join('\n');
}

export default router;
