/**
 * Detransformer Module with RFC 9254 Delta-SID
 *
 * Implements DETRANSFORMATION LAYER with parent-tracking Delta-SID
 * CBOR Map with Delta-SID → Nested JSON Object
 */

import { decodeValue } from './value-decoder.js';

/**
 * Decode CBOR Map to nested object, resolving Delta-SIDs
 * @param {*} cborData - CBOR data (Map/Array/primitive)
 * @param {Map} sidToInfo - Reverse-lookup map SID → node info
 * @param {object} typeTable - Type table for value decoding
 * @param {object} sidInfo - SID tree for identity resolution
 * @param {number|null} parentSid - Parent's absolute SID
 * @returns {*} Decoded JavaScript object
 */
function cborToJsonDelta(cborData, sidToInfo, typeTable, sidInfo, parentSid = null) {
  // Primitives
  if (cborData === null || cborData === undefined || typeof cborData !== 'object') {
    return cborData;
  }

  // Arrays - recursively decode each item with same parentSid
  if (Array.isArray(cborData)) {
    return cborData.map(item => cborToJsonDelta(item, sidToInfo, typeTable, sidInfo, parentSid));
  }

  // Maps and plain Objects with SID keys - resolve SIDs and recursively decode
  // Handle both Map objects (with Tag 259) and plain objects (without Tag 259)
  const isMap = cborData instanceof Map;
  const isPlainObject = !isMap && cborData.constructor === Object;

  if (isMap || isPlainObject) {
    const result = {};
    const entries = isMap ? cborData.entries() : Object.entries(cborData);

    for (let [key, value] of entries) {
      // Convert numeric string keys to numbers (Object.entries() converts numeric keys to strings)
      if (!isMap && typeof key === 'string') {
        const numKey = Number(key);
        if (!isNaN(numKey) && String(numKey) === key) {
          key = numKey;
        }
      }

      let decodedKey = key;
      let absoluteSid = null;
      let yangPath = null;

      if (typeof key === 'number') {
        let nodeInfo = null;

        // Try Delta-SID first (if we have a parent)
        if (parentSid !== null) {
          const potentialAbsoluteSid = key + parentSid;
          const potentialNode = sidToInfo.get(potentialAbsoluteSid);

          // Verify this is a valid child of parent
          if (potentialNode && potentialNode.parent === parentSid) {
            nodeInfo = potentialNode;
            absoluteSid = potentialAbsoluteSid;
          }
        }

        // If not Delta-SID, try Absolute-SID
        if (absoluteSid === null) {
          nodeInfo = sidToInfo.get(key);
          if (nodeInfo) {
            absoluteSid = key;
          }
        }

        if (nodeInfo) {
          // Use local name as key
          decodedKey = nodeInfo.localName;
          yangPath = nodeInfo.path;
        } else {
          // Unknown SID - create placeholder
          console.warn(`No YANG path found for SID ${key}`);
          decodedKey = `__sid_${key}`;
        }
      }
      // String keys remain unchanged

      // Get type info for value decoding
      const typeInfo = yangPath ? typeTable.types.get(yangPath) : null;

      // Recursively decode value
      let decodedValue;
      const isNestedMap = value instanceof Map;
      const isNestedObject = value && typeof value === 'object' && !Array.isArray(value) && value.constructor === Object;

      if (isNestedMap || isNestedObject || Array.isArray(value)) {
        // Nested structure - recurse with current absoluteSid as parentSid
        decodedValue = cborToJsonDelta(value, sidToInfo, typeTable, sidInfo, absoluteSid);
      } else {
        // Leaf value - decode based on type
        decodedValue = typeInfo
          ? decodeValue(value, typeInfo, sidInfo, false, null, yangPath)
          : value;
      }

      result[decodedKey] = decodedValue;
    }

    return result;
  }

  // Other objects (Buffers, etc.)
  return cborData;
}

/**
 * Detransform CBOR Map to flat YANG path object (legacy interface)
 * @param {Map|object} cborData - CBOR Map or object
 * @param {object} typeTable - Type table
 * @param {object} sidInfo - SID tree with nodeInfo
 * @returns {object} Flat object with YANG paths as keys
 */
export function detransformFromDeltaSid(cborData, typeTable, sidInfo) {
  const sidToInfo = sidInfo.sidToInfo;

  // Convert to Map if needed
  const cborMap = cborData instanceof Map ? cborData : new Map(Object.entries(cborData));

  // Decode with Delta-SID support
  const nested = cborToJsonDelta(cborMap, sidToInfo, typeTable, sidInfo, null);

  // Flatten to YANG paths
  return flattenObject(nested);
}

/**
 * Detransform CBOR Map to nested object (new interface)
 * @param {Map|object} cborData - CBOR Map or object
 * @param {object} typeTable - Type table
 * @param {object} sidInfo - SID tree with nodeInfo
 * @returns {object} Nested object
 */
export function detransform(cborData, typeTable, sidInfo) {
  const sidToInfo = sidInfo.sidToInfo;

  // Convert to Map if needed, preserving numeric keys
  let cborMap;
  if (cborData instanceof Map) {
    cborMap = cborData;
  } else {
    // Object.entries() converts numeric keys to strings!
    // We need to convert them back to numbers
    cborMap = new Map();
    for (const [key, value] of Object.entries(cborData)) {
      const numKey = Number(key);
      const actualKey = !isNaN(numKey) && String(numKey) === key ? numKey : key;
      cborMap.set(actualKey, value);
    }
  }

  // Decode with Delta-SID support, keeping nested structure
  return cborToJsonDelta(cborMap, sidToInfo, typeTable, sidInfo, null);
}

/**
 * Flatten nested object to YANG paths
 * @param {object} obj - Nested object
 * @param {string} prefix - Path prefix
 * @returns {object} Flat object
 */
function flattenObject(obj, prefix = '') {
  const result = {};

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}/${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, path));
    } else {
      result[path] = value;
    }
  }

  return result;
}

/**
 * Restore nested structure from flat YANG paths
 * @param {object} flatObj - Flat object with YANG path keys
 * @returns {object} Nested object
 */
export function restoreNesting(flatObj) {
  const result = {};

  for (const [path, value] of Object.entries(flatObj)) {
    const parts = path.split('/');
    let current = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }

    const lastPart = parts[parts.length - 1];
    current[lastPart] = value;
  }

  return result;
}

/**
 * Get detransformation statistics
 * @param {object} deltaSidObj - Delta-SID object (Map or object)
 * @param {object} nested - Nested decoded object
 * @returns {object} Statistics
 */
export function getDetransformStats(deltaSidObj, nested) {
  const countKeys = (obj) => {
    let count = 0;
    if (obj instanceof Map) {
      count = obj.size;
      for (const value of obj.values()) {
        if (value instanceof Map) {
          count += countKeys(value);
        }
      }
    } else if (obj && typeof obj === 'object') {
      for (const value of Object.values(obj)) {
        count++;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          count += countKeys(value);
        }
      }
    }
    return count;
  };

  const sidKeys = countKeys(deltaSidObj);
  const nestedKeys = countKeys(nested);

  return {
    sidKeys,
    nestedKeys,
    expansionRatio: sidKeys > 0 ? nestedKeys / sidKeys : 1,
    deltaSidSize: JSON.stringify(deltaSidObj instanceof Map ? Object.fromEntries(deltaSidObj) : deltaSidObj).length,
    nestedSize: JSON.stringify(nested).length
  };
}
