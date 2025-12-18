const WebSocket = require('ws');

class BackendConnector {
  constructor(ipcMain, mainWindowGetter) {
    this.ws = null;
    this.url = null;
    this.reconnectInterval = null;
    this.queue = [];
    this.connected = false;
    this.ipcMain = ipcMain;
    this.mainWindowGetter = mainWindowGetter;
  }

  connect(url) {
    if (this.url === url && this.connected) return;
    this.url = url;
    
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
      this.ws = new WebSocket(url);
      
      this.ws.on('open', () => {
        console.log('BackendConnector: Connected');
        this.connected = true;
        this.flushQueue();
      });

      this.ws.on('message', (data) => {
        try {
          const dataStr = data.toString();
          console.log('BackendConnector: Message received:', dataStr);
          
          // Ignore simple acknowledgment responses from Python websocket
          if (dataStr === 'True' || dataStr === 'False') {
            return;
          }
          
          // Try to parse as JSON
          const message = JSON.parse(dataStr);
          console.log('BackendConnector: Parsed message:', message);
          
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
      });

    } catch (e) {
      console.error('BackendConnector: Connection error', e);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectInterval) return;
    this.reconnectInterval = setTimeout(() => {
      this.reconnectInterval = null;
      if (this.url) {
        this.connect(this.url);
      }
    }, 5000);
  }

  send(data) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      this.queue.push(data);
    }
  }

  flushQueue() {
    while (this.queue.length > 0 && this.connected && this.ws.readyState === WebSocket.OPEN) {
      const data = this.queue.shift();
      this.send(data);
    }
  }
}

module.exports = BackendConnector;
