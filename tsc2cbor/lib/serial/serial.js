/**
 * Serial Port Communication for MUP1/CoAP
 *
 * Handles UART communication with Microchip VelocityDRIVE-SP board
 */

import { SerialPort } from 'serialport';
import { FrameBuffer, buildFrame, parseFrame, FrameType } from './mup1-v2.js';
import {
  buildiFetchRequest,
  buildiPatchRequest,
  buildPutRequest,
  buildMessage,
  buildPostRequest,
  buildGetRequest,
  parseResponse,
  OptionNumber,
  ResponseCode,
  MethodCode,
  MessageType,
  ContentFormat,
  encodeBlock2Value,
  encodeBlock1Value,
  cborDecode
} from '../coap/coap.js';
import EventEmitter from 'events';

// Debug logging helper - controlled by DEBUG environment variable
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const debugLog = (...args) => {
  if (DEBUG_ENABLED) {
    console.log(...args);
  }
};

// Block1 configuration (RFC 7959)
const DEFAULT_BLOCK_SIZE_EXPONENT = 6; // SZX=6 means 1024 bytes (2^(6+4))
const MIN_BLOCK_SIZE_EXPONENT = 4;     // SZX=4 means 256 bytes minimum

/**
 * Serial Communication Manager
 */
class SerialManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = null;
    this.frameBuffer = new FrameBuffer();
    this.isConnected = false;
    this.sequenceNumber = 0;
    this.pendingRequests = new Map(); // messageId -> {resolve, reject, timeout}
    this.requestTimeout = 30000; // 30 seconds (increased for block-wise transfers)
    this.boardReady = false;  // Track if board has completed booting
    this.announceReceived = false;  // Track if ANNOUNCE frame received
    this.verbose = options.verbose || false;  // Verbose output mode
  }

  /**
   * Conditional log - only outputs when verbose mode is enabled
   */
  log(...args) {
    if (this.verbose) {
      console.log(...args);
    }
  }

  /**
   * Set verbose mode
   */
  setVerbose(verbose) {
    this.verbose = verbose;
  }

  /**
   * List available serial ports
   * @returns {Promise<Array>} Array of port info
   */
  static async listPorts() {
    const ports = await SerialPort.list();
    return ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      pnpId: port.pnpId,
      vendorId: port.vendorId,
      productId: port.productId
    }));
  }

  /**
   * Connect to serial port
   * @param {string} portPath - Path to serial device (e.g., /dev/ttyACM0)
   * @param {Object} options - Serial port options
   * @returns {Promise<void>}
   */
  async connect(portPath, options = {}) {
    if (this.isConnected) {
      throw new Error('Already connected');
    }

    const portOptions = {
      baudRate: options.baudRate || 115200,
      dataBits: options.dataBits || 8,
      stopBits: options.stopBits || 1,
      parity: options.parity || 'none',
      autoOpen: false
    };

    this.port = new SerialPort({
      path: portPath,
      ...portOptions
    });

    // Set up event handlers
    this.port.on('data', (data) => this._handleData(data));
    this.port.on('error', (err) => this._handleError(err));
    this.port.on('close', () => this._handleClose());

    // Open port
    return new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) {
          reject(new Error(`Failed to open port: ${err.message}`));
        } else {
          this.isConnected = true;
          this.emit('connected', { path: portPath });
          // Send PING to start handshake
          this.sendPing().catch(pingErr => {
            console.error("Failed to send initial PING:", pingErr);
            this._handleError(pingErr);
          });
          resolve();
        }
      });
    });
  }

  /**
   * Send PING frame to initiate handshake
   * @returns {Promise<void>}
   */
  async sendPing() {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }

    this.log('[MUP1] Sending PING to initiate handshake...');

    // Build an empty frame with PING_REQ type
    const pingFrame = buildFrame(Buffer.alloc(0), {
      type: FrameType.PING_REQ
    });

    return new Promise((resolve, reject) => {
      this.port.write(pingFrame, (err) => {
        if (err) {
          reject(new Error(`PING write failed: ${err.message}`));
        } else {
          this.log('[MUP1] PING frame sent successfully.');
          resolve();
        }
      });
    });
  }

  /**
   * Disconnect from serial port
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.isConnected || !this.port) {
      return;
    }

    // Cancel all pending requests
    for (const [messageId, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Disconnected'));
      this.pendingRequests.delete(messageId);
    }

    return new Promise((resolve) => {
      this.port.close((err) => {
        this.isConnected = false;
        this.port = null;
        this.emit('disconnected');
        resolve();
      });
    });
  }

  /**
   * Send iFETCH request (query configuration)
   * @param {Object} query - CBOR query object (e.g., {1000: {}})
   * @param {Object} options - Request options
   * @returns {Promise<Object>} CoAP response with decoded CBOR
   */
  async sendiFetchRequest(query, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }
    if (!this.boardReady) {
      throw new Error('Board not ready. ANNOUNCE frame not received yet.');
    }

    const payloads = [];
    let lastResponse = null;
    const token = options.token || Buffer.alloc(0);

    // Initial request with query payload
    const initialMessageId = Math.floor(Math.random() * 65536);
    const coapFrame = buildiFetchRequest(query, {
      messageId: initialMessageId,
      token,
      ...options
    });

    const firstResponse = await this._sendRequest(coapFrame, initialMessageId);
    lastResponse = firstResponse;

    if (!firstResponse.isSuccess()) {
      return firstResponse;
    }

    if (firstResponse.payload) {
      payloads.push(firstResponse.payload);
    }

    // Handle block-wise transfer (Block2 continuation)
    let block2 = firstResponse.getBlock2Value();
    let more = block2 ? block2.m : false;
    let blockNum = block2 ? block2.num : 0;

    while (more) {
      blockNum++;
      const messageId = Math.floor(Math.random() * 65536);
      const block2Value = encodeBlock2Value(blockNum, false, block2.szx);

      // For FETCH continuation, only send URI_PATH and Block2 (no payload)
      const continuationFrame = buildMessage({
        type: MessageType.CON,
        code: MethodCode.FETCH,
        messageId,
        token,
        options: [
          { number: OptionNumber.URI_PATH, value: 'c' },
          { number: OptionNumber.BLOCK2, value: block2Value }
        ]
      });

      this.log(`[CoAP] Requesting block ${blockNum}`);
      const response = await this._sendRequest(continuationFrame, messageId);
      lastResponse = response;

      if (!response.isSuccess()) {
        throw new Error(`Block ${blockNum} failed with code ${response.code}`);
      }

      if (response.payload) {
        payloads.push(response.payload);
      }

      const nextBlock2 = response.getBlock2Value();
      if (nextBlock2) {
        more = nextBlock2.m;
        block2 = nextBlock2;
      } else {
        more = false;
      }
    }

    this.log(`[CoAP] iFETCH complete. Assembled ${payloads.length} block(s).`);
    const assembledPayload = Buffer.concat(payloads);

    // Return response with assembled payload
    return {
      ...lastResponse,
      payload: assembledPayload
    };
  }

  /**
   * Send iPATCH request (modify configuration) with Block1 support (RFC 7959)
   * @param {Buffer} patch - CBOR-encoded patch data (already encoded!)
   * @param {Object} options - Request options
   * @param {number} options.blockSize - Block size exponent (0-6, default 6 = 1024 bytes)
   * @returns {Promise<Object>} CoAP response
   */
  async sendiPatchRequest(patch, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }
    if (!this.boardReady) {
      throw new Error('Board not ready. ANNOUNCE frame not received yet.');
    }

    // Ensure patch is a Buffer
    const payload = Buffer.isBuffer(patch) ? patch : Buffer.from(patch);
    const totalSize = payload.length;

    // Token must be same for all blocks in same transfer (RFC 7959)
    const token = options.token || Buffer.from([
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256)
    ]);

    this.log(`[CoAP] Starting iPATCH with payload size: ${totalSize} bytes, Token: ${token.toString('hex')}`);

    // Initialize block parameters
    let szx = options.blockSize || DEFAULT_BLOCK_SIZE_EXPONENT;
    let blockSize = 1 << (szx + 4);
    let blockNum = 0;
    let offset = 0;

    // Check if block-wise transfer is needed
    if (totalSize <= blockSize) {
      // Payload fits in single block - use simple iPATCH
      this.log('[CoAP] Payload fits in single block, sending without Block1 option');
      const messageId = Math.floor(Math.random() * 65536);
      const coapFrame = buildiPatchRequest(payload, {
        messageId,
        token,
        ...options
      });
      return this._sendRequest(coapFrame, messageId);
    }

    // Block-wise transfer needed
    this.log(`[CoAP] Block-wise transfer required: ${totalSize} bytes with block size ${blockSize}`);

    let lastResponse = null;

    while (offset < totalSize) {
      const chunk = payload.slice(offset, offset + blockSize);
      const moreBlocks = (offset + chunk.length) < totalSize;
      const messageId = Math.floor(Math.random() * 65536);

      // Encode Block1 option
      const block1Value = encodeBlock1Value(blockNum, moreBlocks, szx);
      const block1Option = { number: OptionNumber.BLOCK1, value: block1Value };

      this.log(`[CoAP] Sending block ${blockNum}: offset=${offset}, size=${chunk.length}, more=${moreBlocks}, szx=${szx}`);

      // Build iPATCH request with Block1 option
      const coapOptions = [
        { number: OptionNumber.URI_PATH, value: 'c' },
        { number: OptionNumber.CONTENT_FORMAT, value: ContentFormat.YANG_INSTANCES_CBOR },
        { number: OptionNumber.ACCEPT, value: ContentFormat.YANG_DATA_CBOR_SID },
        block1Option
      ];

      const coapFrame = buildMessage({
        type: MessageType.CON,
        code: MethodCode.IPATCH,
        messageId,
        token,
        options: coapOptions,
        payload: chunk
      });

      try {
        const response = await this._sendRequest(coapFrame, messageId);
        lastResponse = response;

        this.log(`[CoAP] Block ${blockNum} response: code=${response.code} (${response.getCodeClass()}.${response.getCodeDetail()})`);

        // Check response code
        if (moreBlocks) {
          // Expect 2.31 Continue for intermediate blocks
          if (response.code !== ResponseCode.CONTINUE) {
            throw new Error(`Expected 2.31 Continue for block ${blockNum}, got ${response.code} (${response.getCodeClass()}.${response.getCodeDetail()})`);
          }
        } else {
          // Last block - expect final response (e.g., 2.04 Changed)
          if (!response.isSuccess()) {
            throw new Error(`Final block ${blockNum} failed with code ${response.code} (${response.getCodeClass()}.${response.getCodeDetail()})`);
          }
        }

        // Check for Block1 option in response (server acknowledgment and negotiation)
        const responseBlock1 = response.getBlock1Value();
        if (responseBlock1) {
          this.log(`[CoAP] Server acknowledged block ${responseBlock1.num}, szx=${responseBlock1.szx}`);

          // Verify block number matches
          if (responseBlock1.num !== blockNum) {
            throw new Error(`Block number mismatch! Sent ${blockNum}, server acknowledged ${responseBlock1.num}`);
          }

          // Handle SZX negotiation (server may request smaller blocks)
          if (responseBlock1.szx < szx) {
            this.log(`[CoAP] Server requested smaller block size: szx ${szx} -> ${responseBlock1.szx}`);
            szx = responseBlock1.szx;
            blockSize = 1 << (szx + 4);
            // Don't change offset - continue from where we left off
            // Next iteration will use new block size
          }
        }

        // Move to next block
        offset += chunk.length;
        blockNum++;

      } catch (error) {
        console.error(`[CoAP] Block-wise iPATCH failed at block ${blockNum}:`, error);
        throw error;
      }
    }

    this.log(`[CoAP] Block-wise iPATCH complete. Sent ${blockNum} block(s), total ${totalSize} bytes`);
    return lastResponse;
  }

  /**
   * Send PUT request (replace entire resource)
   * PUT semantics: complete replacement of the resource at the target URI
   * Supports Block1 for large payloads (RFC 7959)
   *
   * @param {Buffer|Object|Map} payload - Complete configuration (CBOR or raw Buffer)
   * @param {Object} options - Request options (token, blockSize, etc.)
   * @returns {Promise<Object>} CoAP response
   */
  async sendPutRequest(payload, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }
    if (!this.boardReady) {
      throw new Error('Board not ready. ANNOUNCE frame not received yet.');
    }

    // Ensure payload is a Buffer
    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const totalSize = payloadBuffer.length;

    // Token must be same for all blocks in same transfer (RFC 7959)
    const token = options.token || Buffer.from([
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256)
    ]);

    this.log(`[CoAP] Starting PUT with payload size: ${totalSize} bytes, Token: ${token.toString('hex')}`);

    // Initialize block parameters
    let szx = options.blockSize || DEFAULT_BLOCK_SIZE_EXPONENT;
    let blockSize = 1 << (szx + 4);
    let blockNum = 0;
    let offset = 0;

    // Check if block-wise transfer is needed
    if (totalSize <= blockSize) {
      // Payload fits in single block - use simple PUT without Block1
      this.log('[CoAP] Payload fits in single block, sending without Block1 option');
      const messageId = Math.floor(Math.random() * 65536);
      const coapFrame = buildPutRequest(payloadBuffer, {
        messageId,
        token,
        ...options
      });
      return this._sendRequest(coapFrame, messageId);
    }

    // Block-wise transfer needed
    this.log(`[CoAP] Block-wise transfer required: ${totalSize} bytes with block size ${blockSize}`);

    let lastResponse = null;

    while (offset < totalSize) {
      const chunk = payloadBuffer.slice(offset, offset + blockSize);
      const moreBlocks = (offset + chunk.length) < totalSize;
      const messageId = Math.floor(Math.random() * 65536);

      // Encode Block1 option
      const block1Value = encodeBlock1Value(blockNum, moreBlocks, szx);
      const block1Option = { number: OptionNumber.BLOCK1, value: block1Value };

      this.log(`[CoAP] Sending block ${blockNum}: offset=${offset}, size=${chunk.length}, more=${moreBlocks}, szx=${szx}`);

      // Build PUT request with Block1 option
      const coapOptions = [
        { number: OptionNumber.URI_PATH, value: 'c' },
        { number: OptionNumber.CONTENT_FORMAT, value: ContentFormat.YANG_INSTANCES_CBOR },
        { number: OptionNumber.ACCEPT, value: ContentFormat.YANG_DATA_CBOR_SID },
        block1Option
      ];

      const coapFrame = buildMessage({
        type: MessageType.CON,
        code: MethodCode.PUT,
        messageId,
        token,
        options: coapOptions,
        payload: chunk
      });

      try {
        const response = await this._sendRequest(coapFrame, messageId);
        lastResponse = response;

        this.log(`[CoAP] Block ${blockNum} response: code=${response.code} (${response.getCodeClass()}.${response.getCodeDetail()})`);

        // Check response code
        if (moreBlocks) {
          // Expect 2.31 Continue for intermediate blocks
          if (response.code !== ResponseCode.CONTINUE) {
            throw new Error(`Expected 2.31 Continue for block ${blockNum}, got ${response.code} (${response.getCodeClass()}.${response.getCodeDetail()})`);
          }
        } else {
          // Last block - expect final response (e.g., 2.04 Changed or 2.01 Created)
          if (!response.isSuccess()) {
            throw new Error(`Final block ${blockNum} failed with code ${response.code} (${response.getCodeClass()}.${response.getCodeDetail()})`);
          }
        }

        // Check for Block1 option in response (server acknowledgment and negotiation)
        const responseBlock1 = response.getBlock1Value();
        if (responseBlock1) {
          this.log(`[CoAP] Server acknowledged block ${responseBlock1.num}, szx=${responseBlock1.szx}`);

          // Verify block number matches
          if (responseBlock1.num !== blockNum) {
            throw new Error(`Block number mismatch! Sent ${blockNum}, server acknowledged ${responseBlock1.num}`);
          }

          // Handle SZX negotiation (server may request smaller blocks)
          if (responseBlock1.szx < szx) {
            this.log(`[CoAP] Server requested smaller block size: szx ${szx} -> ${responseBlock1.szx}`);
            szx = responseBlock1.szx;
            blockSize = 1 << (szx + 4);
            // Don't change offset - continue from where we left off
            // Next iteration will use new block size
          }
        }

        // Move to next block
        offset += chunk.length;
        blockNum++;

      } catch (error) {
        console.error(`[CoAP] Block-wise PUT failed at block ${blockNum}:`, error);
        throw error;
      }
    }

    this.log(`[CoAP] Block-wise PUT complete. Sent ${blockNum} block(s), total ${totalSize} bytes`);
    return lastResponse;
  }

  /**
   * Send POST request (RPC/action invocation)
   * @param {Object|Map} payload - CBOR payload
   * @param {Object} options - Request options
   * @returns {Promise<Object>} CoAP response
   */
  async sendPostRequest(payload, options = {}) {
    const messageId = options.messageId || Math.floor(Math.random() * 65536);
    const token = options.token || Buffer.alloc(0);

    const coapFrame = buildPostRequest(payload, {
      messageId,
      token,
      ...options
    });

    return this._sendRequest(coapFrame, messageId);
  }

  /**
   * Send GET request (retrieve entire datastore), handling block-wise transfer.
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Assembled CoAP response
   */
  async sendGetRequest(options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }
    if (!this.boardReady) {
      throw new Error('Board not ready. ANNOUNCE frame not received yet.');
    }

    const payloads = [];
    let lastResponse = null;
    // Per RFC 7959, the token MUST be the same for all requests for the same resource representation.
    const token = options.token || Buffer.from([
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256)
    ]);

    this.log(`[CoAP] Starting GET with Token: ${token.length > 0 ? token.toString('hex') : 'empty'}`);

    // --- 1. Initial Request ---
    // First, send a regular GET without a Block2 option.
    // The server will respond with a Block2 option if the payload is large.
    const initialMessageId = Math.floor(Math.random() * 65536);
    const { token: _token, messageId: _mid, ...restOptions } = options;

    const initialCoapFrame = buildGetRequest({
      ...restOptions,
      messageId: initialMessageId,
      token,
    });

    this.log('[CoAP] Sending initial GET request to discover if block-wise transfer is needed.');
    const firstResponse = await this._sendRequest(initialCoapFrame, initialMessageId);
    lastResponse = firstResponse;

    if (!firstResponse.isSuccess()) {
      throw new Error(`CoAP request failed with code ${firstResponse.code} (${firstResponse.getCodeClass()}.${firstResponse.getCodeDetail()})`);
    }

    if (firstResponse.payload) {
      payloads.push(firstResponse.payload);
    }

    // --- 2. Check if block-wise transfer is needed and loop ---
    let block2 = firstResponse.getBlock2Value();
    let more = block2 ? block2.m : false;
    let blockNum = block2 ? block2.num : 0;

    if (block2) {
      this.log(`[CoAP] Received block ${block2.num}, more=${block2.m}, size=${block2.size}`);
      if (block2.num !== 0) {
        throw new Error(`Server initiated block-wise transfer with non-zero block number: ${block2.num}`);
      }
    } else {
      this.log('[CoAP] Response without Block2 option, transfer complete.');
    }

    while (more) {
      blockNum++;

      try {
        const messageId = Math.floor(Math.random() * 65536);
        // Use the SZX value provided by the server in the first response
        const block2Value = encodeBlock2Value(blockNum, false, block2.szx);
        const block2Option = { number: OptionNumber.BLOCK2, value: block2Value };

        const coapFrame = buildGetRequest({
          ...restOptions,
          messageId,
          token,
          options: [block2Option, ...(options.options || [])],
        });

        this.log(`[CoAP] Requesting block ${blockNum}`);
        const coapResponse = await this._sendRequest(coapFrame, messageId);
        lastResponse = coapResponse;

        if (!coapResponse.isSuccess()) {
          throw new Error(`CoAP request failed for block ${blockNum} with code ${coapResponse.code} (${coapResponse.getCodeClass()}.${coapResponse.getCodeDetail()})`);
        }

        if (coapResponse.payload) {
          payloads.push(coapResponse.payload);
        }

        const nextBlock2 = coapResponse.getBlock2Value();
        if (nextBlock2) {
          this.log(`[CoAP] Received block ${nextBlock2.num}, more=${nextBlock2.m}, size=${nextBlock2.size}`);
          if (nextBlock2.num !== blockNum) {
            throw new Error(`Received block out of order. Expected ${blockNum}, got ${nextBlock2.num}`);
          }
          more = nextBlock2.m;
          block2 = nextBlock2; // Update block info for next potential request
        } else {
          // This case is unexpected in the middle of a transfer but we handle it gracefully.
          this.log('[CoAP] Response in block-wise transfer missing Block2 option. Assuming transfer is complete.');
          more = false;
        }
      } catch (error) {
        console.error(`[CoAP] Block-wise transfer failed at block ${blockNum}:`, error);
        throw error; // Re-throw to reject the main promise
      }
    }

    this.log(`[CoAP] Block-wise transfer complete. Assembling ${payloads.length} block(s).`);

    const assembledPayload = Buffer.concat(payloads);

    // Return a response object that mimics the last response but with the full, assembled payload.
    return {
      ...lastResponse,
      payload: assembledPayload,
      getPayloadAsCBOR: () => assembledPayload ? cborDecode(assembledPayload) : null,
      getBlock2Value: () => { // Overwrite helper to reflect assembled state
        const finalBlock2 = lastResponse.getBlock2Value();
        if (finalBlock2) {
          return { ...finalBlock2, m: false }; // No more blocks
        }
        return null;
      }
    };
  }

  /**
   * Send CoAP frame with MUP1 wrapper
   * @private
   * @param {Buffer} coapFrame - CoAP frame
   * @param {number} messageId - CoAP message ID for tracking
   * @returns {Promise<Object>} CoAP response
   */
  async _sendRequest(coapFrame, messageId) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }

    // Log board readiness state before sending
    debugLog(`[DEBUG] Board state: announceReceived=${this.announceReceived}, boardReady=${this.boardReady}`);

    // Wait for board to be ready
    if (!this.boardReady) {
      return Promise.reject(new Error('Board not ready. ANNOUNCE frame not received yet.'));
    }

    // Wrap CoAP frame in MUP1
    const mup1Frame = buildFrame(coapFrame, {
      type: FrameType.COAP  // Use 'C' (0x43) for CoAP
    });

    // DEBUG: Log frame being sent
    debugLog(`[DEBUG] Sending MUP1 frame (${mup1Frame.length} bytes):`);
    debugLog(`  Hex: ${mup1Frame.toString('hex')}`);
    debugLog(`  CoAP size: ${coapFrame.length} bytes`);
    debugLog(`  Message ID: ${messageId}`);

    // Create promise for response
    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        debugLog(`[DEBUG] Request timeout after ${this.requestTimeout}ms (Message ID: ${messageId})`);
        this.pendingRequests.delete(messageId);
        reject(new Error('Request timeout'));
      }, this.requestTimeout);

      // Store pending request
      this.pendingRequests.set(messageId, {
        resolve,
        reject,
        timeout
      });

      // Send frame
      this.port.write(mup1Frame, (err) => {
        if (err) {
          debugLog(`[DEBUG] Write failed: ${err.message}`);
          clearTimeout(timeout);
          this.pendingRequests.delete(messageId);
          reject(new Error(`Write failed: ${err.message}`));
        } else {
          debugLog(`[DEBUG] Frame sent to serial port`);
        }
      });
    });
  }

  /**
   * Handle incoming serial data
   * @private
   * @param {Buffer} data
   */
  _handleData(data) {
    // DEBUG: Log received data
    debugLog(`[DEBUG] Received ${data.length} bytes from serial:`);
    debugLog(`  Hex: ${data.toString('hex')}`);

    // Add to frame buffer
    const frames = this.frameBuffer.addData(data);

    debugLog(`[DEBUG] Parsed ${frames.length} complete frame(s)`);

    // Process each complete frame
    for (const frame of frames) {
      this._handleFrame(frame);
    }
  }

  /**
   * Handle parsed MUP1 frame
   * @private
   * @param {Object} frame - Parsed MUP1 frame
   */
  _handleFrame(frame) {
    // Accept both lowercase 'c' (0x63) and uppercase 'C' (0x43) for CoAP
    if (frame.type === FrameType.COAP || frame.type === FrameType.COAP_RESPONSE) {
      // Parse CoAP response
      try {
        const coapResponse = parseResponse(frame.payload);

        // Find and resolve pending request
        const pending = this.pendingRequests.get(coapResponse.messageId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(coapResponse.messageId);
          pending.resolve(coapResponse);
        }

        // Emit event for monitoring
        this.emit('response', coapResponse);
      } catch (err) {
        console.error('Failed to parse CoAP response:', err);
        this.emit('error', new Error(`Parse error: ${err.message}`));
      }
    } else if (frame.type === FrameType.ANNOUNCE) {
      this.log('[MUP1] Announce frame received - Board is ready');
      this.log(`      Payload: ${frame.payload.toString('ascii').replace(/[^\x20-\x7E]/g, '.')}`);
      this.announceReceived = true;
      this.boardReady = true; // Board is ready for requests immediately after announce
      this.emit('announce', { data: frame.payload });
    } else if (frame.type === FrameType.TRACE) {
      const traceMessage = frame.payload.toString();
      this.log('[MUP1] Trace frame received:', traceMessage);
      // TRACE frames are debug output, not errors - just emit event without failing requests
      this.emit('trace', { data: frame.payload, message: traceMessage });
    }
  }

  /**
   * Handle serial port error
   * @private
   * @param {Error} err
   */
  _handleError(err) {
    console.error('Serial port error:', err);
    this.emit('error', err);
  }

  /**
   * Handle serial port close
   * @private
   */
  _handleClose() {
    this.isConnected = false;
    this.frameBuffer.clear();

    // Cancel all pending requests
    for (const [messageId, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Port closed'));
      this.pendingRequests.delete(messageId);
    }

    this.emit('disconnected');
  }

  /**
   * Get connection status
   * @returns {boolean}
   */
  getConnectionStatus() {
    return this.isConnected;
  }

  /**
   * Get serial port info
   * @returns {Object|null}
   */
  getPortInfo() {
    if (!this.port) {
      return null;
    }
    return {
      path: this.port.path,
      baudRate: this.port.baudRate,
      isOpen: this.port.isOpen
    };
  }
}

export {
  SerialManager
};
