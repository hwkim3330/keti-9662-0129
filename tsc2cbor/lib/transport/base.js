/**
 * Transport Base Class
 *
 * Abstract interface for transport implementations (Serial, WiFi, etc.)
 * All transport classes must implement these methods.
 */

import EventEmitter from 'events';

class Transport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.verbose = options.verbose || false;
    this.isConnected = false;
    this.boardReady = false;
  }

  /**
   * Connect to the transport endpoint
   * @param {Object} options - Connection options (varies by transport type)
   * @returns {Promise<void>}
   */
  async connect(options) {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from the transport endpoint
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Wait for the board/device to be ready
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForReady(timeout = 10000) {
    const startTime = Date.now();

    while (!this.boardReady) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Board did not become ready within ${timeout}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Send iFETCH request (CoAP GET with query)
   * @param {Buffer|Object} query - Query payload
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendiFetchRequest(query, options) {
    throw new Error('sendiFetchRequest() must be implemented by subclass');
  }

  /**
   * Send iPATCH request
   * @param {Buffer} patch - CBOR encoded patch data
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendiPatchRequest(patch, options) {
    throw new Error('sendiPatchRequest() must be implemented by subclass');
  }

  /**
   * Send GET request
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendGetRequest(options) {
    throw new Error('sendGetRequest() must be implemented by subclass');
  }

  /**
   * Send PUT request
   * @param {Buffer} payload - Request payload
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendPutRequest(payload, options) {
    throw new Error('sendPutRequest() must be implemented by subclass');
  }

  /**
   * Send POST request
   * @param {Buffer} payload - Request payload
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response object
   */
  async sendPostRequest(payload, options) {
    throw new Error('sendPostRequest() must be implemented by subclass');
  }

  /**
   * Get connection status
   * @returns {boolean}
   */
  getConnectionStatus() {
    return this.isConnected;
  }

  /**
   * Set verbose mode
   * @param {boolean} verbose
   */
  setVerbose(verbose) {
    this.verbose = verbose;
  }

  /**
   * Log message if verbose mode is enabled
   * @param {...any} args
   */
  log(...args) {
    if (this.verbose) {
      console.log('[Transport]', ...args);
    }
  }

  /**
   * Get transport type name
   * @returns {string}
   */
  getType() {
    return 'base';
  }

  /**
   * Get transport info
   * @returns {Object}
   */
  getInfo() {
    return {
      type: this.getType(),
      isConnected: this.isConnected,
      boardReady: this.boardReady
    };
  }
}

export { Transport };
