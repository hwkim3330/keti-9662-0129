/**
 * List command - List cached YANG catalogs (offline)
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor/lib');

/**
 * List cached YANG catalogs
 * @param {object} options - Command options
 * @param {boolean} options.verbose - Verbose output
 */
export async function listCommand(options) {
  const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/yang-catalog/yang-catalog.js`);

  const yangCatalog = new YangCatalogManager();
  const catalogs = yangCatalog.listCachedCatalogs();

  if (catalogs.length === 0) {
    console.log('No cached YANG catalogs found.');
    console.log('Run "keti-tsn download" to download a catalog.');
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
