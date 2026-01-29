/**
 * YANG catalog management command
 *
 * Commands:
 *   keti-tsn <device> yang id         : Query YANG catalog checksum from device
 *   keti-tsn <device> yang download   : Download YANG catalog from device
 *   keti-tsn yang list                : List cached catalogs (offline)
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');

// Dynamic imports for tsc2cbor modules
async function loadModules() {
  const { SerialManager } = await import(`${TSC2CBOR_LIB}/serial/serial.js`);
  const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/yang-catalog/yang-catalog.js`);
  return { SerialManager, YangCatalogManager };
}

export async function yangCommand(action, options) {
  const { SerialManager, YangCatalogManager } = await loadModules();

  switch (action) {
    case 'id':
      await yangIdCommand(options, SerialManager, YangCatalogManager);
      break;
    case 'download':
      await yangDownloadCommand(options, SerialManager, YangCatalogManager);
      break;
    case 'list':
      await yangListCommand(YangCatalogManager);
      break;
    default:
      console.error(`Unknown action: ${action}`);
      console.log('Available actions: id, download, list');
      process.exit(1);
  }
}

/**
 * Query YANG catalog checksum from device
 */
async function yangIdCommand(options, SerialManager, YangCatalogManager) {
  if (!options.device) {
    console.error('Error: Device path required');
    console.log('Usage: keti-tsn <device> yang id');
    console.log('Example: keti-tsn /dev/ttyACM0 yang id');
    process.exit(1);
  }

  const serialManager = new SerialManager();
  const yangCatalog = new YangCatalogManager();

  try {
    console.log(`Connecting to ${options.device}...`);
    await serialManager.connect(options.device);
    console.log('Connected.\n');

    const checksum = await yangCatalog.queryChecksumFromDevice(serialManager);
    console.log(`\nYANG Catalog Checksum: ${checksum}`);

    // Check if already cached
    const catalogInfo = yangCatalog.getCatalogInfo(checksum);
    if (catalogInfo) {
      console.log(`Status: Cached at ${catalogInfo.path}`);
      console.log(`  YANG files: ${catalogInfo.count.yang}`);
      console.log(`  SID files: ${catalogInfo.count.sid}`);
    } else {
      console.log('Status: Not cached');
      console.log(`Run "keti-tsn ${options.device} yang download" to download.`);
    }

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    if (serialManager.getConnectionStatus()) {
      await serialManager.disconnect();
    }
  }
}

/**
 * Download YANG catalog
 */
async function yangDownloadCommand(options, SerialManager, YangCatalogManager) {
  const yangCatalog = new YangCatalogManager();
  let checksum = options.checksum;

  // If no checksum provided, query from device
  if (!checksum) {
    if (!options.device) {
      console.error('Error: Device path required');
      console.log('Usage: keti-tsn <device> yang download');
      console.log('Example: keti-tsn /dev/ttyACM0 yang download');
      process.exit(1);
    }

    const serialManager = new SerialManager();

    try {
      console.log(`Connecting to ${options.device}...`);
      await serialManager.connect(options.device);
      console.log('Connected.\n');

      checksum = await yangCatalog.queryChecksumFromDevice(serialManager);

    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    } finally {
      if (serialManager.getConnectionStatus()) {
        await serialManager.disconnect();
      }
    }
  }

  // Download and extract catalog
  try {
    console.log(`\nDownloading catalog: ${checksum}`);
    const tarPath = await yangCatalog.downloadCatalog(checksum);
    const catalogDir = await yangCatalog.extractCatalog(tarPath);

    const catalogInfo = yangCatalog.getCatalogInfo(checksum);
    console.log(`\nYANG catalog ready!`);
    console.log(`  Checksum: ${checksum}`);
    console.log(`  Path: ${catalogDir}`);
    console.log(`  YANG files: ${catalogInfo.count.yang}`);
    console.log(`  SID files: ${catalogInfo.count.sid}`);

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * List cached catalogs
 */
async function yangListCommand(YangCatalogManager) {
  const yangCatalog = new YangCatalogManager();
  const catalogs = yangCatalog.listCachedCatalogs();

  if (catalogs.length === 0) {
    console.log('No cached catalogs found.');
    console.log('Run "keti-tsn <device> yang download" to download.');
    return;
  }

  console.log('Cached YANG Catalogs:\n');
  for (const catalog of catalogs) {
    console.log(`  ${catalog.checksum}`);
    console.log(`    Path: ${catalog.path}`);
    console.log(`    YANG files: ${catalog.count.yang}`);
    console.log(`    SID files: ${catalog.count.sid}`);
    console.log('');
  }
}
