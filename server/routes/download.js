import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');

const router = express.Router();

router.post('/', async (req, res) => {
  const { transport = 'serial', device = '/dev/ttyACM0', host, port = 5683 } = req.body;

  try {
    const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
    const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/yang-catalog/yang-catalog.js`);

    const transportInstance = createTransport(transport, { verbose: false });
    const yangCatalog = new YangCatalogManager();

    // Connect based on transport type
    if (transport === 'wifi') {
      if (!host) {
        return res.status(400).json({ error: 'WiFi transport requires host parameter' });
      }
      await transportInstance.connect({ host, port });
    } else {
      await transportInstance.connect({ device });
    }

    // Wait for board to be ready
    await transportInstance.waitForReady(10000);

    // Get checksum first
    const checksum = await yangCatalog.queryChecksumFromDevice(transportInstance);

    // Check if already cached
    let catalogInfo = yangCatalog.getCatalogInfo(checksum);
    if (catalogInfo) {
      await transportInstance.disconnect();
      return res.json({
        message: 'Catalog already cached',
        checksum,
        catalogInfo
      });
    }

    await transportInstance.disconnect();

    // Download catalog from remote server (Microchip)
    const tarPath = await yangCatalog.downloadCatalog(checksum);

    // Extract catalog
    await yangCatalog.extractCatalog(tarPath);

    // Get catalog info after download
    catalogInfo = yangCatalog.getCatalogInfo(checksum);

    res.json({
      message: 'Catalog downloaded successfully',
      checksum,
      catalogInfo
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
