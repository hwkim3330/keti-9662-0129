/**
 * Transformer Module for Instance-Identifier (RFC 8072 style)
 *
 * Directly transforms instance-identifier format to Delta-SID CBOR Map
 * without intermediate RFC 7951 conversion.
 *
 * Input: [{ "/module:path/list[key='value']/leaf": value }, ...]
 * Output: CBOR Map with Delta-SID keys
 */

import { encodeValue } from './value-encoder.js';
import { resolvePathToSid } from '../common/sid-resolver.js';

export { parseInstanceIdPath, buildYangPath, resolveSid, findTypeInfo };

/**
 * Find type info for a YANG path with fuzzy matching
 * Uses leafToTypes index for O(1) lookup when exact path doesn't match
 *
 * @param {string} fullPath - Full YANG path (e.g., "bridges/.../vlan-transmitted")
 * @param {Object} typeTable - Type table with leafToTypes index
 * @returns {Object|null} Type info or null
 */
function findTypeInfo(fullPath, typeTable) {
  if (!fullPath || !typeTable) return null;

  // 1. Try exact path match first
  const exactMatch = typeTable.types?.get(fullPath);
  if (exactMatch) {
    return exactMatch;
  }

  // 2. Use leafToTypes index for fuzzy matching
  const leafName = fullPath.split('/').pop();
  const candidates = typeTable.leafToTypes?.get(leafName);

  if (!candidates || candidates.length === 0) {
    return null;
  }

  // 3. Find best match by suffix
  // Prefer longer matching suffix (more specific match)
  let bestMatch = null;
  let bestMatchLength = 0;

  for (const { path, typeInfo } of candidates) {
    if (fullPath.endsWith(path)) {
      if (path.length > bestMatchLength) {
        bestMatch = typeInfo;
        bestMatchLength = path.length;
      }
    }
  }

  // 4. If no suffix match, return first candidate as fallback
  // (same leaf name, different path - likely from grouping)
  return bestMatch || candidates[0]?.typeInfo || null;
}

/**
 * Parse instance-identifier path into components
 * @param {string} path - Instance-identifier path (e.g., "/ietf-interfaces:interfaces/interface[name='1']/enabled")
 * @returns {Array<Object>} Array of path components
 */
function parseInstanceIdPath(path) {
  const components = [];
  const segments = path.startsWith('/') ? path.substring(1).split('/') : path.split('/');

  // Regex: (module:)?(nodeName)([key='value'])*
  const segmentRegex = /^(?:([a-zA-Z0-9_-]+):)?([a-zA-Z0-9_-]+)((?:\[[^\]]+\])*)$/;
  const predicateRegex = /\[([a-zA-Z0-9_-]+)='([^']+)'\]/g;

  for (const segment of segments) {
    if (!segment) continue;

    const match = segment.match(segmentRegex);
    if (!match) {
      throw new Error(`Invalid instance-identifier segment: "${segment}"`);
    }

    const [, modulePrefix, nodeName, predicatesStr] = match;

    // Extract list keys if present
    const keys = [];
    if (predicatesStr) {
      let predicateMatch;
      while ((predicateMatch = predicateRegex.exec(predicatesStr)) !== null) {
        keys.push({ keyName: predicateMatch[1], keyValue: predicateMatch[2] });
      }
      predicateRegex.lastIndex = 0;
    }

    components.push({
      module: modulePrefix || null,
      name: nodeName,
      prefixedName: modulePrefix ? `${modulePrefix}:${nodeName}` : nodeName,
      isListEntry: keys.length > 0,
      keys: keys
    });
  }

  return components;
}

/**
 * Build YANG path from components (for SID lookup)
 * @param {Array<Object>} components - Path components
 * @param {number} upToIndex - Index up to which to build path (-1 for all)
 * @returns {Object} { prefixedPath, strippedPath }
 */
function buildYangPath(components, upToIndex = -1) {
  const endIdx = upToIndex === -1 ? components.length : upToIndex + 1;
  const prefixedParts = [];
  const strippedParts = [];

  for (let i = 0; i < endIdx; i++) {
    prefixedParts.push(components[i].prefixedName);
    strippedParts.push(components[i].name);
  }

  return {
    prefixedPath: prefixedParts.join('/'),
    strippedPath: strippedParts.join('/')
  };
}

/**
 * Resolve path to SID using sidInfo
 * @param {string} prefixedPath - Prefixed YANG path
 * @param {string} strippedPath - Stripped YANG path
 * @param {Object} sidInfo - SID tree
 * @returns {number|null} SID or null
 */
function resolveSid(prefixedPath, strippedPath, sidInfo) {
  // Try prefixed path first
  if (sidInfo.prefixedPathToSid?.has(prefixedPath)) {
    return sidInfo.prefixedPathToSid.get(prefixedPath);
  }
  // Fall back to stripped path (use nodeInfo instead of pathToSid)
  const nodeInfo = sidInfo.pathToInfo?.get(strippedPath);
  if (nodeInfo) {
    return nodeInfo.sid;
  }
  return null;
}

/**
 * Get node info for Delta-SID calculation
 * @param {string} strippedPath - Stripped YANG path
 * @param {Object} sidInfo - SID tree
 * @returns {Object|null} Node info with parent and deltaSid
 */
function getNodeInfo(strippedPath, sidInfo) {
  return sidInfo.pathToInfo?.get(strippedPath) || null;
}

/**
 * Find node type (list/container/leaf) for a YANG path with fuzzy matching
 * Uses leafToNodeTypes index for O(1) lookup when exact path doesn't match
 *
 * @param {string} fullPath - Full YANG path
 * @param {Object} schemaInfo - Schema info with nodeTypes and leafToNodeTypes
 * @returns {string|null} Node type ('list', 'container', 'leaf', 'leaf-list') or null
 */
function findNodeType(fullPath, schemaInfo) {
  if (!fullPath || !schemaInfo) return null;

  // 1. Try exact path match first
  const exactMatch = schemaInfo.nodeTypes?.get(fullPath);
  if (exactMatch) {
    return exactMatch;
  }

  // 2. Use leafToNodeTypes index for fuzzy matching
  const leafName = fullPath.split('/').pop();
  const candidates = schemaInfo.leafToNodeTypes?.get(leafName);

  if (!candidates || candidates.length === 0) {
    return null;
  }

  // 3. Find best match by suffix
  for (const { path, nodeType } of candidates) {
    if (fullPath.endsWith(path)) {
      return nodeType;
    }
  }

  // 4. Fallback to first candidate with same leaf name
  return candidates[0]?.nodeType || null;
}

/**
 * Transform instance-identifier array to Delta-SID CBOR structure
 *
 * @param {Array<Object>} instanceIdArray - Array of { "/path": value } objects
 * @param {Object} typeTable - Type table from yang-type-extractor
 * @param {Object} sidInfo - SID tree from sid-resolver
 * @param {Object} schemaInfo - Schema info for node type detection
 * @param {Object} options - Options
 * @returns {Map} CBOR-ready Map with Delta-SID keys
 */
export function transformInstanceIdentifier(instanceIdArray, typeTable, sidInfo, schemaInfo, options = {}) {
  // Use instance-identifier key format { [SID, keys...] => value }
  // This matches mup1cc's encoding format (RFC 9254 section 6.4)
  // Used for fetch/ipatch/post operations
  // Much more efficient than nested tree format (13-20 bytes vs 32-40 bytes)
  return transformForInstanceIdKey(
    instanceIdArray, typeTable, sidInfo, schemaInfo, options
  );
}

/**
 * Legacy: Transform to nested tree format (for yang/get/put if needed later)
 * Kept for backwards compatibility
 */
export function transformInstanceIdToTree(instanceIdArray, typeTable, sidInfo, schemaInfo, options = {}) {
  const useMap = options.useMap !== false;
  const sortMode = options.sortMode || 'velocity';
  const verbose = options.verbose || false;

  // Build a hierarchical structure first, then convert to CBOR Map
  // We need to handle:
  // 1. Multiple paths that share common ancestors
  // 2. List entries with keys
  // 3. Delta-SID calculation based on parent

  // Step 1: Group paths by their structure
  const pathEntries = [];

  for (const item of instanceIdArray) {
    const path = Object.keys(item)[0];
    const value = item[path];
    const components = parseInstanceIdPath(path);

    pathEntries.push({ path, components, value });
  }

  // Step 2: Build hierarchical CBOR Map
  // For each path, we need to:
  // - Find or create parent containers
  // - Handle list entries
  // - Set leaf values with Delta-SID

  const rootMap = useMap ? new Map() : {};

  const setInMap = (map, key, value) => {
    if (map instanceof Map) {
      map.set(key, value);
    } else {
      map[key] = value;
    }
  };

  const getFromMap = (map, key) => {
    if (map instanceof Map) {
      return map.get(key);
    } else {
      return map[key];
    }
  };

  const hasInMap = (map, key) => {
    if (map instanceof Map) {
      return map.has(key);
    } else {
      return key in map;
    }
  };

  for (const { path, components, value } of pathEntries) {
    let currentMap = rootMap;
    let parentSid = null;

    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      const isLast = (i === components.length - 1);
      const { prefixedPath, strippedPath } = buildYangPath(components, i);

      // Get SID for this path segment
      const currentSid = resolveSid(prefixedPath, strippedPath, sidInfo);

      if (currentSid === null) {
        if (verbose) {
          console.warn(`No SID found for path: ${prefixedPath}`);
        }
        break;
      }

      // Calculate key (Delta-SID or Absolute-SID)
      const nodeInfo = getNodeInfo(strippedPath, sidInfo);
      let encodedKey;

      if (nodeInfo && nodeInfo.parent !== null && nodeInfo.parent === parentSid) {
        // Use Delta-SID
        encodedKey = nodeInfo.deltaSid;
      } else {
        // Use Absolute-SID
        encodedKey = currentSid;
      }

      if (comp.isListEntry) {
        // Handle list entry
        // Ensure list array exists
        if (!hasInMap(currentMap, encodedKey)) {
          setInMap(currentMap, encodedKey, []);
        }

        const listArray = getFromMap(currentMap, encodedKey);

        // Find or create list entry with matching keys
        let listEntry = null;
        for (const entry of listArray) {
          let matches = true;
          for (const { keyName, keyValue } of comp.keys) {
            // Find key SID (use nodeInfo instead of pathToSid)
            const keyPath = `${strippedPath}/${keyName}`;
            const keyNodeInfoForSid = sidInfo.pathToInfo?.get(keyPath);
            const keySid = keyNodeInfoForSid?.sid;

            if (keySid == null) continue;

            // Calculate key's Delta-SID
            const keyNodeInfo = getNodeInfo(keyPath, sidInfo);
            let keyEncodedKey;
            if (keyNodeInfo && keyNodeInfo.parent === currentSid) {
              keyEncodedKey = keyNodeInfo.deltaSid;
            } else {
              keyEncodedKey = keySid;
            }

            const entryValue = getFromMap(entry, keyEncodedKey);
            if (entryValue !== keyValue) {
              matches = false;
              break;
            }
          }
          if (matches) {
            listEntry = entry;
            break;
          }
        }

        if (!listEntry) {
          // Create new list entry with keys
          listEntry = useMap ? new Map() : {};

          for (const { keyName, keyValue } of comp.keys) {
            // Find key SID (use nodeInfo instead of pathToSid)
            const keyPath = `${strippedPath}/${keyName}`;
            const keyNodeInfo = getNodeInfo(keyPath, sidInfo);
            const keySid = keyNodeInfo?.sid;

            if (keySid == null) continue;
            let keyEncodedKey;
            if (keyNodeInfo && keyNodeInfo.parent === currentSid) {
              keyEncodedKey = keyNodeInfo.deltaSid;
            } else {
              keyEncodedKey = keySid;
            }

            // Encode key value (usually string)
            const keyTypeInfo = findTypeInfo(keyPath, typeTable);
            const encodedKeyValue = keyTypeInfo
              ? encodeValue(keyValue, keyTypeInfo, sidInfo, false)
              : keyValue;

            setInMap(listEntry, keyEncodedKey, encodedKeyValue);
          }

          listArray.push(listEntry);
        }

        // If this is the last component and there's a value, merge it into the list entry
        if (isLast && value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const transformedValue = transformObjectToSidMap(
            value, strippedPath, currentSid, sidInfo, typeTable, useMap, verbose
          );
          // Merge transformed value into the list entry
          if (transformedValue instanceof Map) {
            for (const [k, v] of transformedValue) {
              listEntry.set(k, v);
            }
          } else {
            Object.assign(listEntry, transformedValue);
          }
        }

        currentMap = listEntry;
        parentSid = currentSid;
      } else if (isLast) {
        // Last node - could be leaf, container, or list without keys in path

        // If value is an object, we need to recursively transform it with SID keys
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          // Object value: transform keys to Delta-SID
          const transformedValue = transformObjectToSidMap(
            value, strippedPath, currentSid, sidInfo, typeTable, useMap, verbose
          );

          // For iPATCH: Don't wrap single list entry in array
          // mup1cc also outputs Hash directly for list when input is Hash
          // RFC 9254 allows both Hash (single entry) and Array (multiple entries)
          setInMap(currentMap, encodedKey, transformedValue);
        } else if (Array.isArray(value)) {
          // Array value (e.g., list entries): transform each item
          const transformedArray = value.map(item => {
            if (item !== null && typeof item === 'object') {
              return transformObjectToSidMap(
                item, strippedPath, currentSid, sidInfo, typeTable, useMap, verbose
              );
            }
            return item;
          });
          setInMap(currentMap, encodedKey, transformedArray);
        } else {
          // Leaf node - set value with type encoding
          const typeInfo = findTypeInfo(strippedPath, typeTable);
          const encodedValue = typeInfo
            ? encodeValue(value, typeInfo, sidInfo, false)
            : value;
          setInMap(currentMap, encodedKey, encodedValue);
        }
      } else {
        // Container node - ensure it exists
        if (!hasInMap(currentMap, encodedKey)) {
          setInMap(currentMap, encodedKey, useMap ? new Map() : {});
        }

        currentMap = getFromMap(currentMap, encodedKey);
        parentSid = currentSid;
      }
    }
  }

  // Step 3: Sort the map if needed
  if (sortMode === 'velocity' && useMap) {
    return sortMapVelocity(rootMap);
  }

  return rootMap;
}

/**
 * Transform a plain object to SID-keyed Map/Object
 * Recursively converts object keys to Delta-SID based on YANG path
 *
 * @param {Object} obj - Plain object to transform
 * @param {string} basePath - Base YANG path (stripped, e.g., "bridges/bridge/component")
 * @param {number} parentSid - Parent SID for Delta-SID calculation
 * @param {Object} sidInfo - SID tree
 * @param {Object} typeTable - Type table
 * @param {boolean} useMap - Use Map instead of Object
 * @param {boolean} verbose - Verbose logging
 * @returns {Map|Object} Transformed object with SID keys
 */
function transformObjectToSidMap(obj, basePath, parentSid, sidInfo, typeTable, useMap, verbose) {
  const result = useMap ? new Map() : {};

  const setInResult = (key, value) => {
    if (result instanceof Map) {
      result.set(key, value);
    } else {
      result[key] = value;
    }
  };

  for (const [key, value] of Object.entries(obj)) {
    // Use resolvePathToSid with fuzzy matching for choice/case nodes
    const childSid = resolvePathToSid(key, sidInfo, basePath);

    if (childSid === null) {
      if (verbose) {
        console.warn(`No SID found for nested key: ${key} (context: ${basePath})`);
      }
      // Fall back to string key
      setInResult(key, value);
      continue;
    }

    // Get nodeInfo from sidToInfo for Delta-SID calculation
    const nodeInfo = sidInfo.sidToInfo?.get(childSid);
    const childPath = nodeInfo?.path || `${basePath}/${key}`;

    // Calculate Delta-SID or Absolute-SID
    let encodedKey;
    if (nodeInfo && nodeInfo.parent === parentSid) {
      encodedKey = nodeInfo.deltaSid;
    } else {
      encodedKey = childSid;
    }

    // Recursively transform nested objects/arrays
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const transformed = transformObjectToSidMap(
        value, childPath, childSid, sidInfo, typeTable, useMap, verbose
      );
      setInResult(encodedKey, transformed);
    } else if (Array.isArray(value)) {
      // Array: could be leaf-list or list
      const transformedArray = value.map(item => {
        if (item !== null && typeof item === 'object') {
          return transformObjectToSidMap(
            item, childPath, childSid, sidInfo, typeTable, useMap, verbose
          );
        }
        // Primitive array item: encode with type info
        const typeInfo = findTypeInfo(childPath, typeTable);
        return typeInfo ? encodeValue(item, typeInfo, sidInfo, false) : item;
      });
      setInResult(encodedKey, transformedArray);
    } else {
      // Leaf value: encode with type info (use fuzzy matching for grouping paths)
      const typeInfo = findTypeInfo(childPath, typeTable);
      const encodedValue = typeInfo
        ? encodeValue(value, typeInfo, sidInfo, false)
        : value;
      setInResult(encodedKey, encodedValue);
    }
  }

  return result;
}

/**
 * Transform instance-identifier array to instance-identifier key format
 * Produces:
 * - For paths with values: { [SID, keys...] => value } Map
 * - For paths only (fetch): Array of [SID, keys...] arrays
 *
 * Used for fetch/ipatch/post operations (RFC 9254 section 6.4)
 *
 * @param {Array} instanceIdArray - Array of { "/path": value } or ["/path", ...] strings
 * @param {Object} typeTable - Type table
 * @param {Object} sidInfo - SID tree
 * @param {Object} schemaInfo - Schema info
 * @param {Object} options - Options
 * @returns {Map|Array} CBOR-ready Map or Array of SID arrays
 */
function transformForInstanceIdKey(instanceIdArray, typeTable, sidInfo, schemaInfo, options = {}) {
  const useMap = options.useMap !== false;
  const verbose = options.verbose || false;

  // Detect if this is path-only format (fetch without values)
  const isPathOnly = instanceIdArray.every(item => typeof item === 'string');

  if (isPathOnly) {
    // Return array of [SID, keys...] arrays for fetch
    return transformPathsOnly(instanceIdArray, typeTable, sidInfo, verbose);
  }

  const rootMap = useMap ? new Map() : {};

  for (const item of instanceIdArray) {
    const path = Object.keys(item)[0];
    const value = item[path];
    const components = parseInstanceIdPath(path);

    // Collect all key values from the path and find target SID
    const allKeyValues = [];
    let targetSid = null;
    let targetPath = '';

    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      const { prefixedPath, strippedPath } = buildYangPath(components, i);

      // Get SID for this path segment
      const currentSid = resolveSid(prefixedPath, strippedPath, sidInfo);

      if (currentSid === null) {
        if (verbose) {
          console.warn(`No SID found for path: ${prefixedPath}`);
        }
        continue;
      }

      // Collect key values from list entries
      if (comp.keys && comp.keys.length > 0) {
        for (const { keyName, keyValue } of comp.keys) {
          // Encode key value with proper type
          const keyPath = `${strippedPath}/${keyName}`;
          const keyTypeInfo = findTypeInfo(keyPath, typeTable);
          const encodedKeyValue = keyTypeInfo
            ? encodeValue(keyValue, keyTypeInfo, sidInfo, false)
            : keyValue;
          allKeyValues.push(encodedKeyValue);
        }
      }

      // Update target (last valid node)
      targetSid = currentSid;
      targetPath = strippedPath;
    }

    if (targetSid === null) {
      if (verbose) {
        console.warn(`Could not resolve SID for path: ${path}`);
      }
      continue;
    }

    // Build the key: [SID] or [SID, key1, key2, ...]
    let cborKey;
    if (allKeyValues.length > 0) {
      cborKey = [targetSid, ...allKeyValues];
    } else {
      cborKey = targetSid;
    }

    // Transform value with delta-SID keys relative to target node
    let cborValue;
    if (value === null || value === undefined) {
      cborValue = null;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      // Object value: transform keys to delta-SID relative to target
      cborValue = transformObjectToSidMap(
        value, targetPath, targetSid, sidInfo, typeTable, useMap, verbose
      );
    } else if (Array.isArray(value)) {
      // Array value (leaf-list or list entries)
      const firstItem = value[0];
      if (firstItem !== null && typeof firstItem === 'object') {
        // List entries: transform each item
        cborValue = value.map(item =>
          transformObjectToSidMap(item, targetPath, targetSid, sidInfo, typeTable, useMap, verbose)
        );
      } else {
        // Leaf-list: encode each primitive value
        const typeInfo = findTypeInfo(targetPath, typeTable);
        cborValue = value.map(item =>
          typeInfo ? encodeValue(item, typeInfo, sidInfo, false) : item
        );
      }
    } else {
      // Primitive value: encode with type info
      const typeInfo = findTypeInfo(targetPath, typeTable);
      cborValue = typeInfo ? encodeValue(value, typeInfo, sidInfo, false) : value;
    }

    // Set in result map
    if (rootMap instanceof Map) {
      rootMap.set(cborKey, cborValue);
    } else {
      rootMap[JSON.stringify(cborKey)] = cborValue;
    }
  }

  return rootMap;
}

/**
 * Transform path-only array to SID arrays (for fetch without values)
 * Produces array of [SID, keys...] arrays
 *
 * @param {Array<string>} paths - Array of "/path" strings
 * @param {Object} typeTable - Type table
 * @param {Object} sidInfo - SID tree
 * @param {boolean} verbose - Verbose logging
 * @returns {Array} Array of [SID, keys...] arrays
 */
function transformPathsOnly(paths, typeTable, sidInfo, verbose) {
  const result = [];

  for (const path of paths) {
    const components = parseInstanceIdPath(path);

    // Collect all key values from the path and find target SID
    const allKeyValues = [];
    let targetSid = null;

    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      const { prefixedPath, strippedPath } = buildYangPath(components, i);

      // Get SID for this path segment
      const currentSid = resolveSid(prefixedPath, strippedPath, sidInfo);

      if (currentSid === null) {
        if (verbose) {
          console.warn(`No SID found for path: ${prefixedPath}`);
        }
        continue;
      }

      // Collect key values from list entries
      if (comp.keys && comp.keys.length > 0) {
        for (const { keyName, keyValue } of comp.keys) {
          // Encode key value with proper type
          const keyPath = `${strippedPath}/${keyName}`;
          const keyTypeInfo = findTypeInfo(keyPath, typeTable);
          const encodedKeyValue = keyTypeInfo
            ? encodeValue(keyValue, keyTypeInfo, sidInfo, false)
            : keyValue;
          allKeyValues.push(encodedKeyValue);
        }
      }

      // Update target (last valid node)
      targetSid = currentSid;
    }

    if (targetSid === null) {
      if (verbose) {
        console.warn(`Could not resolve SID for path: ${path}`);
      }
      continue;
    }

    // Build the SID array: [SID] or [SID, key1, key2, ...]
    if (allKeyValues.length > 0) {
      result.push([targetSid, ...allKeyValues]);
    } else {
      result.push([targetSid]);
    }
  }

  return result;
}

/**
 * Sort Map entries in VelocityDriveSP order
 * Delta-SIDs first, then Absolute-SIDs, both sorted by value
 * @param {Map} map - Map to sort
 * @returns {Map} Sorted map
 */
function sortMapVelocity(map) {
  if (!(map instanceof Map)) return map;

  const entries = [...map.entries()];

  // Recursively sort nested maps
  const sortedEntries = entries.map(([key, value]) => {
    if (value instanceof Map) {
      return [key, sortMapVelocity(value)];
    } else if (Array.isArray(value)) {
      return [key, value.map(item => item instanceof Map ? sortMapVelocity(item) : item)];
    }
    return [key, value];
  });

  // Sort: smaller keys first (both delta and absolute are just numbers)
  sortedEntries.sort((a, b) => a[0] - b[0]);

  return new Map(sortedEntries);
}

/**
 * Check if data is in instance-identifier format
 * Supports two formats:
 * 1. Path with value: [{ "/path": value }, ...]
 * 2. Path only (fetch): ["/path1", "/path2", ...]
 *
 * @param {*} data - Parsed YAML/JSON data
 * @returns {boolean}
 */
export function isInstanceIdentifierFormat(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return false;
  }

  return data.every(item => {
    // Format 1: String path only (for fetch without values)
    if (typeof item === 'string') {
      return item.startsWith('/');
    }
    // Format 2: Object with path key and value
    if (typeof item === 'object' && item !== null) {
      const keys = Object.keys(item);
      if (keys.length !== 1) return false;
      return typeof keys[0] === 'string' && keys[0].startsWith('/');
    }
    return false;
  });
}

/**
 * Extract SIDs from instance-identifier array (for iFETCH)
 *
 * iFETCH requires SID identifiers. For list entries, the format is [SID, key1, key2, ...].
 * Each path becomes a separate CBOR-encodable entry.
 *
 * @param {Array<Object>} instanceIdArray - Array of { "/path": value } objects
 * @param {Object} sidInfo - SID tree from sid-resolver
 * @param {Object} options - Options
 * @returns {Array} Array of SID entries (each entry is either a number or [sid, key1, key2, ...])
 *
 * @example
 * // Input: [{ "/ietf-interfaces:interfaces/interface[name='1']": null }]
 * // Output: [[2033, "1"]] (SID + key value for list entry)
 *
 * // Input: [{ "/ietf-constrained-yang-library:yang-library/checksum": null }]
 * // Output: [29304] (just SID for non-list)
 */
export function extractSidsFromInstanceIdentifier(instanceIdArray, sidInfo, options = {}) {
  const verbose = options.verbose || false;
  const entries = [];

  for (const item of instanceIdArray) {
    const path = Object.keys(item)[0];
    const components = parseInstanceIdPath(path);

    if (components.length === 0) {
      if (verbose) {
        console.warn(`Empty path: ${path}`);
      }
      continue;
    }

    // Build the full path to resolve SID
    const { prefixedPath, strippedPath } = buildYangPath(components, -1);

    // Get the SID for the target (last) path element
    const sid = resolveSid(prefixedPath, strippedPath, sidInfo);

    if (sid === null) {
      if (verbose) {
        console.warn(`No SID found for path: ${prefixedPath}`);
      }
      continue;
    }

    // Collect ALL keys from the ENTIRE path (not just last component)
    // mvdct traverses entire path and collects keys from list entries
    const allKeys = [];
    for (const comp of components) {
      if (comp.isListEntry && comp.keys.length > 0) {
        for (const k of comp.keys) {
          allKeys.push(k.keyValue);
        }
      }
    }

    if (allKeys.length > 0) {
      // Has keys: [sid, key1, key2, ...]
      const entry = [sid, ...allKeys];
      entries.push(entry);

      if (verbose) {
        console.log(`  Path: ${path} -> [${sid}, ${allKeys.map(v => `"${v}"`).join(', ')}]`);
      }
    } else {
      // No keys: just SID
      entries.push(sid);

      if (verbose) {
        console.log(`  Path: ${path} -> SID: ${sid}`);
      }
    }
  }

  return entries;
}

/**
 * Get transformation statistics
 * @param {Array} instanceIdArray - Original array
 * @param {Map} transformed - Transformed map
 * @returns {Object} Statistics
 */
export function getInstanceIdTransformStats(instanceIdArray, transformed) {
  const countEntries = (obj) => {
    let count = 0;
    const values = obj instanceof Map ? [...obj.values()] : Object.values(obj);
    for (const value of values) {
      count++;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        count += countEntries(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') {
            count += countEntries(item);
          }
        }
      }
    }
    return count;
  };

  return {
    inputPaths: instanceIdArray.length,
    outputEntries: countEntries(transformed),
    format: 'instance-identifier'
  };
}
