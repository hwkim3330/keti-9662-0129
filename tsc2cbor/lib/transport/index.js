/**
 * Transport Factory
 *
 * Creates transport instances based on type (serial, wifi, etc.)
 */

import { SerialTransport } from './serial-transport.js';
import { WiFiTransport } from './wifi-transport.js';

/**
 * Available transport types
 */
const TransportType = {
  SERIAL: 'serial',
  WIFI: 'wifi'
};

/**
 * Create a transport instance based on type
 * @param {string} type - Transport type ('serial' or 'wifi')
 * @param {Object} options - Transport options
 * @param {boolean} options.verbose - Enable verbose logging
 * @returns {Transport} Transport instance
 */
function createTransport(type, options = {}) {
  switch (type) {
    case TransportType.SERIAL:
      return new SerialTransport(options);

    case TransportType.WIFI:
      return new WiFiTransport(options);

    default:
      throw new Error(`Unknown transport type: ${type}. Available types: ${Object.values(TransportType).join(', ')}`);
  }
}

/**
 * Get default transport type
 * @returns {string}
 */
function getDefaultTransportType() {
  return TransportType.SERIAL;
}

export {
  createTransport,
  TransportType,
  getDefaultTransportType,
  SerialTransport,
  WiFiTransport
};
