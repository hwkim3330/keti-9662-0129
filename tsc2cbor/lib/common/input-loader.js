/**
 * Input Loader - Common module for loading YANG/SID inputs
 *
 * This module extracts the shared loadInputs logic from both
 * tsc2cbor.js and cbor2tsc.js to eliminate code duplication.
 *
 * Supports pre-compiled cache for fast loading.
 *
 * @module input-loader
 */

import { buildSidInfo } from './sid-resolver.js';
import { extractYangTypes } from './yang-type-extractor.js';
import fs from 'fs';
import path from 'path';

// Cache version - increment when cache format changes
// v8: Renamed nodeInfo → pathToInfo, nodeInfoBySid → sidToInfo
// v9: Added augment node processing in yang-type-extractor
// v10: Added leafToTypes index for O(1) type lookup by leaf name
// v11: Added nodeTypes map for list/container detection
// v12: Fixed typedef resolution with module prefix stripping
const CACHE_VERSION = 12;

/**
 * Get cache file path for a YANG cache directory
 */
function getCacheFilePath(yangCacheDir) {
  const dirName = path.basename(yangCacheDir);
  return path.join(path.dirname(yangCacheDir), `${dirName}.cache.json`);
}

/**
 * Check if cache is valid (exists and newer than source files)
 */
async function isCacheValid(cacheFile, yangCacheDir) {
  try {
    const cacheStat = await fs.promises.stat(cacheFile);
    const cacheTime = cacheStat.mtimeMs;

    // Check if any source file is newer than cache
    const files = await fs.promises.readdir(yangCacheDir);
    for (const file of files) {
      if (file.endsWith('.yang') || file.endsWith('.sid')) {
        const fileStat = await fs.promises.stat(path.join(yangCacheDir, file));
        if (fileStat.mtimeMs > cacheTime) {
          return false; // Source file is newer
        }
      }
    }
    return true;
  } catch {
    return false; // Cache doesn't exist
  }
}

/**
 * Serialize Maps and Sets to JSON-compatible format
 */
function serializeData(sidInfo, typeTable, schemaInfo) {
  return {
    version: CACHE_VERSION,
    timestamp: Date.now(),
    sidInfo: {
      // Final maps only (no temporary maps like pathEntries)
      prefixedPathToSid: [...sidInfo.prefixedPathToSid],
      identityToSid: [...sidInfo.identityToSid],
      sidToIdentity: [...sidInfo.sidToIdentity],
      pathToInfo: [...sidInfo.pathToInfo],
      sidToInfo: [...sidInfo.sidToInfo],
      leafToPaths: [...sidInfo.leafToPaths]
    },
    typeTable: {
      types: [...typeTable.types].map(([k, v]) => [k, serializeTypeInfo(v)]),
      typedefs: [...typeTable.typedefs].map(([k, v]) => [k, serializeTypeInfo(v)]),
      leafToTypes: [...typeTable.leafToTypes].map(([k, v]) => [k, v.map(item => ({
        path: item.path,
        typeInfo: serializeTypeInfo(item.typeInfo)
      }))])
    },
    schemaInfo: {
      nodeOrders: [...schemaInfo.nodeOrders],
      nodeTypes: [...schemaInfo.nodeTypes],
      leafToNodeTypes: [...schemaInfo.leafToNodeTypes]
    }
  };
}

/**
 * Serialize type info (handle nested Maps)
 */
function serializeTypeInfo(typeInfo) {
  if (!typeInfo) return typeInfo;
  const result = { ...typeInfo };
  if (typeInfo.enum) {
    result.enum = {
      nameToValue: [...typeInfo.enum.nameToValue],
      valueToName: [...typeInfo.enum.valueToName]
    };
  }
  return result;
}

/**
 * Deserialize JSON data back to Maps and Sets
 */
function deserializeData(data) {
  if (data.version !== CACHE_VERSION) {
    throw new Error('Cache version mismatch');
  }

  const sidInfo = {
    // Final maps only
    prefixedPathToSid: new Map(data.sidInfo.prefixedPathToSid),
    identityToSid: new Map(data.sidInfo.identityToSid),
    sidToIdentity: new Map(data.sidInfo.sidToIdentity),
    pathToInfo: new Map(data.sidInfo.pathToInfo),
    sidToInfo: new Map(data.sidInfo.sidToInfo),
    leafToPaths: new Map(data.sidInfo.leafToPaths)
  };

  const typeTable = {
    types: new Map(data.typeTable.types.map(([k, v]) => [k, deserializeTypeInfo(v)])),
    typedefs: new Map(data.typeTable.typedefs.map(([k, v]) => [k, deserializeTypeInfo(v)])),
    leafToTypes: new Map(data.typeTable.leafToTypes.map(([k, v]) => [k, v.map(item => ({
      path: item.path,
      typeInfo: deserializeTypeInfo(item.typeInfo)
    }))]))
  };

  const schemaInfo = {
    nodeOrders: new Map(data.schemaInfo.nodeOrders),
    nodeTypes: new Map(data.schemaInfo.nodeTypes),
    leafToNodeTypes: new Map(data.schemaInfo.leafToNodeTypes)
  };

  return { sidInfo, typeTable, schemaInfo };
}

/**
 * Deserialize type info
 */
function deserializeTypeInfo(typeInfo) {
  if (!typeInfo) return typeInfo;
  const result = { ...typeInfo };
  if (typeInfo.enum) {
    result.enum = {
      nameToValue: new Map(typeInfo.enum.nameToValue),
      valueToName: new Map(typeInfo.enum.valueToName)
    };
  }
  return result;
}

/**
 * Load from cache file
 */
async function loadFromCache(cacheFile, verbose) {
  const data = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
  const result = deserializeData(data);

  if (verbose) {
    const sidCount = result.sidInfo.pathToInfo.size;
    const typeCount = result.typeTable.types.size;
    console.log(`  Loaded from cache: ${sidCount} SIDs, ${typeCount} types`);
  }

  return result;
}

/**
 * Save to cache file
 */
async function saveToCache(cacheFile, sidInfo, typeTable, schemaInfo, verbose) {
  const data = serializeData(sidInfo, typeTable, schemaInfo);
  await fs.promises.writeFile(cacheFile, JSON.stringify(data), 'utf8');

  if (verbose) {
    const stat = await fs.promises.stat(cacheFile);
    console.log(`  Cache saved: ${(stat.size / 1024).toFixed(1)} KB`);
  }
}

/**
 * Load and merge YANG/SID inputs from cache directory
 *
 * Uses pre-compiled cache if available for fast loading.
 *
 * @param {string} yangCacheDir - Directory containing .yang and .sid files
 * @param {boolean} verbose - Enable verbose logging
 * @param {object} options - Additional options
 * @param {boolean} options.noCache - Disable cache (force reload)
 * @returns {Promise<{sidInfo: object, typeTable: object, schemaInfo: object}>}
 */
export async function loadYangInputs(yangCacheDir, verbose = false, options = {}) {
  const cacheFile = getCacheFilePath(yangCacheDir);

  // Try to load from cache first (unless disabled)
  if (!options.noCache && await isCacheValid(cacheFile, yangCacheDir)) {
    if (verbose) {
      console.log('Loading YANG/SID from cache...');
    }
    try {
      return await loadFromCache(cacheFile, verbose);
    } catch (err) {
      if (verbose) {
        console.log(`  Cache load failed: ${err.message}, rebuilding...`);
      }
    }
  }

  if (verbose) {
    console.log('Loading YANG/SID inputs...');
  }

  // Step 1: Load all SID files from cache directory (async)
  const allFiles = await fs.promises.readdir(yangCacheDir);
  const sidFiles = allFiles
    .filter(f => f.endsWith('.sid'))
    .map(f => path.join(yangCacheDir, f));

  if (verbose) {
    console.log(`  - Found ${sidFiles.length} SID files`);
  }

  // Step 2: Initialize merged SID info structure
  const sidInfo = {
    // Temporary: for merging and parent calculation (deleted after pathToInfo built)
    pathEntries: new Map(),

    // Final Maps (kept)
    prefixedPathToSid: new Map(),
    identityToSid: new Map(),
    sidToIdentity: new Map(),
    pathToInfo: new Map(),
    sidToInfo: new Map(),
    leafToPaths: new Map()
  };

  // Load all SID files in parallel for better performance
  const sidInfos = await Promise.all(sidFiles.map(sidFile => buildSidInfo(sidFile)));

  // Merge all SID infos
  for (const info of sidInfos) {
    // Merge pathEntries (temporary)
    for (const [nodePath, entry] of info.pathEntries) {
      sidInfo.pathEntries.set(nodePath, entry);
    }
    // Merge prefixedPathToSid (final)
    for (const [prefixedPath, sid] of info.prefixedPathToSid) {
      sidInfo.prefixedPathToSid.set(prefixedPath, sid);
    }
    // Merge identity maps (final)
    for (const [identity, sid] of info.identityToSid) {
      sidInfo.identityToSid.set(identity, sid);
    }
    for (const [sid, identity] of info.sidToIdentity) {
      sidInfo.sidToIdentity.set(sid, identity);
    }
    // Merge leafToPaths index for fuzzy matching (final)
    for (const [leaf, paths] of info.leafToPaths) {
      const existing = sidInfo.leafToPaths.get(leaf) || [];
      sidInfo.leafToPaths.set(leaf, [...new Set([...existing, ...paths])]); // Delete duplicated data using Set
    }
  }

  // Step 3: Build pathToInfo with parent relationships
  // This is done after merging because parent might be from a different module
  for (const [nodePath, entry] of sidInfo.pathEntries) {
    if (nodePath.startsWith('identity:') || nodePath.startsWith('feature:')) {
      continue;
    }

    const parts = nodePath.split('/').filter(p => p);
    let parent = null;

    for (let i = parts.length - 1; i > 0; i--) {
      const ancestorPath = parts.slice(0, i).join('/');
      const ancestorEntry = sidInfo.pathEntries.get(ancestorPath);
      if (ancestorEntry) {
        parent = ancestorEntry.sid;
        break;
      }
    }

    const prefixedPath = entry.prefixedPath || nodePath;
    sidInfo.pathToInfo.set(nodePath, {
      sid: entry.sid,
      parent,
      deltaSid: parent !== null ? entry.sid - parent : entry.sid,
      prefixedPath
    });
  }

  // Step 3.5: Build sidToInfo for reverse lookup (SID → node info)
  for (const [nodePath, pathToInfo] of sidInfo.pathToInfo) {
    const prefixedPath = pathToInfo.prefixedPath || nodePath;
    const prefixedSegments = prefixedPath.split('/').filter(Boolean);
    const localPrefixed = prefixedSegments.length ? prefixedSegments[prefixedSegments.length - 1] : prefixedPath;

    sidInfo.sidToInfo.set(pathToInfo.sid, {
      parent: pathToInfo.parent,
      deltaSid: pathToInfo.deltaSid,
      path: nodePath,
      prefixedPath,
      localName: localPrefixed,
      strippedLocalName: nodePath.split('/').pop()
    });
  }

  // Step 3.6: Clean up temporary Map
  delete sidInfo.pathEntries;

  // Step 4: Load all YANG files from cache directory
  const yangFiles = allFiles
    .filter(f => f.endsWith('.yang'))
    .map(f => path.join(yangCacheDir, f));

  if (verbose) {
    console.log(`  - Found ${yangFiles.length} YANG files`);
  }

  // Step 5: Initialize merged type table and schema info structures
  const typeTable = {
    types: new Map(),
    typedefs: new Map()
  };

  const schemaInfo = {
    nodeOrders: new Map(),
    nodeTypes: new Map()
  };

  // Load all YANG files in parallel for better performance
  const yangResults = await Promise.all(
    yangFiles.map(yangFile => extractYangTypes(yangFile, yangCacheDir))
  );

  // Merge all type tables and schema infos
  for (const result of yangResults) {
    for (const [path, type] of result.typeTable.types) {
      typeTable.types.set(path, type);
    }
    for (const [name, typedef] of result.typeTable.typedefs) {
      typeTable.typedefs.set(name, typedef);
    }
    if (result.schemaInfo?.nodeOrders) {
      for (const [nodeName, order] of result.schemaInfo.nodeOrders) {
        schemaInfo.nodeOrders.set(nodeName, order);
      }
    }
    if (result.schemaInfo?.nodeTypes) {
      for (const [nodePath, nodeType] of result.schemaInfo.nodeTypes) {
        schemaInfo.nodeTypes.set(nodePath, nodeType);
      }
    }
  }

  // Step 6: Merge vendor-prefixed typedefs into base typedefs
  const mergedTypedefs = new Set();
  for (const [name, typedef] of typeTable.typedefs) {
    const vendorPrefixes = ['velocitysp-', 'mchp-'];
    for (const prefix of vendorPrefixes) {
      if (name.startsWith(prefix)) {
        const baseName = name.substring(prefix.length); // Get a name without prefix
        const baseTypedef = typeTable.typedefs.get(baseName);

        if (baseTypedef && baseTypedef.enum && typedef.enum) {
          const mergedEnum = {
            nameToValue: new Map([...baseTypedef.enum.nameToValue, ...typedef.enum.nameToValue]),
            valueToName: new Map([...baseTypedef.enum.valueToName, ...typedef.enum.valueToName])
          };
          typeTable.typedefs.set(baseName, {
            ...typedef,
            enum: mergedEnum,
            original: baseName
          });
          mergedTypedefs.add(baseName);
          if (verbose) {
            console.log(`  - Merged ${name} into ${baseName} (${mergedEnum.nameToValue.size} enum values)`);
          }
        }
      }
    }
  }

  // Update leaf types that use merged typedefs
  for (const [path, typeInfo] of typeTable.types) {
    if (typeInfo.original && mergedTypedefs.has(typeInfo.original)) {
      const mergedTypedef = typeTable.typedefs.get(typeInfo.original);
      typeTable.types.set(path, {
        ...mergedTypedef,
        original: typeInfo.original
      });
    }
  }

  // Step 7: Post-process typedef resolution
  // Typedefs from other modules may not have been available during initial processing
  const builtinTypes = ['enumeration', 'identityref', 'decimal64', 'bits', 'union',
    'binary', 'boolean', 'string', 'empty',
    'uint8', 'uint16', 'uint32', 'uint64', 'int8', 'int16', 'int32', 'int64'];

  for (const [path, typeInfo] of typeTable.types) {
    // Skip if already resolved (has enum, bits, or base property)
    if (typeInfo.enum || typeInfo.bits || typeInfo.base) continue;

    // Skip built-in types
    if (builtinTypes.includes(typeInfo.type)) continue;

    // Try to resolve typedef
    let typedef = typeTable.typedefs.get(typeInfo.type);
    if (!typedef && typeInfo.type.includes(':')) {
      const strippedType = typeInfo.type.split(':')[1];
      typedef = typeTable.typedefs.get(strippedType);
    }

    if (typedef) {
      // Update the type entry with resolved typedef info
      typeTable.types.set(path, {
        ...typedef,
        original: typeInfo.type
      });
    }
  }

  // Step 8: Build leafToTypes index for O(1) type lookup by leaf name
  // This enables fuzzy matching when grouping paths don't match full SID paths
  typeTable.leafToTypes = new Map();
  for (const [path, typeInfo] of typeTable.types) {
    const leafName = path.split('/').pop();
    if (!typeTable.leafToTypes.has(leafName)) {
      typeTable.leafToTypes.set(leafName, []);
    }
    typeTable.leafToTypes.get(leafName).push({ path, typeInfo });
  }

  // Step 9: Build leafToNodeTypes index for O(1) node type lookup
  // This enables detecting list/container when path doesn't exactly match
  schemaInfo.leafToNodeTypes = new Map();
  for (const [path, nodeType] of schemaInfo.nodeTypes) {
    const leafName = path.split('/').pop();
    if (!schemaInfo.leafToNodeTypes.has(leafName)) {
      schemaInfo.leafToNodeTypes.set(leafName, []);
    }
    schemaInfo.leafToNodeTypes.get(leafName).push({ path, nodeType });
  }

  if (verbose) {
    const sidCount = sidInfo.pathToInfo.size;
    const typeCount = typeTable.types.size;

    let enumCount = 0;
    for (const typeInfo of typeTable.types.values()) {
      if (typeInfo.type === 'enumeration' && typeInfo.enum) {
        enumCount++;
      }
    }

    console.log(`  Loaded: ${sidCount} SID mappings`);
    console.log(`  Loaded: ${typeCount} types (${enumCount} enums)`);
  }

  // Step 8: Save to cache for future fast loading
  if (!options.noCache) {
    try {
      await saveToCache(cacheFile, sidInfo, typeTable, schemaInfo, verbose);
    } catch (err) {
      // Cache save failure is not critical
      if (verbose) {
        console.log(`  Warning: Failed to save cache: ${err.message}`);
      }
    }
  }

  return { sidInfo, typeTable, schemaInfo };
}
