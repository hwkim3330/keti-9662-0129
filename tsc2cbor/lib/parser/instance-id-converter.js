/**
 * Instance-identifier to RFC 7951 Converter
 *
 * Converts XPath-style instance-identifier format (used by mvdct/RFC 8072)
 * to RFC 7951 hierarchical JSON format (used internally by tsc2cbor).
 *
 * @module lib/parser/instance-id-converter
 *
 * @example
 * // Instance-identifier format (input):
 * [
 *   { "/ieee802-dot1ab-lldp:lldp/message-tx-interval": 15 },
 *   { "/ietf-interfaces:interfaces/interface[name='1']/enabled": true }
 * ]
 *
 * // RFC 7951 format (output):
 * {
 *   "ieee802-dot1ab-lldp:lldp": { "message-tx-interval": 15 },
 *   "ietf-interfaces:interfaces": {
 *     "interface": [{ "name": "1", "enabled": true }]
 *   }
 * }
 */

/**
 * Parses an instance-identifier path string into structured components.
 * Supports /module:container/list[key='value']/leaf patterns.
 *
 * @param {string} path - The instance-identifier path string
 * @returns {Array<Object>} An array of parsed path components
 * @throws {Error} If a segment of the path is malformed
 *
 * @example
 * parseInstanceIdentifierPath("/ietf-interfaces:interfaces/interface[name='1']/enabled")
 * // Returns:
 * // [
 * //   { module: 'ietf-interfaces', name: 'interfaces', type: 'node' },
 * //   { module: null, name: 'interface', type: 'list', keys: [{keyName: 'name', keyValue: '1'}] },
 * //   { module: null, name: 'enabled', type: 'node' }
 * // ]
 */
function parseInstanceIdentifierPath(path) {
  const components = [];

  // Remove leading slash, then split by '/'
  const segments = path.startsWith('/') ? path.substring(1).split('/') : path.split('/');

  // Regex to match: (module:)?(nodeName)([key='value'])*
  // Group 1: module prefix (e.g., 'ietf-interfaces')
  // Group 2: node name (e.g., 'interfaces', 'interface', 'gate-enabled')
  // Group 3: full key-value predicate(s) (e.g., "[name='1']" or "[name='1'][index='2']")
  const segmentRegex = /^(?:([a-zA-Z0-9_-]+):)?([a-zA-Z0-9_-]+)((?:\[[^\]]+\])*)$/;

  // Regex to extract individual key-value pairs from predicates
  const predicateRegex = /\[([a-zA-Z0-9_-]+)='([^']+)'\]/g;

  for (const segment of segments) {
    if (!segment) continue; // Skip empty segments

    const match = segment.match(segmentRegex);
    if (!match) {
      throw new Error(`Invalid instance-identifier segment: "${segment}" in path "${path}"`);
    }

    const [, modulePrefix, nodeName, predicatesStr] = match;

    if (predicatesStr) {
      // Extract all key-value pairs from predicates
      const keys = [];
      let predicateMatch;
      while ((predicateMatch = predicateRegex.exec(predicatesStr)) !== null) {
        keys.push({
          keyName: predicateMatch[1],
          keyValue: predicateMatch[2]
        });
      }
      // Reset regex lastIndex for next use
      predicateRegex.lastIndex = 0;

      if (keys.length > 0) {
        components.push({
          module: modulePrefix || null,
          name: nodeName,
          type: 'list',
          keys: keys // Support multiple keys for composite list keys
        });
      } else {
        // Predicate exists but couldn't parse - treat as node
        components.push({
          module: modulePrefix || null,
          name: nodeName,
          type: 'node'
        });
      }
    } else {
      components.push({
        module: modulePrefix || null,
        name: nodeName,
        type: 'node'
      });
    }
  }

  return components;
}

/**
 * Detects if the input data is in instance-identifier format.
 *
 * Instance-identifier format characteristics:
 * - Top-level is an array
 * - Each element is an object with a single key starting with '/'
 *
 * @param {*} data - Parsed YAML/JSON data
 * @returns {boolean} True if data is in instance-identifier format
 */
function isInstanceIdentifierFormat(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return false;
  }

  // Check if all items match instance-identifier pattern
  return data.every(item => {
    if (typeof item !== 'object' || item === null) {
      return false;
    }

    const keys = Object.keys(item);
    if (keys.length !== 1) {
      return false;
    }

    const key = keys[0];
    return typeof key === 'string' && key.startsWith('/');
  });
}

/**
 * Converts an array of instance-identifier objects to RFC 7951 format.
 *
 * @param {Array<Object>} instanceIdentifierData - Array like [{ "/path/to/leaf": value }, ...]
 * @returns {Object} RFC 7951 compliant hierarchical JavaScript object
 * @throws {Error} If path parsing fails or object merging encounters type conflicts
 *
 * @example
 * convertInstanceIdentifierToRfc7951([
 *   { "/ieee802-dot1ab-lldp:lldp/message-tx-interval": 15 }
 * ])
 * // Returns: { "ieee802-dot1ab-lldp:lldp": { "message-tx-interval": 15 } }
 */
function convertInstanceIdentifierToRfc7951(instanceIdentifierData) {
  const rfc7951Object = {};

  for (const item of instanceIdentifierData) {
    const path = Object.keys(item)[0];
    const value = item[path];

    const components = parseInstanceIdentifierPath(path);

    let currentTarget = rfc7951Object;

    for (let i = 0; i < components.length; i++) {
      const component = components[i];
      const isLastComponent = (i === components.length - 1);

      // Determine the node key
      // Use module prefix if explicitly provided
      let nodeKey;
      if (component.module) {
        nodeKey = `${component.module}:${component.name}`;
      } else {
        nodeKey = component.name;
      }

      if (component.type === 'list') {
        // Ensure the list exists
        if (!currentTarget[nodeKey]) {
          currentTarget[nodeKey] = [];
        }
        if (!Array.isArray(currentTarget[nodeKey])) {
          throw new Error(`Path segment '${nodeKey}' expected to be a list, but found a non-array at "${path}"`);
        }

        // Find or create the list item matching all keys
        let listItem = currentTarget[nodeKey].find(el => {
          if (!el || typeof el !== 'object') return false;
          return component.keys.every(k => el[k.keyName] === k.keyValue);
        });

        if (!listItem) {
          // Create new item with all keys
          listItem = {};
          for (const k of component.keys) {
            listItem[k.keyName] = k.keyValue;
          }
          currentTarget[nodeKey].push(listItem);
        }

        currentTarget = listItem;
      } else {
        // Container or leaf node
        if (isLastComponent) {
          // This is the target leaf - assign value
          currentTarget[nodeKey] = value;
        } else {
          // Intermediate container - create or traverse
          if (!currentTarget[nodeKey]) {
            currentTarget[nodeKey] = {};
          }
          if (typeof currentTarget[nodeKey] !== 'object' || Array.isArray(currentTarget[nodeKey])) {
            throw new Error(`Path segment '${nodeKey}' expected to be a container, but found a non-object at "${path}"`);
          }
          currentTarget = currentTarget[nodeKey];
        }
      }
    }
  }

  return rfc7951Object;
}

/**
 * Main conversion function with format detection.
 * Converts instance-identifier format to RFC 7951 if needed.
 *
 * @param {*} data - Parsed YAML/JSON data (either format)
 * @param {Object} options - Options
 * @param {boolean} options.verbose - Enable verbose logging
 * @returns {Object} Object with converted data and format info
 */
function convertToRfc7951IfNeeded(data, options = {}) {
  const verbose = options.verbose || false;

  if (isInstanceIdentifierFormat(data)) {
    if (verbose) {
      console.log('\nDetected instance-identifier format. Converting to RFC 7951...');
    }

    const converted = convertInstanceIdentifierToRfc7951(data);

    if (verbose) {
      console.log('Conversion to RFC 7951 successful.');
    }

    return {
      data: converted,
      originalFormat: 'instance-identifier',
      wasConverted: true
    };
  }

  return {
    data: data,
    originalFormat: 'rfc7951',
    wasConverted: false
  };
}

export {
  parseInstanceIdentifierPath,
  isInstanceIdentifierFormat,
  convertInstanceIdentifierToRfc7951,
  convertToRfc7951IfNeeded
};
