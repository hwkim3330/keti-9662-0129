/**
 * Encode YAML to CBOR command (offline)
 *
 * Converts YAML configuration to CBOR binary format using RFC 9254 Delta-SID encoding.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC2CBOR_LIB = path.resolve(__dirname, '../../tsc2cbor');

/**
 * Find YANG cache directory
 * @param {string|null} cacheOption - User-specified cache path
 * @returns {Promise<string>} Path to YANG cache directory
 */
async function findYangCache(cacheOption) {
  // 1. Use explicitly specified cache directory
  if (cacheOption) {
    if (!fs.existsSync(cacheOption)) {
      throw new Error(`Cache directory not found: ${cacheOption}`);
    }
    return cacheOption;
  }

  // 2. Auto-detect from cached catalogs
  const { YangCatalogManager } = await import(`${TSC2CBOR_LIB}/lib/yang-catalog/yang-catalog.js`);
  const yangCatalog = new YangCatalogManager();
  const catalogs = yangCatalog.listCachedCatalogs();

  if (catalogs.length === 0) {
    throw new Error(
      'No YANG catalog found. Please run "keti-tsn download" first, or specify -c <cache_dir>'
    );
  }

  // Use first available catalog
  return catalogs[0].path;
}

/**
 * Encode YAML to CBOR
 * @param {string} input - Input YAML file path
 * @param {object} options - Command options
 * @param {string} [options.output] - Output file path
 * @param {string} [options.cache] - YANG cache directory
 * @param {boolean} [options.verbose] - Verbose output
 */
export async function encodeCommand(input, options) {
  const verbose = options.verbose || false;

  // Validate input file exists
  if (!fs.existsSync(input)) {
    throw new Error(`Input file not found: ${input}`);
  }

  // Determine output file path
  const outputFile = options.output || input.replace(/\.(yaml|yml)$/i, '.cbor');

  if (verbose) {
    console.log(`Input:  ${input}`);
    console.log(`Output: ${outputFile}`);
  }

  // Find YANG cache directory
  const yangCacheDir = await findYangCache(options.cache);
  if (verbose) {
    console.log(`Cache:  ${yangCacheDir}`);
  }

  // Load converter
  const { Tsc2CborConverter } = await import(`${TSC2CBOR_LIB}/tsc2cbor.js`);

  // Create converter and convert
  const converter = new Tsc2CborConverter(yangCacheDir);

  const sortMode = options.sortMode || 'velocity';

  const result = await converter.convertFile(input, {
    outputFile,
    verbose,
    compatible: true,     // VelocityDRIVE-SP compatible mode
    sortMode,             // 'velocity' (default) or 'rfc8949'
    diagnostic: verbose   // Generate .diag.txt in verbose mode
  });

  // Print summary
  console.log(`\nEncoded: ${input} -> ${outputFile}`);
  console.log(`   ${result.stats.yamlSize} bytes -> ${result.stats.cborSize} bytes (${result.stats.compressionRatio}% saved)`);
}
