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
    patches,
    transport = 'serial',
    device = '/dev/ttyACM0',
    host,
    port = 5683,
    cache
  } = req.body;

  if (!patches || !Array.isArray(patches) || patches.length === 0) {
    return res.status(400).json({ error: 'patches array is required' });
  }

  try {
    const yangCacheDir = await findYangCache(cache);

    const { isInstanceIdentifierFormat } = await import(`${TSC2CBOR_LIB}/encoder/transformer-instance-id.js`);
    const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
    const { Tsc2CborConverter } = await import('../../tsc2cbor/tsc2cbor.js');
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    // Convert patches to instance-identifier format
    const patchItems = patches.map(p => ({ [p.path]: p.value }));

    if (!isInstanceIdentifierFormat(patchItems)) {
      return res.status(400).json({ error: 'Invalid path format. Use instance-identifier format.' });
    }

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

    // Process each patch item sequentially
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < patchItems.length; i++) {
      const item = patchItems[i];
      const itemPath = Object.keys(item)[0];

      try {
        const singleItemYaml = yaml.dump([item]);
        const encodeResult = await encoder.convertString(singleItemYaml, { verbose: false });
        const patchData = encodeResult.cbor;

        const response = await transportInstance.sendiPatchRequest(patchData);

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

          results.push({ path: itemPath, success: false, error: errorDetail });
          failCount++;
        } else {
          results.push({ path: itemPath, success: true });
          successCount++;
        }
      } catch (err) {
        results.push({ path: itemPath, success: false, error: err.message });
        failCount++;
      }
    }

    await transportInstance.disconnect();

    res.json({
      results,
      summary: {
        total: patchItems.length,
        success: successCount,
        failed: failCount
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
