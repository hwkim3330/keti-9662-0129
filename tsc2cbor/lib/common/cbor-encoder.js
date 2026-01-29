/**
 * CBOR Encoder Module
 *
 * Encodes data to CBOR format using cbor-x or cbor
 * Optimized for RFC 9254 Delta-SID encoding
 */

import { encode as encodeWithCborX, decode as decodeWithCborX, decodeMultiple, Tag } from 'cbor-x';
import cbor from 'cbor';

// Export Tag for creating CBOR tags in value-encoder.js
export { Tag };

/**
 * Encode CBOR major type with length
 * @param {number} majorType - CBOR major type (0-7)
 * @param {number} length - Length value
 * @returns {Buffer} Encoded header bytes
 */
function encodeCborHeader(majorType, length) {
  const mt = majorType << 5;
  if (length < 24) {
    return Buffer.from([mt | length]);
  } else if (length < 256) {
    return Buffer.from([mt | 24, length]);
  } else if (length < 65536) {
    return Buffer.from([mt | 25, (length >> 8) & 0xff, length & 0xff]);
  } else if (length < 4294967296) {
    return Buffer.from([mt | 26, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  } else {
    // For very large lengths, use 8-byte encoding
    const buf = Buffer.alloc(9);
    buf[0] = mt | 27;
    buf.writeBigUInt64BE(BigInt(length), 1);
    return buf;
  }
}

/**
 * Convert string keys to numbers recursively for plain Objects (for cbor-x)
 * This ensures CBOR encodes numeric keys as integers, not strings
 * @param {*} data - Data to process
 * @returns {*} Data with numeric keys converted
 */
function convertNumericKeys(data) {
  // Skip primitives
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }

  // Skip Maps and Buffers (already processed)
  if (data instanceof Map || Buffer.isBuffer(data)) {
    return data;
  }

  // Process arrays recursively
  if (Array.isArray(data)) {
    return data.map(item => convertNumericKeys(item));
  }

  // For plain Objects, convert numeric string keys to numbers
  const result = new Map();
  for (const [key, value] of Object.entries(data)) {
    // Try to parse key as number
    const numKey = Number(key);
    const actualKey = !isNaN(numKey) && String(numKey) === key ? numKey : key;

    // Recursively process nested objects and arrays
    const processedValue = convertNumericKeys(value);
    result.set(actualKey, processedValue);
  }

  return result;
}

/**
 * Encode with definite-length maps/arrays (manual CBOR construction)
 * This matches mup1cc approach: definite-length encoding for all containers
 * @param {*} obj - Data to encode
 * @param {string} sortMode - Sort mode: 'velocity' or 'rfc8949'
 * @returns {Buffer} CBOR bytes
 */
function encodeWithDefinite(obj, sortMode = 'rfc8949') {
  // Primitives and nulls
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return cbor.encode(obj);
  }

  // CBOR Tagged values (e.g., Tag 43 for bits, Tag 4 for decimal64)
  if (obj instanceof cbor.Tagged) {
    return cbor.encode(obj);
  }

  // Buffers
  if (Buffer.isBuffer(obj)) {
    return cbor.encode(obj);
  }

  // Arrays - always use definite-length
  if (Array.isArray(obj)) {
    const items = obj.map(item => encodeWithDefinite(item, sortMode));
    return Buffer.concat([
      encodeCborHeader(4, obj.length), // Major type 4 = array
      ...items
    ]);
  }

  // Maps - always use definite-length
  if (obj instanceof Map) {
    let entries = Array.from(obj.entries());

    // Only sort for RFC 8949 mode - VelocityDriveSP mode preserves transformer ordering
    if (sortMode === 'rfc8949') {
      entries = entries.sort((a, b) => {
        const keyA = cbor.encode(a[0]);
        const keyB = cbor.encode(b[0]);
        return Buffer.compare(keyA, keyB);
      });
    }

    const pairs = [];
    for (const [key, value] of entries) {
      pairs.push(cbor.encode(key));
      pairs.push(encodeWithDefinite(value, sortMode));
    }
    return Buffer.concat([
      encodeCborHeader(5, entries.length), // Major type 5 = map
      ...pairs
    ]);
  }

  // Plain objects - convert to definite-length map
  let entries = Object.entries(obj);

  // Only sort for RFC 8949 mode - VelocityDriveSP mode preserves transformer ordering
  if (sortMode === 'rfc8949') {
    entries = entries.sort((a, b) => {
      const keyA = cbor.encode(a[0]);
      const keyB = cbor.encode(b[0]);
      return Buffer.compare(keyA, keyB);
    });
  }

  const pairs = [];
  for (const [key, value] of entries) {
    pairs.push(cbor.encode(key));
    pairs.push(encodeWithDefinite(value, sortMode));
  }
  return Buffer.concat([
    encodeCborHeader(5, entries.length), // Major type 5 = map
    ...pairs
  ]);
}

/**
 * Encode data to CBOR
 * @param {*} data - Data to encode (Map or plain Object)
 * @param {object} options - Encoding options
 * @param {boolean} options.useCompatible - Use cbor library (no Tag 259, indefinite-length)
 * @param {string} options.sortMode - Sort mode: 'velocity' or 'rfc8949'
 * @returns {Buffer} CBOR binary data
 */
export function encodeToCbor(data, options = {}) {
  try {
    const sortMode = options.sortMode || 'rfc8949';

    if (options.useCompatible) {
      // Compatible mode: Manual CBOR construction with definite-length encoding
      // This produces CBOR without Tag(259), matching mup1cc/VelocityDriveSP output
      return encodeWithDefinite(data, sortMode);
    } else {
      // Normal mode: Use cbor-x with Tag(259) for better roundtrip support
      // Convert plain Objects with numeric string keys to Maps with numeric keys
      // This ensures cbor-x encodes them as CBOR integers, not text strings
      const processedData = (data && typeof data === 'object' && !(data instanceof Map))
        ? convertNumericKeys(data)
        : data;

      return encodeWithCborX(processedData, {
        useRecords: options.useRecords || false,
        structuredClone: options.structuredClone || false,
        variableMapSize: options.variableMapSize !== false, // Default true
        ...options
      });
    }
  } catch (error) {
    throw new Error(`CBOR encoding error: ${error.message}`);
  }
}

/**
 * Decode CBOR to data
 * @param {Buffer} cborBuffer - CBOR binary data
 * @param {object} options - Decoding options
 * @returns {*} Decoded data
 */
export function decodeFromCbor(cborBuffer, options = {}) {
  try {
    // Use cbor-x for decoding (supports both Tag 259 and regular maps)
    const data = decodeWithCborX(cborBuffer, options);
    return data;
  } catch (error) {
    throw new Error(`CBOR decoding error: ${error.message}`);
  }
}

/**
 * Decode multiple CBOR items from a buffer (CBOR sequence)
 * @param {Buffer} cborBuffer - Buffer containing multiple CBOR items
 * @param {object} options - Decoding options
 * @returns {Array} Array of decoded CBOR items
 */
export function decodeAllFromCbor(cborBuffer, options = {}) {
  try {
    const results = [];
    decodeMultiple(cborBuffer, (item) => {
      results.push(item);
    });
    return results;
  } catch (error) {
    throw new Error(`CBOR decoding error: ${error.message}`);
  }
}

/**
 * Get CBOR diagnostic notation
 * @param {Buffer} cborBuffer - CBOR binary data
 * @returns {string} Diagnostic notation
 */
export function getCborDiagnostic(cborBuffer) {
  try {
    // Decode and format as JSON-like notation
    const data = decode(cborBuffer);
    return formatDiagnostic(data, cborBuffer);
  } catch (error) {
    throw new Error(`Diagnostic generation error: ${error.message}`);
  }
}

/**
 * Format diagnostic notation
 * @param {*} data - Decoded data
 * @param {Buffer} cborBuffer - Original CBOR buffer
 * @returns {string} Formatted diagnostic
 */
function formatDiagnostic(data, cborBuffer) {
  const hex = cborBuffer.toString('hex');
  const hexFormatted = hex.match(/.{1,2}/g).join(' ');

  return `
=== CBOR Diagnostic ===
Hex: ${hexFormatted}
Size: ${cborBuffer.length} bytes

Decoded:
${JSON.stringify(data, null, 2)}
`;
}

/**
 * Calculate compression ratio
 * @param {number} originalSize - Original data size (JSON/YAML)
 * @param {number} cborSize - CBOR size
 * @returns {object} Compression statistics
 */
export function calculateCompressionRatio(originalSize, cborSize) {
  const ratio = ((originalSize - cborSize) / originalSize * 100).toFixed(2);
  const compressionFactor = (originalSize / cborSize).toFixed(2);

  return {
    originalSize,
    cborSize,
    savedBytes: originalSize - cborSize,
    compressionRatio: `${ratio}%`,
    compressionFactor: `${compressionFactor}x`
  };
}

/**
 * Validate CBOR encoding
 * @param {Buffer} cborBuffer - CBOR binary data
 * @returns {boolean} True if valid
 */
export function validateCbor(cborBuffer) {
  try {
    decode(cborBuffer);
    return true;
  } catch (error) {
    console.error('CBOR validation error:', error.message);
    return false;
  }
}

/**
 * Encode with indefinite length (streaming)
 * @param {Array|object} data - Data to encode
 * @returns {Buffer} CBOR with indefinite length encoding
 */
export function encodeIndefinite(data) {
  // cbor-x automatically uses indefinite length for streaming
  return encodeToCbor(data, {
    useRecords: false,
    variableMapSize: true
  });
}

/**
 * Get CBOR size
 * @param {*} data - Data to measure
 * @returns {number} Size in bytes after CBOR encoding
 */
export function getCborSize(data) {
  const cbor = encodeToCbor(data);
  return cbor.length;
}

/**
 * Compare two CBOR encodings
 * @param {Buffer} cbor1 - First CBOR buffer
 * @param {Buffer} cbor2 - Second CBOR buffer
 * @returns {object} Comparison results
 */
export function compareCbor(cbor1, cbor2) {
  const data1 = decode(cbor1);
  const data2 = decode(cbor2);

  return {
    size1: cbor1.length,
    size2: cbor2.length,
    sizeDiff: cbor2.length - cbor1.length,
    dataEqual: JSON.stringify(data1) === JSON.stringify(data2)
  };
}

/**
 * Optimize CBOR encoding
 * @param {*} data - Data to encode
 * @returns {Buffer} Optimized CBOR
 */
export function optimizeCbor(data) {
  // Use cbor-x's record structure for optimization
  return encodeToCbor(data, {
    useRecords: true,
    structuredClone: false,
    variableMapSize: true
  });
}

/**
 * Get encoding statistics (simplified version)
 * @param {*} jsObject - JavaScript object before encoding
 * @param {Buffer} cborBuffer - CBOR buffer after encoding
 * @returns {object} Statistics
 */
export function getEncodingStats(jsObject, cborBuffer) {
  const jsonSize = JSON.stringify(jsObject).length;
  const cborSize = cborBuffer.length;

  return {
    jsonSize,
    cborSize,
    compressionRatio: cborSize / jsonSize,
    savedBytes: jsonSize - cborSize,
    savedPercent: ((1 - cborSize / jsonSize) * 100).toFixed(1)
  };
}

/**
 * Verify round-trip: encode → decode → compare
 * @param {*} data - Original data
 * @returns {object} Verification result
 */
export function verifyRoundTrip(data) {
  const encoded = encodeToCbor(data);
  const decoded = decodeFromCbor(encoded);

  const originalJson = JSON.stringify(data);
  const decodedJson = JSON.stringify(decoded);

  return {
    success: originalJson === decodedJson,
    original: data,
    encoded: encoded,
    decoded: decoded,
    encodedSize: encoded.length
  };
}
