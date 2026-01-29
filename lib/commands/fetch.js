/**
 * Fetch configuration command (iFETCH)
 *
 * Queries specific configuration values from device using CoAP iFETCH.
 * Uses instance-identifier format (YAML) and converts to SID array for the request.
 * Supports both Serial and WiFi transports.
 *
 * Note: iFETCH requires SID array format, not Delta-SID Map.
 */

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

// Static imports for better performance (no dynamic import overhead)
import { YangCatalogManager } from '../../tsc2cbor/lib/yang-catalog/yang-catalog.js';
import { loadYangInputs } from '../../tsc2cbor/lib/common/input-loader.js';
import { isInstanceIdentifierFormat, extractSidsFromInstanceIdentifier } from '../../tsc2cbor/lib/encoder/transformer-instance-id.js';
import { createTransport } from '../../tsc2cbor/lib/transport/index.js';
import { Cbor2TscConverter } from '../../tsc2cbor/cbor2tsc.js';

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
 * Fetch specific configuration values from device
 * @param {string} file - Input YAML file (instance-identifier format)
 * @param {object} options - Command options
 */
export async function fetchCommand(file, options) {
  const verbose = options.verbose || false;
  const format = options.format || 'rfc7951';
  const transportType = options.transport || 'serial';

  if (!fs.existsSync(file)) {
    throw new Error(`Input file not found: ${file}`);
  }

  // Find YANG cache
  const yangCacheDir = await findYangCache(options.cache);

  // Load YANG/SID inputs
  if (verbose) {
    console.log('Converting query to CBOR...');
  }

  const { sidInfo, typeTable } = await loadYangInputs(yangCacheDir, verbose);

  // Parse YAML file
  const yamlContent = fs.readFileSync(file, 'utf8');
  let parsedData = yaml.load(yamlContent);

  // Support string array format for fetch (without trailing colon)
  // Convert: ["/path1", "/path2"] → [{ "/path1": null }, { "/path2": null }]
  if (Array.isArray(parsedData) && parsedData.length > 0 && typeof parsedData[0] === 'string') {
    if (verbose) {
      console.log('Detected string array format, converting to instance-identifier format...');
    }
    parsedData = parsedData.map(path => ({ [path]: null }));
  }

  // iFETCH requires SID array, not Delta-SID Map
  let query;

  if (isInstanceIdentifierFormat(parsedData)) {
    if (verbose) {
      console.log('\nDetected instance-identifier format');
      console.log('Extracting SIDs for iFETCH...');
    }

    // Extract SID entries from instance-identifier paths
    // Each entry is either a number (SID) or [SID, key1, key2, ...] for list entries
    const entries = extractSidsFromInstanceIdentifier(parsedData, sidInfo, { verbose });

    if (entries.length === 0) {
      throw new Error('No valid SIDs found in instance-identifier paths');
    }

    if (verbose) {
      console.log(`  Total queries: ${entries.length}`);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const queryStr = Array.isArray(entry)
          ? `[${entry.map(v => typeof v === 'string' ? `"${v}"` : v).join(', ')}]`
          : entry;
        console.log(`  [${i + 1}] ${queryStr}`);
      }
    }

    // Store entries for later use
    var queries = entries;
  } else {
    throw new Error(
      'iFETCH requires instance-identifier format.\n' +
      'Example: - "/ietf-interfaces:interfaces/interface[name=\'1\']"\n' +
      'Each entry should be a path string starting with "/"'
    );
  }

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

    // Send all queries in a single iFETCH request (mup1cc compatible)
    // Each query is CBOR-encoded and concatenated into a sequence
    const decoder = new Cbor2TscConverter(yangCacheDir);

    if (verbose) {
      console.log(`\nSending iFETCH request with ${queries.length} queries...`);
    }

    // Send all queries at once
    const response = await transport.sendiFetchRequest(queries);

    if (!response.isSuccess()) {
      throw new Error(`iFETCH failed: CoAP code ${response.code}`);
    }

    const cborPayload = response.payload;
    if (verbose) console.log(`  Received ${cborPayload.length} bytes`);

    // Decode response (may contain multiple CBOR values)
    const result = await decoder.convertBuffer(cborPayload, {
      verbose: false,
      outputFormat: format
    });

    const combinedResult = result.yaml;

    if (options.output) {
      fs.writeFileSync(options.output, combinedResult, 'utf8');
      if (verbose) console.log(`\nResult saved to: ${options.output}`);
    } else {
      if (verbose) console.log('\n--- Result ---\n');
      console.log(combinedResult);
    }

  } finally {
    if (transport.getConnectionStatus()) {
      await transport.disconnect();
    }
  }
}
