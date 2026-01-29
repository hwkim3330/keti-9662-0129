import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/yang-catalog/yang-catalog.js`);
    const yangCatalog = new YangCatalogManager();

    const catalogs = yangCatalog.listCachedCatalogs();

    res.json({
      catalogs,
      count: catalogs.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
