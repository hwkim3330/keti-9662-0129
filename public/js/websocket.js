/**
 * WebSocket Manager for real-time updates
 */
class WebSocketManager {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.reconnectInterval = 3000;
    this.reconnectTimer = null;
    this.connected = false;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/capture`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[WS] Connected');
        this.connected = true;
        this.emit('connected');
        this.clearReconnect();
      };

      this.ws.onclose = () => {
        console.log('[WS] Disconnected');
        this.connected = false;
        this.emit('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('[WS] Error:', err);
        this.emit('error', err);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.emit(msg.type, msg.data || msg);
        } catch (e) {
          console.error('[WS] Parse error:', e);
        }
      };
    } catch (e) {
      console.error('[WS] Connection error:', e);
      this.scheduleReconnect();
    }
  }

  disconnect() {
    this.clearReconnect();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Add event listener
   * @param {string} event - Event type (e.g., 'c-capture-stats', 'connected')
   * @param {function} callback - Callback function
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
  }

  /**
   * Remove event listener
   */
  off(event, callback) {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
    }
  }

  /**
   * Emit event to listeners
   */
  emit(event, data) {
    const set = this.listeners.get(event);
    if (set) {
      set.forEach(cb => {
        try {
          cb(data);
        } catch (e) {
          console.error('[WS] Listener error:', e);
        }
      });
    }
  }

  /**
   * Get connection status
   */
  isConnected() {
    return this.connected;
  }
}

// Singleton
export const ws = new WebSocketManager();
export default ws;
