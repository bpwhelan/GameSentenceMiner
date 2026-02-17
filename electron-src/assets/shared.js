// Shared bridge for legacy HTML pages loaded inside the React shell.
// Use `var` declarations to avoid redeclaration errors when this file
// is included more than once in the same page context.

var __gsmBridgeIpc =
    window.ipcRenderer ||
    window.parent?.ipcRenderer ||
    window.top?.ipcRenderer;

var __gsmBridgeClipboard =
    window.clipboard ||
    window.parent?.clipboard ||
    window.top?.clipboard;

var __gsmBridgeEnv =
    window.gsmEnv ||
    window.parent?.gsmEnv ||
    window.top?.gsmEnv ||
    { platform: "win32" };

// Legacy globals expected by existing HTML scripts.
var ipcRenderer = __gsmBridgeIpc;
var clipboard = __gsmBridgeClipboard;
var isWindows = __gsmBridgeEnv.platform === "win32";
var isMac = __gsmBridgeEnv.platform === "darwin";
var isLinux = __gsmBridgeEnv.platform === "linux";

if (!window.__gsmSharedStateListeners) {
    window.__gsmSharedStateListeners = new Map();
}

var __gsmStateListeners = window.__gsmSharedStateListeners;

function __gsmNoopAsync() {
    return Promise.resolve();
}

function __gsmNoopValue(defaultValue) {
    return Promise.resolve(defaultValue === undefined ? null : defaultValue);
}

if (!window.sharedState) {
    window.sharedState = {
        setState: __gsmNoopAsync,
        getState: function (_key, defaultValue) {
            return __gsmNoopValue(defaultValue);
        },
        removeState: __gsmNoopAsync,
        getAllState: function () {
            return Promise.resolve({});
        },
        clearAllState: __gsmNoopAsync,
        onStateChanged: function () {
            return function () {};
        },
        onAnyStateChanged: function () {
            return function () {};
        },
    };
}

if (__gsmBridgeIpc && typeof __gsmBridgeIpc.invoke === "function") {
    window.sharedState.setState = function (key, value) {
        return __gsmBridgeIpc.invoke("state.set", key, value);
    };

    window.sharedState.getState = function (key, defaultValue) {
        return __gsmBridgeIpc.invoke("state.get", key).then(function (value) {
            return value !== undefined ? value : (defaultValue === undefined ? null : defaultValue);
        });
    };

    window.sharedState.removeState = function (key) {
        return __gsmBridgeIpc.invoke("state.remove", key);
    };

    window.sharedState.getAllState = function () {
        return __gsmBridgeIpc.invoke("state.getAll");
    };

    window.sharedState.clearAllState = function () {
        return __gsmBridgeIpc.invoke("state.clear");
    };

    window.sharedState.onStateChanged = function (key, callback) {
        if (!__gsmStateListeners.has(key)) {
            __gsmStateListeners.set(key, new Set());
        }
        __gsmStateListeners.get(key).add(callback);

        return function () {
            var listeners = __gsmStateListeners.get(key);
            if (!listeners) return;
            listeners.delete(callback);
            if (listeners.size === 0) {
                __gsmStateListeners.delete(key);
            }
        };
    };

    window.sharedState.onAnyStateChanged = function (callback) {
        return window.sharedState.onStateChanged("*", callback);
    };

    if (!window.__gsmStateChangedListenerAttached && typeof __gsmBridgeIpc.on === "function") {
        window.__gsmStateChangedListenerAttached = true;

        __gsmBridgeIpc.on("state-changed", function (_event, payload) {
            var key = payload?.key;
            var value = payload?.value;
            var oldValue = payload?.oldValue;

            var keyListeners = __gsmStateListeners.get(key);
            if (keyListeners) {
                keyListeners.forEach(function (callback) {
                    try {
                        callback(value, oldValue);
                    } catch (error) {
                        console.error('Error in state listener for key "' + key + '":', error);
                    }
                });
            }

            var wildcardListeners = __gsmStateListeners.get("*");
            if (wildcardListeners) {
                wildcardListeners.forEach(function (callback) {
                    try {
                        callback({ key: key, value: value, oldValue: oldValue });
                    } catch (error) {
                        console.error("Error in wildcard state listener:", error);
                    }
                });
            }
        });
    }
}

// Keep both property and identifier-style access compatible with legacy scripts.
window.isWindows = isWindows;
window.isMac = isMac;
window.isLinux = isLinux;
var sharedState = window.sharedState;
