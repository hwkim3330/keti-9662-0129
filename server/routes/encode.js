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
  const { yaml: yamlContent, sortMode = 'velocity', cache } = req.body;

  if (!yamlContent) {
    return res.status(400).json({ error: 'YAML content is required' });
  }

  try {
    const yangCacheDir = await findYangCache(cache);
    const { Tsc2CborConverter } = await import('../../tsc2cbor/tsc2cbor.js');

    const encoder = new Tsc2CborConverter(yangCacheDir);
    const result = await encoder.convertString(yamlContent, {
      verbose: false,
      sortMode
    });

    res.json({
      cbor: result.cbor.toString('hex'),
      cborBase64: result.cbor.toString('base64'),
      size: result.cbor.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
