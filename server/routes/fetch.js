import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import yaml from 'js-yaml';

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
    paths,
    transport = 'serial',
    device = '/dev/ttyACM0',
    host,
    port = 5683,
    format = 'rfc7951',
    cache
  } = req.body;

  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths array is required' });
  }

  try {
    const yangCacheDir = await findYangCache(cache);

    const { loadYangInputs } = await import(`${TSC2CBOR_LIB}/common/input-loader.js`);
    const { isInstanceIdentifierFormat, extractSidsFromInstanceIdentifier } = await import(`${TSC2CBOR_LIB}/encoder/transformer-instance-id.js`);
    const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const { sidInfo } = await loadYangInputs(yangCacheDir, false);

    // Convert paths array to instance-identifier format
    let parsedData = paths.map(p => ({ [p]: null }));

    if (!isInstanceIdentifierFormat(parsedData)) {
      return res.status(400).json({ error: 'Invalid path format. Use instance-identifier format.' });
    }

    const queries = extractSidsFromInstanceIdentifier(parsedData, sidInfo, { verbose: false });

    if (queries.length === 0) {
      return res.status(400).json({ error: 'No valid SIDs found in paths' });
    }

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

    const decoder = new Cbor2TscConverter(yangCacheDir);
    const response = await transportInstance.sendiFetchRequest(queries);

    if (!response.isSuccess()) {
      await transportInstance.disconnect();
      return res.status(500).json({ error: `iFETCH failed: CoAP code ${response.code}` });
    }

    const cborPayload = response.payload;
    const result = await decoder.convertBuffer(cborPayload, {
      verbose: false,
      outputFormat: format
    });

    await transportInstance.disconnect();

    res.json({
      result: result.yaml,
      format
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
