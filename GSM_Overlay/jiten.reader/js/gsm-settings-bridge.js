// GSM Overlay <-> Jiten Reader settings bridge.
//
// Runs as a content script alongside ajb.js. Listens for window.postMessage
// requests of type 'gsm-jiten-settings-request' and replies with the relevant
// SRS highlighting configuration from chrome.storage.local. This lets GSM reuse
// the user's active Jiten Reader profile settings without duplicating the UI.

(function () {
  'use strict';

  try {
    if (window.top !== window) return;
  } catch (_) {
    return;
  }

  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    return;
  }

  var PROFILES_STATE_KEY = '__profiles__';
  var DEFAULT_PROFILE_ID = 'default';
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
    'showGradingActions',
    'jitenUseTwoGrades',
    'jitenDisableReviews',
  ];

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function parseJson(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (_) {
      return value;
    }
  }

  function getActiveProfileId(all) {
    var profilesRaw = all[PROFILES_STATE_KEY];
    var profilesState = parseJson(profilesRaw);
    if (
      profilesState &&
      typeof profilesState.activeProfileId === 'string' &&
      profilesState.activeProfileId
    ) {
      return profilesState.activeProfileId;
    }

    var legacyActiveProfile = all.activeProfile;
    if (typeof legacyActiveProfile === 'string' && legacyActiveProfile) {
      return legacyActiveProfile;
    }

    return DEFAULT_PROFILE_ID;
  }

  function getProfileValue(all, activeProfileId, key) {
    var profileKey = 'profile:' + activeProfileId + ':' + key;
    if (hasOwn(all, profileKey)) {
      return all[profileKey];
    }
    if (hasOwn(all, key)) {
      return all[key];
    }
    return undefined;
  }

  function readSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(null, function (items) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({});
            return;
          }

          var all = items && typeof items === 'object' ? items : {};
          var activeProfileId = getActiveProfileId(all);
          var out = {};

          for (var i = 0; i < RELEVANT_KEYS.length; i++) {
            var key = RELEVANT_KEYS[i];
            var value = getProfileValue(all, activeProfileId, key);
            if (typeof value !== 'undefined') {
              out[key] = value;
            }
          }

          var apiKeyValue = getProfileValue(all, activeProfileId, 'jitenApiKey');
          out.hasApiKey = typeof apiKeyValue === 'string' && apiKeyValue.trim().length > 0;
          out.parsingPaused = all.parsingPaused === true || all.parsingPaused === 'true';

          resolve(out);
        });
      } catch (_) {
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
    readSettings()
      .then(function (data) {
        try {
          window.postMessage(
            {
              type: 'gsm-jiten-settings-response',
              requestId: requestId,
              data: data,
            },
            '*',
          );
        } catch (_) {}
      })
      .catch(function (err) {
        try {
          window.postMessage(
            {
              type: 'gsm-jiten-settings-response',
              requestId: requestId,
              data: {},
              error: String((err && err.message) || err),
            },
            '*',
          );
        } catch (_) {}
      });
  });

  try {
    window.postMessage({ type: 'gsm-jiten-settings-ready' }, '*');
  } catch (_) {}
})();
