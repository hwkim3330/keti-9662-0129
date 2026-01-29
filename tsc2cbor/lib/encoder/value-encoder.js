/**
 * Value Encoder Module
 *
 * Encodes values based on YANG type information with RFC 9254 CBOR Tags
 *
 * CBOR Tags (RFC 9254):
 * - Tag 4: decimal64 as [-fractionDigits, mantissa]
 * - Tag 43: bits as byte array
 * - Tag 44: enumeration in union context
 * - Tag 45: identityref in union context
 */

import cbor from 'cbor';
import { resolveIdentityToSid } from '../common/sid-resolver.js';

// Use cbor library's Tagged class for CBOR tag encoding
// Note: cbor uses Tagged(tagNumber, value), not Tag(value, tagNumber)
const { Tagged } = cbor;

/**
 * Encode value based on YANG type information
 * @param {*} value - Value to encode
 * @param {object} typeInfo - Type information from yang-type-extractor
 * @param {object} sidInfo - SID tree from sid-resolver (for identity resolution)
 * @param {boolean} isUnion - Whether this is inside a union context
 * @returns {*} Encoded value suitable for CBOR (may include Tags)
 */
export function encodeValue(value, typeInfo, sidInfo = null, isUnion = false) {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return null;
  }

  // If no type info, auto-detect
  if (!typeInfo || !typeInfo.type) {
    return autoEncodeValue(value);
  }

  const yangType = typeInfo.type;

  switch (yangType) {
    case 'enumeration':
      return encodeEnum(value, typeInfo, isUnion);

    case 'identityref':
      return encodeIdentity(value, typeInfo, sidInfo, isUnion);

    case 'decimal64':
      return encodeDecimal64(value, typeInfo);

    case 'bits':
      return encodeBits(value, typeInfo, isUnion);

    case 'boolean':
      return Boolean(value);

    case 'uint8':
    case 'uint16':
    case 'uint32':
    case 'uint64':
      return encodeUint(value);

    case 'int8':
    case 'int16':
    case 'int32':
    case 'int64':
      return encodeInt(value);

    case 'string':
      // Convert MAC address format: colon to dash (YANG ieee:mac-address standard)
      const stringValue = String(value);
      if (isMacAddress(stringValue)) {
        const converted = stringValue.replace(/:/g, '-');
        // Debug: log conversion
        if (process.env.DEBUG_MAC) {
          console.log(`MAC conversion: ${stringValue} → ${converted}`);
        }
        return converted;
      }
      return stringValue;

    case 'binary':
      return encodeBinary(value);

    case 'empty':
      return null; // RFC 9254: empty type is encoded as null

    case 'union':
      return encodeUnion(value, typeInfo, sidInfo);

    default:
      // Unknown type - auto-detect
      return autoEncodeValue(value);
  }
}

/**
 * Encode enum value with optional Tag(44) for union context
 * @param {string|number} value - Enum value (name or number)
 * @param {object} typeInfo - Type information with enum mapping
 * @param {boolean} isUnion - Whether in union context
 * @returns {number|Tag} Enum integer or Tag(44, integer)
 */
function encodeEnum(value, typeInfo, isUnion = false) {
  let enumValue;

  if (typeof value === 'number') {
    // If in union context, validate that this number is a valid enum value
    if (isUnion && typeInfo.enum) {
      // BiMap: valueToName has all valid values
      if (!typeInfo.enum.valueToName.has(value)) {
        throw new Error(`Numeric value ${value} is not a valid enum value`);
      }
    }
    enumValue = value;
  } else if (typeof value === 'string') {
    // Look up enum name → value using BiMap (O(1))
    if (typeInfo.enum && typeInfo.enum.nameToValue.has(value)) {
      enumValue = typeInfo.enum.nameToValue.get(value);
    } else {
      throw new Error(`Enum value "${value}" not found in type definition`);
    }
  } else {
    throw new Error(`Invalid enum value type: ${typeof value}`);
  }

  // RFC 9254: Use Tag(44) for enum in union context
  return isUnion ? new Tagged(44, enumValue) : enumValue;
}

/**
 * Encode identity value with optional Tag(45) for union context
 * @param {string|number} value - Identity name or SID
 * @param {object} typeInfo - Type information with base identity
 * @param {object} sidInfo - SID tree for identity→SID resolution
 * @param {boolean} isUnion - Whether in union context
 * @returns {number|Tag} Identity SID or Tag(45, SID)
 */
function encodeIdentity(value, typeInfo, sidInfo, isUnion = false) {
  let sid;

  if (typeof value === 'number') {
    sid = value;
  } else if (typeof value === 'string') {
    if (!sidInfo) {
      throw new Error('SID tree required for identity resolution');
    }

    // Resolve identity name → SID
    sid = resolveIdentityToSid(value, sidInfo);

    if (sid === null) {
      throw new Error(`Identity "${value}" not found in SID tree`);
    }
  } else {
    throw new Error(`Invalid identity value type: ${typeof value}`);
  }

  // RFC 9254: Use Tag(45) for identityref in union context
  return isUnion ? new Tagged(45, sid) : sid;
}

/**
 * Encode decimal64 with RFC 9254 Tag(4)
 * @param {number|string} value - Decimal value (e.g., 3.14)
 * @param {object} typeInfo - Type information with fractionDigits
 * @returns {Tag} Tag(4, [-fractionDigits, mantissa])
 */
function encodeDecimal64(value, typeInfo) {
  const fractionDigits = typeInfo.fractionDigits || 2;
  const numValue = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(numValue)) {
    throw new Error(`Invalid decimal64 value: ${value}`);
  }

  // Calculate mantissa: value * 10^fractionDigits
  const mantissa = Math.round(numValue * Math.pow(10, fractionDigits));

  // RFC 9254: Tag(4, [-fractionDigits, mantissa])
  // Example: 3.14 with fd=2 → Tag(4, [-2, 314])
  return new Tagged(4, [-fractionDigits, mantissa]);
}

/**
 * Encode bits per RFC 9254
 * - Normal context: byte string only
 * - Union context: Tag(43) + byte string (to distinguish from other types)
 * @param {string|Array} value - Bits value (e.g., "bit0 bit2" or ["bit0", "bit2"])
 * @param {object} typeInfo - Type information with bit definitions
 * @param {boolean} isUnion - Whether in union context
 * @returns {Buffer|Tagged} Byte buffer or Tag(43, byteBuffer)
 */
function encodeBits(value, typeInfo, isUnion = false) {
  let bitNames = [];

  if (Array.isArray(value)) {
    bitNames = value;
  } else if (typeof value === 'string') {
    bitNames = value.split(/\s+/).filter(Boolean);
  } else {
    throw new Error(`Invalid bits value type: ${typeof value}`);
  }

  if (!typeInfo.bits) {
    throw new Error('Bits type definition not found');
  }

  // Convert bit names to positions
  const positions = bitNames.map(name => {
    const pos = typeInfo.bits[name];
    if (pos === undefined) {
      throw new Error(`Bit "${name}" not found in type definition`);
    }
    return pos;
  });

  // Convert positions to byte array
  // Find max position to determine byte array size
  const maxPos = Math.max(...positions, -1);
  const numBytes = Math.ceil((maxPos + 1) / 8);
  const bytes = Buffer.alloc(numBytes);

  // Set bits
  positions.forEach(pos => {
    const byteIndex = Math.floor(pos / 8);
    const bitIndex = pos % 8;
    bytes[byteIndex] |= (1 << bitIndex);
  });

  // RFC 9254: Use Tag(43) only in union context to distinguish bits from other types
  return isUnion ? new Tagged(43, bytes) : bytes;
}

/**
 * Encode union value
 * Union types need special handling - must detect actual type and apply appropriate Tag
 * @param {*} value - Union value
 * @param {object} typeInfo - Type information with unionTypes
 * @param {object} sidInfo - SID tree
 * @returns {*} Encoded value with appropriate Tag
 */
function encodeUnion(value, typeInfo, sidInfo) {
  if (!typeInfo.unionTypes || typeInfo.unionTypes.length === 0) {
    return autoEncodeValue(value);
  }

  // Try each union type in order
  for (const unionType of typeInfo.unionTypes) {
    try {
      // Attempt to encode with isUnion=true for Tag wrapping
      return encodeValue(value, unionType, sidInfo, true);
    } catch (err) {
      // Try next type
      continue;
    }
  }

  // If no type matched, return as-is
  console.warn(`Union value could not be encoded with any union type: ${value}`);
  return autoEncodeValue(value);
}

/**
 * Encode unsigned integer
 * @param {number|string} value - Unsigned integer value
 * @returns {number} Validated unsigned integer
 */
function encodeUint(value) {
  const num = Number(value);
  if (num < 0) {
    throw new Error(`Unsigned integer cannot be negative: ${value}`);
  }
  if (!Number.isInteger(num)) {
    throw new Error(`Unsigned integer must be an integer: ${value}`);
  }
  return num;
}

/**
 * Encode signed integer
 * @param {number|string} value - Signed integer value
 * @returns {number} Validated signed integer
 */
function encodeInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num)) {
    throw new Error(`Signed integer must be an integer: ${value}`);
  }
  return num;
}

/**
 * Encode binary value
 * @param {string|Buffer} value - Binary value (base64 string or Buffer)
 * @returns {Buffer} Binary buffer
 */
function encodeBinary(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  // Assume base64 encoded string
  if (typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }

  return Buffer.from(String(value));
}

/**
 * Auto-detect and encode value (fallback for unknown types)
 * @param {*} value - Value to encode
 * @returns {*} Encoded value
 */
function autoEncodeValue(value) {
  const type = typeof value;

  switch (type) {
    case 'boolean':
      return value;
    case 'number':
      return value;
    case 'string':
      // Convert MAC address format even without typeInfo
      if (isMacAddress(value)) {
        const converted = value.replace(/:/g, '-');
        if (process.env.DEBUG_MAC) {
          console.log(`MAC conversion (auto): ${value} → ${converted}`);
        }
        return converted;
      }
      return value;
    case 'object':
      if (Array.isArray(value)) {
        return value.map(v => autoEncodeValue(v));
      }
      if (value === null) {
        return null;
      }
      // Object - recursively encode
      const encoded = {};
      for (const [k, v] of Object.entries(value)) {
        encoded[k] = autoEncodeValue(v);
      }
      return encoded;
    default:
      return value;
  }
}

/**
 * Encode object values recursively with type information
 * @param {object} obj - Object with values to encode
 * @param {object} typeTable - Type table from yang-type-extractor
 * @param {object} sidInfo - SID tree from sid-resolver
 * @param {string} currentPath - Current YANG path (for nested objects)
 * @returns {object} Object with encoded values
 */
export function encodeObjectValues(obj, typeTable = {}, sidInfo = null, currentPath = '') {
  const encoded = {};

  for (const [key, value] of Object.entries(obj)) {
    const yangPath = currentPath ? `${currentPath}/${key}` : key;
    const typeInfo = typeTable.types ? typeTable.types.get(yangPath) : null;

    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      // Recursively encode nested objects
      encoded[key] = encodeObjectValues(value, typeTable, sidInfo, yangPath);
    } else if (Array.isArray(value)) {
      // Encode array elements
      encoded[key] = value.map(v =>
        typeof v === 'object' && v !== null
          ? encodeObjectValues(v, typeTable, sidInfo, yangPath)
          : encodeValue(v, typeInfo, sidInfo, false)
      );
    } else {
      // Encode primitive value
      encoded[key] = encodeValue(value, typeInfo, sidInfo, false);
    }
  }

  return encoded;
}

/**
 * Check if string is a MAC address (with colon or dash separator)
 * @param {string} value - String to check
 * @returns {boolean} True if MAC address format
 */
function isMacAddress(value) {
  // MAC address patterns (IEEE 802 format):
  // - Colon separated: DE:68:FE:C8:1C:01
  // - Dash separated: DE-68-FE-C8-1C-01
  const macPattern = /^[0-9A-Fa-f]{2}([-:])[0-9A-Fa-f]{2}(\1[0-9A-Fa-f]{2}){4}$/;
  return macPattern.test(value);
}
