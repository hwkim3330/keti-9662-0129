/**
 * WiFi Transport (UDP-based)
 *
 * UDP-based transport for communication via ESP32 WiFi proxy.
 * Uses transparent bridging - MUP1 frames are sent directly over UDP.
 *
 * Architecture:
 *   Host (PC/Station) --[WiFi/UDP]--> Proxy (ESP32/AP) --[Serial/MUP1]--> Target (LAN9692)
 *
 * The ESP32 operates in AP mode, creating an isolated debugging network.
 * CoAP naturally runs over UDP (RFC 7252), making this the ideal transport.
 */

import dgram from 'dgram';
import { Transport } from './base.js';
import { buildFrame, FrameBuffer, parseFrame, FrameType } from '../serial/mup1-v2.js';
import {
  buildiFetchRequest,
  buildiPatchRequest,
  buildPutRequest,
  buildPostRequest,
  buildGetRequest,
  buildMessage,
  parseResponse,
  OptionNumber,
  ResponseCode,
  MethodCode,
  MessageType,
  ContentFormat,
  encodeBlock1Value,
  encodeBlock2Value,
  cborDecode
} from '../coap/coap.js';

// Debug logging helper
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const debugLog = (...args) => {
  if (DEBUG_ENABLED) {
    console.log(...args);
  }
};

// Default configuration
const DEFAULT_PORT = 5683;  // CoAP default port
const DEFAULT_REQUEST_TIMEOUT = 30000;  // 30 seconds
const DEFAULT_BLOCK_SIZE_EXPONENT = 6;  // SZX=6 means 1024 bytes

class WiFiTransport extends Transport {
  constructor(options = {}) {
    super(options);
    this.socket = null;
    this.frameBuffer = new FrameBuffer();
    this.pendingRequests = new Map();  // messageId -> {resolve, reject, timeout}
    this.requestTimeout = options.requestTimeout || DEFAULT_REQUEST_TIMEOUT;
    this.host = null;
    this.port = null;
  }

  /**
   * Connect to WiFi proxy (ESP32 AP)
   * @param {Object} options - Connection options
   * @param {string} options.host - Proxy IP address (ESP32 AP address, typically 192.168.4.1)
   * @param {number} options.port - Proxy UDP port (default: 5683)
   * @returns {Promise<void>}
   */
  async connect(options = {}) {
    if (this.isConnected) {
      throw new Error('Already connected');
    }

    if (!options.host) {
      throw new Error('WiFi proxy host address is required');
    }

    this.host = options.host;
    this.port = options.port || DEFAULT_PORT;

    this.log(`Connecting to WiFi proxy at ${this.host}:${this.port} (UDP)`);

    return new Promise((resolve, reject) => {
      // Create UDP socket
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        this._handleError(err);
        if (!this.isConnected) {
          reject(err);
        }
      });

      this.socket.on('message', (msg, rinfo) => {
        debugLog(`[UDP] Received ${msg.length} bytes from ${rinfo.address}:${rinfo.port}`);
        this._handleData(msg);
      });

      this.socket.on('listening', () => {
        const address = this.socket.address();
        this.log(`UDP socket listening on ${address.address}:${address.port}`);
        this.isConnected = true;
        this.boardReady = true;  // UDP는 connectionless - 핸드셰이크 불필요
        this.emit('connected', { host: this.host, port: this.port });

        resolve();
      });

      // Bind to any available port
      this.socket.bind();
    });
  }

  /**
   * Disconnect from WiFi proxy
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.isConnected || !this.socket) {
      return;
    }

    this.log('Disconnecting from WiFi proxy');

    // Cancel all pending requests
    for (const [messageId, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Disconnected'));
      this.pendingRequests.delete(messageId);
    }

    return new Promise((resolve) => {
      this.socket.close(() => {
        this.socket = null;
        this.isConnected = false;
        this.boardReady = false;
        this.frameBuffer.clear();
        this.emit('disconnected');
        resolve();
      });
    });
  }

  /**
   * Send raw data over UDP
   * @private
   * @param {Buffer} data - Data to send
   * @returns {Promise<void>}
   */
  async _sendRaw(data) {
    if (!this.socket) {
      throw new Error('Socket not initialized');
    }

    return new Promise((resolve, reject) => {
      this.socket.send(data, this.port, this.host, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Send iFETCH request
   * @param {Object} query - CBOR query object
   * @param {Object} options - Request options
   * @returns {Promise<Object>} CoAP response
   */
  async sendiFetchRequest(query, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }
    if (!this.boardReady) {
      throw new Error('Board not ready. ANNOUNCE not received yet.');
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

    const firstResponse = await this._sendCoAPRequest(coapFrame, initialMessageId);
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
      const response = await this._sendCoAPRequest(continuationFrame, messageId);
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
   * Send iPATCH request with Block1 support
   * @param {Buffer} patch - CBOR-encoded patch data
   * @param {Object} options - Request options
   * @returns {Promise<Object>} CoAP response
   */
  async sendiPatchRequest(patch, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }
    if (!this.boardReady) {
      throw new Error('Board not ready. ANNOUNCE not received yet.');
    }

    const payload = Buffer.isBuffer(patch) ? patch : Buffer.from(patch);
    const totalSize = payload.length;

    const token = options.token || Buffer.from([
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256)
    ]);

    this.log(`[CoAP] Starting iPATCH with payload size: ${totalSize} bytes`);

    let szx = options.blockSize || DEFAULT_BLOCK_SIZE_EXPONENT;
    let blockSize = 1 << (szx + 4);
    let blockNum = 0;
    let offset = 0;

    // Single block transfer
    if (totalSize <= blockSize) {
      this.log('[CoAP] Payload fits in single block');
      const messageId = Math.floor(Math.random() * 65536);
      const coapFrame = buildiPatchRequest(payload, {
        messageId,
        token,
        ...options
      });
      return this._sendCoAPRequest(coapFrame, messageId);
    }

    // Block-wise transfer
    this.log(`[CoAP] Block-wise transfer: ${totalSize} bytes with block size ${blockSize}`);

    let lastResponse = null;

    while (offset < totalSize) {
      const chunk = payload.slice(offset, offset + blockSize);
      const moreBlocks = (offset + chunk.length) < totalSize;
      const messageId = Math.floor(Math.random() * 65536);

      const block1Value = encodeBlock1Value(blockNum, moreBlocks, szx);
      const block1Option = { number: OptionNumber.BLOCK1, value: block1Value };

      this.log(`[CoAP] Sending block ${blockNum}: offset=${offset}, size=${chunk.length}, more=${moreBlocks}`);

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
        const response = await this._sendCoAPRequest(coapFrame, messageId);
        lastResponse = response;

        if (moreBlocks && response.code !== ResponseCode.CONTINUE) {
          throw new Error(`Expected 2.31 Continue for block ${blockNum}, got ${response.code}`);
        }

        if (!moreBlocks && !response.isSuccess()) {
          throw new Error(`Final block ${blockNum} failed with code ${response.code}`);
        }

        const responseBlock1 = response.getBlock1Value();
        if (responseBlock1 && responseBlock1.szx < szx) {
          szx = responseBlock1.szx;
          blockSize = 1 << (szx + 4);
        }

        offset += chunk.length;
        blockNum++;
      } catch (error) {
        console.error(`[CoAP] Block-wise iPATCH failed at block ${blockNum}:`, error);
        throw error;
      }
    }

    this.log(`[CoAP] Block-wise iPATCH complete. Sent ${blockNum} block(s)`);
    return lastResponse;
  }

  /**
   * Send GET request with Block2 support
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Assembled CoAP response
   */
  async sendGetRequest(options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }
    if (!this.boardReady) {
      throw new Error('Board not ready. ANNOUNCE not received yet.');
    }

    const payloads = [];
    let lastResponse = null;
    const token = options.token || Buffer.from([
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256)
    ]);

    this.log(`[CoAP] Starting GET with Token: ${token.toString('hex')}`);

    // Initial request
    const initialMessageId = Math.floor(Math.random() * 65536);
    const { token: _token, messageId: _mid, ...restOptions } = options;

    const initialCoapFrame = buildGetRequest({
      ...restOptions,
      messageId: initialMessageId,
      token
    });

    const firstResponse = await this._sendCoAPRequest(initialCoapFrame, initialMessageId);
    lastResponse = firstResponse;

    if (!firstResponse.isSuccess()) {
      throw new Error(`CoAP request failed with code ${firstResponse.code}`);
    }

    if (firstResponse.payload) {
      payloads.push(firstResponse.payload);
    }

    // Handle block-wise transfer
    let block2 = firstResponse.getBlock2Value();
    let more = block2 ? block2.m : false;
    let blockNum = block2 ? block2.num : 0;

    while (more) {
      blockNum++;

      const messageId = Math.floor(Math.random() * 65536);
      const block2Value = encodeBlock2Value(blockNum, false, block2.szx);
      const block2Option = { number: OptionNumber.BLOCK2, value: block2Value };

      const coapFrame = buildGetRequest({
        ...restOptions,
        messageId,
        token,
        options: [block2Option, ...(options.options || [])]
      });

      this.log(`[CoAP] Requesting block ${blockNum}`);
      const response = await this._sendCoAPRequest(coapFrame, messageId);
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

    this.log(`[CoAP] Transfer complete. Assembling ${payloads.length} block(s).`);
    const assembledPayload = Buffer.concat(payloads);

    return {
      ...lastResponse,
      payload: assembledPayload,
      getPayloadAsCBOR: () => assembledPayload ? cborDecode(assembledPayload) : null
    };
  }

  /**
   * Send PUT request with Block1 support
   * @param {Buffer} payload - Request payload
   * @param {Object} options - Request options
   * @returns {Promise<Object>} CoAP response
   */
  async sendPutRequest(payload, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }
    if (!this.boardReady) {
      throw new Error('Board not ready. ANNOUNCE not received yet.');
    }

    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const totalSize = payloadBuffer.length;

    const token = options.token || Buffer.from([
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256)
    ]);

    this.log(`[CoAP] Starting PUT with payload size: ${totalSize} bytes`);

    let szx = options.blockSize || DEFAULT_BLOCK_SIZE_EXPONENT;
    let blockSize = 1 << (szx + 4);
    let blockNum = 0;
    let offset = 0;

    // Single block
    if (totalSize <= blockSize) {
      const messageId = Math.floor(Math.random() * 65536);
      const coapFrame = buildPutRequest(payloadBuffer, {
        messageId,
        token,
        ...options
      });
      return this._sendCoAPRequest(coapFrame, messageId);
    }

    // Block-wise transfer
    let lastResponse = null;

    while (offset < totalSize) {
      const chunk = payloadBuffer.slice(offset, offset + blockSize);
      const moreBlocks = (offset + chunk.length) < totalSize;
      const messageId = Math.floor(Math.random() * 65536);

      const block1Value = encodeBlock1Value(blockNum, moreBlocks, szx);
      const block1Option = { number: OptionNumber.BLOCK1, value: block1Value };

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

      const response = await this._sendCoAPRequest(coapFrame, messageId);
      lastResponse = response;

      if (moreBlocks && response.code !== ResponseCode.CONTINUE) {
        throw new Error(`Expected 2.31 Continue for block ${blockNum}`);
      }

      const responseBlock1 = response.getBlock1Value();
      if (responseBlock1 && responseBlock1.szx < szx) {
        szx = responseBlock1.szx;
        blockSize = 1 << (szx + 4);
      }

      offset += chunk.length;
      blockNum++;
    }

    return lastResponse;
  }

  /**
   * Send POST request
   * @param {Buffer} payload - Request payload
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

    return this._sendCoAPRequest(coapFrame, messageId);
  }

  /**
   * Send CoAP request wrapped in MUP1 frame over UDP
   * @private
   * @param {Buffer} coapFrame - CoAP frame
   * @param {number} messageId - Message ID for tracking
   * @returns {Promise<Object>} CoAP response
   */
  async _sendCoAPRequest(coapFrame, messageId) {
    if (!this.isConnected) {
      throw new Error('Not connected');
    }

    if (!this.boardReady) {
      throw new Error('Board not ready. ANNOUNCE not received yet.');
    }

    // Wrap CoAP in MUP1 frame (transparent bridge forwards this to serial)
    const mup1Frame = buildFrame(coapFrame, {
      type: FrameType.COAP
    });

    debugLog(`[DEBUG] Sending UDP packet (${mup1Frame.length} bytes)`);
    debugLog(`  CoAP frame: ${coapFrame.length} bytes`);
    debugLog(`  Message ID: ${messageId}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        debugLog(`[DEBUG] Request timeout (Message ID: ${messageId})`);
        this.pendingRequests.delete(messageId);
        reject(new Error('Request timeout'));
      }, this.requestTimeout);

      this.pendingRequests.set(messageId, {
        resolve,
        reject,
        timeout
      });

      this._sendRaw(mup1Frame).catch(err => {
        debugLog(`[DEBUG] Send failed: ${err.message}`);
        clearTimeout(timeout);
        this.pendingRequests.delete(messageId);
        reject(new Error(`Send failed: ${err.message}`));
      });
    });
  }

  /**
   * Handle incoming UDP data (MUP1 frames from ESP32)
   * @private
   * @param {Buffer} data - Received data
   */
  _handleData(data) {
    debugLog(`[DEBUG] Received ${data.length} bytes via UDP`);

    // UDP delivers complete datagrams, but we still use FrameBuffer
    // in case of any fragmentation at the MUP1 level
    const frames = this.frameBuffer.addData(data);

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
    debugLog(`[DEBUG] Handling frame type: 0x${frame.type.toString(16)}`);

    if (frame.type === FrameType.COAP || frame.type === FrameType.COAP_RESPONSE) {
      try {
        const coapResponse = parseResponse(frame.payload);

        const pending = this.pendingRequests.get(coapResponse.messageId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(coapResponse.messageId);
          pending.resolve(coapResponse);
        }

        this.emit('response', coapResponse);
      } catch (err) {
        console.error('Failed to parse CoAP response:', err);
        this.emit('error', new Error(`Parse error: ${err.message}`));
      }
    } else if (frame.type === FrameType.ANNOUNCE) {
      this.log('[MUP1] ANNOUNCE received');
      this.emit('announce', { data: frame.payload });
    } else if (frame.type === FrameType.TRACE) {
      const traceMessage = frame.payload.toString();
      this.log('[MUP1] TRACE received:', traceMessage);
      // TRACE frames are debug output, not errors - just emit event without failing requests
      this.emit('trace', { data: frame.payload, message: traceMessage });
    }
  }

  /**
   * Handle trace/error from device
   * @private
   * @param {string} errorMessage - Error message
   */
  _handleTrace(errorMessage) {
    if (this.pendingRequests.size > 0) {
      this.log(`[WiFi] Failing ${this.pendingRequests.size} pending request(s) due to device error`);

      for (const [messageId, pending] of this.pendingRequests.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Device error: ${errorMessage}`));
        this.pendingRequests.delete(messageId);
      }
    }
  }

  /**
   * Handle socket error
   * @private
   * @param {Error} err - Error object
   */
  _handleError(err) {
    console.error('WiFi transport error:', err);
    this.emit('error', err);
  }

  /**
   * Get transport type
   * @returns {string}
   */
  getType() {
    return 'wifi';
  }

  /**
   * Get transport info
   * @returns {Object}
   */
  getInfo() {
    return {
      type: this.getType(),
      protocol: 'UDP',
      isConnected: this.isConnected,
      boardReady: this.boardReady,
      host: this.host,
      port: this.port
    };
  }
}

export { WiFiTransport };
