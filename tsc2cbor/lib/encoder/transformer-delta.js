/**
 * Transformer Module with RFC 9254 Delta-SID
 *
 * Implements TRANSFORMATION LAYER with parent-tracking Delta-SID
 * Similar to yaml2cbor_js approach
 */

import { encodeValue } from './value-encoder.js';
import { resolvePathToSid } from '../common/sid-resolver.js';

/**
 * Strip module prefixes from all path segments
 * Example: "ietf-interfaces:interfaces/interface/ieee802-ethernet-interface:ethernet/duplex"
 *          → "interfaces/interface/ethernet/duplex"
 *
 * @param {string} path - YANG path with potential module prefixes
 * @returns {string} Path without module prefixes
 */
function stripModulePrefixes(path) {
  if (!path) return '';
  return path.split('/').map(segment => {
    const colonIndex = segment.indexOf(':');
    return colonIndex !== -1 ? segment.substring(colonIndex + 1) : segment;
  }).join('/');
}

/**
 * Transform JSON object to CBOR-ready format with context-aware Delta-SID
 * @param {object} jsonObj - JSON object from YAML
 * @param {object} typeTable - Type table from yang-type-extractor
 * @param {object} sidInfo - SID tree from sid-resolver (with nodeInfo)
 * @param {object} schemaInfo - Schema info (nodeOrders for sorting)
 * @param {string} currentPath - Current YANG path (for nested objects)
 * @param {number|null} parentSid - Parent's absolute SID for Delta-SID calculation
 * @param {boolean} useMap - Whether to use Map (Tag 259) or plain Object
 * @returns {Map|object} Map with Delta-SID/Absolute-SID keys and encoded values
 */
export function transformTree(
  jsonObj,
  typeTable,
  sidInfo,
  schemaInfo,
  currentPath = '',
  parentSid = null,
  useMap = true,
  sortMode = 'velocity'
) {
  const result = useMap ? new Map() : {};  // Map with Tag(259) or plain Object
  const stats = { delta: 0, absolute: 0 };

  // Helper function to set value (works for both Map and Object)
  const setValue = (key, value) => {
    if (useMap) {
      result.set(key, value);
    } else {
      result[key] = value;
    }
  };

  // Collect entries with metadata for sorting
  const entries = [];

  // Process each key-value pair - collect entries first
  for (const [key, value] of Object.entries(jsonObj)) {
    // Build YANG path
    const yangPath = currentPath ? `${currentPath}/${key}` : key;
    const yangPathNoPrefix = stripModulePrefixes(yangPath);
    const localName = key.includes(':') ? key.split(':')[1] : key;
    const yangOrder = schemaInfo?.nodeOrders?.get(localName) || 999999;

    // Handle nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Get SID for this object
      const currentSid = resolvePathToSid(key, sidInfo, currentPath);

      if (currentSid === null) {
        console.warn(`No SID found for path: ${yangPath}`);
        continue;
      }

      // Recursively transform nested objects
      // Pass current SID as parent for next level, and propagate useMap and sortMode
      const nestedResult = transformTree(
        value,
        typeTable,
        sidInfo,
        schemaInfo,
        yangPath,
        currentSid,
        useMap,
        sortMode
      );

      // Determine key encoding
      const nodeInfo = sidInfo.pathToInfo?.get(yangPathNoPrefix) || sidInfo.pathToInfo?.get(yangPath);
      let encodedKey;
      const isDeltaSid = (nodeInfo?.parent !== null && nodeInfo?.parent === parentSid);

      if (isDeltaSid) {
        // Parent matches: use Delta-SID
        encodedKey = nodeInfo.deltaSid;
        stats.delta++;
      } else {
        // Parent doesn't match or no parent: use Absolute-SID
        encodedKey = currentSid;
        stats.absolute++;
      }

      // Collect entry for sorting
      entries.push({
        key: encodedKey,
        value: nestedResult,
        isDeltaSid,
        yangOrder,
        originalKey: key
      });
      continue;
    }

    // Handle arrays (list in YANG)
    if (Array.isArray(value)) {
      // Get SID for the array (list) node
      const arraySid = resolvePathToSid(key, sidInfo, currentPath);

      if (arraySid === null) {
        console.warn(`No SID found for list path: ${yangPath}`);
        continue;
      }

      // For arrays, process each element with the array SID as parent
      // Collect results in an array
      const arrayResults = [];

      value.forEach((item) => {
        if (item && typeof item === 'object') {
          const itemResult = transformTree(
            item,
            typeTable,
            sidInfo,
            schemaInfo,
            yangPath,
            arraySid,  // Array SID becomes parent for all items
            useMap,
            sortMode
          );
          arrayResults.push(itemResult);
        } else {
          // Primitive value in array
          arrayResults.push(item);
        }
      });

      // Determine key encoding for the array
      const nodeInfo = sidInfo.pathToInfo?.get(yangPathNoPrefix) || sidInfo.pathToInfo?.get(yangPath);
      let encodedKey;
      const isDeltaSid = (nodeInfo?.parent !== null && nodeInfo?.parent === parentSid);

      if (isDeltaSid) {
        // Parent matches: use Delta-SID
        encodedKey = nodeInfo.deltaSid;
        stats.delta++;
      } else {
        // Parent doesn't match or no parent: use Absolute-SID
        encodedKey = arraySid;
        stats.absolute++;
      }

      // Collect entry for sorting
      entries.push({
        key: encodedKey,
        value: arrayResults,
        isDeltaSid,
        yangOrder,
        originalKey: key
      });
      continue;
    }

    // Leaf node: encode value and determine SID key
    // Step 1: VALUE encoding
    // Strip module prefixes for typeTable lookup
    const typeInfo = typeTable.types.get(yangPathNoPrefix);
    const encodedValue = typeInfo
      ? encodeValue(value, typeInfo, sidInfo, false)
      : value;

    // Step 2: KEY encoding with context-aware Delta-SID
    const currentSid = resolvePathToSid(key, sidInfo, currentPath);

    if (currentSid === null) {
      console.warn(`No SID found for path: ${yangPath}`);
      continue;
    }

    // Get node info to check parent relationship
    const nodeInfo = sidInfo.pathToInfo?.get(yangPathNoPrefix) || sidInfo.pathToInfo?.get(yangPath);

    let encodedKey;
    if (nodeInfo && nodeInfo.parent !== null && nodeInfo.parent === parentSid) {
      // Parent matches: use Delta-SID
      encodedKey = nodeInfo.deltaSid;
      stats.delta++;
    } else {
      // Parent doesn't match or no parent: use Absolute-SID
      encodedKey = currentSid;
      stats.absolute++;
    }

    // Collect entry for sorting (localName and yangOrder already calculated at loop start)
    const isDeltaSid = (nodeInfo?.parent !== null && nodeInfo?.parent === parentSid);

    entries.push({
      key: encodedKey,
      value: encodedValue,
      isDeltaSid,
      yangOrder,
      originalKey: key
    });
  }

  // Sort entries based on sortMode
  if (sortMode === 'rfc8949') {
    // RFC 8949: Will be sorted by cbor-encoder based on CBOR byte order
    // For now, just add entries in original order
    for (const entry of entries) {
      setValue(entry.key, entry.value);
    }
  } else {
    // VelocityDriveSP mode: Delta-SID (by YANG order) first, then Absolute SID
    if (parentSid === null) {
      // Top level: sort by absolute SID value
      entries.sort((a, b) => a.key - b.key);
    } else {
      // Nested level: Delta-SIDs first (by YANG order), then Absolute SIDs
      entries.sort((a, b) => {
        // Group delta-SIDs before absolute SIDs
        if (a.isDeltaSid && !b.isDeltaSid) return -1;
        if (!a.isDeltaSid && b.isDeltaSid) return 1;

        // Within delta-SIDs, sort by YANG order
        if (a.isDeltaSid && b.isDeltaSid) {
          const aHasValidOrder = a.yangOrder > 0 && a.yangOrder < 999999;
          const bHasValidOrder = b.yangOrder > 0 && b.yangOrder < 999999;

          if (aHasValidOrder && bHasValidOrder) {
            return a.yangOrder - b.yangOrder;
          }
          if (aHasValidOrder && !bHasValidOrder) return -1;
          if (!aHasValidOrder && bHasValidOrder) return 1;

          // Neither has valid order: sort by delta-SID value
          return a.key - b.key;
        }

        // Within absolute SIDs, sort by SID value
        return a.key - b.key;
      });
    }

    // Add sorted entries to result
    for (const entry of entries) {
      setValue(entry.key, entry.value);
    }
  }

  return result;
}

/**
 * Transform JSON object to CBOR-ready format (convenience function)
 * @param {object} jsonObj - JSON object from YAML
 * @param {object} typeTable - Type table
 * @param {object} sidInfo - SID tree with nodeInfo
 * @param {object} schemaInfo - Schema info (nodeOrders for sorting)
 * @param {object} options - Transformation options
 * @param {boolean} options.useMap - Use Map (Tag 259) or plain Object (default: true)
 * @returns {Map|object} Transformed Map or Object ready for CBOR encoding
 */
export function transform(jsonObj, typeTable, sidInfo, schemaInfo, options = {}) {
  const useMap = options.useMap !== undefined ? options.useMap : true;
  const sortMode = options.sortMode || 'velocity';  // Default to VelocityDriveSP mode

  // Return Map (with Tag 259) or plain Object (without Tag 259)
  // useMap=true: Better for roundtrip testing, decoder knows it's SID map
  // useMap=false: Device-compatible, smaller size, no Tag overhead
  return transformTree(jsonObj, typeTable, sidInfo, schemaInfo, '', null, useMap, sortMode);
}

/**
 * Get transformation statistics
 * @param {object} jsonObj - Original JSON object
 * @param {Map|object} transformed - Transformed Map or object
 * @returns {object} Statistics
 */
export function getTransformStats(jsonObj, transformed) {
  const countKeys = (obj) => {
    let count = 0;
    const values = obj instanceof Map ? obj.values() : Object.values(obj);
    for (const value of values) {
      count++;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        count += countKeys(value);
      }
    }
    return count;
  };

  const originalKeys = countKeys(jsonObj);
  const transformedKeys = transformed instanceof Map ? transformed.size : Object.keys(transformed).length;

  const originalSize = JSON.stringify(jsonObj).length;
  // Convert Map to object for size calculation
  const transformedObj = transformed instanceof Map ? Object.fromEntries(transformed) : transformed;
  const transformedSize = JSON.stringify(transformedObj).length;

  return {
    originalKeys,
    transformedKeys,
    originalSize,
    transformedSize,
    sizeRatio: transformedSize / originalSize,
    keysProcessed: transformedKeys
  };
}
