const WebSocket = require("ws");

function normalizeButtonSnapshot(buttons) {
  const nextState = {};

  if (Array.isArray(buttons)) {
    buttons.forEach((buttonValue, index) => {
      const pressed = typeof buttonValue === "object" && buttonValue !== null
        ? (buttonValue.pressed === true || Number(buttonValue.value) > 0.5)
        : !!buttonValue;
      if (pressed) {
        nextState[index] = true;
      }
    });
    return nextState;
  }

  if (!buttons || typeof buttons !== "object") {
    return nextState;
  }

  Object.entries(buttons).forEach(([buttonIndex, buttonValue]) => {
    const numericIndex = Number(buttonIndex);
    if (!Number.isInteger(numericIndex) || numericIndex < 0) {
      return;
    }

    const pressed = typeof buttonValue === "object" && buttonValue !== null
      ? (buttonValue.pressed === true || Number(buttonValue.value) > 0.5)
      : !!buttonValue;
    if (pressed) {
      nextState[numericIndex] = true;
    }
  });

  return nextState;
}

class ControllerShortcutManager {
  constructor(options = {}) {
    this.getServerUrl = typeof options.getServerUrl === "function"
      ? options.getServerUrl
      : (() => null);
    this.shouldConnect = typeof options.shouldConnect === "function"
      ? options.shouldConnect
      : (() => true);
    this.isInputSuppressed = typeof options.isInputSuppressed === "function"
      ? options.isInputSuppressed
      : (() => false);
    this.onAction = typeof options.onAction === "function"
      ? options.onAction
      : null;
    this.reconnectDelayMs = Number.isFinite(options.reconnectDelayMs)
      ? options.reconnectDelayMs
      : 2000;
    this.logger = options.logger || console;

    this.buttonToAction = new Map();
    this.buttonStates = new Map();
    this.socket = null;
    this.currentUrl = null;
    this.reconnectTimer = null;
    this.disposed = false;
  }

  updateBindings(bindings = {}) {
    const nextBindings = new Map();

    Object.entries(bindings).forEach(([actionKey, buttonIndex]) => {
      const numericButton = Number(buttonIndex);
      if (!Number.isInteger(numericButton) || numericButton < 0 || nextBindings.has(numericButton)) {
        return;
      }
      nextBindings.set(numericButton, actionKey);
    });

    this.buttonToAction = nextBindings;
  }

  hasBindings() {
    return this.buttonToAction.size > 0;
  }

  sync(reason = "unknown") {
    if (this.disposed) {
      return;
    }

    if (!this.hasBindings() || !this.shouldConnect()) {
      this.cancelReconnect();
      this.disconnectSocket({ clearStates: true, clearUrl: true });
      return;
    }

    const nextUrl = this.getServerUrl();
    if (!nextUrl) {
      this.scheduleReconnect(`${reason}:missing-url`);
      return;
    }

    const socketReady = this.socket && (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    );

    if (socketReady && this.currentUrl === nextUrl) {
      return;
    }

    this.disconnectSocket({ clearStates: true, clearUrl: false });
    this.connect(nextUrl, reason);
  }

  dispose() {
    this.disposed = true;
    this.cancelReconnect();
    this.disconnectSocket({ clearStates: true, clearUrl: true });
  }

  connect(url, reason = "unknown") {
    let ws = null;

    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.logger.warn(`[ControllerShortcutManager] Failed to create WebSocket (${reason}): ${error.message}`);
      this.scheduleReconnect(`${reason}:connect-failed`);
      return;
    }

    this.socket = ws;
    this.currentUrl = url;

    ws.on("open", () => {
      if (this.socket !== ws) {
        return;
      }

      try {
        ws.send(JSON.stringify({ type: "get_state" }));
      } catch (error) {
        this.logger.warn(`[ControllerShortcutManager] Failed to request initial state: ${error.message}`);
      }
    });

    ws.on("message", (payload) => {
      if (this.socket !== ws) {
        return;
      }
      this.handleMessage(payload);
    });

    ws.on("error", () => {
      // Ignore transient connection errors and rely on the reconnect loop.
    });

    ws.on("close", () => {
      if (this.socket !== ws) {
        return;
      }

      this.socket = null;
      this.clearButtonStates();
      this.scheduleReconnect(`${reason}:closed`);
    });
  }

  handleMessage(payload) {
    const rawText = Buffer.isBuffer(payload)
      ? payload.toString("utf-8")
      : String(payload || "");
    if (!rawText) {
      return;
    }

    let message = null;
    try {
      message = JSON.parse(rawText);
    } catch (error) {
      return;
    }

    switch (message.type) {
      case "gamepad_connected":
        this.syncDeviceState(message.device, message.state?.buttons || message.buttons);
        break;
      case "gamepad_state":
        this.syncDeviceState(message.device, message.buttons || message.state?.buttons);
        break;
      case "gamepad_disconnected":
        if (typeof message.device === "string" && message.device) {
          this.buttonStates.delete(message.device);
        }
        break;
      case "button":
        this.handleButtonEvent(message);
        break;
      default:
        break;
    }
  }

  syncDeviceState(device, buttons) {
    if (typeof device !== "string" || !device) {
      return;
    }
    this.buttonStates.set(device, normalizeButtonSnapshot(buttons));
  }

  handleButtonEvent(message) {
    const numericButton = Number(message.button);
    if (!Number.isInteger(numericButton) || numericButton < 0) {
      return;
    }

    const device = typeof message.device === "string" && message.device
      ? message.device
      : "default";
    const pressed = message.pressed === true;
    const deviceState = this.buttonStates.get(device) || {};
    const wasPressed = deviceState[numericButton] === true;

    deviceState[numericButton] = pressed;
    this.buttonStates.set(device, deviceState);

    if (!pressed || wasPressed || this.isInputSuppressed()) {
      return;
    }

    const actionKey = this.buttonToAction.get(numericButton);
    if (!actionKey || !this.onAction) {
      return;
    }

    this.onAction(actionKey, {
      button: numericButton,
      device,
      name: typeof message.name === "string" ? message.name : null,
    });
  }

  scheduleReconnect(reason = "unknown") {
    if (this.disposed || this.reconnectTimer || !this.hasBindings() || !this.shouldConnect()) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.sync(`reconnect:${reason}`);
    }, this.reconnectDelayMs);
  }

  cancelReconnect() {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  clearButtonStates() {
    this.buttonStates.clear();
  }

  disconnectSocket({ clearStates = false, clearUrl = false } = {}) {
    if (clearStates) {
      this.clearButtonStates();
    }

    if (clearUrl) {
      this.currentUrl = null;
    }

    if (!this.socket) {
      return;
    }

    const socketToClose = this.socket;
    this.socket = null;

    try {
      socketToClose.close();
    } catch (error) {
      // Ignore close errors during cleanup.
    }
  }
}

module.exports = ControllerShortcutManager;
