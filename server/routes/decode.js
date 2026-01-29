import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();

async function findYangCache(cacheOption) {
  const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');
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
  const { cbor: cborHex, cborBase64, format = 'rfc7951', cache } = req.body;

  if (!cborHex && !cborBase64) {
    return res.status(400).json({ error: 'CBOR content is required (hex or base64)' });
  }

  try {
    const yangCacheDir = await findYangCache(cache);
    const { Cbor2TscConverter } = await import('../../tsc2cbor/cbor2tsc.js');

    const decoder = new Cbor2TscConverter(yangCacheDir);

    const cborBuffer = cborBase64
      ? Buffer.from(cborBase64, 'base64')
      : Buffer.from(cborHex, 'hex');

    const result = await decoder.convertBuffer(cborBuffer, {
      verbose: false,
      outputFormat: format
    });

    res.json({
      yaml: result.yaml,
      format
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
