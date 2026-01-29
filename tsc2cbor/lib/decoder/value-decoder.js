/**
 * Value Decoder Module
 *
 * Decodes CBOR values back to YANG types using BiMap
 * Reverse operation of value-encoder.js
 *
 * 처리 순서:
 * 1. CBOR value 받기
 * 2. TypeInfo로 타입 판단
 * 3. BiMap 사용해서 원본 값 복원
 */

import { Tag } from 'cbor-x';

/**
 * Decode CBOR value to original YANG value
 * @param {*} cborValue - CBOR encoded value
 * @param {object} typeInfo - Type information from yang-type-extractor
 * @param {object} sidInfo - SID tree for identity resolution
 * @param {boolean} isUnion - Whether this is inside a union type
 * @param {object} typeTable - Type table for typedef resolution (optional)
 * @param {string} yangPath - YANG path for error reporting (optional)
 * @returns {*} Decoded value
 */
export function decodeValue(cborValue, typeInfo, sidInfo = null, isUnion = false, typeTable = null, yangPath = null) {
  if (!typeInfo || !typeInfo.type) {
    return cborValue; // No type info, return as-is
  }

  // CRITICAL FIX: Resolve typedef to base type
  // If typeInfo.type is not a built-in type, it might be a typedef
  // Check if typeInfo has resolved type info (enum, bits, etc.)
  // If not, this might be a typedef that needs resolution
  let resolvedTypeInfo = typeInfo;

  // If typeInfo has original type stored and is different from type
  // Or if type is not a built-in type, try to use original or resolve
  if (typeInfo.original && typeInfo.original !== typeInfo.type) {
    // This is a typedef - use the original info if it has enum/bits/etc
    if (typeInfo.enum || typeInfo.bits || typeInfo.base) {
      // Type info already has resolved information, use it
      resolvedTypeInfo = typeInfo;
    }
  }

  switch (resolvedTypeInfo.type) {
    case 'enumeration':
      return decodeEnum(cborValue, resolvedTypeInfo, isUnion, yangPath);

    case 'identityref':
      return decodeIdentity(cborValue, resolvedTypeInfo, sidInfo, isUnion);

    case 'decimal64':
      return decodeDecimal64(cborValue);

    case 'bits':
      return decodeBits(cborValue, resolvedTypeInfo);

    case 'union':
      return decodeUnion(cborValue, resolvedTypeInfo, sidInfo, typeTable, yangPath);

    case 'binary':
      return decodeBinary(cborValue);

    case 'boolean':
      return cborValue; // Already boolean

    case 'string':
      return cborValue; // Already string

    case 'uint8':
    case 'uint16':
    case 'uint32':
    case 'uint64':
    case 'int8':
    case 'int16':
    case 'int32':
    case 'int64':
      return cborValue; // Already number

    default:
      // CRITICAL FIX: Check if this is a typedef with enum/bits/identityref embedded
      if (resolvedTypeInfo.enum) {
        // Has enum definition - treat as enumeration
        return decodeEnum(cborValue, resolvedTypeInfo, isUnion, yangPath);
      }
      if (resolvedTypeInfo.bits) {
        // Has bits definition - treat as bits
        return decodeBits(cborValue, resolvedTypeInfo);
      }
      if (resolvedTypeInfo.base) {
        // Has base identity - treat as identityref
        return decodeIdentity(cborValue, resolvedTypeInfo, sidInfo, isUnion);
      }

      // Unknown type or primitive - return as-is
      return cborValue;
  }
}

/**
 * Decode enum value to name
 * @param {number|Tag} cborValue - CBOR enum value (number or Tag(44))
 * @param {object} typeInfo - Type info with enum definition
 * @param {boolean} isUnion - Whether inside union
 * @param {string} yangPath - YANG path for error reporting
 * @returns {string} Enum name
 */
function decodeEnum(cborValue, typeInfo, isUnion, yangPath = null) {
  // Extract value from Tag(44) if in union
  let value = cborValue;
  if (isUnion && cborValue instanceof Tag && cborValue.tag === 44) {
    value = cborValue.value;
  }

  if (!typeInfo.enum) {
    throw new Error(`Enum type info missing enum definition${yangPath ? ` for path: ${yangPath}` : ''}`);
  }

  let enumName;

  if (typeof value === 'string') {
    // String input: validate against nameToValue map
    if (typeInfo.enum.nameToValue && typeInfo.enum.nameToValue.has(value)) {
      enumName = value; // Already a valid enum name
    } else {
      const availableNames = Array.from(typeInfo.enum.valueToName.values());
      const pathInfo = yangPath ? ` Path: ${yangPath}.` : '';
      throw new Error(`Enum name "${value}" not found in enum definition.${pathInfo} Available names: ${availableNames.join(', ')}. Type: ${typeInfo.type}, Original: ${typeInfo.original || 'N/A'}`);
    }
  } else if (typeof value === 'number') {
    // Numeric input: use BiMap value → name (O(1))
    enumName = typeInfo.enum.valueToName.get(value);
    if (!enumName) {
      const availableValues = Array.from(typeInfo.enum.valueToName.keys()).sort((a, b) => a - b);
      const pathInfo = yangPath ? ` Path: ${yangPath}.` : '';
      throw new Error(`Enum value ${value} not found in enum definition.${pathInfo} Available values: ${availableValues.join(', ')}. Type: ${typeInfo.type}, Original: ${typeInfo.original || 'N/A'}`);
    }
  } else {
    const pathInfo = yangPath ? ` Path: ${yangPath}.` : '';
    throw new Error(`Unexpected enum value type: ${typeof value}.${pathInfo} Expected number or string.`);
  }

  return enumName;
}

/**
 * Decode identity SID to identity name
 * @param {number|Tag} cborValue - Identity SID (number or Tag(45))
 * @param {object} typeInfo - Type info with identity base
 * @param {object} sidInfo - SID tree with sidToIdentity map
 * @param {boolean} isUnion - Whether inside union
 * @returns {string} Identity name
 */
function decodeIdentity(cborValue, typeInfo, sidInfo, isUnion) {
  // Extract SID from Tag(45) if in union
  let sid = cborValue;
  if (isUnion && cborValue instanceof Tag && cborValue.tag === 45) {
    sid = cborValue.value;
  }

  if (!sidInfo || !sidInfo.sidToIdentity) {
    throw new Error('SID tree missing sidToIdentity map');
  }

  // Use BiMap: SID → identity name
  const identityName = sidInfo.sidToIdentity.get(sid);
  if (!identityName) {
    throw new Error(`Identity SID ${sid} not found in SID tree`);
  }

  return identityName;
}

/**
 * Decode decimal64 from CBOR Tag(4) or number
 * @param {Tag|number} cborValue - CBOR decimal64 value
 * @returns {number} JavaScript number
 *
 * cbor-x automatically converts Tag(4, [-2, 314]) → 3.14
 * So we usually receive a number already
 */
function decodeDecimal64(cborValue) {
  // If already a number (cbor-x auto-converted)
  if (typeof cborValue === 'number') {
    return cborValue;
  }

  // If still a Tag(4)
  if (cborValue instanceof Tag && cborValue.tag === 4) {
    const [exponent, mantissa] = cborValue.value;
    return mantissa * Math.pow(10, exponent);
  }

  return cborValue;
}

/**
 * Decode bits from CBOR Tag(43) byte array
 * @param {Tag|Buffer} cborValue - CBOR bits value
 * @param {object} typeInfo - Type info with bit definitions
 * @returns {string[]} Array of bit names
 */
function decodeBits(cborValue, typeInfo) {
  let buffer = cborValue;

  // Extract buffer from Tag(43)
  if (cborValue instanceof Tag && cborValue.tag === 43) {
    buffer = cborValue.value;
  }

  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Expected Buffer for bits type');
  }

  if (!typeInfo.bits) {
    throw new Error('Bits type info missing bits definition');
  }

  const result = [];

  // Check each bit position
  for (const [bitName, position] of Object.entries(typeInfo.bits)) {
    const byteIndex = Math.floor(position / 8);
    const bitIndex = position % 8;

    if (byteIndex < buffer.length) {
      const byte = buffer[byteIndex];
      if ((byte & (1 << bitIndex)) !== 0) {
        result.push(bitName);
      }
    }
  }

  return result;
}

/**
 * Decode binary (byte string) to base64 string
 * @param {Buffer} cborValue - CBOR binary value (Buffer)
 * @returns {string} Base64 encoded string
 */
function decodeBinary(cborValue) {
  // CBOR binary is decoded as Buffer by cbor-x
  if (Buffer.isBuffer(cborValue)) {
    return cborValue.toString('base64');
  }

  // If it's already a string, return as-is
  if (typeof cborValue === 'string') {
    return cborValue;
  }

  // Unexpected type
  return cborValue;
}

/**
 * Decode union type by checking CBOR Tag
 * @param {*} cborValue - CBOR value (may have Tag 44 or 45)
 * @param {object} typeInfo - Union type info
 * @param {object} sidInfo - SID tree
 * @param {object} typeTable - Type table for typedef resolution
 * @param {string} yangPath - YANG path for error reporting
 * @returns {*} Decoded value
 */
function decodeUnion(cborValue, typeInfo, sidInfo, typeTable, yangPath = null) {
  // Check for union-specific tags
  if (cborValue instanceof Tag) {
    if (cborValue.tag === 44) {
      // Tag(44) = enum in union
      // Find enum type in union
      for (const memberType of typeInfo.unionTypes || typeInfo.types || []) {
        if (memberType.type === 'enumeration' || memberType.enum) {
          return decodeEnum(cborValue, memberType, true, yangPath);
        }
      }
    } else if (cborValue.tag === 45) {
      // Tag(45) = identity in union
      for (const memberType of typeInfo.unionTypes || typeInfo.types || []) {
        if (memberType.type === 'identityref' || memberType.base) {
          return decodeIdentity(cborValue, memberType, sidInfo, true);
        }
      }
    }
  }

  // Try each union member type
  if (typeInfo.unionTypes && Array.isArray(typeInfo.unionTypes)) {
    for (const memberType of typeInfo.unionTypes) {
      try {
        return decodeValue(cborValue, memberType, sidInfo, true, typeTable, yangPath);
      } catch (err) {
        // Try next type
        continue;
      }
    }
  } else if (typeInfo.types && Array.isArray(typeInfo.types)) {
    for (const memberType of typeInfo.types) {
      try {
        return decodeValue(cborValue, memberType, sidInfo, true, typeTable, yangPath);
      } catch (err) {
        // Try next type
        continue;
      }
    }
  }

  // Fallback
  return cborValue;
}

/**
 * Decode object values based on type information
 * @param {object} sidObject - Object with SID keys and CBOR values
 * @param {object} typeTable - Type table from yang-type-extractor
 * @param {object} sidInfo - SID tree for path resolution
 * @returns {object} Object with YANG paths and decoded values
 */
export function decodeObjectValues(sidObject, typeTable, sidInfo) {
  const decoded = {};

  for (const [sidKey, cborValue] of Object.entries(sidObject)) {
    const sid = Number(sidKey);

    // Step 1: SID → YANG path (use sidToInfo instead of sidToPath)
    const yangPath = sidInfo.sidToInfo?.get(sid)?.path;
    if (!yangPath) {
      console.warn(`No YANG path found for SID ${sid}`);
      decoded[sid] = cborValue; // Keep as SID
      continue;
    }

    // Step 2: Get TypeInfo for this path
    const typeInfo = typeTable.types.get(yangPath);

    // Step 3: Decode value based on TypeInfo
    const decodedValue = typeInfo
      ? decodeValue(cborValue, typeInfo, sidInfo, false)
      : cborValue;

    decoded[yangPath] = decodedValue;
  }

  return decoded;
}
