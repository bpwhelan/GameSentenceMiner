/**
 * Shared Module for GSM
 * 
 * This module provides common imports and utilities for all pages/iframes.
 * Include this ONCE in each HTML file instead of requiring electron multiple times.
 * 
 * Provides:
 * - ipcRenderer: Electron IPC communication
 * - clipboard: System clipboard access
 * - sharedState: Cross-page state management
 */

// ============================================================================
// Common Electron Imports - Available globally in all pages
// ============================================================================

const { ipcRenderer, clipboard } = require('electron');

// Make them available globally
window.ipcRenderer = ipcRenderer;
window.clipboard = clipboard;

// ============================================================================
// Shared State Manager
// ============================================================================

// Internal listener registry
const _stateListeners = new Map();
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

// const isWindows = false;
// const isMac = true;
// const isLinux = false;

/**
 * Set a state value. Notifies all windows/iframes of the change.
 * @param {string} key - The state key
 * @param {any} value - The value to store (will be JSON serialized)
 * @returns {Promise<void>}
 */
async function setState(key, value) {
    await ipcRenderer.invoke('state.set', key, value);
}

/**
 * Get a state value
 * @param {string} key - The state key
 * @param {any} defaultValue - Optional default value if key doesn't exist
 * @returns {Promise<any>}
 */
async function getState(key, defaultValue = null) {
    const value = await ipcRenderer.invoke('state.get', key);
    return value !== undefined ? value : defaultValue;
}

/**
 * Remove a state value
 * @param {string} key - The state key to remove
 * @returns {Promise<void>}
 */
async function removeState(key) {
    await ipcRenderer.invoke('state.remove', key);
}

/**
 * Get all state as an object
 * @returns {Promise<Object>}
 */
async function getAllState() {
    return await ipcRenderer.invoke('state.getAll');
}

/**
 * Clear all state
 * @returns {Promise<void>}
 */
async function clearAllState() {
    await ipcRenderer.invoke('state.clear');
}

/**
 * Listen for changes to a specific state key
 * @param {string} key - The state key to watch
 * @param {Function} callback - Called with (newValue, oldValue) when state changes
 * @returns {Function} Unsubscribe function
 */
function onStateChanged(key, callback) {
    if (!_stateListeners.has(key)) {
        _stateListeners.set(key, new Set());
    }
    _stateListeners.get(key).add(callback);
    
    // Return unsubscribe function
    return () => {
        const listeners = _stateListeners.get(key);
        if (listeners) {
            listeners.delete(callback);
            if (listeners.size === 0) {
                _stateListeners.delete(key);
            }
        }
    };
}

/**
 * Listen for any state change
 * @param {Function} callback - Called with ({ key, value, oldValue }) when any state changes
 * @returns {Function} Unsubscribe function
 */
function onAnyStateChanged(callback) {
    return onStateChanged('*', callback);
}

// Set up IPC listener for state changes from main process
ipcRenderer.on('state-changed', (event, { key, value, oldValue }) => {
    // Notify specific key listeners
    const keyListeners = _stateListeners.get(key);
    if (keyListeners) {
        keyListeners.forEach(callback => {
            try {
                callback(value, oldValue);
            } catch (error) {
                console.error(`Error in state listener for key "${key}":`, error);
            }
        });
    }
    
    // Notify wildcard listeners
    const wildcardListeners = _stateListeners.get('*');
    if (wildcardListeners) {
        wildcardListeners.forEach(callback => {
            try {
                callback({ key, value, oldValue });
            } catch (error) {
                console.error('Error in wildcard state listener:', error);
            }
        });
    }
});

// Export the sharedState API globally
window.sharedState = {
    setState,
    getState,
    removeState,
    getAllState,
    clearAllState,
    onStateChanged,
    onAnyStateChanged
};

// Also export as module for those who prefer imports
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ipcRenderer,
        clipboard,
        sharedState: window.sharedState
    };
}

console.log('✅ GSM Shared Module Loaded');
