/**
 * MUP1 (Microchip UART Protocol 1) - OFFICIAL Implementation
 *
 * Based on velocitydrivesp-support/support/libeasy/handler/mup1.rb
 *
 * Frame Structure:
 * > TYPE [DATA...] < [<] CHECKSUM
 *
 * - SOF: 0x3E ('>')
 * - TYPE: 1 byte (e.g., 'C' = 0x43 for CoAP)
 * - DATA: variable length (with byte stuffing)
 * - EOF: 0x3C ('<')
 *   - If data length is EVEN, use TWO EOFs ('<<')
 * - CHECKSUM: 4 ASCII hex chars (e.g., "a67f")
 *   - Internet Checksum algorithm
 */

// Debug logging helper - controlled by DEBUG environment variable
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const debugLog = (...args) => {
  if (DEBUG_ENABLED) {
    console.log(...args);
  }
};

// Frame markers
const SOF = 0x3E;  // '>'
const EOF = 0x3C;  // '<'
const ESC = 0x5C;  // '\\'
const NL  = 0x0D;  // '\r'
const ESC_00 = 0x30;  // '0' (escaped 0x00)
const ESC_FF = 0x46;  // 'F' (escaped 0xFF)

// Frame types
const FrameType = {
  ANNOUNCE:      0x50,  // 'P' (Frame sent by device after PING_REQ)
  COAP:          0x63,  // 'c' (lowercase - for sending requests)
  COAP_RESPONSE: 0x43,  // 'C' (uppercase - device may respond with this)
  PING_REQ:      0x70,  // 'p' (Frame sent by host to initiate handshake)
  TRACE:         0x54,  // 'T'
};

/**
 * Calculate Internet Checksum (RFC 1071)
 * Returns 4-char ASCII hex string (e.g., "a67f")
 *
 * @param {Buffer} data - Frame data to checksum
 * @returns {string} 4-char hex string
 */
function calculateChecksum(data) {
  let sum = 0;

  // Sum all 16-bit words
  for (let i = 0; i < data.length; i += 2) {
    if (i + 1 < data.length) {
      // Full 16-bit word (big-endian)
      sum += (data[i] << 8) + data[i + 1];
    } else {
      // Last byte (if odd length)
      sum += data[i] << 8;
    }
  }

  // Add carry twice (first addition may cause another carry)
  sum = (sum >> 16) + (sum & 0xFFFF);
  sum = (sum >> 16) + (sum & 0xFFFF);

  // One's complement
  sum = (~sum) & 0xFFFF;

  // Convert to 4-char ASCII hex string
  return sum.toString(16).padStart(4, '0');
}

/**
 * Escape special bytes for byte stuffing
 *
 * Special bytes that need escaping:
 * - 0x3E (>) → \>
 * - 0x3C (<) → \<
 * - 0x5C (\) → \\
 * - 0x00    → \0
 * - 0xFF    → \F
 *
 * @param {Buffer} data
 * @returns {Buffer}
 */
function escapeData(data) {
  const escaped = [];

  for (let i = 0; i < data.length; i++) {
    const byte = data[i];

    if (byte === SOF || byte === EOF || byte === ESC) {
      // Frame markers: >, <, \ → \> \< \\
      escaped.push(ESC);
      escaped.push(byte);
    } else if (byte === 0x00) {
      // Null byte: 0x00 → \0
      escaped.push(ESC);
      escaped.push(ESC_00);
    } else if (byte === 0xFF) {
      // 0xFF → \F
      escaped.push(ESC);
      escaped.push(ESC_FF);
    } else {
      escaped.push(byte);
    }
  }

  return Buffer.from(escaped);
}

/**
 * Unescape data (reverse of escapeData)
 *
 * NOTE: Device may escape 0x00 and 0xFF in responses, even though we don't escape them in requests
 *
 * @param {Buffer} data
 * @returns {Buffer}
 */
function unescapeData(data) {
  const unescaped = [];
  let i = 0;

  while (i < data.length) {
    if (data[i] === ESC && i + 1 < data.length) {
      const next = data[i + 1];

      // Handle special escape sequences from device
      if (next === ESC_00) {
        unescaped.push(0x00);  // \0 → 0x00
      } else if (next === ESC_FF) {
        unescaped.push(0xFF);  // \F → 0xFF
      } else {
        unescaped.push(next);  // \>, \<, \\ → >, <, \
      }
      i += 2;
    } else {
      unescaped.push(data[i]);
      i++;
    }
  }

  return Buffer.from(unescaped);
}

/**
 * Build MUP1 frame
 *
 * @param {Buffer} payload - CoAP frame
 * @param {Object} options
 * @param {number} options.type - Frame type (default: FrameType.COAP)
 * @returns {Buffer} MUP1 frame
 */
function buildFrame(payload, options = {}) {
  const type = options.type || FrameType.COAP;

  // 1. Build frame for checksum calculation (un-escaped)
  let frameForChecksum = Buffer.concat([
    Buffer.from([SOF, type]),
    payload,
    Buffer.from([EOF])
  ]);

  // Add extra EOF if payload is EVEN length
  if (payload.length % 2 === 0) {
    frameForChecksum = Buffer.concat([frameForChecksum, Buffer.from([EOF])]);
  }

  // 2. Calculate checksum
  const checksumStr = calculateChecksum(frameForChecksum);
  const checksumBuf = Buffer.from(checksumStr, 'ascii');

  // 3. Build actual frame with byte stuffing
  const parts = [];
  parts.push(Buffer.from([SOF]));  // >
  parts.push(Buffer.from([type])); // C

  // Escape payload data
  const escapedPayload = escapeData(payload);
  parts.push(escapedPayload);

  parts.push(Buffer.from([EOF]));  // <

  // Add extra EOF if original payload is EVEN length
  if (payload.length % 2 === 0) {
    parts.push(Buffer.from([EOF])); // <<
  }

  parts.push(checksumBuf);  // CHECKSUM (4 ASCII chars)

  const frame = Buffer.concat(parts);

  debugLog(`[MUP1 V2] Built frame (${frame.length} bytes):`);
  debugLog(`  SOF: 0x${SOF.toString(16)} (${String.fromCharCode(SOF)})`);
  debugLog(`  TYPE: 0x${type.toString(16)} (${String.fromCharCode(type)})`);
  debugLog(`  Payload: ${payload.length} bytes`);
  debugLog(`  EOF count: ${payload.length % 2 === 0 ? 2 : 1}`);
  debugLog(`  Checksum: ${checksumStr}`);
  debugLog(`  Full hex: ${frame.toString('hex')}`);
  debugLog(`  ASCII: ${frame.toString('ascii').replace(/[^\x20-\x7E]/g, '.')}`);

  return frame;
}

/**
 * Parse MUP1 frame
 *
 * @param {Buffer} data - Raw frame data
 * @returns {Object|null} Parsed frame or null if invalid
 */
function parseFrame(data) {
  let offset = 0;

  // Check SOF
  if (data[offset] !== SOF) {
    console.error(`[MUP1 V2] Invalid SOF: expected 0x3E, got 0x${data[offset].toString(16)}`);
    return null;
  }
  offset++;

  // Read TYPE
  const type = data[offset++];

  // Find EOF marker(s) - skip escaped EOFs (\<)
  let eofIndex = -1;
  for (let i = offset; i < data.length; i++) {
    if (data[i] === EOF) {
      // Check if this EOF is escaped (preceded by ESC)
      if (i > offset && data[i - 1] === ESC) {
        // This is an escaped EOF (\<), skip it
        continue;
      }
      // Found real EOF
      eofIndex = i;
      break;
    }
  }

  if (eofIndex === -1) {
    console.error('[MUP1 V2] No EOF marker found');
    return null;
  }

  // Extract escaped payload
  const escapedPayload = data.slice(offset, eofIndex);
  const payload = unescapeData(escapedPayload);

  // Move past EOF(s)
  offset = eofIndex + 1;

  // Check for double EOF
  if (offset < data.length && data[offset] === EOF) {
    offset++;  // Skip second EOF
  }

  // Extract checksum (4 ASCII chars)
  if (offset + 4 > data.length) {
    console.error('[MUP1 V2] Insufficient data for checksum');
    return null;
  }

  const receivedChecksum = data.slice(offset, offset + 4).toString('ascii');

  // Verify checksum
  let frameForChecksum = Buffer.concat([
    Buffer.from([SOF, type]),
    payload,
    Buffer.from([EOF])
  ]);

  if (payload.length % 2 === 0) {
    frameForChecksum = Buffer.concat([frameForChecksum, Buffer.from([EOF])]);
  }

  const calculatedChecksum = calculateChecksum(frameForChecksum);

  if (receivedChecksum !== calculatedChecksum) {
    console.error(`[MUP1 V2] Checksum mismatch: received=${receivedChecksum}, calculated=${calculatedChecksum}`);
    return null;
  }

  debugLog(`[MUP1 V2] Parsed frame successfully:`);
  debugLog(`  TYPE: 0x${type.toString(16)} (${String.fromCharCode(type)})`);
  debugLog(`  Payload: ${payload.length} bytes`);
  debugLog(`  Checksum: ${receivedChecksum} ✓`);

  return {
    type,
    payload,
    isValid: true
  };
}

/**
 * Frame buffer for handling fragmented frames
 */
class FrameBuffer {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.state = 'INIT';
  }

  addData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);

    const frames = [];

    while (true) {
      // Look for SOF
      const sofIndex = this.buffer.indexOf(SOF);
      if (sofIndex === -1) {
        this.buffer = Buffer.alloc(0);
        break;
      }

      // Remove data before SOF
      if (sofIndex > 0) {
        this.buffer = this.buffer.slice(sofIndex);
      }

      // Need at least: SOF(1) + TYPE(1) + EOF(1) + CHECKSUM(4) = 7 bytes
      if (this.buffer.length < 7) {
        break;
      }

      // Find EOF - skip escaped EOFs (\<)
      let eofIndex = -1;
      for (let i = 1; i < this.buffer.length; i++) {
        if (this.buffer[i] === EOF) {
          // Check if this EOF is escaped (preceded by ESC)
          if (i > 1 && this.buffer[i - 1] === ESC) {
            // This is an escaped EOF (\<), skip it
            continue;
          }
          // Found real EOF
          eofIndex = i;
          break;
        }
      }

      if (eofIndex === -1) {
        // No EOF yet, wait for more data
        if (this.buffer.length > 1024) {
          // Frame too big, discard
          this.buffer = this.buffer.slice(1);
        }
        break;
      }

      // Check for double EOF
      let checksumOffset = eofIndex + 1;
      if (checksumOffset < this.buffer.length && this.buffer[checksumOffset] === EOF) {
        checksumOffset++;
      }

      // Check if we have complete checksum
      if (this.buffer.length < checksumOffset + 4) {
        break;  // Wait for more data
      }

      // Try to parse
      const frameEnd = checksumOffset + 4;
      const frameData = this.buffer.slice(0, frameEnd);
      const frame = parseFrame(frameData);

      if (frame) {
        frames.push(frame);
        this.buffer = this.buffer.slice(frameEnd);
      } else {
        // Invalid frame, skip SOF
        this.buffer = this.buffer.slice(1);
      }
    }

    return frames;
  }

  clear() {
    this.buffer = Buffer.alloc(0);
  }
}

export {
  FrameType,
  SOF,
  EOF,
  ESC,
  buildFrame,
  parseFrame,
  calculateChecksum,
  escapeData,
  unescapeData,
  FrameBuffer
};
