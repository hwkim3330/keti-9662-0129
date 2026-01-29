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

router.post('/', async (req, res) => {
  const {
    transport = 'serial',
    device = '/dev/ttyACM0',
    host,
    port = 5683,
    format = 'rfc7951',
    cache
  } = req.body;

  try {
    const yangCacheDir = await findYangCache(cache);

    const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

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

    // Use block-wise GET to retrieve full configuration
    const decoder = new Cbor2TscConverter(yangCacheDir);
    const response = await transportInstance.sendBlockwiseGet();

    if (!response.isSuccess()) {
      await transportInstance.disconnect();
      return res.status(500).json({ error: `GET failed: CoAP code ${response.code}` });
    }

    const cborPayload = response.payload;
    const result = await decoder.convertBuffer(cborPayload, {
      verbose: false,
      outputFormat: format
    });

    await transportInstance.disconnect();

    res.json({
      result: result.yaml,
      format,
      size: cborPayload.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
