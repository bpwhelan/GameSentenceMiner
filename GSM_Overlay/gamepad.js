/**
 * GSM Overlay Gamepad Handler
 * 
 * Comprehensive gamepad support for navigating text blocks and cursor positions.
 * Enables Yomitan lookups via cursor positioning using gamepad controls.
 * 
 * This version connects to a Python WebSocket server (overlay_server.py) that
 * handles gamepad input at the OS level, allowing it to work regardless of
 * which window has focus.
 * 
 * Features:
 * - Receives gamepad input from Python middleware via WebSocket
 * - Two activation modes:
 *   1. Modifier mode: Hold a button (e.g., LB/RB) while using DPAD
 *   2. Toggle mode: Press a button to enter/exit controller navigation mode
 * - Text block navigation (Up/Down on DPAD)
 * - Cursor position navigation (Left/Right on DPAD) - AUTO-CONFIRMS lookups
 * - Thumbstick support for analog navigation
 * - Configurable button mappings
 * - Auto-confirm: Yomitan lookups trigger automatically when navigating
 */

class FUNCTIONALITY_FLAGS {
  AUTO_CONFIRM_SELECTION = false
}

class GamepadHandler {
  constructor(options = {}) {
    // Configuration
    this.config = {
      // WebSocket server URL (Python overlay_server.py)
      serverUrl: options.serverUrl || 'ws://localhost:55003',
      
      // Activation modes: 'modifier' or 'toggle'
      activationMode: options.activationMode || 'modifier',
      
      // Button mappings (Xbox layout by default)
      // Standard Gamepad button indices:
      // 0: A, 1: B, 2: X, 3: Y
      // 4: LB, 5: RB, 6: LT, 7: RT
      // 8: Back/Select, 9: Start, 10: LS, 11: RS
      // 12: DPad Up, 13: DPad Down, 14: DPad Left, 15: DPad Right
      // 16: Home/Guide
      modifierButton: options.modifierButton ?? 4, // LB by default
      toggleButton: options.toggleButton ?? 8, // Back/Select by default
      confirmButton: options.confirmButton ?? 0, // A button (optional - auto-confirm enabled)
      cancelButton: options.cancelButton ?? 1, // B button
      tokenModeToggleButton: options.tokenModeToggleButton ?? 3, // Y button to toggle token/char mode
      
      // D-Pad buttons
      dpadUp: 12,
      dpadDown: 13,
      dpadLeft: 14,
      dpadRight: 15,
      
      // Navigation settings
      repeatDelay: options.repeatDelay || 400, // Initial delay before repeat
      repeatRate: options.repeatRate || 150, // Repeat rate in ms
      thumbstickNavigationThreshold: options.thumbstickNavigationThreshold || 0.7,
      
      // Visual feedback
      showIndicator: options.showIndicator !== false,
      highlightColor: options.highlightColor || 'rgba(0, 255, 136, 0.5)',
      cursorColor: options.cursorColor || 'rgba(255, 200, 0, 0.8)',
      
      // Callbacks
      onBlockChange: options.onBlockChange || null,
      onCursorChange: options.onCursorChange || null,
      onModeChange: options.onModeChange || null,
      onButtonPress: options.onButtonPress || null,
      onConfirm: options.onConfirm || null,
      onCancel: options.onCancel || null,
      onConnectionChange: options.onConnectionChange || null,
      
      // Activation control
      controllerEnabled: options.controllerEnabled !== false, // Enable controller button activation
      keyboardEnabled: options.keyboardEnabled !== false, // Enable keyboard hotkey activation (handled by main process)
    };
    
    // WebSocket connection
    this.ws = null;
    this.wsConnected = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 2000; // ms
    
    // State
    this.gamepads = new Map(); // Connected gamepads from server
    this.isActive = false; // Whether controller navigation is active
    this.toggleModeActive = false; // For toggle activation mode
    this.currentBlockIndex = -1; // Currently selected text block
    this.currentCursorIndex = 0; // Cursor position within block (now token index)
    this.currentLineIndex = 0; // Line within the current block
    this.textBlocks = []; // Array of text block elements
    this.characters = []; // Characters in current block
    this.lines = []; // Line metadata for current block
    this.lineNavPrefersCharacters = false; // When true, treat up/down as character mode even in token mode
    
    // Token-based navigation
    this.tokens = []; // Array of tokens for current block {word, start, end, reading, headword}
    this.tokenMode = options.tokenMode === true; // Navigate by tokens (true) or characters (false)
    this.mecabAvailable = false; // Whether MeCab is available on the server
    
    // Button state tracking
    this.buttonStates = new Map(); // device -> {button: pressed}
    
    // Repeat handling
    this.repeatTimers = new Map();
    this.lastNavigationTime = 0;
    
    // Double-press tracking for mining
    this.lastConfirmTime = 0;
    this.doublePressWindow = 800; // ms - time window to detect double-press
    
    // Furigana request tracking
    this.furiganaRequestId = 0;
    this.pendingFuriganaRequests = new Map(); // requestId -> {resolve, reject, timeout}
    
    // Visual elements
    this.blockHighlight = null;
    this.cursorHighlight = null;
    this.modeIndicator = null;

    // DOM change tracking for live text updates
    this.textMutationObserver = null;
    this.pendingTextRefresh = false;
    
    // Bind methods
    this.onWebSocketMessage = this.onWebSocketMessage.bind(this);
    this.onWebSocketOpen = this.onWebSocketOpen.bind(this);
    this.onWebSocketClose = this.onWebSocketClose.bind(this);
    this.onWebSocketError = this.onWebSocketError.bind(this);
    
    // Initialize
    this.init();
  }
  
  init() {
    // Create visual elements
    this.createVisualElements();
    
    // Connect to Python gamepad server
    this.connectWebSocket();

    // Keep overlays in sync with new text even without controller input
    this.setupTextObserver();
    
    console.log('[GamepadHandler] Initialized with config:', this.config);
  }
  
  destroy() {
    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Clear repeat timers
    this.repeatTimers.forEach(timer => clearTimeout(timer));
    this.repeatTimers.clear();
    
    // Remove visual elements
    this.removeVisualElements();

    // Disconnect DOM observer
    if (this.textMutationObserver) {
      this.textMutationObserver.disconnect();
      this.textMutationObserver = null;
    }
    
    console.log('[GamepadHandler] Destroyed');
  }
  
  // ==================== WebSocket Connection ====================
  
  connectWebSocket() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    
    console.log(`[GamepadHandler] Connecting to gamepad server: ${this.config.serverUrl}`);
    
    try {
      this.ws = new WebSocket(this.config.serverUrl);
      this.ws.onopen = this.onWebSocketOpen;
      this.ws.onclose = this.onWebSocketClose;
      this.ws.onerror = this.onWebSocketError;
      this.ws.onmessage = this.onWebSocketMessage;
    } catch (e) {
      console.error('[GamepadHandler] WebSocket connection error:', e);
      this.scheduleReconnect();
    }
  }
  
  onWebSocketOpen() {
    console.log('[GamepadHandler] Connected to gamepad server');
    this.wsConnected = true;
    
    // Clear any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Request current state
    this.ws.send(JSON.stringify({ type: 'get_state' }));
    
    // Dispatch event
    window.dispatchEvent(new CustomEvent('gsm-gamepad-server-connected'));
    
    if (this.config.onConnectionChange) {
      this.config.onConnectionChange({ connected: true });
    }
  }
  
  onWebSocketClose() {
    console.log('[GamepadHandler] Disconnected from gamepad server');
    this.wsConnected = false;
    this.ws = null;
    
    // Dispatch event
    window.dispatchEvent(new CustomEvent('gsm-gamepad-server-disconnected'));
    
    if (this.config.onConnectionChange) {
      this.config.onConnectionChange({ connected: false });
    }
    
    // Schedule reconnect
    this.scheduleReconnect();
  }
  
  onWebSocketError(error) {
    console.error('[GamepadHandler] WebSocket error:', error);
  }
  
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    console.log(`[GamepadHandler] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, this.reconnectDelay);
  }
  
  onWebSocketMessage(event) {
    try {
      const data = JSON.parse(event.data);
      this.processServerMessage(data);
    } catch (e) {
      console.error('[GamepadHandler] Error parsing message:', e);
    }
  }
  
  // ==================== Message Processing ====================
  
  processServerMessage(data) {
    switch (data.type) {
      case 'gamepad_connected':
        this.onGamepadConnected(data);
        break;
        
      case 'gamepad_disconnected':
        this.onGamepadDisconnected(data);
        break;
        
      case 'gamepad_state':
        this.onGamepadState(data);
        break;
        
      case 'button':
        this.onButtonEvent(data);
        break;
        
      case 'axis':
        this.onAxisEvent(data);
        break;
        
      case 'tokens':
        this.onTokensReceived(data);
        break;
      
      case 'furigana':
        this.onFuriganaReceived(data);
        break;
        
      case 'pong':
        // Heartbeat response
        break;
    }
  }
  
  onTokensReceived(data) {
    // Handle tokenization response from server
    const { blockIndex, tokens, mecabAvailable, text } = data;
    
    this.mecabAvailable = mecabAvailable;
    
    // Only update if it's for the current block
    if (blockIndex === this.currentBlockIndex) {
      this.tokens = tokens || [];
      console.log(`[GamepadHandler] Received ${this.tokens.length} tokens for block ${blockIndex}:`, 
        this.tokens.map(t => t.word).join(' | '));
      
      // Reset cursor to first token
      if (this.tokens.length > 0 && this.tokenMode) {
        this.currentCursorIndex = 0;
        this.updateVisuals();
        this.positionCursorAtToken();
        
        // Auto-confirm selection when tokens are first received
        this.autoConfirmSelection();
      }
    }
  }
  
  onFuriganaReceived(data) {
    // Handle furigana response from server
    const { lineIndex, segments, mecabAvailable, text, requestId } = data;
    
    // Check if there's a pending request for this
    if (requestId !== undefined && this.pendingFuriganaRequests.has(requestId)) {
      const { resolve, timeout } = this.pendingFuriganaRequests.get(requestId);
      clearTimeout(timeout);
      this.pendingFuriganaRequests.delete(requestId);
      
      resolve({
        lineIndex,
        text,
        segments: segments || [],
        mecabAvailable,
      });
    }
    
    // Also dispatch an event for non-Promise based usage
    window.dispatchEvent(new CustomEvent('gsm-furigana-received', {
      detail: { lineIndex, text, segments, mecabAvailable }
    }));
  }
  
  /**
   * Request furigana readings for text from the MeCab server.
   * Returns a Promise that resolves with the furigana segments.
   * 
   * @param {string} text - The text to get furigana for
   * @param {number} lineIndex - Optional line index for tracking
   * @param {number} timeout - Timeout in ms (default 5000)
   * @returns {Promise<{lineIndex: number, text: string, segments: Array, mecabAvailable: boolean}>}
   */
  requestFurigana(text, lineIndex = 0, timeout = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.wsConnected || !this.ws) {
        reject(new Error('Not connected to server'));
        return;
      }
      
      if (!text) {
        resolve({
          lineIndex,
          text: '',
          segments: [],
          mecabAvailable: this.mecabAvailable,
        });
        return;
      }
      
      const requestId = ++this.furiganaRequestId;
      
      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (this.pendingFuriganaRequests.has(requestId)) {
          this.pendingFuriganaRequests.delete(requestId);
          reject(new Error('Furigana request timed out'));
        }
      }, timeout);
      
      // Store the pending request
      this.pendingFuriganaRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutId,
      });
      
      // Send the request
      this.ws.send(JSON.stringify({
        type: 'get_furigana',
        text: text,
        lineIndex: lineIndex,
        requestId: requestId,
      }));
    });
  }
  
  /**
   * Check if the furigana server is connected and MeCab is available.
   * @returns {boolean}
   */
  isFuriganaAvailable() {
    return this.wsConnected && this.mecabAvailable;
  }

  onGamepadConnected(data) {
    const device = data.device;
    console.log(`[GamepadHandler] Gamepad connected: ${device}`);
    
    this.gamepads.set(device, {
      name: device,
      buttons: data.state?.buttons || {},
      axes: data.state?.axes || {},
    });
    
    // Initialize button states for this device
    this.buttonStates.set(device, {});
    
    // Dispatch custom event
    window.dispatchEvent(new CustomEvent('gsm-gamepad-connected', {
      detail: { device }
    }));
  }
  
  onGamepadDisconnected(data) {
    const device = data.device;
    console.log(`[GamepadHandler] Gamepad disconnected: ${device}`);
    
    this.gamepads.delete(device);
    this.buttonStates.delete(device);
    
    // Dispatch custom event
    window.dispatchEvent(new CustomEvent('gsm-gamepad-disconnected', {
      detail: { device }
    }));
  }
  
  onGamepadState(data) {
    const device = data.device;
    if (!this.gamepads.has(device)) {
      this.gamepads.set(device, { name: device, buttons: {}, axes: {} });
      this.buttonStates.set(device, {});
    }
    
    const gamepad = this.gamepads.get(device);
    gamepad.buttons = data.buttons || {};
    gamepad.axes = data.axes || {};
  }
  
  onButtonEvent(data) {
    const { device, button, pressed, name } = data;
    
    // Update button state
    if (!this.buttonStates.has(device)) {
      this.buttonStates.set(device, {});
    }
    this.buttonStates.get(device)[button] = pressed;
    
    // Update gamepad state
    if (this.gamepads.has(device)) {
      this.gamepads.get(device).buttons[button] = pressed;
    }
    
    console.log(`[GamepadHandler] Button ${name || button}: ${pressed ? 'pressed' : 'released'}`);
    
    // Fire callback for any button press
    if (this.config.onButtonPress) {
      this.config.onButtonPress({
        button,
        name,
        device,
        pressed,
      });
    }
    
    if (pressed) {
      this.onButtonDown(button, device);
    } else {
      this.onButtonUp(button, device);
    }
  }
  
  onAxisEvent(data) {
    const { device, axis, value } = data;
    
    // Update gamepad state
    if (this.gamepads.has(device)) {
      this.gamepads.get(device).axes[axis] = value;
    }
    
    // Handle thumbstick navigation
    this.processThumbstick(device, axis, value);
    
    // Dispatch event
    window.dispatchEvent(new CustomEvent('gsm-gamepad-axis', {
      detail: { device, axis, value }
    }));
  }
  
  // ==================== Button Handling ====================
  
  onButtonDown(buttonIndex, device) {
    // Ignore controller input if controller activation is disabled
    if (!this.config.controllerEnabled) {
      return;
    }
    
    // Handle toggle button activation regardless of current mode
    // This ensures the toggle button always behaves as a sticky on/off switch,
    // even if activationMode is set to modifier.
    if (buttonIndex === this.config.toggleButton) {
      this.toggleNavigationMode();
      return;
    }
    
    // In toggle mode, allow the modifier button to also toggle navigation
    // This allows the user to use the main activation button (e.g. LB) as a toggle
    if (this.config.activationMode === 'toggle' && buttonIndex === this.config.modifierButton) {
      this.toggleNavigationMode();
      return;
    }
    
    // Handle confirm/cancel buttons
    if (this.isNavigationActive()) {
      if (buttonIndex === this.config.confirmButton) {
        this.confirmSelection();
        return;
      }
      if (buttonIndex === this.config.cancelButton) {
        this.cancelSelection();
        return;
      }
      // Handle token mode toggle (Y button by default)
      if (buttonIndex === this.config.tokenModeToggleButton) {
        this.toggleTokenMode();
        return;
      }
    }
    
    // Handle D-Pad navigation
    if (this.shouldProcessNavigation(device)) {
      this.handleDPadNavigation(buttonIndex, device);
    }
  }
  
  onButtonUp(buttonIndex, device) {
    // Clear repeat timer for this button
    const timerKey = `${device}-${buttonIndex}`;
    if (this.repeatTimers.has(timerKey)) {
      clearTimeout(this.repeatTimers.get(timerKey));
      this.repeatTimers.delete(timerKey);
    }
    
    // Handle modifier release ONLY in modifier mode
    if (this.config.activationMode === 'modifier' && buttonIndex === this.config.modifierButton) {
      if (this.isActive) {
        this.deactivateNavigation();
      }
    }
    // In toggle mode, button releases don't affect navigation state
  }
  
  isDPadButton(buttonIndex) {
    return [
      this.config.dpadUp,
      this.config.dpadDown,
      this.config.dpadLeft,
      this.config.dpadRight,
    ].includes(buttonIndex);
  }
  
  handleDPadNavigation(buttonIndex, device) {
    // Execute navigation
    let navigated = false;
    
    switch (buttonIndex) {
      case this.config.dpadUp:
        this.navigateBlockUp();
        navigated = true;
        break;
      case this.config.dpadDown:
        this.navigateBlockDown();
        navigated = true;
        break;
      case this.config.dpadLeft:
        this.navigateCursorLeft();
        navigated = true;
        break;
      case this.config.dpadRight:
        this.navigateCursorRight();
        navigated = true;
        break;
    }
    
    // Set up repeat
    if (navigated && this.isDPadButton(buttonIndex)) {
      this.scanHiddenCharacterToHideYomitan()
      const timerKey = `${device}-${buttonIndex}`;
      if (!this.repeatTimers.has(timerKey)) {
        const timer = setTimeout(() => {
          this.repeatTimers.delete(timerKey);
          this.startRepeatNavigation(buttonIndex, device);
        }, this.config.repeatDelay);
        this.repeatTimers.set(timerKey, timer);
      }
    }
  }
  
  startRepeatNavigation(buttonIndex, device) {
    const timerKey = `${device}-${buttonIndex}`;
    
    const repeat = () => {
      // Check if button is still pressed
      const buttonStates = this.buttonStates.get(device);
      if (buttonStates && buttonStates[buttonIndex] && this.shouldProcessNavigation(device)) {
        // Execute navigation
        switch (buttonIndex) {
          case this.config.dpadUp:
            this.navigateBlockUp();
            break;
          case this.config.dpadDown:
            this.navigateBlockDown();
            break;
          case this.config.dpadLeft:
            this.navigateCursorLeft();
            break;
          case this.config.dpadRight:
            this.navigateCursorRight();
            break;
        }
        
        // Schedule next repeat
        const timer = setTimeout(repeat, this.config.repeatRate);
        this.repeatTimers.set(timerKey, timer);
      } else {
        this.repeatTimers.delete(timerKey);
      }
    };
    
    repeat();
  }
  
  // ==================== Thumbstick Handling ====================
  
  processThumbstick(device, axis, value) {
    if (!this.shouldProcessNavigation(device)) return;
    
    const now = Date.now();
    if (now - this.lastNavigationTime < this.config.repeatRate) return;
    
    const threshold = this.config.thumbstickNavigationThreshold;
    
    // Left stick Y axis (up/down)
    if (axis === 'left_y') {
      if (value < -threshold) {
        this.navigateBlockUp();
        this.lastNavigationTime = now;
      } else if (value > threshold) {
        this.navigateBlockDown();
        this.lastNavigationTime = now;
      }
    }
    
    // Left stick X axis (left/right)
    if (axis === 'left_x') {
      if (value < -threshold) {
        this.navigateCursorLeft();
        this.lastNavigationTime = now;
      } else if (value > threshold) {
        this.navigateCursorRight();
        this.lastNavigationTime = now;
      }
    }
  }
  
  // ==================== Navigation Logic ====================
  
  shouldProcessNavigation(device) {
    // If toggle mode is active, always allow navigation regardless of configured mode
    if (this.toggleModeActive) {
      return true;
    }

    if (this.config.activationMode === 'modifier') {
      // Check if modifier button is held
      const buttonStates = this.buttonStates.get(device);
      const modifierPressed = buttonStates && buttonStates[this.config.modifierButton];
      if (modifierPressed && !this.isActive) {
        this.activateNavigation();
      }
      return modifierPressed;
    } else {
      // Toggle mode - navigation is active when toggle is on, regardless of button state
      return this.toggleModeActive;
    }
  }
  
  isNavigationActive() {
    if (this.config.activationMode === 'modifier') {
      return this.isActive;
    }
    // Toggle mode - only check toggle flag
    return this.toggleModeActive;
  }
  
  toggleNavigationMode() {
    this.toggleModeActive = !this.toggleModeActive;
    
    if (this.toggleModeActive) {
      this.activateNavigation();
    } else {
      this.deactivateNavigation();
    }
    
    console.log(`[GamepadHandler] Toggle mode: ${this.toggleModeActive ? 'ON' : 'OFF'}`);
  }
  
  activateNavigation() {
    if (this.isActive) return;
    
    this.isActive = true;
    this.refreshTextBlocks();
    
    // Select first block if none selected
    if (this.currentBlockIndex < 0 && this.textBlocks.length > 0) {
      this.currentBlockIndex = 0;
      this.currentCursorIndex = 0;
    }
    
    this.updateVisuals();
    this.showModeIndicator(true);
    
    // Request window focus via IPC
    if (window.ipcRenderer) {
      window.ipcRenderer.send('gamepad-request-focus');
    }
    
    // Auto-confirm selection when navigation is activated
    this.autoConfirmSelection();
    
    if (this.config.onModeChange) {
      this.config.onModeChange({ active: true });
    }
    
    // Dispatch event
    window.dispatchEvent(new CustomEvent('gsm-gamepad-navigation-active', {
      detail: { active: true }
    }));
    
    console.log('[GamepadHandler] Navigation activated');
  }
  
  deactivateNavigation() {
    if (!this.isActive) return;
    
    this.isActive = false;
    // In toggle mode, don't reset toggleModeActive here - it should only be changed by toggleNavigationMode()
    // (The toggle button itself controls this state)
    
    this.hideVisuals();
    this.showModeIndicator(false);
    
    // Clear cursor position
    this.clearCursorPosition();
    
    // Release window focus via IPC
    if (window.ipcRenderer) {
      window.ipcRenderer.send('gamepad-release-focus');
    }
    
    // Trigger scan on hidden character to hide Yomitan popup
    this.scanHiddenCharacterToHideYomitan();
    
    if (this.config.onModeChange) {
      this.config.onModeChange({ active: false });
    }
    
    // Dispatch event
    window.dispatchEvent(new CustomEvent('gsm-gamepad-navigation-active', {
      detail: { active: false }
    }));
    
    console.log('[GamepadHandler] Navigation deactivated');
  }
  
  // ==================== Text Block Management ====================

  setupTextObserver() {
    if (this.textMutationObserver || typeof MutationObserver === 'undefined') return;

    this.textMutationObserver = new MutationObserver((mutations) => {
      let relevant = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          const added = Array.from(mutation.addedNodes || []);
          const removed = Array.from(mutation.removedNodes || []);
          const nodes = added.concat(removed);
          if (nodes.some(node => this.isTextNodeRelevant(node))) {
            relevant = true;
            break;
          }
        } else if (mutation.type === 'characterData') {
          relevant = true;
          break;
        }
      }

      if (relevant) {
        this.scheduleTextRefresh();
      }
    });

    this.textMutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  isTextNodeRelevant(node) {
    if (!node) return false;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node;
      if (el.classList?.contains('text-block-container') || el.classList?.contains('text-box')) {
        return true;
      }
      if (el.querySelector?.('.text-block-container, .text-box')) {
        return true;
      }
    }
    return false;
  }

  scheduleTextRefresh() {
    if (this.pendingTextRefresh) return;
    this.pendingTextRefresh = true;

    requestAnimationFrame(() => {
      this.pendingTextRefresh = false;
      this.refreshOnTextChange();
    });
  }

  refreshOnTextChange() {
    // Only refresh visuals when navigation is active; activateNavigation() handles initial state.
    if (!this.isNavigationActive()) {
      return;
    }

    this.scanHiddenCharacterToHideYomitan();

    const previousBlockCount = this.textBlocks.length;
    const wasOnLastBlock = previousBlockCount > 0 && this.currentBlockIndex === previousBlockCount - 1;

    this.refreshTextBlocks();

    if (this.textBlocks.length === 0) {
      this.hideVisuals();
      return;
    }

    // If we were on the last block, follow newly appended text.
    if (wasOnLastBlock && this.textBlocks.length > previousBlockCount) {
      this.currentBlockIndex = this.textBlocks.length - 1;
      this.currentCursorIndex = 0;
      this.currentLineIndex = 0;
      this.refreshCharacters();
    }

    this.updateVisuals();
  }
  
  refreshTextBlocks() {
    // Find all text block containers
    this.textBlocks = Array.from(document.querySelectorAll('.text-block-container'));
    
    // If no block containers, try individual text boxes
    if (this.textBlocks.length === 0) {
      this.textBlocks = Array.from(document.querySelectorAll('.text-box'));
    }
    
    console.log(`[GamepadHandler] Found ${this.textBlocks.length} text blocks`);
    
    // Validate current block index
    if (this.currentBlockIndex >= this.textBlocks.length) {
      this.currentBlockIndex = Math.max(0, this.textBlocks.length - 1);
    }
    
    // Update characters for current block
    this.refreshCharacters();
  }
  
  refreshCharacters() {
    this.characters = [];
    this.lines = [];
    
    if (this.currentBlockIndex < 0 || this.currentBlockIndex >= this.textBlocks.length) {
      return;
    }
    
    const block = this.textBlocks[this.currentBlockIndex];
    
    // Get all text-box spans within this block (each represents a character)
    const textBoxes = block.querySelectorAll('.text-box');
    
    if (textBoxes.length > 0) {
      this.characters = Array.from(textBoxes).filter(box => {
        // Filter out newline characters and hidden boxes
        const text = box.textContent;
        return text && text !== '\n' && box.style.display !== 'none';
      });
    } else {
      // Fallback: treat the block itself as a single unit
      this.characters = [block];
    }
    
    console.log(`[GamepadHandler] Block ${this.currentBlockIndex} has ${this.characters.length} characters`);
    
    // Validate cursor index
    if (this.currentCursorIndex >= this.characters.length) {
      this.currentCursorIndex = Math.max(0, this.characters.length - 1);
    }

    // Rebuild line metadata for intra-block navigation
    this.buildLines();
    this.currentLineIndex = this.getLineIndexForCursor();
    
    console.log(`[GamepadHandler] Block ${this.currentBlockIndex}: ${this.lines.length} lines, current line: ${this.currentLineIndex}, cursor: ${this.currentCursorIndex}`);
    
    // Request tokenization for this block if in token mode
    if (this.tokenMode) {
      this.requestTokenization();
    }
  }

  buildLines() {
    this.lines = [];
    if (!this.characters.length) return;
    // Prefer explicit line metadata if present on character spans
    const linesById = new Map();
    let sawExplicit = false;
    this.characters.forEach((char, idx) => {
      if (!char || !char.isConnected) return;
      const lineAttr = char.dataset ? char.dataset.lineIndex : undefined;
      if (lineAttr !== undefined) {
        sawExplicit = true;
        const lineId = parseInt(lineAttr, 10);
        if (!linesById.has(lineId)) linesById.set(lineId, []);
        linesById.get(lineId).push(idx);
      }
    });

    if (sawExplicit) {
      const sortedIds = Array.from(linesById.keys()).sort((a, b) => a - b);
      sortedIds.forEach(lineId => {
        const indices = linesById.get(lineId).sort((a, b) => a - b);
        this.lines.push({ indices, y: null });
      });
      console.log(`[GamepadHandler] Built ${this.lines.length} lines from explicit data-line-index:`, 
        this.lines.map((line, idx) => `Line ${idx}: ${line.indices.length} chars`).join(', '));
      return;
    }

    // Fallback: geometry-based grouping
    const lineThreshold = 12; // px tolerance for grouping by Y (slightly looser)
    const positioned = [];
    this.characters.forEach((char, idx) => {
      if (!char || !char.isConnected) return;
      const rect = char.getBoundingClientRect();
      positioned.push({ idx, centerY: rect.top + rect.height / 2, centerX: rect.left + rect.width / 2 });
    });
    positioned.sort((a, b) => a.centerY === b.centerY ? a.centerX - b.centerX : a.centerY - b.centerY);

    let currentLine = { indices: [], y: null };
    positioned.forEach(p => {
      if (currentLine.y === null || Math.abs(p.centerY - currentLine.y) <= lineThreshold) {
        currentLine.indices.push(p.idx);
        currentLine.y = currentLine.y === null ? p.centerY : (currentLine.y + p.centerY) / 2;
      } else {
        this.lines.push(currentLine);
        currentLine = { indices: [p.idx], y: p.centerY };
      }
    });
    if (currentLine.indices.length) {
      this.lines.push(currentLine);
    }
  }

  getLineIndexForCursor() {
    if (!this.lines || !this.lines.length) return 0;
    const idx = this.lines.findIndex(line => line.indices.includes(this.currentCursorIndex));
    return idx >= 0 ? idx : 0;
  }

  getCursorCenterX() {
    if (!this.characters.length || this.currentCursorIndex < 0) return null;
    // Use character index for line navigation; otherwise map token to first char
    let charIndex = this.currentCursorIndex;
    if (!this.lineNavPrefersCharacters && this.tokenMode && this.tokens.length > 0 && this.currentCursorIndex < this.tokens.length) {
      const token = this.tokens[this.currentCursorIndex];
      if (token && typeof token.start === 'number') {
        charIndex = token.start;
      }
    }
    const char = this.characters[charIndex];
    if (!char || !char.isConnected) return null;
    const rect = char.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  getNearestIndexInLine(lineIdx, targetX) {
    if (!this.lines || lineIdx < 0 || lineIdx >= this.lines.length) return 0;
    const line = this.lines[lineIdx];
    if (!line.indices.length) return 0;
    if (targetX === null) return line.indices[0];
    let bestIdx = line.indices[0];
    let bestDelta = Infinity;
    line.indices.forEach(idx => {
      const char = this.characters[idx];
      if (!char || !char.isConnected) return;
      const rect = char.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const delta = Math.abs(centerX - targetX);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = idx;
      }
    });
    return bestIdx;
  }
  
  requestTokenization() {
    // Extract text from current block and request tokenization from server
    if (this.currentBlockIndex < 0 || this.currentBlockIndex >= this.textBlocks.length) {
      return;
    }
    
    if (!this.wsConnected || !this.ws) {
      console.log('[GamepadHandler] Cannot request tokenization: not connected to server');
      return;
    }
    
    // Get the text from the current block
    const block = this.textBlocks[this.currentBlockIndex];
    let text = '';
    
    // Build text from character elements
    this.characters.forEach(char => {
      text += char.textContent || '';
    });
    
    if (!text) {
      // Fallback to textContent
      text = block.textContent || '';
    }
    
    console.log(`[GamepadHandler] Requesting tokenization for block ${this.currentBlockIndex}: "${text.slice(0, 30)}..."`);
    
    // Send tokenization request to server
    this.ws.send(JSON.stringify({
      type: 'tokenize',
      blockIndex: this.currentBlockIndex,
      text: text,
    }));
  }
  
  getNavigationUnits() {
    // Return tokens if available and in token mode, otherwise characters
    if (this.tokenMode && this.tokens.length > 0) {
      return this.tokens;
    }
    return this.characters;
  }
  
  getNavigationUnitCount() {
    if (this.tokenMode && this.tokens.length > 0) {
      return this.tokens.length;
    }
    return this.characters.length;
  }
  
  // Convert character index to token index (for token mode navigation)
  charIndexToTokenIndex(charIndex) {
    if (!this.tokenMode || this.tokens.length === 0) {
      return charIndex;
    }
    // Find the token that contains this character index
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.start <= charIndex && charIndex < token.start + token.length) {
        return i;
      }
    }
    // If not found, return closest token
    return Math.min(charIndex, this.tokens.length - 1);
  }
  
  // ==================== Navigation Methods ====================
  
  navigateBlockUp() {
    this.lineNavPrefersCharacters = true;
    if (this.textBlocks.length === 0) {
      this.refreshTextBlocks();
    }
    
    if (this.textBlocks.length === 0) return;
    
    // Ensure lines are built (refreshTextBlocks may have just been called)
    if (!this.lines || this.lines.length === 0) {
      this.buildLines();
      this.currentLineIndex = this.getLineIndexForCursor();
    }
    
    // Reset double-press tracking on navigation
    this.lastConfirmTime = 0;

    // First, try moving to the previous line within the same block
    const targetX = this.getCursorCenterX();
    if (this.lines && this.lines.length > 1 && this.currentLineIndex > 0) {
      this.currentLineIndex -= 1;
      this.currentCursorIndex = this.getNearestIndexInLine(this.currentLineIndex, targetX);
      this.updateVisuals();
      this.positionCursorAtCharacter();
      this.autoConfirmSelection();
      console.log(`[GamepadHandler] Line UP: now at line ${this.currentLineIndex}`);
      return;
    }

    // If single block and multiple lines, wrap to last line instead of leaving block
    if (this.lines && this.lines.length > 1 && this.currentLineIndex === 0 && this.textBlocks.length === 1) {
      this.currentLineIndex = this.lines.length - 1;
      this.currentCursorIndex = this.getNearestIndexInLine(this.currentLineIndex, targetX);
      this.updateVisuals();
      this.positionCursorAtCharacter();
      this.autoConfirmSelection();
      console.log('[GamepadHandler] Line UP wrap within single block');
      return;
    }

    // Otherwise, move to the previous block and land on its last line
    if (this.currentBlockIndex <= 0) {
      // Wrap to last block
      this.currentBlockIndex = this.textBlocks.length - 1;
    } else {
      this.currentBlockIndex--;
    }
    
    this.currentCursorIndex = 0;
    this.refreshCharacters();
    // Move cursor to nearest char in last line of the new block
    this.currentLineIndex = this.lines.length ? this.lines.length - 1 : 0;
    this.currentCursorIndex = this.getNearestIndexInLine(this.currentLineIndex, targetX);
    this.updateVisuals();
    this.positionCursorAtCharacter();
    
    // Auto-confirm selection when switching blocks
    this.autoConfirmSelection();
    
    if (this.config.onBlockChange) {
      this.config.onBlockChange({
        blockIndex: this.currentBlockIndex,
        block: this.textBlocks[this.currentBlockIndex],
        totalBlocks: this.textBlocks.length,
      });
    }
    
    console.log(`[GamepadHandler] Block UP: now at ${this.currentBlockIndex}`);
  }
  
  navigateBlockDown() {
    this.lineNavPrefersCharacters = true;
    if (this.textBlocks.length === 0) {
      this.refreshTextBlocks();
    }
    
    if (this.textBlocks.length === 0) return;
    
    // Ensure lines are built (refreshTextBlocks may have just been called)
    if (!this.lines || this.lines.length === 0) {
      this.buildLines();
      this.currentLineIndex = this.getLineIndexForCursor();
    }
    
    // Reset double-press tracking on navigation
    this.lastConfirmTime = 0;

    const targetX = this.getCursorCenterX();
    // First, try moving to the next line within the same block
    if (this.lines && this.lines.length > 1 && this.currentLineIndex < this.lines.length - 1) {
      this.currentLineIndex += 1;
      this.currentCursorIndex = this.getNearestIndexInLine(this.currentLineIndex, targetX);
      this.updateVisuals();
      this.positionCursorAtCharacter();
      this.autoConfirmSelection();
      console.log(`[GamepadHandler] Line DOWN: now at line ${this.currentLineIndex}`);
      return;
    }

    // If single block and multiple lines, wrap to first line instead of leaving block
    if (this.lines && this.lines.length > 1 && this.currentLineIndex === this.lines.length - 1 && this.textBlocks.length === 1) {
      this.currentLineIndex = 0;
      this.currentCursorIndex = this.getNearestIndexInLine(this.currentLineIndex, targetX);
      this.updateVisuals();
      this.positionCursorAtCharacter();
      this.autoConfirmSelection();
      console.log('[GamepadHandler] Line DOWN wrap within single block');
      return;
    }

    // Otherwise, move to the next block and land on its first line
    if (this.currentBlockIndex >= this.textBlocks.length - 1) {
      // Wrap to first block
      this.currentBlockIndex = 0;
    } else {
      this.currentBlockIndex++;
    }
    
    this.currentCursorIndex = 0;
    this.refreshCharacters();
    this.currentLineIndex = 0;
    this.currentCursorIndex = this.getNearestIndexInLine(this.currentLineIndex, targetX);
    this.updateVisuals();
    this.positionCursorAtCharacter();
    
    // Auto-confirm selection when switching blocks
    this.autoConfirmSelection();
    
    if (this.config.onBlockChange) {
      this.config.onBlockChange({
        blockIndex: this.currentBlockIndex,
        block: this.textBlocks[this.currentBlockIndex],
        totalBlocks: this.textBlocks.length,
      });
    }
    
    console.log(`[GamepadHandler] Block DOWN: now at ${this.currentBlockIndex}`);
  }
  
  navigateCursorLeft() {
    this.lineNavPrefersCharacters = false;
    const unitCount = this.getNavigationUnitCount();
    if (unitCount === 0) return;
    
    // Reset double-press tracking on navigation
    this.lastConfirmTime = 0;
    
    if (this.currentCursorIndex <= 0) {
      // At start of block - go to previous block
      this.navigateBlockUp();
      // Position cursor at end of the new block
      const newUnitCount = this.getNavigationUnitCount();
      this.currentCursorIndex = Math.max(0, newUnitCount - 1);
      return; // navigateBlockUp already handles visuals and positioning
    } else {
      this.currentCursorIndex--;
    }
    this.currentLineIndex = this.getLineIndexForCursor();
    
    this.updateVisuals();
    
    // Position cursor based on mode
    if (this.tokenMode && this.tokens.length > 0) {
      this.positionCursorAtToken();
    } else {
      this.positionCursorAtCharacter();
    }
    
    // Auto-confirm selection when cursor moves
    this.autoConfirmSelection();
    
    if (this.config.onCursorChange) {
      const unit = this.getNavigationUnits()[this.currentCursorIndex];
      this.config.onCursorChange({
        cursorIndex: this.currentCursorIndex,
        character: this.tokenMode && this.tokens.length > 0 ? unit.word : unit,
        totalCharacters: unitCount,
        isToken: this.tokenMode && this.tokens.length > 0,
      });
    }
    
    const unitType = this.tokenMode && this.tokens.length > 0 ? 'token' : 'char';
    console.log(`[GamepadHandler] Cursor LEFT: now at ${unitType} ${this.currentCursorIndex}`);
  }
  
  navigateCursorRight() {
    this.lineNavPrefersCharacters = false;
    const unitCount = this.getNavigationUnitCount();
    if (unitCount === 0) return;
    
    // Reset double-press tracking on navigation
    this.lastConfirmTime = 0;
    
    if (this.currentCursorIndex >= unitCount - 1) {
      // At end of block - go to next block
      this.navigateBlockDown();
      // Position cursor at start of the new block
      this.currentCursorIndex = 0;
      return; // navigateBlockDown already handles visuals and positioning
    } else {
      this.currentCursorIndex++;
    }
    this.currentLineIndex = this.getLineIndexForCursor();
    
    this.updateVisuals();
    
    // Position cursor based on mode
    if (this.tokenMode && this.tokens.length > 0) {
      this.positionCursorAtToken();
    } else {
      this.positionCursorAtCharacter();
    }
    
    // Auto-confirm selection when cursor moves
    this.autoConfirmSelection();
    
    if (this.config.onCursorChange) {
      const unit = this.getNavigationUnits()[this.currentCursorIndex];
      this.config.onCursorChange({
        cursorIndex: this.currentCursorIndex,
        character: this.tokenMode && this.tokens.length > 0 ? unit.word : unit,
        totalCharacters: unitCount,
        isToken: this.tokenMode && this.tokens.length > 0,
      });
    }
    
    const unitType = this.tokenMode && this.tokens.length > 0 ? 'token' : 'char';
    console.log(`[GamepadHandler] Cursor RIGHT: now at ${unitType} ${this.currentCursorIndex}`);
  }
  
  // ==================== Cursor Positioning for Yomitan ====================
  
  positionCursorAtCharacter() {
    if (this.characters.length === 0 || this.currentCursorIndex < 0) {
      return;
    }
    if (!this.ensureCurrentBlockConnected()) return;
    
    const character = this.characters[this.currentCursorIndex];
    if (!character || !character.isConnected) return;
    
    const rect = character.getBoundingClientRect();
    
    // Calculate center of the character
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    // Create and dispatch a synthetic mouse event at this position
    // This allows Yomitan to detect the cursor position
    this.simulateMousePosition(centerX, centerY, character);
    
    // Also dispatch a custom event for any listeners
    window.dispatchEvent(new CustomEvent('gsm-gamepad-cursor-position', {
      detail: {
        x: centerX,
        y: centerY,
        character: character.textContent,
        element: character,
        blockIndex: this.currentBlockIndex,
        cursorIndex: this.currentCursorIndex,
      }
    }));
  }
  
  positionCursorAtToken() {
    // Position cursor at the first character of the current token
    if (this.tokens.length === 0 || this.currentCursorIndex < 0) {
      return;
    }
    if (!this.ensureCurrentBlockConnected()) return;
    
    const token = this.tokens[this.currentCursorIndex];
    if (!token) return;
    
    // Find the first character element that corresponds to this token
    const startCharIndex = token.start;
    
    if (startCharIndex >= 0 && startCharIndex < this.characters.length) {
      const character = this.characters[startCharIndex];
      if (!character || !character.isConnected) return;
      
      const rect = character.getBoundingClientRect();
      
      // Calculate center of the first character of the token
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      // Create and dispatch a synthetic mouse event at this position
      this.simulateMousePosition(centerX, centerY, character);
      
      // Also dispatch a custom event with token information
      window.dispatchEvent(new CustomEvent('gsm-gamepad-cursor-position', {
        detail: {
          x: centerX,
          y: centerY,
          character: character.textContent,
          element: character,
          blockIndex: this.currentBlockIndex,
          cursorIndex: this.currentCursorIndex,
          token: token,
          isToken: true,
        }
      }));
      
      console.log(`[GamepadHandler] Positioned cursor at token "${token.word}" (chars ${token.start}-${token.end})`);
    } else {
      // Fallback to character positioning
      this.positionCursorAtCharacter();
    }
  }
  
  simulateMousePosition(x, y, targetElement) {
    // Create a mousemove event at the target position
    // This helps Yomitan (which uses cursor position scanning) to find the text
    
    const mouseEvent = new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      view: window,
    });
    
    // Dispatch on the target element first
    if (targetElement) {
      targetElement.dispatchEvent(mouseEvent);
    }
    
    // Also dispatch on document for global listeners
    document.dispatchEvent(mouseEvent);
    
    // For Yomitan specifically, we may need to also trigger mouseenter
    if (targetElement) {
      const enterEvent = new MouseEvent('mouseenter', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        view: window,
      });
      targetElement.dispatchEvent(enterEvent);
    }
  }
  
  clearCursorPosition() {
    // Dispatch a mouseleave to clear any active Yomitan scan
    const mouseEvent = new MouseEvent('mouseleave', {
      bubbles: true,
      cancelable: true,
      view: window,
    });
    document.dispatchEvent(mouseEvent);
  }
  
  // ==================== Confirm/Cancel Actions ====================
  
  simulateKeyboardShortcut(key, modifiers = {}) {
    // Create keyboard events that will be picked up by Yomitan
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      key: key,
      code: `Key${key.toUpperCase()}`,
      altKey: modifiers.alt || false,
      ctrlKey: modifiers.ctrl || false,
      shiftKey: modifiers.shift || false,
      metaKey: modifiers.meta || false,
      view: window
    };
    
    // Fire keydown event
    const keydownEvent = new KeyboardEvent('keydown', eventOptions);
    document.dispatchEvent(keydownEvent);
    
    // Fire keyup event after a short delay
    setTimeout(() => {
      const keyupEvent = new KeyboardEvent('keyup', eventOptions);
      document.dispatchEvent(keyupEvent);
    }, 50);
    
    console.log(`[GamepadHandler] Simulated keyboard shortcut: ${modifiers.alt ? 'Alt+' : ''}${modifiers.ctrl ? 'Ctrl+' : ''}${modifiers.shift ? 'Shift+' : ''}${key}`);
  }
  
  confirmSelection() {
    if (this.characters.length === 0 || this.currentCursorIndex < 0) return;

    const { targetChar, centerX, centerY, label } = this.getTargetCharForLookup();
    if (!targetChar) return;

    // Check if this is a double-press (for Yomitan mining)
    const now = Date.now();
    const isDoublePressAndPressedOnce = (now - this.lastConfirmTime) < this.doublePressWindow && this.lastConfirmTime > 0;
    
    if (isDoublePressAndPressedOnce) {
      // Second press within time window - trigger mining via postMessage + direct hook
      console.log(`[GamepadHandler] Double-press detected - triggering mining (postMessage + hook)`);
      
      // 1) postMessage to any Yomitan iframe / extension context
      try {
        window.postMessage({ type: 'gsm-trigger-anki-add', cardFormatIndex: 0 }, '*');
      } catch (e) {
        console.log('postMessage gsm-trigger-anki-add failed', e);
      }
      
      // 2) if the Yomitan iframe is present, postMessage into its contentWindow (safe cross-origin)
      try {
        const yomitanFrame = document.querySelector('iframe');
        yomitanFrame?.contentWindow?.postMessage({ type: 'gsm-trigger-anki-add', cardFormatIndex: 0 }, '*');
      } catch (e) {
        console.log('iframe postMessage gsm-trigger-anki-add failed', e);
      }
      
      this.lastConfirmTime = 0; // Reset to prevent triple-press
      return;
    }
    
    // First press - perform normal lookup
    console.log(`Confirming selection at ${label}: ${targetChar.textContent}`);
    
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: centerX,
      clientY: centerY,
      view: window,
    });
    
    targetChar.dispatchEvent(clickEvent);
    
    if (this.config.onConfirm) {
      this.config.onConfirm({
        character: targetChar.textContent,
        element: targetChar,
        position: { x: centerX, y: centerY },
      });
    }
    
    // Update last confirm time for double-press detection
    this.lastConfirmTime = now;
    
    console.log(`[GamepadHandler] Confirmed selection at ${label}: ${targetChar.textContent}`);
  }
  
  autoConfirmSelection() {
    // Automatically trigger Yomitan lookup when cursor moves
    if (this.characters.length === 0 || this.currentCursorIndex < 0 || !FUNCTIONALITY_FLAGS.AUTO_CONFIRM_SELECTION) return;
    
    // Reset double-press tracking since auto-confirm is triggered by movement
    this.lastConfirmTime = 0;
    
    const result = this.getTargetCharForLookup();
    if (!result.targetChar) return;
    
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: result.centerX,
      clientY: result.centerY,
      view: window,
    });
    
    result.targetChar.dispatchEvent(clickEvent);
    
    console.log(`[GamepadHandler] Auto-confirmed selection at ${result.label}: ${result.targetChar.textContent}`);
  }

  getTargetCharForLookup() {
    // In token mode, click the first character of the current token
    let targetIndex = this.currentCursorIndex;
    let label = 'character index';
    if (!this.lineNavPrefersCharacters && this.tokenMode && this.tokens.length > 0 && this.currentCursorIndex < this.tokens.length) {
      const token = this.tokens[this.currentCursorIndex];
      if (token && typeof token.start === 'number') {
        targetIndex = token.start;
        label = `token '${token.word}' (char ${token.start})`;
      }
    }
    
    if (targetIndex < 0 || targetIndex >= this.characters.length) {
      return { targetChar: null };
    }
    
    const targetChar = this.characters[targetIndex];
    if (!targetChar) return { targetChar: null };
    
    const rect = targetChar.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    return { targetChar, centerX, centerY, label };
  }
  
  cancelSelection() {
    // Reset double-press tracking on cancel
    this.lastConfirmTime = 0;
    
    // Deactivate navigation mode
    if (this.config.activationMode === 'toggle') {
      this.deactivateNavigation();
    }
    
    if (this.config.onCancel) {
      this.config.onCancel();
    }
    
    console.log('[GamepadHandler] Selection cancelled');
  }
  
  // ==================== Visual Feedback ====================
  
  createVisualElements() {
    // Create block highlight
    this.blockHighlight = document.createElement('div');
    this.blockHighlight.id = 'gamepad-block-highlight';
    this.blockHighlight.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 3px solid ${this.config.highlightColor};
      border-radius: 4px;
      background: transparent;
      z-index: 10003;
      display: none;
      transition: all 0.15s ease-out;
      box-shadow: 0 0 10px ${this.config.highlightColor};
    `;
    document.body.appendChild(this.blockHighlight);
    
    // Create cursor highlight
    this.cursorHighlight = document.createElement('div');
    this.cursorHighlight.id = 'gamepad-cursor-highlight';
    this.cursorHighlight.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 2px solid ${this.config.cursorColor};
      background: ${this.config.cursorColor.replace('0.8', '0.2')};
      z-index: 10004;
      display: none;
      transition: all 0.1s ease-out;
      box-shadow: 0 0 8px ${this.config.cursorColor};
    `;
    document.body.appendChild(this.cursorHighlight);
    
    // Create mode indicator
    this.modeIndicator = document.createElement('div');
    this.modeIndicator.id = 'gamepad-mode-indicator';
    this.modeIndicator.style.cssText = `
      position: fixed;
      top: 60px;
      left: 15px;
      padding: 8px 16px;
      background: rgba(0, 0, 0, 0.85);
      color: ${this.config.highlightColor};
      border: 2px solid ${this.config.highlightColor};
      border-radius: 8px;
      font-size: 14px;
      font-weight: bold;
      z-index: 10005;
      display: none;
      pointer-events: none;
      box-shadow: 0 0 15px rgba(0, 255, 136, 0.3);
    `;
    this.modeIndicator.innerHTML = '🎮 Controller Mode';
    document.body.appendChild(this.modeIndicator);
  }
  
  removeVisualElements() {
    if (this.blockHighlight && this.blockHighlight.parentNode) {
      this.blockHighlight.remove();
    }
    if (this.cursorHighlight && this.cursorHighlight.parentNode) {
      this.cursorHighlight.remove();
    }
    if (this.modeIndicator && this.modeIndicator.parentNode) {
      this.modeIndicator.remove();
    }
  }
  
  updateVisuals() {
    if (!this.config.showIndicator || !this.isActive) {
      this.hideVisuals();
      return;
    }

    // Bail out if the cached block/characters were removed from the DOM (common after redraws)
    if (!this.ensureCurrentBlockConnected()) {
      this.hideVisuals();
      return;
    }
    
    // Update block highlight
    if (this.currentBlockIndex >= 0 && this.currentBlockIndex < this.textBlocks.length) {
      const block = this.textBlocks[this.currentBlockIndex];
      const blockRect = this.getBlockBoundingRect(block);
      
      if (blockRect) {
        this.blockHighlight.style.display = 'block';
        this.blockHighlight.style.left = `${blockRect.left - 5}px`;
        this.blockHighlight.style.top = `${blockRect.top - 5}px`;
        this.blockHighlight.style.width = `${blockRect.width + 10}px`;
        this.blockHighlight.style.height = `${blockRect.height + 10}px`;
      }
    }
    
    // Update cursor highlight - handle token mode
    const unitCount = this.lineNavPrefersCharacters ? this.characters.length : this.getNavigationUnitCount();
    if (this.currentCursorIndex >= 0 && this.currentCursorIndex < unitCount) {
      let cursorRect;
      
      const highlightToken = this.tokenMode && this.tokens.length > 0 && !this.lineNavPrefersCharacters;
      if (highlightToken) {
        // Token mode: highlight all characters in the token
        cursorRect = this.getTokenBoundingRect(this.currentCursorIndex);
      } else {
        // Character mode: highlight single character
        const character = this.characters[this.currentCursorIndex];
        if (character && character.isConnected) {
          cursorRect = character.getBoundingClientRect();
        }
      }
      
      if (cursorRect) {
        this.cursorHighlight.style.display = 'block';
        this.cursorHighlight.style.left = `${cursorRect.left - 2}px`;
        this.cursorHighlight.style.top = `${cursorRect.top - 2}px`;
        this.cursorHighlight.style.width = `${cursorRect.width + 4}px`;
        this.cursorHighlight.style.height = `${cursorRect.height + 4}px`;
      }
    }
  }
  
  getTokenBoundingRect(tokenIndex) {
    // Get bounding rect for all characters in the token
    if (tokenIndex < 0 || tokenIndex >= this.tokens.length) {
      return null;
    }
    if (!this.ensureCurrentBlockConnected()) return null;
    
    const token = this.tokens[tokenIndex];
    const startIndex = token.start;
    const endIndex = token.end;
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    for (let i = startIndex; i < endIndex && i < this.characters.length; i++) {
      const char = this.characters[i];
      if (!char || !char.isConnected) continue;
      
      const rect = char.getBoundingClientRect();
      minX = Math.min(minX, rect.left);
      minY = Math.min(minY, rect.top);
      maxX = Math.max(maxX, rect.right);
      maxY = Math.max(maxY, rect.bottom);
    }
    
    if (minX === Infinity) return null;
    
    return {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }
  
  getBlockBoundingRect(block) {
    // Get the bounding rect that encompasses all visible text boxes in the block
    if (!block || !block.isConnected) return null;
    const textBoxes = block.querySelectorAll('.text-box');
    
    if (textBoxes.length === 0) {
      return block.getBoundingClientRect();
    }
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    textBoxes.forEach(box => {
      if (box.style.display === 'none') return;
      const text = box.textContent;
      if (text === '\n') return;
      
      const rect = box.getBoundingClientRect();
      minX = Math.min(minX, rect.left);
      minY = Math.min(minY, rect.top);
      maxX = Math.max(maxX, rect.right);
      maxY = Math.max(maxY, rect.bottom);
    });
    
    if (minX === Infinity) return null;
    
    return {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }
  
  hideVisuals() {
    if (this.blockHighlight) {
      this.blockHighlight.style.display = 'none';
    }
    if (this.cursorHighlight) {
      this.cursorHighlight.style.display = 'none';
    }
  }
  
  showModeIndicator(show) {
    if (this.modeIndicator) {
      this.modeIndicator.style.display = show ? 'block' : 'none';
      if (show) {
        this.updateModeIndicatorText();
      }
    }
  }
  
  // ==================== Configuration ====================
  
  toggleTokenMode() {
    // Toggle between token and character navigation
    this.tokenMode = !this.tokenMode;
    this.lineNavPrefersCharacters = false;
    
    // Reset cursor position
    this.currentCursorIndex = 0;
    
    // If switching to token mode, request tokenization
    if (this.tokenMode) {
      this.requestTokenization();
    }
    
    // Update visuals
    this.updateVisuals();
    this.updateModeIndicatorText();
    
    // Dispatch event so the main application can save this preference
    window.dispatchEvent(new CustomEvent('gsm-gamepad-token-mode-changed', {
      detail: { tokenMode: this.tokenMode }
    }));
    
    console.log(`[GamepadHandler] Token mode: ${this.tokenMode ? 'ON' : 'OFF'}`);
  }
  
  updateModeIndicatorText() {
    if (this.modeIndicator) {
      const modeText = this.tokenMode && this.mecabAvailable ? '🎮 Token Mode' : '🎮 Character Mode';
      this.modeIndicator.innerHTML = modeText;
    }
  }
  
  updateConfig(newConfig) {
    const oldServerUrl = this.config.serverUrl;
    Object.assign(this.config, newConfig);
    console.log('[GamepadHandler] Config updated:', this.config);
    
    // Reconnect if server URL changed
    if (newConfig.serverUrl && newConfig.serverUrl !== oldServerUrl) {
      if (this.ws) {
        this.ws.close();
      }
      this.connectWebSocket();
    }
    
    // Update visual elements colors if changed
    if (this.blockHighlight) {
      this.blockHighlight.style.borderColor = this.config.highlightColor;
      this.blockHighlight.style.boxShadow = `0 0 10px ${this.config.highlightColor}`;
    }
    if (this.cursorHighlight) {
      this.cursorHighlight.style.borderColor = this.config.cursorColor;
      this.cursorHighlight.style.background = this.config.cursorColor.replace('0.8', '0.2');
      this.cursorHighlight.style.boxShadow = `0 0 8px ${this.config.cursorColor}`;
    }
    if (this.modeIndicator) {
      this.modeIndicator.style.color = this.config.highlightColor;
      this.modeIndicator.style.borderColor = this.config.highlightColor;
    }
  }
  
  // ==================== Public API ====================
  
  getConnectedGamepads() {
    return Array.from(this.gamepads.values());
  }
  
  isGamepadConnected() {
    return this.gamepads.size > 0;
  }
  
  isServerConnected() {
    return this.wsConnected;
  }
  
  getCurrentState() {
    return {
      isActive: this.isActive,
      toggleModeActive: this.toggleModeActive,
      currentBlockIndex: this.currentBlockIndex,
      currentCursorIndex: this.currentCursorIndex,
      totalBlocks: this.textBlocks.length,
      totalCharacters: this.characters.length,
      totalTokens: this.tokens.length,
      tokenMode: this.tokenMode,
      mecabAvailable: this.mecabAvailable,
      connectedGamepads: this.gamepads.size,
      serverConnected: this.wsConnected,
    };
  }
  
  // Manual navigation methods (can be called from keyboard shortcuts too)
  manualBlockUp() {
    this.activateNavigation();
    this.navigateBlockUp();
  }
  
  manualBlockDown() {
    this.activateNavigation();
    this.navigateBlockDown();
  }
  
  manualCursorLeft() {
    this.activateNavigation();
    this.navigateCursorLeft();
  }
  
  manualCursorRight() {
    this.activateNavigation();
    this.navigateCursorRight();
  }
  
  manualActivate() {
    this.activateNavigation();
  }
  
  manualDeactivate() {
    this.deactivateNavigation();
    this.scanHiddenCharacterToHideYomitan();
  }
  
  manualToggle() {
    this.toggleNavigationMode();
  }
  
  manualToggleTokenMode() {
    this.toggleTokenMode();
  }
  
  setTokenMode(enabled) {
    this.tokenMode = enabled;
    this.currentCursorIndex = 0;
    if (enabled) {
      this.requestTokenization();
    }
    this.updateVisuals();
    this.updateModeIndicatorText();
    console.log(`[GamepadHandler] Token mode set to: ${enabled}`);
  }

  /**
   * Ensure current block and character cache point to live DOM nodes.
   * Returns false when the DOM was rebuilt and caches are stale.
   */
  ensureCurrentBlockConnected() {
    if (this.currentBlockIndex < 0) return false;
    const block = this.textBlocks[this.currentBlockIndex];
    if (!block || !block.isConnected) {
      this.refreshTextBlocks();
      return false;
    }
    return true;
  }
  
  /**
   * Position cursor at the hidden character and trigger a click to hide Yomitan popup.
   * This is called when controller mode is deactivated.
   */
  scanHiddenCharacterToHideYomitan() {
    // Use the shared utility function if available
    if (typeof OverlayUtils !== 'undefined') {
      OverlayUtils.hideYomitan();
    } else if (typeof require === 'function') {
      try {
        const OverlayUtils = require('./overlay_utils');
        OverlayUtils.hideYomitan();
      } catch (e) {
        console.warn('[GamepadHandler] OverlayUtils not found via require');
        this._fallbackHideYomitan();
      }
    } else {
      this._fallbackHideYomitan();
    }
  }

  _fallbackHideYomitan() {
    try {
      // Create and dispatch a click event at the hidden character position
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: 50,
        clientY: 50,
      });
      
      window.dispatchEvent(clickEvent);
      console.log('[GamepadHandler] Triggered scan on hidden character to hide Yomitan (fallback)');
    } catch (error) {
      console.error('[GamepadHandler] Error scanning hidden character:', error);
    }
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GamepadHandler;
}

// Also expose globally for direct script access
window.GamepadHandler = GamepadHandler;
