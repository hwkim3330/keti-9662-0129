/**
 * Detransformer Module for Instance-Identifier Output
 *
 * Direct conversion from Delta-SID CBOR to Instance-Identifier format.
 * More efficient than RFC7951 → Instance-ID conversion.
 *
 * CBOR Map with Delta-SID → Instance-Identifier Array
 */

import { decodeValue } from './value-decoder.js';

/**
 * List key definitions for known YANG modules
 */
const LIST_KEYS = {
  'interface': ['name'],
  'instance': ['instance-index'],
  'port': ['port-index'],
  'gate-control-entry': ['index'],
  'pcp-decoding-map': ['pcp'],
  'pcp-encoding-map': ['traffic-class'],
  'queue-max-sdu-table': ['traffic-class'],
  'vlan-registration-entry': ['vids'],
  'filtering-entry': ['vids'],
  'port-map': ['port-ref'],
  'stream-identity': ['index'],
  'identification-list': ['index'],
  'stream-filter': ['stream-filter-instance-id'],
  'stream-gate': ['stream-gate-instance-id'],
  'flow-meter': ['flow-meter-instance-id'],
  'admin-control-list': ['index'],
  'oper-control-list': ['index'],
};

/**
 * Build XPath from prefixed YANG path with list key predicates
 */
function buildXPath(prefixedPath, listKeys) {
  const segments = prefixedPath.split('/').filter(Boolean);
  let xpath = '';
  let currentPath = '';

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    xpath += '/' + segment;

    if (listKeys.has(currentPath)) {
      const keys = listKeys.get(currentPath);
      for (const [keyName, keyValue] of Object.entries(keys)) {
        xpath += `[${keyName}='${keyValue}']`;
      }
    }
  }

  return xpath;
}

/**
 * Check if value is a leaf (primitive) value
 */
function isLeafValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'number') return true;
  if (typeof value === 'boolean') return true;
  if (Buffer.isBuffer(value)) return true;
  return false;
}

/**
 * Recursively extract instance-identifier entries from CBOR data
 */
function extractInstanceIds(cborData, sidToInfo, typeTable, sidInfo, parentSid, currentPrefixedPath, listKeys, results) {
  if (cborData === null || cborData === undefined || typeof cborData !== 'object') {
    return;
  }

  // Handle arrays (lists)
  if (Array.isArray(cborData)) {
    for (const item of cborData) {
      if (item && typeof item === 'object') {
        const itemListKeys = new Map(listKeys);
        const listName = currentPrefixedPath.split('/').pop();
        const nodeName = listName.includes(':') ? listName.split(':')[1] : listName;
        const keyNames = LIST_KEYS[nodeName] || ['name', 'index'];

        const itemKeys = {};
        const isMap = item instanceof Map;
        const entries = isMap ? item.entries() : Object.entries(item);

        for (let [key, value] of entries) {
          if (!isMap && typeof key === 'string') {
            const numKey = Number(key);
            if (!isNaN(numKey) && String(numKey) === key) {
              key = numKey;
            }
          }

          if (typeof key === 'number') {
            let absoluteSid = null;
            let nodeInfo = null;

            if (parentSid !== null) {
              const potentialSid = key + parentSid;
              const potentialNode = sidToInfo.get(potentialSid);
              if (potentialNode && potentialNode.parent === parentSid) {
                nodeInfo = potentialNode;
                absoluteSid = potentialSid;
              }
            }

            if (!nodeInfo) {
              nodeInfo = sidToInfo.get(key);
              if (nodeInfo) absoluteSid = key;
            }

            if (nodeInfo && keyNames.includes(nodeInfo.localName)) {
              const typeInfo = typeTable.types.get(nodeInfo.path);
              const decodedValue = typeInfo
                ? decodeValue(value, typeInfo, sidInfo, false, null, nodeInfo.path)
                : value;
              itemKeys[nodeInfo.localName] = decodedValue;
            }
          }
        }

        if (Object.keys(itemKeys).length > 0) {
          itemListKeys.set(currentPrefixedPath, itemKeys);
        }

        extractInstanceIds(item, sidToInfo, typeTable, sidInfo, parentSid, currentPrefixedPath, itemListKeys, results);
      }
    }
    return;
  }

  // Handle Maps and Objects
  const isMap = cborData instanceof Map;
  const isPlainObject = !isMap && cborData.constructor === Object;

  if (isMap || isPlainObject) {
    const entries = isMap ? cborData.entries() : Object.entries(cborData);

    for (let [key, value] of entries) {
      if (!isMap && typeof key === 'string') {
        const numKey = Number(key);
        if (!isNaN(numKey) && String(numKey) === key) {
          key = numKey;
        }
      }

      if (typeof key !== 'number') continue;

      let absoluteSid = null;
      let nodeInfo = null;

      if (parentSid !== null) {
        const potentialSid = key + parentSid;
        const potentialNode = sidToInfo.get(potentialSid);
        if (potentialNode && potentialNode.parent === parentSid) {
          nodeInfo = potentialNode;
          absoluteSid = potentialSid;
        }
      }

      if (!nodeInfo) {
        nodeInfo = sidToInfo.get(key);
        if (nodeInfo) absoluteSid = key;
      }

      if (!nodeInfo) {
        console.warn(`Unknown SID: ${key}`);
        continue;
      }

      const newPrefixedPath = nodeInfo.prefixedPath;

      if (isLeafValue(value)) {
        const xpath = buildXPath(newPrefixedPath, listKeys);
        const typeInfo = typeTable.types.get(nodeInfo.path);
        const decodedValue = typeInfo
          ? decodeValue(value, typeInfo, sidInfo, false, null, nodeInfo.path)
          : value;

        results.push({ [xpath]: decodedValue });
      } else if (Array.isArray(value)) {
        extractInstanceIds(value, sidToInfo, typeTable, sidInfo, absoluteSid, newPrefixedPath, listKeys, results);
      } else {
        extractInstanceIds(value, sidToInfo, typeTable, sidInfo, absoluteSid, newPrefixedPath, listKeys, results);
      }
    }
  }
}

/**
 * Detransform CBOR to Instance-Identifier format
 * @param {Map|object} cborData - CBOR data with Delta-SID encoding
 * @param {object} typeTable - Type table
 * @param {object} sidInfo - SID tree
 * @returns {Array<Object>} Array of instance-identifier entries
 */
export function detransformToInstanceId(cborData, typeTable, sidInfo) {
  const sidToInfo = sidInfo.sidToInfo;
  const results = [];
  const listKeys = new Map();

  let cborMap;
  if (cborData instanceof Map) {
    cborMap = cborData;
  } else {
    cborMap = new Map();
    for (const [key, value] of Object.entries(cborData)) {
      const numKey = Number(key);
      const actualKey = !isNaN(numKey) && String(numKey) === key ? numKey : key;
      cborMap.set(actualKey, value);
    }
  }

  extractInstanceIds(cborMap, sidToInfo, typeTable, sidInfo, null, '', listKeys, results);

  return results;
}

/**
 * Filter out list key entries
 */
export function filterListKeys(instanceIdEntries) {
  return instanceIdEntries.filter(entry => {
    const xpath = Object.keys(entry)[0];
    const leafName = xpath.split('/').pop().split('[')[0];

    for (const keyNames of Object.values(LIST_KEYS)) {
      if (keyNames.includes(leafName) && xpath.includes('[')) {
        return false;
      }
    }
    return true;
  });
}

export default {
  detransformToInstanceId,
  filterListKeys
};
