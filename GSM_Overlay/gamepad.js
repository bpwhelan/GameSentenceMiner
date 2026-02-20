/**
 * GSM Overlay Gamepad Handler
 * 
 * Comprehensive gamepad support for navigating text blocks and cursor positions.
 * Enables Yomitan lookups via cursor positioning using gamepad controls.
 * 
 * This version connects to a standalone WebSocket server (gsm_overlay_server)
 * handles gamepad input at the OS level, allowing it to work regardless of
 * which window has focus.
 * 
 * Features:
 * - Receives gamepad input from middleware via WebSocket
 * - Two activation modes:
 *   1. Modifier mode: Hold a button (e.g., LB/RB) while using DPAD
 *   2. Toggle mode: Press a button to enter/exit controller navigation mode
 * - Text block navigation (Up/Down on DPAD)
 * - Cursor position navigation (Left/Right on DPAD) - AUTO-CONFIRMS lookups
 * - Thumbstick support for analog navigation
 * - Configurable button mappings
 * - Auto-confirm: Yomitan lookups trigger automatically when navigating
 */

class GamepadHandler {
  constructor(options = {}) {
    // Configuration
    this.config = {
      // WebSocket server URL (gsm_overlay_server)
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
      forwardEnterButton: options.forwardEnterButton ?? -1, // Disabled by default; forwards Enter to target game window
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
      navigationHideDelay: Number.isFinite(options.navigationHideDelay) ? options.navigationHideDelay : 200,
      autoConfirmSelection: options.autoConfirmSelection !== false,

      // Text processing backend
      // "mecab": use gsm_overlay_server token/furigana
      // "yomitan-api": call Yomitan API /tokenize directly
      tokenizerBackend: options.tokenizerBackend || 'mecab',
      yomitanApiUrl: options.yomitanApiUrl || 'http://127.0.0.1:19633',
      yomitanScanLength: Number.isFinite(options.yomitanScanLength) ? options.yomitanScanLength : 10,
      yomitanRequestTimeout: Number.isFinite(options.yomitanRequestTimeout) ? options.yomitanRequestTimeout : 1800,
      
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
    this.config.tokenizerBackend = String(this.config.tokenizerBackend || 'mecab').toLowerCase() === 'yomitan-api'
      ? 'yomitan-api'
      : 'mecab';
    this.config.yomitanApiUrl = String(this.config.yomitanApiUrl || 'http://127.0.0.1:19633').trim().replace(/\/+$/, '') || 'http://127.0.0.1:19633';
    this.config.yomitanScanLength = Math.max(1, Math.min(100, Number(this.config.yomitanScanLength) || 10));
    this.config.forwardEnterButton = Number.isFinite(Number(this.config.forwardEnterButton))
      ? Number(this.config.forwardEnterButton)
      : -1;
    
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
    this.tokensBlockIndex = -1; // Block index these tokens belong to
    this.tokenMode = options.tokenMode === true; // Navigate by tokens (true) or characters (false)
    this.mecabAvailable = false; // Whether MeCab is available on the server
    this.yomitanApiReachable = false; // Whether Yomitan API is reachable when selected
    this.tokenCacheByBlock = new Map(); // blockIndex -> { text, tokens }
    this.pendingTokenizationByBlock = new Map(); // blockIndex -> text
    
    // Button state tracking
    this.buttonStates = new Map(); // device -> {button: pressed}
    
    // Repeat handling
    this.repeatTimers = new Map();
    this.lastNavigationTime = 0;
    
    // Confirm-to-mine gating state
    this.pendingMineCandidate = null; // Set after lookup confirm; consumed by second confirm
    this.yomitanPopupCount = 0;
    this.yomitanPopupIds = new Set();
    this.yomitanPopupVisible = false;
    this.lookupDismissToken = 0;
    this.lookupDismissTimer = null;
    this.lastLookupAnchorKey = null;
    this.navigationAwayHideToken = 0;
    this.navigationAwayHideTimer = null;

    // Thumbstick and virtual mouse state
    this.virtualMouse = {
      x: 0,
      y: 0,
      initialized: false,
      movedByAnalog: false,
      lastMoveTime: 0,
      lastUpdateTime: 0,
    };
    this.thumbstickLatch = new Map(); // axis -> latched boolean for one-shot actions
    this.lastPopupScrollTime = 0;
    this.popupActionSelectionActive = false;
    
    // Furigana request tracking
    this.furiganaRequestId = 0;
    this.pendingFuriganaRequests = new Map(); // requestId -> {resolve, reject, timeout}
    
    // Visual elements
    this.blockHighlight = null;
    this.cursorHighlight = null;
    this.cursorSegmentHighlights = [];
    this.virtualMouseCursor = null;
    this.modeIndicator = null;

    // DOM change tracking for live text updates
    this.textMutationObserver = null;
    this.pendingTextRefresh = false;
    
    // Bind methods
    this.onWebSocketMessage = this.onWebSocketMessage.bind(this);
    this.onWebSocketOpen = this.onWebSocketOpen.bind(this);
    this.onWebSocketClose = this.onWebSocketClose.bind(this);
    this.onWebSocketError = this.onWebSocketError.bind(this);
    this.onYomitanPopupShown = this.onYomitanPopupShown.bind(this);
    this.onYomitanPopupHidden = this.onYomitanPopupHidden.bind(this);
    
    // Initialize
    this.init();
  }
  
  init() {
    // Create visual elements
    this.createVisualElements();
    
    // Connect to gamepad server
    this.connectWebSocket();

    // Keep overlays in sync with new text even without controller input
    this.setupTextObserver();
    this.setupYomitanPopupTracking();
    
    console.log('[GamepadHandler] Initialized with config:', this.config);
  }

  getIpcRenderer() {
    if (typeof window !== 'undefined' && window.ipcRenderer) {
      return window.ipcRenderer;
    }
    if (typeof require === 'function') {
      try {
        const electron = require('electron');
        if (electron && electron.ipcRenderer) {
          return electron.ipcRenderer;
        }
      } catch (e) {
        // Ignore - renderer may not expose Electron APIs in all contexts.
      }
    }
    return null;
  }
  
  destroy() {
    const ipc = this.getIpcRenderer();
    if (this.isActive && ipc) {
      ipc.send('gamepad-release-focus');
    }
    this.clearPendingMineCandidate();
    this.tokenCacheByBlock.clear();
    this.pendingTokenizationByBlock.clear();

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

    if (this.lookupDismissTimer) {
      clearTimeout(this.lookupDismissTimer);
      this.lookupDismissTimer = null;
    }

    if (this.navigationAwayHideTimer) {
      clearTimeout(this.navigationAwayHideTimer);
      this.navigationAwayHideTimer = null;
    }
    
    // Remove visual elements
    this.removeVisualElements();

    // Disconnect DOM observer
    if (this.textMutationObserver) {
      this.textMutationObserver.disconnect();
      this.textMutationObserver = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('yomitan-popup-shown', this.onYomitanPopupShown);
      window.removeEventListener('yomitan-popup-hidden', this.onYomitanPopupHidden);
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
    this.pendingTokenizationByBlock.clear();
    
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

    // Proactively pre-tokenize current text so token mode is ready before activation.
    this.refreshTextBlocks();
    this.prefetchTokenizationForAllBlocks();
  }
  
  onWebSocketClose() {
    console.log('[GamepadHandler] Disconnected from gamepad server');
    this.wsConnected = false;
    this.ws = null;
    this.pendingTokenizationByBlock.clear();
    
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
    const { blockIndex, tokens, mecabAvailable, tokenSource, yomitanApiAvailable, text } = data;

    if (typeof mecabAvailable === 'boolean') {
      this.mecabAvailable = mecabAvailable;
    }
    if (typeof yomitanApiAvailable === 'boolean') {
      this.yomitanApiReachable = yomitanApiAvailable;
    } else if (tokenSource === 'yomitan-api') {
      this.yomitanApiReachable = true;
    }
    
    if (typeof blockIndex === 'number' && blockIndex >= 0) {
      const tokenList = Array.isArray(tokens) ? tokens : [];
      const resolvedText = typeof text === 'string'
        ? text
        : this.getBlockText(blockIndex);

      this.pendingTokenizationByBlock.delete(blockIndex);
      if (resolvedText) {
        this.tokenCacheByBlock.set(blockIndex, {
          text: resolvedText,
          tokens: tokenList,
        });
      }

      // Only apply directly if it's still for the active block text.
      if (blockIndex === this.currentBlockIndex) {
        const currentText = this.getBlockText(this.currentBlockIndex, true);
        const cacheEntry = this.tokenCacheByBlock.get(blockIndex);

        if (cacheEntry && cacheEntry.text === currentText) {
          this.tokens = cacheEntry.tokens || [];
          this.tokensBlockIndex = blockIndex;
          console.log(`[GamepadHandler] Received ${this.tokens.length} tokens for block ${blockIndex}:`,
            this.tokens.map(t => t.word).join(' | '));

          if (this.tokens.length > 0 && this.tokenMode && this.isNavigationActive()) {
            const syncedFromMouse = this.syncSelectionFromVirtualMouse();
            if (!syncedFromMouse) {
              const anchorCharIndex = this.getCurrentAnchorCharIndex();
              this.currentCursorIndex = this.charIndexToTokenIndex(anchorCharIndex >= 0 ? anchorCharIndex : 0);
              this.currentLineIndex = this.getLineIndexForCursor();
              this.updateVisuals();
              this.positionCursorAtToken();
              this.autoConfirmSelection();
            }
          }
        } else if (currentText) {
          // Response is stale for this index; request fresh tokenization for current text.
          this.requestTokenizationForBlock(this.currentBlockIndex, currentText);
        }
      }
    }

    this.updateModeIndicatorText();
  }
  
  onFuriganaReceived(data) {
    // Handle furigana response from server
    const { lineIndex, segments, mecabAvailable, text, requestId, yomitanApiAvailable } = data;

    if (typeof mecabAvailable === 'boolean') {
      this.mecabAvailable = mecabAvailable;
    }
    if (typeof yomitanApiAvailable === 'boolean') {
      this.yomitanApiReachable = yomitanApiAvailable;
    }
    
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

    this.updateModeIndicatorText();
  }
  
  /**
   * Request furigana readings for text.
   * Uses the selected backend (MeCab via gsm_overlay_server or Yomitan API).
   * Returns a Promise that resolves with the furigana segments.
   * 
   * @param {string} text - The text to get furigana for
   * @param {number} lineIndex - Optional line index for tracking
   * @param {number} timeout - Timeout in ms (default 5000)
   * @returns {Promise<{lineIndex: number, text: string, segments: Array, mecabAvailable: boolean}>}
   */
  requestFurigana(text, lineIndex = 0, timeout = 5000) {
    if (this.isUsingYomitanApi()) {
      return this.requestFuriganaFromYomitanApi(text, lineIndex, timeout);
    }

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
   * Check if furigana requests are available for the current backend.
   * @returns {boolean}
   */
  isFuriganaAvailable() {
    return this.canRequestFurigana();
  }

  canRequestFurigana() {
    if (this.isUsingYomitanApi()) {
      // Allow trying requests even before first successful ping; request handles fallback.
      return true;
    }
    return this.wsConnected && this.mecabAvailable;
  }

  isUsingYomitanApi() {
    return String(this.config.tokenizerBackend || 'mecab').toLowerCase() === 'yomitan-api';
  }

  getYomitanApiBaseUrl() {
    const raw = String(this.config.yomitanApiUrl || 'http://127.0.0.1:19633').trim();
    return raw.replace(/\/+$/, '') || 'http://127.0.0.1:19633';
  }

  async requestFuriganaFromYomitanApi(text, lineIndex = 0, timeout = 5000) {
    if (!text) {
      return {
        lineIndex,
        text: '',
        segments: [],
        mecabAvailable: false,
      };
    }

    try {
      const content = await this.requestYomitanTokenize(text, timeout);
      const segments = this.convertYomitanContentToFuriganaSegments(content, text);
      return {
        lineIndex,
        text,
        segments,
        mecabAvailable: false,
        yomitanApiAvailable: true,
      };
    } catch (error) {
      return {
        lineIndex,
        text,
        segments: [{
          text,
          start: 0,
          end: text.length,
          hasReading: false,
          reading: null,
        }],
        mecabAvailable: false,
        yomitanApiAvailable: false,
      };
    }
  }

  async requestYomitanTokenize(text, timeout = null) {
    if (typeof fetch !== 'function') {
      throw new Error('Fetch API unavailable in renderer context');
    }

    const requestTimeout = Number.isFinite(timeout) ? timeout : this.config.yomitanRequestTimeout;
    const safeTimeout = Math.max(200, Math.min(15000, Number(requestTimeout) || 1800));
    const endpoint = `${this.getYomitanApiBaseUrl()}/tokenize`;
    const scanLength = Math.max(1, Math.min(100, Number(this.config.yomitanScanLength) || 10));

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeoutId = null;
    if (controller) {
      timeoutId = setTimeout(() => controller.abort(), safeTimeout);
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          scanLength,
        }),
        signal: controller ? controller.signal : undefined,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      this.yomitanApiReachable = true;
      return this.extractYomitanContent(payload);
    } catch (error) {
      this.yomitanApiReachable = false;
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  extractYomitanContent(payload) {
    if (!Array.isArray(payload) || payload.length === 0) {
      return [];
    }

    const indexed = payload.filter(entry => entry && Number(entry.index) === 0 && Array.isArray(entry.content));
    const candidates = indexed.length > 0
      ? indexed
      : payload.filter(entry => entry && Array.isArray(entry.content));

    if (candidates.length === 0) {
      return [];
    }

    // Prefer the parser result with the most groups; it usually gives the best segmentation.
    let selected = candidates[0];
    for (const entry of candidates) {
      if ((entry.content || []).length > (selected.content || []).length) {
        selected = entry;
      }
    }

    return Array.isArray(selected.content) ? selected.content : [];
  }

  getYomitanGroupText(group) {
    if (!Array.isArray(group)) return '';
    return group.map(segment => String(segment && segment.text ? segment.text : '')).join('');
  }

  getYomitanGroupReading(group) {
    if (!Array.isArray(group)) return '';
    return group
      .map(segment => (segment && typeof segment.reading === 'string' ? segment.reading : ''))
      .join('')
      .trim();
  }

  extractHeadwordFromYomitanGroup(group) {
    if (!Array.isArray(group) || group.length === 0) return null;
    const headwords = group[0] && Array.isArray(group[0].headwords) ? group[0].headwords : [];
    for (const entry of headwords) {
      if (Array.isArray(entry)) {
        for (const item of entry) {
          if (item && typeof item.term === 'string' && item.term) {
            return item.term;
          }
        }
      } else if (entry && typeof entry.term === 'string' && entry.term) {
        return entry.term;
      }
    }
    return null;
  }

  findSegmentStart(text, segmentText, searchStart) {
    if (!segmentText) return searchStart;
    const idx = text.indexOf(segmentText, Math.max(0, searchStart));
    return idx >= 0 ? idx : Math.max(0, searchStart);
  }

  textContainsKanji(text) {
    if (!text) return false;
    for (let i = 0; i < text.length; i++) {
      const codePoint = text.codePointAt(i);
      if (codePoint > 0xFFFF) i++;
      if (
        (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||
        (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||
        (codePoint >= 0x20000 && codePoint <= 0x2A6DF)
      ) {
        return true;
      }
    }
    return false;
  }

  convertYomitanContentToTokens(content, text) {
    const tokens = [];
    let searchStart = 0;

    for (const group of content || []) {
      const word = this.getYomitanGroupText(group);
      if (!word) continue;

      const start = this.findSegmentStart(text, word, searchStart);
      const end = Math.min(text.length, start + word.length);
      searchStart = end;

      if (!word.trim()) continue;

      const token = {
        word,
        start,
        end,
      };

      const reading = this.getYomitanGroupReading(group);
      if (reading) {
        token.reading = reading;
      }

      const headword = this.extractHeadwordFromYomitanGroup(group);
      if (headword) {
        token.headword = headword;
      }

      tokens.push(token);
    }

    // Fallback to character tokens to keep navigation working if parsing returns no usable tokens.
    if (tokens.length === 0) {
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (!char.trim()) continue;
        tokens.push({
          word: char,
          start: i,
          end: i + 1,
        });
      }
    }

    return tokens;
  }

  convertYomitanContentToFuriganaSegments(content, text) {
    const segments = [];
    let searchStart = 0;

    for (const group of content || []) {
      const segmentText = this.getYomitanGroupText(group);
      if (!segmentText) continue;

      const start = this.findSegmentStart(text, segmentText, searchStart);
      const end = Math.min(text.length, start + segmentText.length);
      searchStart = end;

      const reading = this.getYomitanGroupReading(group);
      const hasReading = !!reading && reading !== segmentText && this.textContainsKanji(segmentText);

      segments.push({
        text: segmentText,
        start,
        end,
        hasReading,
        reading: hasReading ? reading : null,
      });
    }

    if (segments.length === 0) {
      return [{
        text,
        start: 0,
        end: text.length,
        hasReading: false,
        reading: null,
      }];
    }

    return segments;
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

    if (this.config.forwardEnterButton >= 0 && buttonIndex === this.config.forwardEnterButton) {
      this.forwardEnterToTargetWindow();
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

  forwardEnterToTargetWindow() {
    const ipc = this.getIpcRenderer();
    if (!ipc) {
      return;
    }

    ipc.send('gamepad-forward-enter');
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

    const gamepad = this.gamepads.get(device);
    const axes = gamepad && gamepad.axes ? gamepad.axes : {};
    const threshold = this.config.thumbstickNavigationThreshold;

    // LEFT stick: emulate mouse movement for word targeting.
    if (axis === 'left_x' || axis === 'left_y') {
      this.processLeftStickAsVirtualMouse(axes);
      return;
    }

    // RIGHT stick while popup is visible:
    // - up/down: scroll popup content
    // - left/right: choose action button for confirm
    if (axis === 'right_x') {
      this.processRightStickHorizontalForPopup(value, threshold);
      return;
    }

    if (axis === 'right_y') {
      this.processRightStickVerticalForPopup(value, threshold);
    }
  }

  processLeftStickAsVirtualMouse(axes) {
    const rawX = Number(axes.left_x) || 0;
    const rawY = Number(axes.left_y) || 0;
    const x = this.applyStickDeadzone(rawX);
    // Flip Y so pushing stick up moves the cursor up in screen space.
    const y = this.applyStickDeadzone(-rawY);

    if (x === 0 && y === 0) {
      this.virtualMouse.lastUpdateTime = 0;
      return;
    }

    if (!this.virtualMouse.initialized) {
      this.initializeVirtualMousePosition();
    }

    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const dtMs = this.virtualMouse.lastUpdateTime > 0
      ? Math.max(8, Math.min(40, now - this.virtualMouse.lastUpdateTime))
      : 16;
    this.virtualMouse.lastUpdateTime = now;

    const speedPxPerSecond = 900;
    const dx = x * speedPxPerSecond * (dtMs / 1000);
    const dy = y * speedPxPerSecond * (dtMs / 1000);

    this.virtualMouse.movedByAnalog = true;
    this.setVirtualMousePosition(this.virtualMouse.x + dx, this.virtualMouse.y + dy, true);
    this.virtualMouse.lastMoveTime = Date.now();
  }

  applyStickDeadzone(value, deadzone = 0.2) {
    const magnitude = Math.abs(Number(value) || 0);
    if (magnitude <= deadzone) return 0;
    const normalized = (magnitude - deadzone) / (1 - deadzone);
    return Math.sign(value) * normalized;
  }

  processRightStickVerticalForPopup(value, threshold) {
    if (!this.yomitanPopupVisible) return;

    const activeThreshold = Math.max(0.45, threshold * 0.75);
    if (Math.abs(value) < activeThreshold) return;

    const now = Date.now();
    if (now - this.lastPopupScrollTime < this.config.repeatRate) return;

    // Right-stick Y is positive when pushed down on most controllers.
    const direction = value > 0 ? -1 : 1;
    this.sendYomitanControlMessage('scroll', {
      direction,
      step: 110,
    });
    this.lastPopupScrollTime = now;
  }

  processRightStickHorizontalForPopup(value, threshold) {
    if (!this.yomitanPopupVisible) {
      this.setThumbstickLatch('right_x', false);
      return;
    }

    const activeThreshold = Math.max(0.45, threshold * 0.75);
    const releaseThreshold = activeThreshold * 0.55;
    if (Math.abs(value) <= releaseThreshold) {
      this.setThumbstickLatch('right_x', false);
      return;
    }

    if (Math.abs(value) < activeThreshold || this.getThumbstickLatch('right_x')) return;

    if (!this.popupActionSelectionActive) {
      this.resetYomitanPopupActionSelection();
    }

    const direction = value > 0 ? 1 : -1;
    this.popupActionSelectionActive = true;
    this.sendYomitanControlMessage('select-action', { direction });
    this.setThumbstickLatch('right_x', true);
  }

  getThumbstickLatch(axis) {
    return this.thumbstickLatch.get(axis) === true;
  }

  setThumbstickLatch(axis, value) {
    this.thumbstickLatch.set(axis, value === true);
  }

  sendYomitanControlMessage(action, params = {}) {
    const message = {
      type: 'gsm-yomitan-control',
      action,
      ...params,
    };

    try {
      window.postMessage(message, '*');
    } catch (e) {
      // Ignore local postMessage issues; frame dispatch below is the primary path.
    }

    const popupFrames = this.getYomitanPopupFrames();
    popupFrames.forEach(frame => {
      try {
        frame.contentWindow?.postMessage(message, '*');
      } catch (e) {
        // Ignore individual frame failures.
      }
    });
  }

  getYomitanPopupFrames() {
    const popupFrames = Array.from(document.querySelectorAll('iframe.yomitan-popup'));
    if (popupFrames.length > 0) {
      return popupFrames;
    }

    const fallbackFrame = document.querySelector('iframe');
    return fallbackFrame ? [fallbackFrame] : [];
  }

  resetYomitanPopupActionSelection() {
    if (!this.yomitanPopupVisible) return;
    this.popupActionSelectionActive = true;
    this.sendYomitanControlMessage('reset-action-selection');
  }

  confirmYomitanPopupActionSelection() {
    if (!this.yomitanPopupVisible) return false;
    if (this.getYomitanPopupFrames().length === 0) return false;
    if (!this.popupActionSelectionActive) {
      this.resetYomitanPopupActionSelection();
    }
    this.sendYomitanControlMessage('confirm-action');
    return true;
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
    this.virtualMouse.movedByAnalog = false;
    this.virtualMouse.lastMoveTime = 0;
    
    // Select first block if none selected
    if (this.currentBlockIndex < 0 && this.textBlocks.length > 0) {
      this.currentBlockIndex = 0;
      this.currentCursorIndex = 0;
    }
    this.resetSelectionToSingleBlockStart();

    this.initializeVirtualMousePosition();
    
    this.updateVisuals();
    this.showModeIndicator(true);
    
    // Request window focus via IPC
    const ipc = this.getIpcRenderer();
    if (ipc) {
      ipc.send('gamepad-request-focus');
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
    this.clearPendingMineCandidate();
    this.virtualMouse.movedByAnalog = false;
    this.virtualMouse.lastMoveTime = 0;
    if (this.navigationAwayHideTimer) {
      clearTimeout(this.navigationAwayHideTimer);
      this.navigationAwayHideTimer = null;
    }
    this.navigationAwayHideToken += 1;
    // In toggle mode, don't reset toggleModeActive here - it should only be changed by toggleNavigationMode()
    // (The toggle button itself controls this state)
    
    this.hideVisuals();
    this.showModeIndicator(false);
    
    // Clear cursor position
    this.clearCursorPosition();
    
    // Release window focus via IPC
    const ipc = this.getIpcRenderer();
    if (ipc) {
      ipc.send('gamepad-release-focus');
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
        } else if (mutation.type === 'attributes') {
          if (this.isTextNodeRelevant(mutation.target)) {
            relevant = true;
            break;
          }
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
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'data-line-index', 'data-selectable'],
    });
  }

  setupYomitanPopupTracking() {
    if (typeof window === 'undefined') return;
    window.addEventListener('yomitan-popup-shown', this.onYomitanPopupShown);
    window.addEventListener('yomitan-popup-hidden', this.onYomitanPopupHidden);
  }

  onYomitanPopupShown(event) {
    const popupId = event?.detail?.popupId;
    if (popupId) {
      if (this.yomitanPopupIds.has(popupId)) return;
      this.yomitanPopupIds.add(popupId);
      this.yomitanPopupCount += 1;
    } else {
      this.yomitanPopupCount += 1;
    }
    this.yomitanPopupVisible = this.yomitanPopupCount > 0;
    this.popupActionSelectionActive = true;
    this.resetYomitanPopupActionSelection();
  }

  onYomitanPopupHidden(event) {
    const popupId = event?.detail?.popupId;
    if (popupId && this.yomitanPopupIds.has(popupId)) {
      this.yomitanPopupIds.delete(popupId);
      this.yomitanPopupCount -= 1;
    } else if (this.yomitanPopupCount > 0) {
      this.yomitanPopupCount -= 1;
    }

    if (this.yomitanPopupCount <= 0) {
      this.yomitanPopupCount = 0;
      this.yomitanPopupIds.clear();
      this.yomitanPopupVisible = false;
      this.popupActionSelectionActive = false;
      this.lastLookupAnchorKey = null;
      this.setThumbstickLatch('right_x', false);
      this.sendYomitanControlMessage('clear-action-selection');
      this.clearPendingMineCandidate();
    } else {
      this.yomitanPopupVisible = true;
    }
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

  isElementVisible(element) {
    if (!element || !element.isConnected) return false;

    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      const computed = window.getComputedStyle(element);
      if (computed.display === 'none' || computed.visibility === 'hidden') {
        return false;
      }
    } else if (element.style?.display === 'none') {
      return false;
    }

    return true;
  }

  isTextBoxSelectable(box) {
    if (!this.isElementVisible(box)) return false;
    const text = box.textContent || '';
    if (!text || text === '\n') return false;
    if (typeof box.getClientRects === 'function' && box.getClientRects().length === 0) return false;
    return box.dataset?.selectable !== 'false';
  }

  blockHasSelectableCharacters(block) {
    if (!this.isElementVisible(block)) return false;

    const textBoxes = block.querySelectorAll('.text-box');
    if (!textBoxes.length) {
      const text = block.textContent || '';
      return text.trim().length > 0;
    }

    for (let i = 0; i < textBoxes.length; i++) {
      const box = textBoxes[i];
      if (this.isTextBoxSelectable(box)) {
        return true;
      }
    }
    return false;
  }

  findFirstSelectableBlockIndex() {
    for (let i = 0; i < this.textBlocks.length; i++) {
      if (this.blockHasSelectableCharacters(this.textBlocks[i])) {
        return i;
      }
    }
    return this.textBlocks.length > 0 ? 0 : -1;
  }

  resetSelectionToSingleBlockStart() {
    if (this.textBlocks.length !== 1) return false;
    this.currentBlockIndex = 0;
    this.currentCursorIndex = 0;
    this.currentLineIndex = 0;
    this.lineNavPrefersCharacters = false;
    this.refreshCharacters();
    return true;
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
    const navigationActive = this.isNavigationActive();
    this.virtualMouse.movedByAnalog = false;
    this.virtualMouse.lastMoveTime = 0;
    this.updateVirtualMouseCursor();

    if (navigationActive) {
      this.scanHiddenCharacterToHideYomitan();
    }

    const previousBlockCount = this.textBlocks.length;
    const wasOnLastBlock = previousBlockCount > 0 && this.currentBlockIndex === previousBlockCount - 1;

    this.refreshTextBlocks();
    this.prefetchTokenizationForAllBlocks();

    if (this.textBlocks.length === 0) {
      if (navigationActive) {
        this.hideVisuals();
      }
      return;
    }

    // When content collapses to a single block, default selection to its first position.
    if (this.textBlocks.length === 1 && (previousBlockCount !== 1 || this.currentBlockIndex !== 0 || this.currentCursorIndex !== 0)) {
      this.resetSelectionToSingleBlockStart();
    }

    // If we were on the last block, follow newly appended text while active.
    if (navigationActive && wasOnLastBlock && this.textBlocks.length > previousBlockCount) {
      this.currentBlockIndex = this.textBlocks.length - 1;
      this.currentCursorIndex = 0;
      this.currentLineIndex = 0;
      this.lineNavPrefersCharacters = false;
      this.refreshCharacters();
    }

    if (navigationActive) {
      this.updateVisuals();
    }
  }
  
  refreshTextBlocks() {
    // Find all text block containers
    this.textBlocks = Array.from(document.querySelectorAll('.text-block-container'))
      .filter(block => this.isElementVisible(block));
    
    // If no block containers, try individual text boxes
    if (this.textBlocks.length === 0) {
      this.textBlocks = Array.from(document.querySelectorAll('.text-box'))
        .filter(box => this.isTextBoxSelectable(box));
    }
    
    console.log(`[GamepadHandler] Found ${this.textBlocks.length} text blocks`);

    for (const blockIndex of Array.from(this.tokenCacheByBlock.keys())) {
      if (blockIndex < 0 || blockIndex >= this.textBlocks.length) {
        this.tokenCacheByBlock.delete(blockIndex);
      }
    }
    for (const blockIndex of Array.from(this.pendingTokenizationByBlock.keys())) {
      if (blockIndex < 0 || blockIndex >= this.textBlocks.length) {
        this.pendingTokenizationByBlock.delete(blockIndex);
      }
    }

    if (this.textBlocks.length === 0) {
      this.currentBlockIndex = -1;
      this.currentCursorIndex = 0;
      this.currentLineIndex = 0;
      this.characters = [];
      this.lines = [];
      this.tokens = [];
      this.tokensBlockIndex = -1;
      return;
    }

    const currentBlock = this.textBlocks[this.currentBlockIndex];
    const needsBlockReset = (
      this.currentBlockIndex < 0 ||
      this.currentBlockIndex >= this.textBlocks.length ||
      !this.blockHasSelectableCharacters(currentBlock)
    );

    if (needsBlockReset) {
      this.currentBlockIndex = this.findFirstSelectableBlockIndex();
      this.currentCursorIndex = 0;
      this.currentLineIndex = 0;
      this.lineNavPrefersCharacters = false;
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
      this.characters = Array.from(textBoxes).filter(box => this.isTextBoxSelectable(box));
    } else {
      // Fallback: treat the block itself as a single unit
      this.characters = [block];
    }
    
    console.log(`[GamepadHandler] Block ${this.currentBlockIndex} has ${this.characters.length} characters`);

    const currentBlockText = this.getBlockText(this.currentBlockIndex, true);
    const cachedTokens = this.tokenCacheByBlock.get(this.currentBlockIndex);
    if (cachedTokens && cachedTokens.text === currentBlockText) {
      this.tokens = cachedTokens.tokens || [];
      this.tokensBlockIndex = this.currentBlockIndex;
    } else {
      this.tokens = [];
      this.tokensBlockIndex = -1;
    }
    
    // Validate cursor index
    if (this.currentCursorIndex >= this.characters.length) {
      this.currentCursorIndex = Math.max(0, this.characters.length - 1);
    }

    // Rebuild line metadata for intra-block navigation
    this.buildLines();
    this.currentLineIndex = this.getLineIndexForCursor();
    
    console.log(`[GamepadHandler] Block ${this.currentBlockIndex}: ${this.lines.length} lines, current line: ${this.currentLineIndex}, cursor: ${this.currentCursorIndex}`);
    
    // Proactive tokenization keeps token mode responsive even before activation.
    this.requestTokenizationForBlock(this.currentBlockIndex, currentBlockText);
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
      const lineEntries = [];
      const sortedIds = Array.from(linesById.keys()).sort((a, b) => a - b);
      sortedIds.forEach(lineId => {
        const indices = linesById.get(lineId);
        const positioned = [];

        indices.forEach(idx => {
          const char = this.characters[idx];
          if (!char || !char.isConnected) return;
          const rect = char.getBoundingClientRect();
          positioned.push({
            idx,
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
          });
        });

        positioned.sort((a, b) => a.centerX - b.centerX);
        const orderedIndices = positioned.length
          ? positioned.map(p => p.idx)
          : [...indices].sort((a, b) => a - b);
        const averageY = positioned.length
          ? positioned.reduce((sum, p) => sum + p.centerY, 0) / positioned.length
          : null;

        lineEntries.push({
          lineId,
          indices: orderedIndices,
          y: averageY,
        });
      });

      lineEntries.sort((a, b) => {
        if (a.y === null && b.y === null) return a.lineId - b.lineId;
        if (a.y === null) return 1;
        if (b.y === null) return -1;
        return a.y - b.y;
      });

      this.lines = lineEntries.map(entry => ({
        indices: entry.indices,
        y: entry.y,
      }));

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

  getCurrentAnchorCharIndex() {
    if (!this.characters.length) return -1;

    if (!this.lineNavPrefersCharacters && this.tokenMode && this.tokens.length > 0 && this.currentCursorIndex >= 0 && this.currentCursorIndex < this.tokens.length) {
      const token = this.tokens[this.currentCursorIndex];
      if (token && typeof token.start === 'number') {
        return Math.max(0, Math.min(token.start, this.characters.length - 1));
      }
    }

    return Math.max(0, Math.min(this.currentCursorIndex, this.characters.length - 1));
  }

  getLineIndexForCharIndex(charIndex) {
    if (!this.lines || !this.lines.length || charIndex < 0) return 0;
    const idx = this.lines.findIndex(line => line.indices.includes(charIndex));
    return idx >= 0 ? idx : 0;
  }

  getLineIndexForCursor() {
    return this.getLineIndexForCharIndex(this.getCurrentAnchorCharIndex());
  }

  getCursorCenterX(charIndex = null) {
    if (!this.characters.length) return null;

    const resolvedCharIndex = charIndex === null ? this.getCurrentAnchorCharIndex() : charIndex;
    if (resolvedCharIndex < 0) return null;

    const clampedIndex = Math.max(0, Math.min(resolvedCharIndex, this.characters.length - 1));
    const char = this.characters[clampedIndex];
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

  getBlockText(blockIndex, preferCurrentCharacters = false) {
    if (blockIndex < 0 || blockIndex >= this.textBlocks.length) return '';

    if (preferCurrentCharacters && blockIndex === this.currentBlockIndex && this.characters.length > 0) {
      let textFromCharacters = '';
      this.characters.forEach(char => {
        textFromCharacters += char.textContent || '';
      });
      if (textFromCharacters) return textFromCharacters;
    }

    const block = this.textBlocks[blockIndex];
    if (!block || !block.isConnected) return '';

    const textBoxes = block.querySelectorAll('.text-box');
    if (textBoxes.length > 0) {
      let text = '';
      textBoxes.forEach(box => {
        if (this.isTextBoxSelectable(box)) {
          text += box.textContent || '';
        }
      });
      if (text) return text;
    }

    return block.textContent || '';
  }

  prefetchTokenizationForAllBlocks() {
    if (!this.textBlocks.length) return;

    for (let blockIndex = 0; blockIndex < this.textBlocks.length; blockIndex++) {
      this.requestTokenizationForBlock(blockIndex);
    }
  }

  requestTokenizationForBlock(blockIndex, textOverride = null) {
    if (blockIndex < 0 || blockIndex >= this.textBlocks.length) {
      return;
    }

    const text = typeof textOverride === 'string'
      ? textOverride
      : this.getBlockText(blockIndex, blockIndex === this.currentBlockIndex);
    if (!text) return;

    const cached = this.tokenCacheByBlock.get(blockIndex);
    if (cached && cached.text === text && Array.isArray(cached.tokens) && cached.tokens.length > 0) {
      return;
    }

    const pendingText = this.pendingTokenizationByBlock.get(blockIndex);
    if (pendingText === text) {
      return;
    }

    if (this.isUsingYomitanApi()) {
      console.log(`[GamepadHandler] Requesting tokenization for block ${blockIndex}: "${text.slice(0, 30)}..."`);
      this.pendingTokenizationByBlock.set(blockIndex, text);
      this.requestTokenizationFromYomitanApi(blockIndex, text);
      return;
    }

    if (!this.wsConnected || !this.ws) {
      return;
    }

    console.log(`[GamepadHandler] Requesting tokenization for block ${blockIndex}: "${text.slice(0, 30)}..."`);
    this.pendingTokenizationByBlock.set(blockIndex, text);
    this.ws.send(JSON.stringify({
      type: 'tokenize',
      blockIndex,
      text,
    }));
  }
  
  requestTokenization() {
    this.requestTokenizationForBlock(this.currentBlockIndex);
  }

  async requestTokenizationFromYomitanApi(blockIndex, text) {
    try {
      const content = await this.requestYomitanTokenize(text, this.config.yomitanRequestTimeout);
      const tokens = this.convertYomitanContentToTokens(content, text);

      this.onTokensReceived({
        type: 'tokens',
        blockIndex,
        text,
        tokens,
        tokenSource: 'yomitan-api',
        mecabAvailable: false,
        yomitanApiAvailable: true,
      });
    } catch (error) {
      console.warn(`[GamepadHandler] Yomitan API tokenization failed: ${error.message}`);
      const fallbackTokens = this.convertYomitanContentToTokens([], text);
      this.onTokensReceived({
        type: 'tokens',
        blockIndex,
        text,
        tokens: fallbackTokens,
        tokenSource: 'yomitan-api',
        mecabAvailable: false,
        yomitanApiAvailable: false,
      });
    }
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

  isUsingTokenNavigation() {
    return this.tokenMode && this.tokens.length > 0 && !this.lineNavPrefersCharacters;
  }

  getNavigationUnitRect(unitIndex) {
    if (this.isUsingTokenNavigation()) {
      if (unitIndex < 0 || unitIndex >= this.tokens.length) return null;

      const tokenRect = this.getTokenBoundingRect(unitIndex);
      if (tokenRect) return tokenRect;

      const token = this.tokens[unitIndex];
      if (token && typeof token.start === 'number' && token.start >= 0 && token.start < this.characters.length) {
        const char = this.characters[token.start];
        if (char && char.isConnected) {
          return char.getBoundingClientRect();
        }
      }
      return null;
    }

    if (unitIndex < 0 || unitIndex >= this.characters.length) return null;
    const char = this.characters[unitIndex];
    if (!char || !char.isConnected) return null;
    return char.getBoundingClientRect();
  }

  getNavigationUnitCenter(unitIndex) {
    if (this.isUsingTokenNavigation()) {
      if (unitIndex < 0 || unitIndex >= this.tokens.length) return null;
      const token = this.tokens[unitIndex];

      // Use the first character of the token as the navigation anchor.
      // This matches lookup anchoring and avoids right-bias on long tokens.
      if (token && typeof token.start === 'number' && token.start >= 0 && token.start < this.characters.length) {
        const anchorChar = this.characters[token.start];
        if (anchorChar && anchorChar.isConnected) {
          const anchorRect = anchorChar.getBoundingClientRect();
          return {
            x: anchorRect.left + anchorRect.width / 2,
            y: anchorRect.top + anchorRect.height / 2,
            width: anchorRect.width,
            height: anchorRect.height,
          };
        }
      }

      // Fallback to whole-token geometry when anchor character is unavailable.
      const tokenRect = this.getTokenBoundingRect(unitIndex);
      if (!tokenRect) return null;
      return {
        x: tokenRect.left + tokenRect.width / 2,
        y: tokenRect.top + tokenRect.height / 2,
        width: tokenRect.width,
        height: tokenRect.height,
      };
    }

    const rect = this.getNavigationUnitRect(unitIndex);
    if (!rect) return null;

    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
  }

  findClosestVerticalUnit(direction) {
    if (direction !== -1 && direction !== 1) return null;

    const unitCount = this.getNavigationUnitCount();
    if (unitCount <= 0) return null;

    const currentCenter = this.getNavigationUnitCenter(this.currentCursorIndex);
    if (!currentCenter) return null;

    // Ignore near-same-row units so we don't jump sideways between misaligned columns.
    const minVerticalStep = Math.max(8, currentCenter.height * 0.55);
    const horizontalBand = Math.max(120, currentCenter.width * 4);

    const candidates = [];
    for (let i = 0; i < unitCount; i++) {
      if (i === this.currentCursorIndex) continue;

      const center = this.getNavigationUnitCenter(i);
      if (!center) continue;

      const dy = center.y - currentCenter.y;
      const forwardDistance = direction === 1 ? dy : -dy;
      if (forwardDistance <= minVerticalStep) continue;

      const dx = Math.abs(center.x - currentCenter.x);
      candidates.push({
        index: i,
        forwardDistance,
        dx,
      });
    }

    if (!candidates.length) return null;

    // Step 1: identify the nearest Y-level in the requested direction.
    const nearestForwardDistance = candidates.reduce(
      (min, candidate) => Math.min(min, candidate.forwardDistance),
      Infinity
    );
    const yLevelTolerance = Math.max(12, currentCenter.height * 0.9);
    const nearestYLevel = candidates.filter(candidate =>
      candidate.forwardDistance <= nearestForwardDistance + yLevelTolerance
    );

    // Step 2: within that Y-level, prefer X-aligned units.
    const inBand = nearestYLevel.filter(candidate => candidate.dx <= horizontalBand);
    const pool = inBand.length > 0 ? inBand : nearestYLevel;

    pool.sort((a, b) => {
      if (a.dx !== b.dx) {
        return a.dx - b.dx;
      }
      return a.forwardDistance - b.forwardDistance;
    });

    return pool[0].index;
  }

  findAdjacentLineUnit(direction, preferredX = null) {
    if (direction !== -1 && direction !== 1) return null;
    if (!this.lines || !this.lines.length || !this.characters.length) return null;

    const anchorCharIndex = this.getCurrentAnchorCharIndex();
    if (anchorCharIndex < 0) return null;

    const currentLineIndex = this.getLineIndexForCharIndex(anchorCharIndex);
    const targetLineIndex = currentLineIndex + direction;
    if (targetLineIndex < 0 || targetLineIndex >= this.lines.length) return null;

    const targetX = typeof preferredX === 'number'
      ? preferredX
      : this.getCursorCenterX(anchorCharIndex);
    const targetCharIndex = this.getNearestIndexInLine(targetLineIndex, targetX);
    if (targetCharIndex < 0) return null;

    if (this.isUsingTokenNavigation()) {
      const targetTokenIndex = this.charIndexToTokenIndex(targetCharIndex);
      if (targetTokenIndex < 0 || targetTokenIndex >= this.tokens.length) return null;
      return targetTokenIndex;
    }

    return Math.max(0, Math.min(targetCharIndex, this.characters.length - 1));
  }

  findEdgeEntryUnit(direction, preferredX = null) {
    if (direction !== -1 && direction !== 1) return 0;

    const unitCount = this.getNavigationUnitCount();
    if (unitCount <= 0) return 0;

    const centers = [];
    for (let i = 0; i < unitCount; i++) {
      const center = this.getNavigationUnitCenter(i);
      if (!center) continue;
      centers.push({ index: i, ...center });
    }

    if (!centers.length) return 0;

    const edgeY = direction === 1
      ? Math.min(...centers.map(center => center.y))
      : Math.max(...centers.map(center => center.y));
    const avgHeight = centers.reduce((sum, center) => sum + center.height, 0) / centers.length;
    const edgeTolerance = Math.max(10, avgHeight * 0.7);

    const edgeUnits = centers.filter(center => Math.abs(center.y - edgeY) <= edgeTolerance);
    const pool = edgeUnits.length ? edgeUnits : centers;

    if (typeof preferredX === 'number') {
      pool.sort((a, b) => {
        const dxA = Math.abs(a.x - preferredX);
        const dxB = Math.abs(b.x - preferredX);
        if (dxA !== dxB) return dxA - dxB;
        if (direction === 1) return a.y - b.y;
        return b.y - a.y;
      });
      return pool[0].index;
    }

    pool.sort((a, b) => {
      if (direction === 1) {
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
      }
      if (a.y !== b.y) return b.y - a.y;
      return a.x - b.x;
    });

    return pool[0].index;
  }

  positionCursorAtCurrentUnit() {
    if (this.isUsingTokenNavigation()) {
      this.positionCursorAtToken();
    } else {
      this.positionCursorAtCharacter();
    }
  }
  
  // Convert character index to token index (for token mode navigation)
  charIndexToTokenIndex(charIndex) {
    if (!this.tokenMode || this.tokens.length === 0) {
      return charIndex;
    }

    let nearestTokenIndex = 0;
    let nearestDistance = Infinity;

    // Find the token that contains this character index
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (!token || typeof token.start !== 'number') continue;

      const tokenStart = token.start;
      const tokenEnd = typeof token.end === 'number'
        ? token.end
        : (typeof token.length === 'number' ? tokenStart + token.length : tokenStart + 1);

      if (tokenStart <= charIndex && charIndex < tokenEnd) {
        return i;
      }

      const distanceToRange = charIndex < tokenStart
        ? tokenStart - charIndex
        : charIndex >= tokenEnd
          ? charIndex - tokenEnd + 1
          : 0;

      if (distanceToRange < nearestDistance) {
        nearestDistance = distanceToRange;
        nearestTokenIndex = i;
      }
    }
    // If not found, return nearest token by character distance
    return nearestTokenIndex;
  }
  
  // ==================== Navigation Methods ====================

  dismissLookupForNavigation() {
    this.clearPendingMineCandidate();

    // Dismiss immediately, then once more shortly after to catch delayed popup creation.
    this.scanHiddenCharacterToHideYomitan();

    const dismissToken = ++this.lookupDismissToken;
    if (this.lookupDismissTimer) {
      clearTimeout(this.lookupDismissTimer);
    }

    this.lookupDismissTimer = setTimeout(() => {
      if (dismissToken !== this.lookupDismissToken) return;
      this.scanHiddenCharacterToHideYomitan();
      this.lookupDismissTimer = null;
    }, 90);
  }
  
  navigateBlockUp() {
    this.dismissLookupForNavigation();
    if (this.textBlocks.length === 0) {
      this.refreshTextBlocks();
    }
    
    if (this.textBlocks.length === 0) return;

    this.lineNavPrefersCharacters = false;

    const currentCenter = this.getNavigationUnitCenter(this.currentCursorIndex);
    const targetX = currentCenter ? currentCenter.x : null;

    // First, try strict adjacent-line movement to avoid skipping visual lines in token mode.
    const adjacentLineTarget = this.findAdjacentLineUnit(-1, targetX);
    if (adjacentLineTarget !== null && adjacentLineTarget !== this.currentCursorIndex) {
      this.currentCursorIndex = adjacentLineTarget;
      this.currentLineIndex = this.getLineIndexForCursor();
      this.updateVisuals();
      this.positionCursorAtCurrentUnit();
      this.autoConfirmSelection();
      console.log(`[GamepadHandler] Vertical UP line step: unit ${this.currentCursorIndex}`);
      return;
    }

    // Fallback: nearest-neighbor vertical movement within the current block.
    const intraBlockTarget = this.findClosestVerticalUnit(-1);
    if (intraBlockTarget !== null) {
      this.currentCursorIndex = intraBlockTarget;
      this.currentLineIndex = this.getLineIndexForCursor();
      this.updateVisuals();
      this.positionCursorAtCurrentUnit();
      this.autoConfirmSelection();
      console.log(`[GamepadHandler] Vertical UP: unit ${this.currentCursorIndex}`);
      return;
    }

    // Single block fallback: wrap to the nearest unit on the bottom edge.
    if (this.textBlocks.length === 1) {
      this.currentCursorIndex = this.findEdgeEntryUnit(-1, targetX);
      this.currentLineIndex = this.getLineIndexForCursor();
      this.updateVisuals();
      this.positionCursorAtCurrentUnit();
      this.autoConfirmSelection();
      console.log('[GamepadHandler] Vertical UP wrap within single block');
      return;
    }

    // No candidate above in this block: move to previous block.
    if (this.currentBlockIndex <= 0) {
      this.currentBlockIndex = this.textBlocks.length - 1;
    } else {
      this.currentBlockIndex--;
    }

    this.currentCursorIndex = 0;
    this.refreshCharacters();
    this.lineNavPrefersCharacters = false;
    this.currentCursorIndex = this.findEdgeEntryUnit(-1, targetX);
    this.currentLineIndex = this.getLineIndexForCursor();
    this.updateVisuals();
    this.positionCursorAtCurrentUnit();
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
    this.dismissLookupForNavigation();
    if (this.textBlocks.length === 0) {
      this.refreshTextBlocks();
    }
    
    if (this.textBlocks.length === 0) return;

    this.lineNavPrefersCharacters = false;

    const currentCenter = this.getNavigationUnitCenter(this.currentCursorIndex);
    const targetX = currentCenter ? currentCenter.x : null;

    // First, try strict adjacent-line movement to avoid skipping visual lines in token mode.
    const adjacentLineTarget = this.findAdjacentLineUnit(1, targetX);
    if (adjacentLineTarget !== null && adjacentLineTarget !== this.currentCursorIndex) {
      this.currentCursorIndex = adjacentLineTarget;
      this.currentLineIndex = this.getLineIndexForCursor();
      this.updateVisuals();
      this.positionCursorAtCurrentUnit();
      this.autoConfirmSelection();
      console.log(`[GamepadHandler] Vertical DOWN line step: unit ${this.currentCursorIndex}`);
      return;
    }

    // Fallback: nearest-neighbor vertical movement within the current block.
    const intraBlockTarget = this.findClosestVerticalUnit(1);
    if (intraBlockTarget !== null) {
      this.currentCursorIndex = intraBlockTarget;
      this.currentLineIndex = this.getLineIndexForCursor();
      this.updateVisuals();
      this.positionCursorAtCurrentUnit();
      this.autoConfirmSelection();
      console.log(`[GamepadHandler] Vertical DOWN: unit ${this.currentCursorIndex}`);
      return;
    }

    // Single block fallback: wrap to the nearest unit on the top edge.
    if (this.textBlocks.length === 1) {
      this.currentCursorIndex = this.findEdgeEntryUnit(1, targetX);
      this.currentLineIndex = this.getLineIndexForCursor();
      this.updateVisuals();
      this.positionCursorAtCurrentUnit();
      this.autoConfirmSelection();
      console.log('[GamepadHandler] Vertical DOWN wrap within single block');
      return;
    }

    // No candidate below in this block: move to next block.
    if (this.currentBlockIndex >= this.textBlocks.length - 1) {
      this.currentBlockIndex = 0;
    } else {
      this.currentBlockIndex++;
    }

    this.currentCursorIndex = 0;
    this.refreshCharacters();
    this.lineNavPrefersCharacters = false;
    this.currentCursorIndex = this.findEdgeEntryUnit(1, targetX);
    this.currentLineIndex = this.getLineIndexForCursor();
    this.updateVisuals();
    this.positionCursorAtCurrentUnit();
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
    const wasLineCharacterMode = this.lineNavPrefersCharacters;
    this.lineNavPrefersCharacters = false;
    this.dismissLookupForNavigation();
    if (wasLineCharacterMode && this.tokenMode && this.tokens.length > 0) {
      this.currentCursorIndex = this.charIndexToTokenIndex(this.currentCursorIndex);
    }
    const unitCount = this.getNavigationUnitCount();
    if (unitCount === 0) return;
    
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
    const wasLineCharacterMode = this.lineNavPrefersCharacters;
    this.lineNavPrefersCharacters = false;
    this.dismissLookupForNavigation();
    if (wasLineCharacterMode && this.tokenMode && this.tokens.length > 0) {
      this.currentCursorIndex = this.charIndexToTokenIndex(this.currentCursorIndex);
    }
    const unitCount = this.getNavigationUnitCount();
    if (unitCount === 0) return;
    
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

  initializeVirtualMousePosition(force = false) {
    if (this.virtualMouse.initialized && !force) return;

    let x = Math.max(1, window.innerWidth || 1) / 2;
    let y = Math.max(1, window.innerHeight || 1) / 2;

    const lookupTarget = this.getTargetCharForLookup();
    if (lookupTarget.targetChar) {
      x = lookupTarget.centerX;
      y = lookupTarget.centerY;
    }

    this.setVirtualMousePosition(x, y, false);
  }

  setVirtualMousePosition(x, y, dispatchMove = false) {
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const clampedX = Math.min(viewportWidth - 1, Math.max(0, Number(x) || 0));
    const clampedY = Math.min(viewportHeight - 1, Math.max(0, Number(y) || 0));

    this.virtualMouse.x = clampedX;
    this.virtualMouse.y = clampedY;
    this.virtualMouse.initialized = true;
    this.updateVirtualMouseCursor();

    if (!dispatchMove) return;

    const targetElement = document.elementFromPoint(clampedX, clampedY);
    if (targetElement) {
      this.simulateMousePosition(clampedX, clampedY, targetElement);
      this.syncSelectionFromVirtualMouse(targetElement);
    }
  }

  updateVirtualMouseCursor() {
    if (!this.virtualMouseCursor) return;
    if (!this.isNavigationActive() || !this.virtualMouse.initialized || !this.virtualMouse.movedByAnalog) {
      this.virtualMouseCursor.style.display = 'none';
      return;
    }

    const size = 12;
    this.virtualMouseCursor.style.display = 'block';
    this.virtualMouseCursor.style.left = `${this.virtualMouse.x - size / 2}px`;
    this.virtualMouseCursor.style.top = `${this.virtualMouse.y - size / 2}px`;
  }

  isVirtualMouseLookupPreferred() {
    if (!this.virtualMouse.initialized || !this.virtualMouse.movedByAnalog) return false;
    const elapsed = Date.now() - (this.virtualMouse.lastMoveTime || 0);
    return elapsed >= 0 && elapsed <= 2500;
  }

  getLookupTargetFromVirtualMouse() {
    if (!this.virtualMouse.initialized) {
      return { targetChar: null };
    }

    const targetElement = document.elementFromPoint(this.virtualMouse.x, this.virtualMouse.y);
    if (!targetElement) {
      return { targetChar: null };
    }

    let targetChar = targetElement.closest?.('.text-box') || targetElement;
    if (!targetChar || typeof targetChar.getBoundingClientRect !== 'function') {
      return { targetChar: null };
    }

    let targetIndex = this.characters.indexOf(targetChar);
    let label = targetIndex >= 0
      ? `virtual mouse char ${targetIndex}`
      : 'virtual mouse target';

    // In token mode, always target the start character of the token.
    if (this.isUsingTokenNavigation() && targetIndex >= 0) {
      const tokenIndex = this.charIndexToTokenIndex(targetIndex);
      const token = this.tokens[tokenIndex];
      if (token && typeof token.start === 'number' && token.start >= 0 && token.start < this.characters.length) {
        targetIndex = token.start;
        targetChar = this.characters[targetIndex];
        label = `virtual mouse token '${token.word || ''}' (char ${targetIndex})`;
      }
    }

    const rect = targetChar.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const anchorKey = targetIndex >= 0
      ? `${this.currentBlockIndex}:${targetIndex}`
      : `mouse:${Math.round(centerX)}:${Math.round(centerY)}`;

    return {
      targetChar,
      centerX,
      centerY,
      label,
      targetIndex,
      anchorKey,
    };
  }

  getCurrentSelectionAnchorKey() {
    const lookup = this.getTargetCharForLookup();
    return lookup && lookup.anchorKey ? lookup.anchorKey : null;
  }

  scheduleHideYomitanAfterLeavingAnchor(previousAnchorKey) {
    if (!previousAnchorKey) return;

    const delay = Math.max(40, Number(this.config.navigationHideDelay) || 200);
    const token = ++this.navigationAwayHideToken;
    if (this.navigationAwayHideTimer) {
      clearTimeout(this.navigationAwayHideTimer);
    }

    this.navigationAwayHideTimer = setTimeout(() => {
      if (token !== this.navigationAwayHideToken) return;
      this.navigationAwayHideTimer = null;

      const currentAnchorKey = this.getCurrentSelectionAnchorKey();
      if (currentAnchorKey === previousAnchorKey) return;

      // Aggressive behavior: if we've moved off the last lookup text, force hide.
      this.scanHiddenCharacterToHideYomitan();
    }, delay);
  }

  getBlockIndexForElement(element) {
    if (!element || !this.textBlocks.length) return -1;

    const blockContainer = element.closest?.('.text-block-container');
    if (blockContainer) {
      const containerIndex = this.textBlocks.indexOf(blockContainer);
      if (containerIndex >= 0) return containerIndex;
    }

    const directTextBox = element.closest?.('.text-box');
    if (directTextBox) {
      const directIndex = this.textBlocks.indexOf(directTextBox);
      if (directIndex >= 0) return directIndex;
    }

    for (let i = 0; i < this.textBlocks.length; i++) {
      const block = this.textBlocks[i];
      if (!block || !block.isConnected) continue;
      if (block === element) return i;
      if (typeof block.contains === 'function' && block.contains(element)) {
        return i;
      }
    }
    return -1;
  }

  getCharacterIndexFromPoint(x, y, sourceElement = null) {
    if (!this.characters.length) return -1;

    const sourceChar = sourceElement?.closest?.('.text-box');
    if (sourceChar) {
      const sourceIndex = this.characters.indexOf(sourceChar);
      if (sourceIndex >= 0) return sourceIndex;
    }

    let nearestIndex = -1;
    let nearestDistance = Infinity;

    for (let i = 0; i < this.characters.length; i++) {
      const char = this.characters[i];
      if (!char || !char.isConnected) continue;
      const rect = char.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return i;
      }

      const clampedX = Math.max(rect.left, Math.min(x, rect.right));
      const clampedY = Math.max(rect.top, Math.min(y, rect.bottom));
      const dx = clampedX - x;
      const dy = clampedY - y;
      const distanceSq = (dx * dx) + (dy * dy);
      if (distanceSq < nearestDistance) {
        nearestDistance = distanceSq;
        nearestIndex = i;
      }
    }

    return nearestIndex;
  }

  syncSelectionFromVirtualMouse(sourceElement = null) {
    if (!this.isNavigationActive() || !this.virtualMouse.initialized) return false;
    const lastLookupAnchorKey = this.lastLookupAnchorKey;

    if (!this.textBlocks.length) {
      this.refreshTextBlocks();
      if (!this.textBlocks.length) return false;
    }

    const x = this.virtualMouse.x;
    const y = this.virtualMouse.y;
    const element = sourceElement || document.elementFromPoint(x, y);
    if (!element) return false;

    let blockIndex = this.getBlockIndexForElement(element);
    if (blockIndex < 0) {
      // DOM may have transitioned (e.g. multi-block -> single-block) while cached block list is stale.
      this.refreshTextBlocks();
      blockIndex = this.getBlockIndexForElement(element);
    }
    if (blockIndex < 0) return false;

    const blockChanged = blockIndex !== this.currentBlockIndex;
    if (blockChanged) {
      this.currentBlockIndex = blockIndex;
      this.currentCursorIndex = 0;
      this.currentLineIndex = 0;
      this.lineNavPrefersCharacters = false;
      this.refreshCharacters();
    } else if (!this.ensureCurrentBlockConnected()) {
      this.refreshCharacters();
    }

    if (!this.characters.length) return false;

    const charIndex = this.getCharacterIndexFromPoint(x, y, element);
    if (charIndex < 0) return false;

    let nextCursorIndex = charIndex;
    if (this.isUsingTokenNavigation()) {
      nextCursorIndex = this.charIndexToTokenIndex(charIndex);
    }

    const unitCount = this.getNavigationUnitCount();
    if (unitCount <= 0) return false;
    nextCursorIndex = Math.max(0, Math.min(nextCursorIndex, unitCount - 1));

    const cursorChanged = nextCursorIndex !== this.currentCursorIndex;
    if (!blockChanged && !cursorChanged) return false;

    this.currentCursorIndex = nextCursorIndex;
    this.currentLineIndex = this.getLineIndexForCursor();
    this.updateVisuals();
    const currentAnchorKey = this.getCurrentSelectionAnchorKey();
    if (lastLookupAnchorKey && currentAnchorKey && currentAnchorKey !== lastLookupAnchorKey) {
      this.scheduleHideYomitanAfterLeavingAnchor(lastLookupAnchorKey);
    } else {
      this.navigationAwayHideToken += 1;
      if (this.navigationAwayHideTimer) {
        clearTimeout(this.navigationAwayHideTimer);
        this.navigationAwayHideTimer = null;
      }
    }
    this.autoConfirmSelection();

    if (blockChanged && this.config.onBlockChange) {
      this.config.onBlockChange({
        blockIndex: this.currentBlockIndex,
        block: this.textBlocks[this.currentBlockIndex],
      });
    }

    if (this.config.onCursorChange) {
      const unit = this.getNavigationUnits()[this.currentCursorIndex];
      this.config.onCursorChange({
        cursorIndex: this.currentCursorIndex,
        character: this.tokenMode && this.tokens.length > 0 ? unit.word : unit,
        totalCharacters: unitCount,
        isToken: this.tokenMode && this.tokens.length > 0,
      });
    }

    return true;
  }
  
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
    this.setVirtualMousePosition(centerX, centerY, false);
    
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
      this.setVirtualMousePosition(centerX, centerY, false);
      
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
    if (this.confirmYomitanPopupActionSelection()) {
      console.log('[GamepadHandler] Confirm routed to selected Yomitan popup action');
      return;
    }

    let lookupInfo = this.isUsingTokenNavigation()
      ? this.getTargetCharForLookup()
      : (
        this.isVirtualMouseLookupPreferred()
          ? this.getLookupTargetFromVirtualMouse()
          : { targetChar: null }
      );

    if (!lookupInfo.targetChar) {
      if (this.characters.length === 0 || this.currentCursorIndex < 0) return;
      lookupInfo = this.getTargetCharForLookup();
    }

    const { targetChar, centerX, centerY, label, anchorKey } = lookupInfo;
    if (!targetChar) return;
    
    // Second confirm mines only if popup is still open and cursor/target hasn't changed.
    if (this.canMineFromCurrentConfirm({ anchorKey })) {
      console.log('[GamepadHandler] Confirm pressed again on active popup target - triggering mining');
      this.triggerMining();
      this.clearPendingMineCandidate();
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
    this.lastLookupAnchorKey = anchorKey || null;
    
    if (this.config.onConfirm) {
      this.config.onConfirm({
        character: targetChar.textContent,
        element: targetChar,
        position: { x: centerX, y: centerY },
      });
    }
    
    // Arm mining for a second confirm on this exact target while popup remains visible.
    this.setPendingMineCandidate({ anchorKey });
    
    console.log(`[GamepadHandler] Confirmed selection at ${label}: ${targetChar.textContent}`);
  }
  
  autoConfirmSelection() {
    // Automatically trigger Yomitan lookup when cursor moves
    if (this.characters.length === 0 || this.currentCursorIndex < 0 || this.config.autoConfirmSelection === false) return;
    
    this.clearPendingMineCandidate();
    
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
    this.lastLookupAnchorKey = result.anchorKey || null;
    
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
    const anchorKey = `${this.currentBlockIndex}:${targetIndex}`;
    
    return { targetChar, centerX, centerY, label, targetIndex, anchorKey };
  }

  clearPendingMineCandidate() {
    this.pendingMineCandidate = null;
  }

  setPendingMineCandidate(lookupInfo) {
    this.pendingMineCandidate = {
      anchorKey: lookupInfo.anchorKey,
      blockIndex: this.currentBlockIndex,
      cursorIndex: this.currentCursorIndex,
    };
  }

  canMineFromCurrentConfirm(lookupInfo) {
    const pending = this.pendingMineCandidate;
    if (!pending || !this.yomitanPopupVisible) return false;

    return (
      pending.anchorKey === lookupInfo.anchorKey &&
      pending.blockIndex === this.currentBlockIndex &&
      pending.cursorIndex === this.currentCursorIndex
    );
  }

  triggerMining() {
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
  }
  
  cancelSelection() {
    this.clearPendingMineCandidate();
    
    // Dismiss Yomitan popup but keep navigation mode intact.
    // In toggle mode, exiting navigation should only happen via toggle button.
    this.scanHiddenCharacterToHideYomitan();
    
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

    // Create virtual mouse cursor (left stick mouse emulation)
    this.virtualMouseCursor = document.createElement('div');
    this.virtualMouseCursor.id = 'gamepad-virtual-mouse-cursor';
    this.virtualMouseCursor.style.cssText = `
      position: fixed;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.95);
      background: rgba(255, 80, 80, 0.9);
      box-shadow: 0 0 10px rgba(255, 80, 80, 0.65);
      pointer-events: none;
      z-index: 10006;
      display: none;
      transform: translateZ(0);
    `;
    document.body.appendChild(this.virtualMouseCursor);
    
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

  createCursorSegmentHighlight() {
    const segment = document.createElement('div');
    segment.className = 'gamepad-cursor-highlight-segment';
    segment.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 2px solid ${this.config.cursorColor};
      background: ${this.config.cursorColor.replace('0.8', '0.2')};
      z-index: 10004;
      display: none;
      transition: all 0.1s ease-out;
      box-shadow: 0 0 8px ${this.config.cursorColor};
    `;
    document.body.appendChild(segment);
    this.cursorSegmentHighlights.push(segment);
    return segment;
  }

  ensureCursorSegmentHighlightCount(count) {
    while (this.cursorSegmentHighlights.length < count) {
      this.createCursorSegmentHighlight();
    }
  }

  hideCursorSegmentHighlights() {
    this.cursorSegmentHighlights.forEach(segment => {
      segment.style.display = 'none';
    });
  }

  removeCursorSegmentHighlights() {
    this.cursorSegmentHighlights.forEach(segment => {
      if (segment && segment.parentNode) {
        segment.remove();
      }
    });
    this.cursorSegmentHighlights = [];
  }

  applyHighlightRect(highlight, rect) {
    highlight.style.display = 'block';
    highlight.style.left = `${rect.left - 2}px`;
    highlight.style.top = `${rect.top - 2}px`;
    highlight.style.width = `${rect.width + 4}px`;
    highlight.style.height = `${rect.height + 4}px`;
  }

  renderTokenSegmentHighlights(rects) {
    if (!Array.isArray(rects) || rects.length === 0) {
      this.hideCursorSegmentHighlights();
      return;
    }

    this.ensureCursorSegmentHighlightCount(rects.length);
    rects.forEach((rect, idx) => {
      this.applyHighlightRect(this.cursorSegmentHighlights[idx], rect);
    });

    for (let i = rects.length; i < this.cursorSegmentHighlights.length; i++) {
      this.cursorSegmentHighlights[i].style.display = 'none';
    }
  }
  
  removeVisualElements() {
    if (this.blockHighlight && this.blockHighlight.parentNode) {
      this.blockHighlight.remove();
    }
    if (this.cursorHighlight && this.cursorHighlight.parentNode) {
      this.cursorHighlight.remove();
    }
    if (this.virtualMouseCursor && this.virtualMouseCursor.parentNode) {
      this.virtualMouseCursor.remove();
    }
    this.removeCursorSegmentHighlights();
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
    this.updateVirtualMouseCursor();
    
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
        // Token mode: highlight token per visual line to avoid oversized boxes on wrapped tokens.
        const tokenRects = this.getTokenLineRects(this.currentCursorIndex);
        if (tokenRects.length) {
          this.cursorHighlight.style.display = 'none';
          this.renderTokenSegmentHighlights(tokenRects);
          return;
        }
        cursorRect = this.getTokenBoundingRect(this.currentCursorIndex);
        this.hideCursorSegmentHighlights();
      } else {
        // Character mode: highlight single character
        this.hideCursorSegmentHighlights();
        const character = this.characters[this.currentCursorIndex];
        if (character && character.isConnected) {
          cursorRect = character.getBoundingClientRect();
        }
      }
      
      if (cursorRect) {
        this.applyHighlightRect(this.cursorHighlight, cursorRect);
      } else {
        this.cursorHighlight.style.display = 'none';
      }
    } else {
      this.cursorHighlight.style.display = 'none';
      this.hideCursorSegmentHighlights();
    }
  }

  getTokenLineRects(tokenIndex) {
    if (tokenIndex < 0 || tokenIndex >= this.tokens.length) {
      return [];
    }
    if (!this.ensureCurrentBlockConnected()) return [];

    const token = this.tokens[tokenIndex];
    if (!token || typeof token.start !== 'number') return [];

    const startIndex = Math.max(0, token.start);
    const tokenEnd = typeof token.end === 'number'
      ? token.end
      : (typeof token.length === 'number' ? token.start + token.length : token.start + 1);
    const endIndex = Math.max(startIndex + 1, tokenEnd);

    const rects = [];
    const addRectFromIndices = (indices) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      indices.forEach(idx => {
        const char = this.characters[idx];
        if (!char || !char.isConnected) return;
        const rect = char.getBoundingClientRect();
        minX = Math.min(minX, rect.left);
        minY = Math.min(minY, rect.top);
        maxX = Math.max(maxX, rect.right);
        maxY = Math.max(maxY, rect.bottom);
      });

      if (minX === Infinity) return;
      rects.push({
        left: minX,
        top: minY,
        right: maxX,
        bottom: maxY,
        width: maxX - minX,
        height: maxY - minY,
      });
    };

    if (this.lines && this.lines.length) {
      this.lines.forEach(line => {
        if (!line || !Array.isArray(line.indices) || line.indices.length === 0) return;
        const inLine = line.indices.filter(idx => idx >= startIndex && idx < endIndex);
        if (inLine.length) {
          addRectFromIndices(inLine);
        }
      });
    }

    if (rects.length) {
      return rects;
    }

    // Fallback when line metadata is unavailable or stale.
    const fallback = this.getTokenBoundingRect(tokenIndex);
    return fallback ? [fallback] : [];
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
      if (!this.isTextBoxSelectable(box)) return;
      
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
    if (this.virtualMouseCursor) {
      this.virtualMouseCursor.style.display = 'none';
    }
    this.hideCursorSegmentHighlights();
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
    this.clearPendingMineCandidate();
    this.lineNavPrefersCharacters = false;
    
    // Reset cursor position
    this.currentCursorIndex = 0;
    
    // If switching to token mode, request tokenization
    if (this.tokenMode) {
      this.prefetchTokenizationForAllBlocks();
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
      const tokenBackendReady = this.isUsingYomitanApi()
        ? (this.yomitanApiReachable || this.tokens.length > 0)
        : this.mecabAvailable;
      const modeText = this.tokenMode && tokenBackendReady ? 'Token Mode' : 'Character Mode';
      this.modeIndicator.innerHTML = modeText;
    }
  }

  updateConfig(newConfig) {
    const oldServerUrl = this.config.serverUrl;
    const oldTokenizerBackend = this.config.tokenizerBackend;
    const oldYomitanApiUrl = this.config.yomitanApiUrl;
    const oldYomitanScanLength = this.config.yomitanScanLength;

    Object.assign(this.config, newConfig);
    this.config.tokenizerBackend = this.isUsingYomitanApi() ? 'yomitan-api' : 'mecab';
    this.config.yomitanApiUrl = this.getYomitanApiBaseUrl();
    this.config.yomitanScanLength = Math.max(1, Math.min(100, Number(this.config.yomitanScanLength) || 10));
    this.config.forwardEnterButton = Number.isFinite(Number(this.config.forwardEnterButton))
      ? Number(this.config.forwardEnterButton)
      : -1;
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

    const backendChanged = (
      this.config.tokenizerBackend !== oldTokenizerBackend ||
      this.config.yomitanApiUrl !== oldYomitanApiUrl ||
      this.config.yomitanScanLength !== oldYomitanScanLength
    );
    if (backendChanged) {
      this.mecabAvailable = false;
      if (this.isUsingYomitanApi()) {
        this.yomitanApiReachable = false;
      }
      this.tokenCacheByBlock.clear();
      this.pendingTokenizationByBlock.clear();
      this.prefetchTokenizationForAllBlocks();
      this.updateModeIndicatorText();
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
      autoConfirmSelection: this.config.autoConfirmSelection !== false,
      mecabAvailable: this.mecabAvailable,
      tokenizerBackend: this.config.tokenizerBackend,
      yomitanApiReachable: this.yomitanApiReachable,
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
      this.prefetchTokenizationForAllBlocks();
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
    this.clearPendingMineCandidate();

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



