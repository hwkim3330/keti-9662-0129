/**
 * Serial Transport
 *
 * Wraps the existing SerialManager to conform to the Transport interface.
 * This adapter pattern allows seamless integration with other transport types.
 */

import { Transport } from './base.js';
import { SerialManager } from '../serial/serial.js';

class SerialTransport extends Transport {
  constructor(options = {}) {
    super(options);
    this.serialManager = new SerialManager({ verbose: options.verbose });
    this.portPath = null;

    // Forward events from SerialManager
    this._setupEventForwarding();
  }

  /**
   * Forward events from the underlying SerialManager
   * @private
   */
  _setupEventForwarding() {
    this.serialManager.on('connected', (info) => {
      this.isConnected = true;
      this.emit('connected', info);
    });

    this.serialManager.on('disconnected', () => {
      this.isConnected = false;
      this.boardReady = false;
      this.emit('disconnected');
    });

    this.serialManager.on('announce', (data) => {
      this.boardReady = true;
      this.emit('announce', data);
    });

    this.serialManager.on('response', (response) => {
      this.emit('response', response);
    });

    this.serialManager.on('trace', (data) => {
      this.emit('trace', data);
    });

    this.serialManager.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /**
   * Connect to serial port
   * @param {Object} options - Connection options
   * @param {string} options.device - Serial device path (e.g., /dev/ttyACM0)
   * @param {number} options.baudRate - Baud rate (default: 115200)
   * @returns {Promise<void>}
   */
  async connect(options = {}) {
    if (!options.device) {
      throw new Error('Serial device path is required');
    }

    this.portPath = options.device;
    this.log(`Connecting to serial port: ${this.portPath}`);

    await this.serialManager.connect(this.portPath, {
      baudRate: options.baudRate || 115200
    });
  }

  /**
   * Disconnect from serial port
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.log('Disconnecting from serial port');
    await this.serialManager.disconnect();
    this.isConnected = false;
    this.boardReady = false;
  }

  /**
   * Wait for the board to be ready (ANNOUNCE frame received)
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForReady(timeout = 10000) {
    const startTime = Date.now();

    while (!this.serialManager.boardReady) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Board did not become ready within ${timeout}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.boardReady = true;
  }

  /**
   * Send iFETCH request
   * @param {Buffer|Object} query - Query payload
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendiFetchRequest(query, options = {}) {
    return this.serialManager.sendiFetchRequest(query, options);
  }

  /**
   * Send iPATCH request
   * @param {Buffer} patch - CBOR encoded patch data
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendiPatchRequest(patch, options = {}) {
    return this.serialManager.sendiPatchRequest(patch, options);
  }

  /**
   * Send GET request
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendGetRequest(options = {}) {
    return this.serialManager.sendGetRequest(options);
  }

  /**
   * Send PUT request
   * @param {Buffer} payload - Request payload
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendPutRequest(payload, options = {}) {
    return this.serialManager.sendPutRequest(payload, options);
  }

  /**
   * Send POST request
   * @param {Buffer} payload - Request payload
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendPostRequest(payload, options = {}) {
    return this.serialManager.sendPostRequest(payload, options);
  }

  /**
   * Set verbose mode
   * @param {boolean} verbose
   */
  setVerbose(verbose) {
    super.setVerbose(verbose);
    this.serialManager.setVerbose(verbose);
  }

  /**
   * Get transport type
   * @returns {string}
   */
  getType() {
    return 'serial';
  }

  /**
   * Get transport info
   * @returns {Object}
   */
  getInfo() {
    const portInfo = this.serialManager.getPortInfo();
    return {
      type: this.getType(),
      isConnected: this.isConnected,
      boardReady: this.boardReady,
      port: portInfo
    };
  }

  /**
   * List available serial ports
   * @returns {Promise<Array>}
   */
  static async listPorts() {
    return SerialManager.listPorts();
  }
}

export { SerialTransport };
