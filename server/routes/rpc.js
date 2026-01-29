import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');

const router = express.Router();

async function findYangCache(cacheOption) {
  const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/yang-catalog/yang-catalog.js`);

  if (cacheOption) {
    if (!fs.existsSync(cacheOption)) {
      throw new Error(`Cache directory not found: ${cacheOption}`);
    }
    return cacheOption;
  }

  const yangCatalog = new YangCatalogManager();
  const catalogs = yangCatalog.listCachedCatalogs();

  if (catalogs.length === 0) {
    throw new Error('No YANG catalog found. Please download first.');
  }

  return catalogs[0].path;
}

// RPC endpoint for YANG RPCs like save-config
router.post('/', async (req, res) => {
  const {
    rpcPath,
    input = null,
    transport = 'serial',
    device = '/dev/ttyACM0',
    host,
    port = 5683,
    cache
  } = req.body;

  if (!rpcPath) {
    return res.status(400).json({ error: 'rpcPath is required' });
  }

  try {
    const yangCacheDir = await findYangCache(cache);

    const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
    const { Tsc2CborConverter } = await import('../../tsc2cbor/tsc2cbor.js');
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const encoder = new Tsc2CborConverter(yangCacheDir);
    const decoder = new Cbor2TscConverter(yangCacheDir);

    // Create transport and connect
    const transportInstance = createTransport(transport, { verbose: false });

    if (transport === 'wifi') {
      if (!host) {
        return res.status(400).json({ error: 'WiFi transport requires host parameter' });
      }
      await transportInstance.connect({ host, port });
    } else {
      await transportInstance.connect({ device });
    }

    await transportInstance.waitForReady(5000);

    // Encode the RPC path to CBOR (SID)
    let payload = Buffer.alloc(0);

    if (input) {
      // If there's input, encode it
      const inputYaml = `- ${rpcPath}: ${JSON.stringify(input)}`;
      const encodeResult = await encoder.convertString(inputYaml, { verbose: false });
      payload = encodeResult.cbor;
    } else {
      // For RPCs without input (like save-config), just encode the path
      const rpcYaml = `- ${rpcPath}: null`;
      const encodeResult = await encoder.convertString(rpcYaml, { verbose: false });
      payload = encodeResult.cbor;
    }

    // Send POST request for RPC
    const response = await transportInstance.sendPostRequest(payload, {});

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

      return res.status(400).json({
        success: false,
        error: errorDetail,
        code: response.code
      });
    }

    // Decode response if any
    let result = null;
    if (response.payload && response.payload.length > 0) {
      try {
        const decodeResult = await decoder.convertBuffer(response.payload, {
          verbose: false,
          outputFormat: 'rfc7951'
        });
        result = decodeResult.yaml;
      } catch {
        result = response.payload.toString('hex');
      }
    }

    res.json({
      success: true,
      rpcPath,
      result
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save config endpoint - try multiple methods for save-config
router.post('/save-config', async (req, res) => {
  const {
    transport = 'serial',
    device = '/dev/ttyACM0',
    host,
    port = 5683
  } = req.body;

  try {
    const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
    const {
      buildMessage,
      MessageType,
      MethodCode,
      OptionNumber,
      ContentFormat
    } = await import(`${TSC2CBOR_LIB}/coap/coap.js`);

    // Create transport and connect
    const transportInstance = createTransport(transport, { verbose: false });

    if (transport === 'wifi') {
      if (!host) {
        return res.status(400).json({ error: 'WiFi transport requires host parameter' });
      }
      await transportInstance.connect({ host, port });
    } else {
      await transportInstance.connect({ device });
    }

    await transportInstance.waitForReady(5000);

    // Try POST to /c with save-config SID (21007)
    // According to CORECONF, RPC is invoked with POST to /c with the RPC SID
    const { Encoder } = await import('cbor-x');
    const cborEncoder = new Encoder({ useRecords: false, mapsAsObjects: false });

    // Encode RPC: Map { 21007: null } (save-config SID)
    const rpcPayload = cborEncoder.encode(new Map([[21007, null]]));

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

    const response = await transportInstance._sendCoAPRequest(coapFrame, messageId);

    await transportInstance.disconnect();

    if (!response.isSuccess()) {
      return res.status(400).json({
        success: false,
        error: `CoAP code ${response.code}`,
        code: response.code,
        codeHex: '0x' + response.code.toString(16)
      });
    }

    res.json({
      success: true,
      message: 'Configuration saved to startup-config'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get well-known/core resources from device
router.get('/discover', async (req, res) => {
  const {
    transport = 'wifi',
    device = '/dev/ttyACM0',
    host,
    port = 5683
  } = req.query;

  try {
    const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
    const {
      buildMessage,
      MessageType,
      MethodCode,
      OptionNumber
    } = await import(`${TSC2CBOR_LIB}/coap/coap.js`);

    const transportInstance = createTransport(transport, { verbose: false });

    if (transport === 'wifi') {
      if (!host) {
        return res.status(400).json({ error: 'WiFi transport requires host parameter' });
      }
      await transportInstance.connect({ host, port: parseInt(port) });
    } else {
      await transportInstance.connect({ device });
    }

    await transportInstance.waitForReady(5000);

    // GET /.well-known/core
    const messageId = Math.floor(Math.random() * 65536);
    const coapFrame = buildMessage({
      type: MessageType.CON,
      code: MethodCode.GET,
      messageId,
      token: Buffer.alloc(0),
      options: [
        { number: OptionNumber.URI_PATH, value: '.well-known' },
        { number: OptionNumber.URI_PATH, value: 'core' }
      ]
    });

    const response = await transportInstance._sendCoAPRequest(coapFrame, messageId);
    await transportInstance.disconnect();

    if (!response.isSuccess()) {
      return res.status(400).json({
        success: false,
        error: `CoAP code ${response.code}`,
        code: response.code
      });
    }

    const resources = response.payload ? response.payload.toString('utf8') : '';
    res.json({
      success: true,
      resources: resources
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
