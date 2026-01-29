/**
 * CoAP (Constrained Application Protocol) Frame Builder
 * RFC 7252, RFC 8132 (FETCH/PATCH methods), RFC 7959 (Block-Wise Transfer)
 *
 * For CORECONF (RFC 9254):
 * - iFETCH: GET method to fetch configuration
 * - iPATCH: FETCH method with CBOR payload to modify configuration
 */

import { Encoder, Decoder } from 'cbor-x';

// Configure CBOR encoder/decoder for RFC 9254 compliance
// Encoder: useRecords: false prevents adding tag 259 wrapper around Maps
// Decoder: mapsAsObjects: false preserves CBOR Maps as JS Map objects (required to keep integer SID keys)
const cborEncoder = new Encoder({ useRecords: false, mapsAsObjects: false });
const cborDecoder = new Decoder({ mapsAsObjects: false });

const cborEncode = (data) => cborEncoder.encode(data);
const cborDecode = (data) => cborDecoder.decode(data);

// CoAP Message Types
const MessageType = {
  CON: 0,  // Confirmable
  NON: 1,  // Non-confirmable
  ACK: 2,  // Acknowledgement
  RST: 3   // Reset
};

// CoAP Method Codes (class.detail format)
const MethodCode = {
  GET: 0x01,      // 0.01
  POST: 0x02,     // 0.02
  PUT: 0x03,      // 0.03
  DELETE: 0x04,   // 0.04
  FETCH: 0x05,    // 0.05 (RFC 8132)
  PATCH: 0x06,    // 0.06 (RFC 8132)
  IPATCH: 0x07    // 0.07 (RFC 8132)
};

// CoAP Response Codes
const ResponseCode = {
  CREATED: 0x41,           // 2.01
  DELETED: 0x42,           // 2.02
  VALID: 0x43,             // 2.03
  CHANGED: 0x44,           // 2.04
  CONTENT: 0x45,           // 2.05
  CONTINUE: 0x5F,          // 2.31 (RFC 7959 Block-Wise Transfer)
  BAD_REQUEST: 0x80,       // 4.00
  UNAUTHORIZED: 0x81,      // 4.01
  NOT_FOUND: 0x84,         // 4.04
  METHOD_NOT_ALLOWED: 0x85,// 4.05
  REQUEST_ENTITY_INCOMPLETE: 0x88, // 4.08 (RFC 7959)
  REQUEST_ENTITY_TOO_LARGE: 0x8D   // 4.13 (RFC 7959)
};

// CoAP Option Numbers (RFC 7252 + extensions)
const OptionNumber = {
  IF_MATCH: 1,
  URI_HOST: 3,
  ETAG: 4,
  IF_NONE_MATCH: 5,
  URI_PORT: 7,
  LOCATION_PATH: 8,
  URI_PATH: 11,
  CONTENT_FORMAT: 12,
  MAX_AGE: 14,
  URI_QUERY: 15,
  ACCEPT: 17,
  LOCATION_QUERY: 20,
  BLOCK2: 23, // RFC 7959 - Response block-wise transfer
  BLOCK1: 27, // RFC 7959 - Request block-wise transfer
  PROXY_URI: 35,
  PROXY_SCHEME: 39,
  SIZE1: 60
};

// Content-Format for CORECONF
const ContentFormat = {
  // Standard CBOR
  CBOR: 60,
  // YANG-CBOR (CORECONF)
  YANG_DATA_CBOR_SID: 140,      // application/yang-data+cbor; id=sid
  YANG_IDENTIFIERS_CBOR: 141,   // application/yang-identifiers+cbor-seq
  YANG_INSTANCES_CBOR: 142      // application/yang-instances+cbor-seq
};

/**
 * Build CoAP message
 * @param {Object} options
 * @param {number} options.type - Message type (CON, NON, ACK, RST)
 * @param {number} options.code - Method/Response code
 * @param {number} options.messageId - Message ID (0-65535)
 * @param {Buffer} options.token - Token (0-8 bytes)
 * @param {Array} options.options - Array of {number, value} pairs
 * @param {Buffer} options.payload - Payload data
 * @returns {Buffer} CoAP message
 */
function buildMessage(options) {
  const {
    type = MessageType.CON,
    code,
    messageId = Math.floor(Math.random() * 65536),
    token = Buffer.alloc(0),
    options: coapOptions = [],
    payload = null
  } = options;

  if (token.length > 8) {
    throw new Error('Token length must be 0-8 bytes');
  }

  const parts = [];

  // Header (4 bytes)
  const header = Buffer.alloc(4);
  header[0] = (1 << 6) | (type << 4) | token.length; // Ver=1, Type, TKL
  header[1] = code;
  header.writeUInt16BE(messageId, 2);
  parts.push(header);

  // Token (0-8 bytes)
  if (token.length > 0) {
    parts.push(token);
  }

  // Options (variable length)
  if (coapOptions.length > 0) {
    parts.push(encodeOptions(coapOptions));
  }

  // Payload (variable length)
  if (payload && payload.length > 0) {
    parts.push(Buffer.from([0xFF])); // Payload marker
    parts.push(payload);
  }

  return Buffer.concat(parts);
}

/**
 * Encode CoAP options
 * @param {Array} options - Array of {number, value}
 * @returns {Buffer}
 */
function encodeOptions(options) {
  // Sort options by number
  options.sort((a, b) => a.number - b.number);

  const parts = [];
  let previousNumber = 0;

  for (const option of options) {
    const delta = option.number - previousNumber;
    const value = encodeOptionValue(option.value);
    const length = value.length;

    // Option header
    let optionHeader = 0;
    let extendedDelta = null;
    let extendedLength = null;

    // Encode delta
    if (delta < 13) {
      optionHeader |= (delta << 4);
    } else if (delta < 269) {
      optionHeader |= (13 << 4);
      extendedDelta = Buffer.from([delta - 13]);
    } else {
      optionHeader |= (14 << 4);
      extendedDelta = Buffer.alloc(2);
      extendedDelta.writeUInt16BE(delta - 269);
    }

    // Encode length
    if (length < 13) {
      optionHeader |= length;
    } else if (length < 269) {
      optionHeader |= 13;
      extendedLength = Buffer.from([length - 13]);
    } else {
      optionHeader |= 14;
      extendedLength = Buffer.alloc(2);
      extendedLength.writeUInt16BE(length - 269);
    }

    parts.push(Buffer.from([optionHeader]));
    if (extendedDelta) parts.push(extendedDelta);
    if (extendedLength) parts.push(extendedLength);
    parts.push(value);

    previousNumber = option.number;
  }

  return Buffer.concat(parts);
}

/**
 * Encode option value
 * @param {string|number|Buffer} value
 * @returns {Buffer}
 */
function encodeOptionValue(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  if (typeof value === 'number') {
    // Encode as minimal bytes
    if (value === 0) return Buffer.alloc(0);
    const bytes = [];
    let temp = value;
    while (temp > 0) {
      bytes.unshift(temp & 0xFF);
      temp >>= 8;
    }
    return Buffer.from(bytes);
  }
  return Buffer.alloc(0);
}

/**
 * Encode Block2 option value as an integer.
 * @param {number} num - Block number
 * @param {boolean} m - More flag
 * @param {number} szx - Size exponent (0-6)
 * @returns {number} Integer value for the option
 */
function encodeBlock2Value(num, m, szx) {
  if (szx < 0 || szx > 6) throw new Error('Invalid SZX value (must be 0-6)');
  if (num < 0 || num >= (1 << 20)) throw new Error('Invalid block number (must be 0-1048575)');
  return (num << 4) | ((m ? 1 : 0) << 3) | szx;
}

/**
 * Decode Block2 option value from a buffer.
 * @param {Buffer} value - Option value buffer
 * @returns {{num: number, m: boolean, szx: number, size: number}}
 */
function decodeBlock2Value(value) {
  let intValue = 0;
  for (let i = 0; i < value.length; i++) {
    intValue = (intValue << 8) | value[i];
  }

  const szx = intValue & 0x07;
  const m = ((intValue >> 3) & 0x01) === 1;
  const num = intValue >> 4;
  const size = 1 << (szx + 4);

  return { num, m, szx, size };
}

/**
 * Encode Block1 option value as an integer.
 * RFC 7959: Block1 for client-to-server block-wise transfer
 * @param {number} num - Block number
 * @param {boolean} m - More flag
 * @param {number} szx - Size exponent (0-6)
 * @returns {number} Integer value for the option
 */
function encodeBlock1Value(num, m, szx) {
  if (szx < 0 || szx > 6) throw new Error('Invalid SZX value (must be 0-6)');
  if (num < 0 || num >= (1 << 20)) throw new Error('Invalid block number (must be 0-1048575)');
  return (num << 4) | ((m ? 1 : 0) << 3) | szx;
}

/**
 * Decode Block1 option value from a buffer.
 * @param {Buffer} value - Option value buffer
 * @returns {{num: number, m: boolean, szx: number, size: number}}
 */
function decodeBlock1Value(value) {
  let intValue = 0;
  for (let i = 0; i < value.length; i++) {
    intValue = (intValue << 8) | value[i];
  }

  const szx = intValue & 0x07;
  const m = ((intValue >> 3) & 0x01) === 1;
  const num = intValue >> 4;
  const size = 1 << (szx + 4);

  return { num, m, szx, size };
}

/**
 * Build iFETCH request (query configuration)
 * @param {Array} query - CBOR array of SIDs (e.g., [29304] or [1000])
 *                        RFC 9254 requires array format, not map
 * @param {Object} options - Additional options
 * @returns {Buffer} CoAP message
 */
function buildiFetchRequest(query, options = {}) {
  // Handle multiple queries: encode each as separate CBOR and concatenate
  // Input: [[SID, key], [SID, key], ...] or [SID, key] for single query
  let payload;
  if (Array.isArray(query) && query.length > 0 && Array.isArray(query[0])) {
    // Multiple queries: each element is a [SID, keys...] array
    const buffers = query.map(q => cborEncode(q));
    payload = Buffer.concat(buffers);
  } else {
    // Single query
    payload = cborEncode(query);
  }

  // Block2 option: request server to use block-wise transfer for response
  // szx=4 means 256 bytes, num=0, more=0 → value=0x04
  const block2Value = 0x04;

  return buildMessage({
    type: MessageType.CON,
    code: MethodCode.FETCH,
    token: options.token || Buffer.alloc(0),  // Empty token (Token Length 0)
    options: [
      { number: OptionNumber.URI_PATH, value: 'c' },  // CORECONF endpoint
      { number: OptionNumber.CONTENT_FORMAT, value: ContentFormat.YANG_IDENTIFIERS_CBOR },  // 141 for iFETCH
      { number: OptionNumber.BLOCK2, value: block2Value }  // Request block-wise response
    ],
    payload,
    ...options
  });
}

/**
 * Build iPATCH request (modify configuration)
 * @param {Buffer|Object} patch - CBOR-encoded Buffer or CBOR-encodable object
 * @param {Object} options - Additional options
 * @returns {Buffer} CoAP message
 */
function buildiPatchRequest(patch, options = {}) {
  // If patch is already CBOR-encoded Buffer, use it directly
  // Otherwise, encode it
  const payload = Buffer.isBuffer(patch) ? patch : cborEncode(patch);

  return buildMessage({
    type: MessageType.CON,
    code: MethodCode.IPATCH,
    token: options.token || Buffer.alloc(0),  // Empty token (Token Length 0)
    options: [
      { number: OptionNumber.URI_PATH, value: 'c' },  // CORECONF endpoint
      // No datastore query parameter for iPATCH (operates on running datastore by default)
      { number: OptionNumber.CONTENT_FORMAT, value: ContentFormat.YANG_INSTANCES_CBOR },  // 142 for iPATCH (VelocityDrive SP spec)
      { number: OptionNumber.ACCEPT, value: ContentFormat.YANG_DATA_CBOR_SID }  // 140 for response
    ],
    payload,
    ...options
  });
}

/**
 * Build POST request (RPC/action invocation)
 * @param {Object|Map|Buffer} payload - CBOR-encodable payload or Buffer
 * @param {Object} options - Additional options
 * @param {string} options.uriPath - Custom URI path (default: 'c')
 * @returns {Buffer} CoAP message
 */
function buildPostRequest(payload, options = {}) {
  const encodedPayload = Buffer.isBuffer(payload) ? payload : cborEncode(payload);
  const uriPath = options.uriPath || 'c';

  return buildMessage({
    type: MessageType.CON,
    code: MethodCode.POST,
    token: options.token || Buffer.alloc(0),
    options: [
      { number: OptionNumber.URI_PATH, value: uriPath },
      { number: OptionNumber.CONTENT_FORMAT, value: ContentFormat.YANG_INSTANCES_CBOR },
      { number: OptionNumber.ACCEPT, value: ContentFormat.YANG_DATA_CBOR_SID }
    ],
    payload: encodedPayload,
    ...options
  });
}

/**
 * Build GET request (retrieve entire datastore)
 * @param {Object} options - Additional options, including custom CoAP options in `options.options`
 * @returns {Buffer} CoAP message
 */
function buildGetRequest(options = {}) {
  const defaultOptions = [
    { number: OptionNumber.URI_PATH, value: 'c' },
    // Don't specify datastore - use default (running datastore)
    // { number: OptionNumber.URI_QUERY, value: 'd=a' }, // Datastore=all may not be supported
    { number: OptionNumber.ACCEPT, value: ContentFormat.YANG_DATA_CBOR_SID }
  ];

  const customOptions = options.options || [];

  // Remove `options` property from top-level object before spreading
  // to avoid overwriting the merged array.
  const { options: _opts, ...restOfOptions } = options;

  return buildMessage({
    type: MessageType.CON,
    code: MethodCode.GET,
    ...restOfOptions,
    options: [...defaultOptions, ...customOptions]
  });
}

/**
 * Build PUT request (replace entire resource)
 * RFC 7252 + RFC 9254 CORECONF
 *
 * PUT replaces the entire resource at the target URI with the provided payload.
 * This is appropriate for sending complete configurations.
 *
 * @param {Object|Map|Buffer} payload - Complete configuration to replace existing resource
 * @param {Object} options - Additional options
 * @returns {Buffer} CoAP message
 */
function buildPutRequest(payload, options = {}) {
  // If payload is already a Buffer (pre-encoded CBOR), use it directly
  // Otherwise, encode it as CBOR
  const encodedPayload = Buffer.isBuffer(payload) ? payload : cborEncode(payload);

  return buildMessage({
    type: MessageType.CON,
    code: MethodCode.PUT,
    token: options.token || Buffer.alloc(0),
    options: [
      { number: OptionNumber.URI_PATH, value: 'c' },  // CORECONF endpoint
      { number: OptionNumber.CONTENT_FORMAT, value: ContentFormat.YANG_INSTANCES_CBOR },  // 142
      { number: OptionNumber.ACCEPT, value: ContentFormat.YANG_DATA_CBOR_SID }  // 140
    ],
    payload: encodedPayload,
    ...options
  });
}

/**
 * Parse CoAP response
 * @param {Buffer} data - CoAP message
 * @returns {Object} Parsed message
 */
function parseResponse(data) {
  if (data.length < 4) {
    throw new Error('Invalid CoAP message: too short');
  }

  let offset = 0;

  // Parse header
  const version = (data[0] >> 6) & 0x03;
  const type = (data[0] >> 4) & 0x03;
  const tokenLength = data[0] & 0x0F;
  const code = data[1];
  const messageId = data.readUInt16BE(2);
  offset += 4;

  // Parse token
  const token = data.slice(offset, offset + tokenLength);
  offset += tokenLength;

  // Parse options
  const options = [];
  let previousNumber = 0;

  while (offset < data.length && data[offset] !== 0xFF) {
    const optionHeader = data[offset++];
    let delta = (optionHeader >> 4) & 0x0F;
    let length = optionHeader & 0x0F;

    // Extended delta
    if (delta === 13) {
      delta = data[offset++] + 13;
    } else if (delta === 14) {
      delta = data.readUInt16BE(offset) + 269;
      offset += 2;
    }

    // Extended length
    if (length === 13) {
      length = data[offset++] + 13;
    } else if (length === 14) {
      length = data.readUInt16BE(offset) + 269;
      offset += 2;
    }

    const number = previousNumber + delta;
    const value = data.slice(offset, offset + length);
    offset += length;

    options.push({ number, value });
    previousNumber = number;
  }

  // Parse payload
  let payload = null;
  if (offset < data.length && data[offset] === 0xFF) {
    offset++; // Skip payload marker
    payload = data.slice(offset);
  }

  return {
    version,
    type,
    code,
    messageId,
    token,
    options,
    payload,
    // Helper methods
    isSuccess: () => (code >> 5) === 2,
    getCodeClass: () => code >> 5,
    getCodeDetail: () => code & 0x1F,
    getPayloadAsCBOR: () => payload ? cborDecode(payload) : null,
    getBlock2Value: () => {
      const block2Opt = options.find(opt => opt.number === OptionNumber.BLOCK2);
      return block2Opt ? decodeBlock2Value(block2Opt.value) : null;
    },
    getBlock1Value: () => {
      const block1Opt = options.find(opt => opt.number === OptionNumber.BLOCK1);
      return block1Opt ? decodeBlock1Value(block1Opt.value) : null;
    }
  };
}

export {
  MessageType,
  MethodCode,
  ResponseCode,
  OptionNumber,
  ContentFormat,
  cborDecode,
  buildMessage,
  buildiFetchRequest,
  buildiPatchRequest,
  buildPostRequest,
  buildGetRequest,
  buildPutRequest,
  parseResponse,
  encodeBlock2Value,
  decodeBlock2Value,
  encodeBlock1Value,
  decodeBlock1Value
};
