/**
 * Download command - Download YANG catalog from device or remote server
 * Supports both Serial and WiFi transports.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');

/**
 * Download YANG catalog
 * @param {object} options - Command options
 * @param {string} options.device - Device path (for serial transport)
 * @param {string} options.transport - Transport type (serial/wifi)
 * @param {string} options.host - WiFi proxy host (for wifi transport)
 * @param {number} options.port - WiFi proxy port (for wifi transport)
 * @param {string} options.checksum - Optional checksum (skip device query)
 * @param {boolean} options.verbose - Verbose output
 */
export async function downloadCommand(options) {
  const transportType = options.transport || 'serial';

  const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
  const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/yang-catalog/yang-catalog.js`);

  const yangCatalog = new YangCatalogManager();
  let checksum = options.checksum;

  // If no checksum provided, query from device
  if (!checksum) {
    const transport = createTransport(transportType, { verbose: options.verbose });

    try {
      // Connect based on transport type
      if (transportType === 'wifi') {
        console.log(`Connecting to WiFi proxy at ${options.host}:${options.port}...`);
        await transport.connect({ host: options.host, port: options.port });
      } else {
        console.log(`Connecting to ${options.device}...`);
        await transport.connect({ device: options.device });
      }
      console.log('Connected.');

      console.log('Waiting for board ANNOUNCE...');
      await transport.waitForReady(5000);
      console.log('Board ready.\n');

      checksum = await yangCatalog.queryChecksumFromDevice(transport);

    } catch (error) {
      throw error;
    } finally {
      if (transport.getConnectionStatus()) {
        await transport.disconnect();
      }
    }
  }

  // Check if already cached
  let catalogInfo = yangCatalog.getCatalogInfo(checksum);
  if (catalogInfo) {
    console.log(`\nYANG catalog already available!`);
    console.log(`  Checksum: ${checksum}`);
    console.log(`  Path: ${catalogInfo.path}`);
    console.log(`  YANG files: ${catalogInfo.count.yang}`);
    console.log(`  SID files: ${catalogInfo.count.sid}`);
    return;
  }

  // Download and extract catalog
  console.log(`\nDownloading catalog: ${checksum}`);
  const tarPath = await yangCatalog.downloadCatalog(checksum);
  const catalogDir = await yangCatalog.extractCatalog(tarPath);

  catalogInfo = yangCatalog.getCatalogInfo(checksum);
  console.log(`\nYANG catalog ready!`);
  console.log(`  Checksum: ${checksum}`);
  console.log(`  Path: ${catalogDir}`);
  console.log(`  YANG files: ${catalogInfo.count.yang}`);
  console.log(`  SID files: ${catalogInfo.count.sid}`);
}
