/**
 * SID Resolver Module
 *
 * Builds SID info and resolves YANG paths to SIDs
 * Supports Delta-SID encoding (RFC 9254)
 * Optimized for fast searching with Map data structure
 */

import fs from 'fs';

/**
 * Build SID info from .sid file
 * @param {string} sidFilePath - Path to .sid JSON file
 * @returns {Promise<object>} SID info with Maps for fast lookup
 */
export async function buildSidInfo(sidFilePath) {
  try {
    const content = await fs.promises.readFile(sidFilePath, 'utf8');
    const sidData = JSON.parse(content); // Object

    // Support both RFC format and simplified format
    const sidFile = sidData['ietf-sid-file:sid-file'] || sidData; // Object

    const info = {
      // Temporary: path → {sid, prefixedPath} for merging and parent calculation
      // Will be deleted after pathToInfo/sidToInfo are built
      pathEntries: new Map(),

      // Final Maps (kept after processing)
      prefixedPathToSid: new Map(), // Prefixed YANG path → SID (encoding)
      identityToSid: new Map(),     // identity name → SID (encoding)
      sidToIdentity: new Map(),     // SID → identity name (decoding)
      leafToPaths: new Map()        // leaf node name → [fullPath1, ...] (fuzzy matching)

      // pathToInfo and sidToInfo are built later after merging all modules
      // (parent calculation requires all modules to be merged first)
    };

    // Parse items array (RFC 9254 format)
    const items = sidFile.items || [];

    // Process all items
    items.forEach(item => {
      processSidItem(item, info);
    });

    // NOTE: pathToInfo (parent-child relationships) are NOT calculated here
    // because augmentation parents may be in different .sid files.
    // Parent calculation must be done AFTER merging all modules.
    // See: loadYangInputs() in input-loader.js

    return info;

  } catch (error) {
    throw new Error(`SID file parsing error: ${error.message}`);
  }
}

/**
 * Process a single SID item
 * @param {object} item - SID item from .sid file
 * @param {object} info - SID info to populate
 */
function processSidItem(item, info) {
  const sid = item.sid;
  const namespace = item.namespace || 'data'; // category 
  const identifier = item.identifier || ''; // name or path

  // Build YANG path based on namespace
  let yangPath;
  let prefixedPath = null;

  switch (namespace) {
    case 'module':
      // Module-level identifier (usually module name)
      yangPath = identifier;
      break;

    case 'identity':
      // Identity: store in BiMap for bidirectional lookup
      // Extract identity name (remove module prefix)
      const identityName = identifier.includes(':')
        ? identifier.split(':')[1]
        : identifier;
      yangPath = `identity:${identityName}`;
      prefixedPath = `identity:${identifier}`;

      // BiMap: name → SID (encoding)
      info.identityToSid.set(identityName, sid);
      info.identityToSid.set(identifier, sid); // Also store full identifier

      // BiMap: SID → name (decoding)
      info.sidToIdentity.set(sid, identityName);
      break;

    case 'feature':
      // Feature: prefix with 'feature:'
      const featureName = identifier.includes(':')
        ? identifier.split(':')[1]
        : identifier;
      yangPath = `feature:${featureName}`;
      prefixedPath = `feature:${identifier}`;
      break;

    case 'data': // leaf, container, list ...
    default:
      // Data node: extract path from identifier
      // Format: "/module:path/to/leaf" → "path/to/leaf"
      // Remove leading "/" and ALL module prefixes from ALL segments
      // e.g., "/ieee1588-ptp:ptp/parent-ds/ieee802-dot1as-ptp:cumulative-rate-ratio"
      //    → "ptp/parent-ds/cumulative-rate-ratio"
      yangPath = identifier
        .replace(/^\//, '')  // Remove leading /
        .split('/')          // Split by /
        .map(segment => segment.includes(':') ? segment.split(':')[1] : segment)  // Remove prefix from each segment
        .join('/');          // Join back
      prefixedPath = identifier.replace(/^\//, ''); // ^ : anker

      break;
  }

  // Populate leafToPaths index for fuzzy matching
  if (namespace === 'data' && yangPath) {
    const parts = yangPath.split('/');
    const leaf = parts[parts.length - 1];
    if (leaf) {
      if (!info.leafToPaths.has(leaf)) {
        info.leafToPaths.set(leaf, []);
      }
      info.leafToPaths.get(leaf).push(yangPath);
    }
  }

  // Store path → {sid, prefixedPath} for later pathToInfo building
  info.pathEntries.set(yangPath, { sid, prefixedPath });

  // Store prefixedPath → SID for encoding (final, kept)
  if (prefixedPath) {
    info.prefixedPathToSid.set(prefixedPath, sid);
  }
}

/**
 * Resolve YANG path to SID with fuzzy matching for choice/case.
 * @param {string} path - The current path segment (JSON key)
 * @param {object} sidInfo - SID info from buildSidInfo()
 * @param {string} [contextPath=''] - The parent path context.
 * @returns {number|null} SID number or null if not found
 */
export function resolvePathToSid(path, sidInfo, contextPath = '') {
  const fullPath = contextPath ? `${contextPath}/${path}` : path;

  // 1. Direct lookup (most common case)
  if (sidInfo.prefixedPathToSid?.has(fullPath)) {
    return sidInfo.prefixedPathToSid.get(fullPath);
  }
  // Use pathToInfo instead of pathToSid
  const fullPathStripped = stripPrefixes(fullPath);
  const pathToInfo = sidInfo.pathToInfo?.get(fullPathStripped);
  if (pathToInfo) {
    return pathToInfo.sid;
  }

  // 2. Fuzzy match fallback for choice/case nodes absent in YAML
  // Uses pre-built leafToPaths index for performance.
  const pathStripped = stripPrefixes(path);
  const candidatePaths = sidInfo.leafToPaths?.get(pathStripped);

  if (!candidatePaths || candidatePaths.length === 0) {
    return null;
  }

  // If only one candidate, it's likely the correct one.
  if (candidatePaths.length === 1) {
    return sidInfo.pathToInfo?.get(candidatePaths[0])?.sid ?? null;
  }

  // Multiple candidates, find best match using context.
  const contextPathStripped = stripPrefixes(contextPath);
  const contextSegments = contextPathStripped.split('/').filter(Boolean);

  let bestMatch = null;
  let highestScore = -1;

  for (const candidate of candidatePaths) {
    const candidateSegments = candidate.split('/');
    // Score is the length of the common prefix.
    let score = 0;
    for (let i = 0; i < Math.min(contextSegments.length, candidateSegments.length); i++) {
      if (contextSegments[i] === candidateSegments[i]) {
        score++;
      } else {
        break;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestMatch = candidate;
    }
  }

  if (bestMatch) {
    return sidInfo.pathToInfo?.get(bestMatch)?.sid ?? null;
  }

  // If no context match, return first candidate as a last resort
  return sidInfo.pathToInfo?.get(candidatePaths[0])?.sid ?? null;
}

/**
 * Resolve SID to YANG path (reverse lookup)
 * @param {number} sid - SID number
 * @param {object} sidInfo - SID info from buildSidInfo()
 * @returns {string|null} YANG path or null if not found
 */
export function resolveSidToPath(sid, sidInfo) {
  // Use sidToInfo instead of sidToPath
  return sidInfo.sidToInfo?.get(sid)?.path || null;
}

/**
 * Remove module prefixes from a YANG path
 * @param {string} path
 * @returns {string}
 */
function stripPrefixes(path) {
  if (!path) return '';
  return path
    .split('/')
    .map(segment => segment.includes(':') ? segment.split(':')[1] : segment)
    .join('/');
}

/**
 * Resolve identity name to SID (encoding)
 * @param {string} identityName - Identity name (e.g., "ethernetCsmacd")
 * @param {object} sidInfo - SID info from buildSidInfo()
 * @returns {number|null} SID number or null if not found
 */
export function resolveIdentityToSid(identityName, sidInfo) {
  // Remove namespace prefix if present
  const cleanName = identityName.includes(':')
    ? identityName.split(':')[1]
    : identityName;

  return sidInfo.identityToSid.get(cleanName) || null;
}

/**
 * Resolve SID to identity name (decoding)
 * @param {number} sid - SID number
 * @param {object} sidInfo - SID info from buildSidInfo()
 * @returns {string|null} Identity name or null if not found
 */
export function resolveSidToIdentity(sid, sidInfo) {
  return sidInfo.sidToIdentity.get(sid) || null;
}

/**
 * Convert JSON path to YANG path
 * @param {string} jsonPath - JSON dot notation path
 * @returns {string} YANG path with slashes
 */
export function jsonPathToYangPath(jsonPath) {
  // Remove array indices: "interfaces.interface[0].name" → "interfaces.interface.name"
  let path = jsonPath.replace(/\[\d+\]/g, '');

  // Convert dots to slashes: "interfaces.interface.name" → "interfaces/interface/name"
  path = path.replace(/\./g, '/');

  return path;
}

/**
 * Get all SID paths for debugging
 * @param {object} sidInfo - SID info (with pathToInfo or pathEntries)
 * @returns {Array} Array of {path, sid} objects, sorted by SID
 */
export function getAllSidPaths(sidInfo) {
  const paths = [];

  // Use pathToInfo (final) or pathEntries (during building)
  const source = sidInfo.pathToInfo || sidInfo.pathEntries;
  if (source) {
    for (const [path, info] of source) {
      const sid = info.sid !== undefined ? info.sid : info;
      paths.push({ path, sid });
    }
  }

  // Sort by SID for better readability
  paths.sort((a, b) => a.sid - b.sid);

  return paths;
}

/**
 * Get statistics about SID info
 * @param {object} sidInfo - SID info
 * @returns {object} Statistics
 */
export function getSidInfoStats(sidInfo) {
  const pathToInfo = sidInfo.pathToInfo;
  const sids = pathToInfo ? [...pathToInfo.values()].map(n => n.sid) : [];

  return {
    totalPaths: pathToInfo ? pathToInfo.size : 0,
    totalIdentities: sidInfo.identityToSid ? sidInfo.identityToSid.size : 0,
    sidRange: sids.length > 0 ? {
      min: Math.min(...sids),
      max: Math.max(...sids)
    } : { min: 0, max: 0 }
  };
}

/**
 * Load multiple SID files and merge
 * @param {string[]} sidFilePaths - Array of .sid file paths
 * @returns {Promise<object>} Merged SID info
 */
export async function loadMultipleSidFiles(sidFilePaths) {
  const merged = {
    // Temporary: for merging and parent calculation
    pathEntries: new Map(),

    // Final Maps
    prefixedPathToSid: new Map(),
    identityToSid: new Map(),
    sidToIdentity: new Map(),
    pathToInfo: new Map(),
    sidToInfo: new Map(),
    leafToPaths: new Map()
  };

  // Load all SID files in parallel
  const sidInfos = await Promise.all(sidFilePaths.map(filePath => buildSidInfo(filePath)));

  sidInfos.forEach(info => {
    // Merge pathEntries
    for (const [path, entry] of info.pathEntries) {
      merged.pathEntries.set(path, entry);
    }
    for (const [prefixedPath, sid] of info.prefixedPathToSid) {
      merged.prefixedPathToSid.set(prefixedPath, sid);
    }

    // Merge BiMap: Identity ↔ SID
    for (const [name, sid] of info.identityToSid) {
      merged.identityToSid.set(name, sid);
    }
    for (const [sid, name] of info.sidToIdentity) {
      merged.sidToIdentity.set(sid, name);
    }

    // Merge leafToPaths index
    for (const [leaf, paths] of info.leafToPaths) {
      const existing = merged.leafToPaths.get(leaf) || [];
      merged.leafToPaths.set(leaf, [...new Set([...existing, ...paths])]);
    }
  });

  // Build pathToInfo with parent relationships
  // This is done after merging because parent might be from a different module
  for (const [path, entry] of merged.pathEntries) {
    if (path.startsWith('identity:') || path.startsWith('feature:')) {
      continue;
    }

    const parts = path.split('/').filter(p => p);
    let parent = null;

    for (let i = parts.length - 1; i > 0; i--) {
      const ancestorPath = parts.slice(0, i).join('/');
      const ancestorEntry = merged.pathEntries.get(ancestorPath);
      if (ancestorEntry) {
        parent = ancestorEntry.sid;
        break;
      }
    }

    const prefixedPath = entry.prefixedPath || path;
    merged.pathToInfo.set(path, {
      sid: entry.sid,
      parent,
      deltaSid: parent !== null ? entry.sid - parent : entry.sid,
      prefixedPath
    });
  }

  // Build sidToInfo for reverse lookup
  for (const [path, pathToInfo] of merged.pathToInfo) {
    const prefixedPath = pathToInfo.prefixedPath || path;
    const prefixedSegments = prefixedPath.split('/').filter(Boolean);
    const localPrefixed = prefixedSegments.length ? prefixedSegments[prefixedSegments.length - 1] : prefixedPath;

    merged.sidToInfo.set(pathToInfo.sid, {
      parent: pathToInfo.parent,
      deltaSid: pathToInfo.deltaSid,
      path,
      prefixedPath,
      localName: localPrefixed,
      strippedLocalName: path.split('/').pop()
    });
  }

  // Clean up temporary Map
  delete merged.pathEntries;

  return merged;
}
