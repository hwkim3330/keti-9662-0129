/**
 * CBOR2TSC - CBOR to TSN Switch Configuration Converter
 *
 * Pure library module for CBOR → YAML conversion
 * Converts CBOR with RFC 9254 Delta-SID encoding back to YAML
 *
 * Full Pipeline:
 * 1. YANG → Type Table (yang-type-extractor.js)
 * 2. SID File → SID Tree (sid-resolver.js)
 * 3. CBOR Binary → JavaScript Object (cbor-x)
 * 4. Delta-SID Object → Nested JSON (detransformer.js)
 * 5. JSON → YAML (js-yaml, optional)
 */

import yaml from 'js-yaml';
import { loadYangInputs } from './lib/common/input-loader.js';
import { detransform, getDetransformStats } from './lib/decoder/detransformer-delta.js';
// Note: detransformer-instance-id.js is kept for potential future use
import { decodeFromCbor, decodeAllFromCbor } from './lib/common/cbor-encoder.js';
import fs from 'fs';
import path from 'path';

/**
 * Main decoding class
 *
 * @example
 * const converter = new Cbor2TscConverter('/path/to/.yang-cache');
 * const result = await converter.convertFile('input.cbor', {
 *   outputFile: 'output.yaml',
 *   verbose: true
 * });
 */
class Cbor2TscConverter {
  /**
   * Create a new converter
   * @param {string} yangCacheDir - Directory containing .yang and .sid files
   */
  constructor(yangCacheDir) {
    if (!yangCacheDir) {
      throw new Error('yangCacheDir is required');
    }

    this.yangCacheDir = yangCacheDir;
    this.sidInfo = null;
    this.typeTable = null;
    this.cacheLoaded = false;
  }

  /**
   * Load YANG/SID inputs (lazy loading, only once)
   * @private
   */
  async loadInputs(verbose = false) {
    if (this.cacheLoaded) return;

    const { sidInfo, typeTable } = await loadYangInputs(this.yangCacheDir, verbose);
    this.sidInfo = sidInfo;
    this.typeTable = typeTable;
    this.cacheLoaded = true;
  }

  /**
   * Convert CBOR file to YAML
   * @param {string} cborPath - Path to CBOR file
   * @param {object} options - Conversion options
   * @param {string} [options.outputFile] - Output YAML file path (optional)
   * @param {boolean} [options.verbose=false] - Verbose output
   * @param {boolean} [options.skipNesting=false] - Skip path nesting (flat output)
   * @returns {Promise<{yaml: string, nested: object, flat: object, stats: object}>}
   */
  async convertFile(cborPath, options = {}) {
    const verbose = options.verbose || false;

    await this.loadInputs(verbose);

    if (verbose) {
      console.log(`\nLoading CBOR file: ${cborPath}`);
    }

    const cborBuffer = fs.readFileSync(cborPath);
    return this.convertBuffer(cborBuffer, options);
  }

  /**
   * Convert CBOR buffer to YAML (RFC 7951 Tree format)
   * @param {Buffer} cborBuffer - CBOR data as Buffer
   * @param {object} options - Conversion options
   * @param {string} [options.outputFile] - Output YAML file path (optional)
   * @param {boolean} [options.verbose=false] - Verbose output
   * @param {boolean} [options.skipNesting=false] - Skip path nesting (flat output)
   * @returns {Promise<{yaml: string, nested: object, flat: object, stats: object}>}
   */
  async convertBuffer(cborBuffer, options = {}) {
    const verbose = options.verbose || false;
    const skipNesting = options.skipNesting || false;
    const outputFile = options.outputFile || null;

    await this.loadInputs(verbose);

    if (verbose) {
      console.log('\nDecoding: CBOR Binary -> JavaScript Object...');
    }

    // Step 1: Decode CBOR → Delta-SID Object
    // Try decoding as CBOR sequence first (for iFETCH responses with multiple items)
    let decoded;
    try {
      const items = decodeAllFromCbor(cborBuffer);
      if (items.length === 1) {
        decoded = items[0];
      } else if (items.length > 1) {
        // Merge multiple delta-SID maps into one
        decoded = new Map();
        for (const item of items) {
          if (item instanceof Map) {
            for (const [key, value] of item.entries()) {
              decoded.set(key, value);
            }
          } else if (typeof item === 'object' && item !== null) {
            for (const [key, value] of Object.entries(item)) {
              decoded.set(Number(key), value);
            }
          }
        }
        if (verbose) {
          console.log(`  Decoded ${items.length} CBOR items, merged into single map`);
        }
      } else {
        throw new Error('No CBOR items found in buffer');
      }
    } catch (err) {
      // Fallback to single-item decode
      decoded = decodeFromCbor(cborBuffer);
    }

    if (verbose) {
      const deltaSidKeys = decoded instanceof Map ? decoded.size : Object.keys(decoded).length;
      console.log(`  Delta-SID keys: ${deltaSidKeys}`);
    }

    // RFC 7951 format output (Tree structure)
    if (verbose) {
      console.log('\nDetransformation: Delta-SID -> Nested JSON...');
    }

    // Step 2: Detransform Delta-SID → Nested JSON
    const flat = detransform(decoded, this.typeTable, this.sidInfo);
    const nested = skipNesting ? flat : flat;  // detransform already nests

    const detransformStats = getDetransformStats(decoded, nested);

    if (verbose) {
      console.log(`  Delta-SID keys: ${detransformStats.deltaSidKeys}`);
      console.log(`  Nested keys: ${detransformStats.nestedKeys}`);
      console.log(`  Expansion ratio: ${detransformStats.expansionRatio.toFixed(2)}x`);
      console.log(`  Delta-SID size: ${detransformStats.deltaSidSize} bytes`);
      console.log(`  Nested size: ${detransformStats.nestedSize} bytes`);
    }

    // Step 3: Convert to YAML
    const yamlString = yaml.dump(nested, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false
    });

    // Step 4: Calculate statistics
    const cborSize = cborBuffer.length;
    const jsonSize = Buffer.byteLength(JSON.stringify(nested), 'utf8');
    const yamlSize = Buffer.byteLength(yamlString, 'utf8');

    const stats = {
      cborSize,
      jsonSize,
      yamlSize,
      expansionRatio: (yamlSize / cborSize).toFixed(2),
      ...detransformStats
    };

    const result = {
      yaml: yamlString,
      nested,
      flat,
      stats
    };

    // Save to file (if outputFile specified)
    if (outputFile) {
      fs.writeFileSync(outputFile, yamlString, 'utf8');
      if (verbose) {
        console.log(`\nYAML written to: ${outputFile}`);
      }
    }

    // Print statistics
    if (verbose) {
      console.log('\nConversion Statistics:');
      console.log(`  CBOR size: ${stats.cborSize} bytes`);
      console.log(`  YAML size: ${stats.yamlSize} bytes`);
      console.log(`  JSON size: ${stats.jsonSize} bytes`);
    }

    return result;
  }
}

export { Cbor2TscConverter };
