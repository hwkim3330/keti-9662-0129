/**
 * WiFi Transparent Bridge Protocol
 *
 * This file documents the transparent bridging approach for WiFi transport.
 * With transparent bridging, MUP1 frames are sent directly over UDP without
 * any additional wrapping.
 *
 * Architecture:
 *   Host (Station) --[UDP/MUP1]--> ESP32 (AP) --[Serial/MUP1]--> LAN9692
 *
 * Protocol Flow:
 *   1. Host connects to ESP32's WiFi AP (e.g., SSID: "TSN-Debug")
 *   2. Host sends MUP1 frames as UDP datagrams to ESP32 (port 5683)
 *   3. ESP32 forwards MUP1 frames directly to serial port
 *   4. Serial responses (MUP1 frames) are forwarded back over UDP
 *
 * MUP1 Frame Format (unchanged):
 *   > TYPE [DATA...] < [<] CHECKSUM
 *
 *   - SOF: 0x3E ('>')
 *   - TYPE: 1 byte (e.g., 0x63 'c' for CoAP request)
 *   - DATA: Variable length with byte stuffing
 *   - EOF: 0x3C ('<') - doubled if data length is even
 *   - CHECKSUM: 4 ASCII hex chars
 *
 * Frame Types:
 *   0x50 'P' - ANNOUNCE (device ready)
 *   0x63 'c' - CoAP request (host → device)
 *   0x43 'C' - CoAP response (device → host)
 *   0x70 'p' - PING request (host → device)
 *   0x54 'T' - TRACE (device error)
 *
 * UDP Considerations:
 *   - Each UDP datagram contains exactly one MUP1 frame
 *   - No fragmentation at application layer (UDP handles it)
 *   - Maximum frame size limited by UDP MTU (~1472 bytes for Ethernet)
 *   - CoAP block-wise transfer handles larger payloads
 *
 * ESP32 AP Configuration (reference):
 *   - SSID: "TSN-Debug" (or configurable)
 *   - Password: (configurable or open for debugging)
 *   - IP: 192.168.4.1 (ESP32 default AP IP)
 *   - UDP Port: 5683 (CoAP default)
 *
 * Example Usage:
 *   keti-tsn checksum --transport wifi --host 192.168.4.1
 */

// Default ESP32 AP configuration
const ESP32_DEFAULT_AP_IP = '192.168.4.1';
const DEFAULT_UDP_PORT = 5683;

// Maximum UDP payload size (considering typical MTU)
const MAX_UDP_PAYLOAD = 1472;

/**
 * Get default ESP32 AP address
 * @returns {string} Default IP address
 */
function getDefaultHost() {
  return ESP32_DEFAULT_AP_IP;
}

/**
 * Get default UDP port
 * @returns {number} Default port number
 */
function getDefaultPort() {
  return DEFAULT_UDP_PORT;
}

/**
 * Check if payload size is within UDP limits
 * @param {number} size - Payload size in bytes
 * @returns {boolean} True if within limits
 */
function isWithinUDPLimits(size) {
  return size <= MAX_UDP_PAYLOAD;
}

export {
  ESP32_DEFAULT_AP_IP,
  DEFAULT_UDP_PORT,
  MAX_UDP_PAYLOAD,
  getDefaultHost,
  getDefaultPort,
  isWithinUDPLimits
};
