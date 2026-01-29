/**
 * Checksum command - Query YANG catalog checksum from device
 * Supports both Serial and WiFi transports.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');

/**
 * Query YANG catalog checksum from device
 * @param {object} options - Command options
 * @param {string} options.device - Device path (for serial transport)
 * @param {string} options.transport - Transport type (serial/wifi)
 * @param {string} options.host - WiFi proxy host (for wifi transport)
 * @param {number} options.port - WiFi proxy port (for wifi transport)
 * @param {boolean} options.verbose - Verbose output
 */
export async function checksumCommand(options) {
  const transportType = options.transport || 'serial';

  const { createTransport } = await import(`${TSC2CBOR_LIB}/transport/index.js`);
  const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/yang-catalog/yang-catalog.js`);

  const transport = createTransport(transportType, { verbose: options.verbose });
  const yangCatalog = new YangCatalogManager();

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

    // Wait for board to be ready (ANNOUNCE frame)
    console.log('Waiting for board ANNOUNCE...');
    await transport.waitForReady(10000);
    console.log('Board ready.\n');

    const checksum = await yangCatalog.queryChecksumFromDevice(transport);
    console.log(`\nYANG Catalog Checksum: ${checksum}`);

    // Check if already cached
    const catalogInfo = yangCatalog.getCatalogInfo(checksum);
    if (catalogInfo) {
      console.log(`Status: Cached`);
      console.log(`  Path: ${catalogInfo.path}`);
      console.log(`  YANG files: ${catalogInfo.count.yang}`);
      console.log(`  SID files: ${catalogInfo.count.sid}`);
    } else {
      console.log('Status: Not cached');
      console.log('Run "keti-tsn download" to download the catalog.');
    }

  } catch (error) {
    throw error;
  } finally {
    if (transport.getConnectionStatus()) {
      await transport.disconnect();
    }
  }
}
