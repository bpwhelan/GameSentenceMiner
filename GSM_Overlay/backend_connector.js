const WebSocket = require('ws');

class BackendConnector {
  constructor(ipcMain, mainWindowGetter, options = {}) {
    this.ws = null;
    this.url = null;
    this.reconnectInterval = null;
    this.queue = [];
    this.reliableOutbox = new Map();
    this.connected = false;
    this.ipcMain = ipcMain;
    this.mainWindowGetter = mainWindowGetter;
    this.WebSocket = options.WebSocket || WebSocket;
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this.destroyed = false;
  }

  connect(url) {
    if (this.destroyed) return;
    if (this.url === url && this.connected) return;
    this.url = url;
    this.connected = false;

    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (e) {
        console.error('BackendConnector: Error closing existing socket', e);
      }
    }

    try {
      console.log('BackendConnector: Connecting to', url);
      this.ws = new this.WebSocket(url);
      
      this.ws.on('open', () => {
        console.log('BackendConnector: Connected');
        this.connected = true;
        this.flushQueue();
        this.flushReliableOutbox();
      });

      this.ws.on('message', (data) => {
        try {
          const dataStr = data.toString();
          // console.log('BackendConnector: Message received:', dataStr);
          
          // Ignore simple acknowledgment responses from Python websocket
          if (dataStr === 'True' || dataStr === 'False') {
            return;
          }
          
          // Try to parse as JSON
          const message = JSON.parse(dataStr);
          console.log('BackendConnector: Parsed message:', message);

          if (message && typeof message.request_id === 'string') {
            this.acknowledgeReliable(message.request_id);
          }
          
          // Handle incoming messages from backend
          if (message.type === 'translation-result') {
            const mainWindow = this.mainWindowGetter();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('translation-received', message.data);
            }
          } else if (message.type === 'translation-error') {
            const mainWindow = this.mainWindowGetter();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('translation-error', message.error);
            }
          }
          if (this.onMessage) {
            this.onMessage(message);
          }
        } catch (e) {
          // Only log parse errors for non-trivial messages
          const dataStr = data.toString();
          if (dataStr !== 'True' && dataStr !== 'False') {
            console.error('BackendConnector: Failed to parse message', e);
          }
        }
      });

      this.ws.on('close', () => {
        console.log('BackendConnector: Disconnected');
        this.connected = false;
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error('BackendConnector: Error', err.message);
        this.connected = false;
        this.scheduleReconnect();
      });

    } catch (e) {
      console.error('BackendConnector: Connection error', e);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.destroyed || this.reconnectInterval) return;
    this.reconnectInterval = setTimeout(() => {
      this.reconnectInterval = null;
      if (this.url) {
        this.connect(this.url);
      }
    }, 5000);
  }

  send(data, delay = 0) {
    if (delay > 0) {
      setTimeout(() => this.send(data), delay);
      return;
    }
    if (this.connected && this.ws && this.ws.readyState === this.WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (error) {
        console.error('BackendConnector: Failed to send message', error);
        this.queue.push(data);
        this.connected = false;
        this.scheduleReconnect();
      }
    } else {
      this.queue.push(data);
    }
  }

  flushQueue() {
    while (this.queue.length > 0 && this.connected && this.ws.readyState === this.WebSocket.OPEN) {
      const data = this.queue.shift();
      this.send(data);
    }
  }

  sendReliable(data, { id, coalesceKey = null } = {}) {
    const reliableId = String(id || data?.request_id || '').trim();
    if (!reliableId) {
      throw new Error('BackendConnector.sendReliable requires an id');
    }

    if (coalesceKey) {
      for (const [pendingId, pending] of this.reliableOutbox.entries()) {
        if (pending.coalesceKey === coalesceKey) {
          this.reliableOutbox.delete(pendingId);
        }
      }
    }

    const pending = { data, coalesceKey };
    this.reliableOutbox.set(reliableId, pending);
    this.sendReliableEntry(pending);
    return reliableId;
  }

  sendReliableEntry(pending) {
    if (!this.connected || !this.ws || this.ws.readyState !== this.WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(pending.data));
      return true;
    } catch (error) {
      console.error('BackendConnector: Failed to send reliable message', error);
      this.connected = false;
      this.scheduleReconnect();
      return false;
    }
  }

  flushReliableOutbox() {
    for (const pending of this.reliableOutbox.values()) {
      if (!this.sendReliableEntry(pending)) {
        break;
      }
    }
  }

  acknowledgeReliable(id) {
    return this.reliableOutbox.delete(String(id || ''));
  }

  destroy() {
    this.destroyed = true;
    this.connected = false;
    this.url = null;
    this.queue = [];
    this.reliableOutbox.clear();
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (e) {
        console.error('BackendConnector: Error closing socket during destroy', e);
      }
      this.ws = null;
    }
  }
}

module.exports = BackendConnector;
