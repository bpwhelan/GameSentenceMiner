// GSM Overlay <-> Jiten Reader settings bridge.
//
// Runs as a content script alongside ajb.js. Listens for window.postMessage
// requests of type 'gsm-jiten-settings-request' and replies with the relevant
// SRS highlighting configuration drawn from chrome.storage.local. This lets
// the overlay piggyback on the user's Jiten Reader settings (markIPlus1,
// markTopX, newStates, etc.) without duplicating the UI.
//
// Protocol:
//   request : { type: 'gsm-jiten-settings-request', requestId }
//   response: { type: 'gsm-jiten-settings-response', requestId, data, error? }
//
// `data` is a plain object containing the settings the overlay understands.
// Unknown / missing keys are simply omitted; the consumer falls back to its
// own defaults.

(function () {
  'use strict';

  // Only run in the top frame to avoid duplicate replies on framed pages.
  try {
    if (window.top !== window) return;
  } catch (_) {
    return;
  }

  // chrome.storage may be unavailable in some content-script contexts; bail
  // gracefully if so. The overlay will fall back to defaults.
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    return;
  }

  // Known setting keys the overlay cares about. Values mirror the names used
  // by Jiten Reader's existing options UI. Anything else is ignored.
  var RELEVANT_KEYS = [
    'markIPlus1',
    'markTopX',
    'markTopXCount',
    'markAllTypes',
    'markOnlyFrequent',
    'minSentenceLength',
    'newStates',
    'activeProfile',
    'profiles',
  ];

  function readSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(null, function (all) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({});
            return;
          }
          var out = {};
          if (!all || typeof all !== 'object') {
            resolve(out);
            return;
          }
          // Pass through any matching top-level keys verbatim.
          for (var i = 0; i < RELEVANT_KEYS.length; i++) {
            var k = RELEVANT_KEYS[i];
            if (Object.prototype.hasOwnProperty.call(all, k)) {
              out[k] = all[k];
            }
          }
          // Jiten Reader stores per-profile values as `profile:<id>:<key>`.
          // If an active profile is set, lift its values to the top level so
          // the consumer doesn't need to know about the profile scheme.
          var activeProfile = out.activeProfile || all.activeProfile;
          if (activeProfile) {
            var prefix = 'profile:' + activeProfile + ':';
            for (var key in all) {
              if (!Object.prototype.hasOwnProperty.call(all, key)) continue;
              if (key.indexOf(prefix) !== 0) continue;
              var shortKey = key.slice(prefix.length);
              if (RELEVANT_KEYS.indexOf(shortKey) === -1) continue;
              // Profile-scoped values win over top-level fallbacks.
              out[shortKey] = all[key];
            }
          }
          resolve(out);
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  window.addEventListener('message', function (event) {
    if (!event || event.source !== window) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'gsm-jiten-settings-request') return;
    var requestId = msg.requestId;
    readSettings().then(function (data) {
      try {
        window.postMessage({
          type: 'gsm-jiten-settings-response',
          requestId: requestId,
          data: data,
        }, '*');
      } catch (_) { /* swallow */ }
    }).catch(function (err) {
      try {
        window.postMessage({
          type: 'gsm-jiten-settings-response',
          requestId: requestId,
          data: {},
          error: String((err && err.message) || err),
        }, '*');
      } catch (_) { /* swallow */ }
    });
  });

  // Announce availability so consumers can skip polling on slow loads.
  try {
    window.postMessage({ type: 'gsm-jiten-settings-ready' }, '*');
  } catch (_) { /* swallow */ }
})();
