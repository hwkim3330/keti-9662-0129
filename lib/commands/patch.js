/**
 * Patch configuration command (iPATCH)
 *
 * Modifies configuration values on device using CoAP iPATCH.
 * Supports instance-identifier format.
 * Supports both Serial and WiFi transports.
 *
 * Note: Multiple paths are sent sequentially (one iPATCH per path)
 * because the target device may not support batch updates in a single request.
 */

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

// Static imports for better performance (no dynamic import overhead)
import { YangCatalogManager } from '../../tsc2cbor/lib/yang-catalog/yang-catalog.js';
import { Tsc2CborConverter } from '../../tsc2cbor/tsc2cbor.js';
import { Cbor2TscConverter } from '../../tsc2cbor/cbor2tsc.js';
import { createTransport } from '../../tsc2cbor/lib/transport/index.js';
import { isInstanceIdentifierFormat } from '../../tsc2cbor/lib/encoder/transformer-instance-id.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find YANG cache directory
 */
async function findYangCache(cacheOption) {
  if (cacheOption) {
    if (!fs.existsSync(cacheOption)) {
      throw new Error(`Cache directory not found: ${cacheOption}`);
    }
    return cacheOption;
  }

  const yangCatalog = new YangCatalogManager();
  const catalogs = yangCatalog.listCachedCatalogs();

  if (catalogs.length === 0) {
    throw new Error(
      'No YANG catalog found. Please run "keti-tsn download" first, or specify -c <cache_dir>'
    );
  }

  return catalogs[0].path;
}

/**
 * Patch configuration values on device
 * @param {string} file - Input YAML file (instance-identifier format)
 * @param {object} options - Command options
 */
export async function patchCommand(file, options) {
  const verbose = options.verbose || false;
  const transportType = options.transport || 'serial';

  if (!fs.existsSync(file)) {
    throw new Error(`Input file not found: ${file}`);
  }

  // Find YANG cache
  const yangCacheDir = await findYangCache(options.cache);

  // Parse YAML file to check format and split into individual patches
  const yamlContent = fs.readFileSync(file, 'utf8');
  const parsedData = yaml.load(yamlContent);

  if (!isInstanceIdentifierFormat(parsedData)) {
    throw new Error(
      'iPATCH requires instance-identifier format.\n' +
      'Example:\n' +
      '  - /module:container/list[key=\'value\']/leaf: value'
    );
  }

  // Each item in the array is a separate patch operation
  const patchItems = parsedData;

  if (verbose) {
    console.log(`Found ${patchItems.length} patch operation(s)`);
  }

  // Create converter for CBOR encoding
  const encoder = new Tsc2CborConverter(yangCacheDir);

  // Create decoder for error response decoding
  const decoder = new Cbor2TscConverter(yangCacheDir);

  // Create transport and connect
  const transport = createTransport(transportType, { verbose });

  try {
    // Connect based on transport type
    if (transportType === 'wifi') {
      if (verbose) console.log(`Connecting to WiFi proxy at ${options.host}:${options.port}...`);
      await transport.connect({ host: options.host, port: options.port });
    } else {
      if (verbose) console.log(`Connecting to ${options.device}...`);
      await transport.connect({ device: options.device });
    }
    if (verbose) console.log('Connected.\n');

    await transport.waitForReady(5000);

    // Process each patch item sequentially
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < patchItems.length; i++) {
      const item = patchItems[i];
      const itemPath = Object.keys(item)[0];

      if (verbose) {
        console.log(`\n[${i + 1}/${patchItems.length}] Patching: ${itemPath}`);
      }

      try {
        // Convert single item to CBOR
        const singleItemYaml = yaml.dump([item]);
        const encodeResult = await encoder.convertString(singleItemYaml, { verbose: false });
        const patchData = encodeResult.cbor;

        if (verbose) {
          console.log(`  CBOR size: ${patchData.length} bytes`);
        }

        // Send iPATCH request
        const response = await transport.sendiPatchRequest(patchData);

        if (!response.isSuccess()) {
          console.error(`  Failed: CoAP code ${response.code}`);

          // Try to decode error response payload if present
          if (response.payload && response.payload.length > 0) {
            try {
              const errorResult = await decoder.convertBuffer(response.payload, {
                verbose: false,
                outputFormat: 'rfc7951'
              });
              console.error(`  Error details: ${errorResult.yaml}`);
            } catch (decodeErr) {
              // If decoding fails, show raw hex
              console.error(`  Error payload (${response.payload.length} bytes): ${response.payload.toString('hex')}`);
            }
          }

          failCount++;
          continue;
        }

        if (verbose) {
          console.log(`  Success`);
        }
        successCount++;

      } catch (err) {
        console.error(`  Error: ${err.message}`);
        failCount++;
        continue;
      }
    }

    // Summary
    if (verbose || failCount > 0) {
      console.log(`\n--- Summary ---`);
      console.log(`Total: ${patchItems.length}, Success: ${successCount}, Failed: ${failCount}`);
    }

    if (failCount > 0 && successCount === 0) {
      throw new Error('All iPATCH operations failed');
    }

  } finally {
    if (transport.getConnectionStatus()) {
      await transport.disconnect();
    }
  }
}
