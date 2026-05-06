# Yomitan Update Instructions

## Get latest Yomitan Chrome extension zip

https://github.com/yomidevs/yomitan/releases/latest


## IMPORTANT: In popup.js, add event dispatchers for popup shown/hidden

```javascript
    /**
     * @param {import('dynamic-property').EventArgument<boolean, 'change'>} event
     */
    _onVisibleChange({value}) {
        if (this._visibleValue === value) { return; }
        this._visibleValue = value;
        this._frame.style.setProperty('visibility', value ? 'visible' : 'hidden', 'important');
        void this._invokeSafe('displayVisibilityChanged', {value});
        if (value) {
            window.dispatchEvent(new CustomEvent('yomitan-popup-shown'));
        } else {
            window.dispatchEvent(new CustomEvent('yomitan-popup-hidden'));
        }
    }
``` 

## IMPORTANT: In display-anki.js, add external mining trigger hook + postMessage listener

This lets external code trigger Anki note creation without keyboard simulation.

**File:** `yomitan/js/display/display-anki.js`

**Location:** In the `prepare()` method, add at the end after the existing event listeners:

```javascript
    prepare() {
        this._noteContext = this._getNoteContext();
        /* eslint-disable @stylistic/no-multi-spaces */
        this._display.hotkeyHandler.registerActions([
            ['addNote',     this._hotkeySaveAnkiNoteForSelectedEntry.bind(this)],
            ['viewNotes',   this._hotkeyViewNotesForSelectedEntry.bind(this)],
        ]);
        /* eslint-enable @stylistic/no-multi-spaces */
        this._display.on('optionsUpdated', this._onOptionsUpdated.bind(this));
        this._display.on('contentClear', this._onContentClear.bind(this));
        this._display.on('contentUpdateStart', this._onContentUpdateStart.bind(this));
        this._display.on('contentUpdateComplete', this._onContentUpdateComplete.bind(this));
        this._display.on('logDictionaryEntryData', this._onLogDictionaryEntryData.bind(this));
        
        // GSM Overlay integration - simple external trigger
        const handleMiningTrigger = (cardFormatIndex = 0) => {
            try {
                this._hotkeySaveAnkiNoteForSelectedEntry(String(cardFormatIndex));
            } catch (e) {
                console.log('[Yomitan] gsm-trigger-anki-add handler error:', e);
            }
        };

        // Expose a direct hook on window
        // eslint-disable-next-line unicorn/prefer-add-event-listener
        window.gsmTriggerAnkiAdd = (cardFormatIndex = 0) => {
            console.log('[Yomitan] gsmTriggerAnkiAdd called', cardFormatIndex);
            handleMiningTrigger(cardFormatIndex);
        };

        // Listen for postMessage triggers
        window.addEventListener('message', (event) => {
            try {
                if (event?.data?.type === 'gsm-trigger-anki-add') {
                    const idx = event.data.cardFormatIndex ?? 0;
                    console.log('[Yomitan] postMessage gsm-trigger-anki-add received', idx);
                    handleMiningTrigger(idx);
                }
            } catch (e) {
                console.log('[Yomitan] postMessage handler error:', e);
            }
        });

        console.log('[Yomitan] GSM mining trigger listeners registered (window hook + postMessage)');
    }
```

**Usage from external code:**
```javascript
// Option 1: call the hook (if you can reach the Yomitan window)
window.gsmTriggerAnkiAdd(0);

// Option 2: postMessage (works cross-frame)
window.postMessage({ type: 'gsm-trigger-anki-add', cardFormatIndex: 0 }, '*');
```

## IMPORTANT: In display-anki.js, dispatch event on successful note save

**File:** `yomitan/js/display/display-anki.js`

**Location:** In `_saveAnkiNote` method, in the success `else` block (after `this._hideErrorNotification(true)`).

```javascript
        if (allErrors.length > 0) {
            this._showErrorNotification(allErrors);
        } else {
            this._hideErrorNotification(true);

            // Signal overlay that mining occurred
            try {
                window.dispatchEvent(new CustomEvent('gsm-anki-note-added'));
            } catch (e) {
                // ignore
            }
        }
```

## Unzip the contents of the zip into `GSM_Overlay/yomitan/`

## Update `GSM_Overlay/yomitan/data/schemas/options-schema.json` to disable layoutAwareScan by default, this is due to weird behavior in overlay

```json
{
    "type": "object",
    "properties": {
        "layoutAwareScan": {
            "type": "boolean",
            "default": false
        }
    }

                                        "selectText": {
                                        "type": "boolean",
                                        "default": false
                                    },
}
```

## Update `getAllPermissions` in `yomitan\js\data\permissions-util.js` to include to apply the yomininja permissions fix

```javascript
/**
 * @returns {Promise<chrome.permissions.Permissions>}
 */
export function getAllPermissions() {
        // YomiNinja workaround | Applied at 1737613286523
        return {
            "origins": [
                "<all_urls>",
                "chrome://favicon/*",
                "file:///*",
                "http://*/*",
                "https://*/*"
            ],
            "permissions": [
                "clipboardWrite",
                "storage",
                "unlimitedStorage",
                "webRequest",
                "webRequestBlocking"
            ]
        };
    return new Promise((resolve, reject) => {
        chrome.permissions.getAll((result) => {
            const e = chrome.runtime.lastError;
            if (e) {
                reject(new Error(e.message));
            } else {
                resolve(result);
            }
        });
    });
}
```


## Optionally, not sure if I'm going to actually do this, but update `GSM_Overlay/yomitan/js/language/text-scanner.js` to force layoutAwareScan to false due to weird behavior in overlay

```javascript
        if (typeof layoutAwareScan === 'boolean') {
            this._layoutAwareScan = false; // force layoutAwareScan to false due weird behavior
        }
```

Additionally force `selectText` to false to avoid automatic selection in overlay:

```javascript
        if (typeof selectText === 'boolean') {
            this._selectText = false;
        }
```

## Update `GSM_Overlay/yomitan/js/language/text-scanner.js` to force terminationCharacterMode to "newlines" to get everything

## Update Scan modifiers to include/exclude arrays to empty arrays to get everything NOT SURE IF THIS IS TOTALLY DESIRED, walked this back for now.

```javascript
        if (typeof sentenceParsingOptions === 'object' && sentenceParsingOptions !== null) {
            let {scanExtent, terminationCharacterMode, terminationCharacters} = sentenceParsingOptions;
            terminationCharacterMode = "newlines" // force to newlines to get everything
            if (typeof scanExtent === 'number') {
                this._sentenceScanExtent = scanExtent;
            }

            // 1508
            include: [],
            exclude: [],
```


## REVERTED, DO NOT DO THIS ONE. Update `GSM_Overlay/yomitan/js/app/frontend.js` to force autoHideResults to true for overlay, walked this back
```javascript
    _onSearchEmpty() {
        const scanningOptions = /** @type {import('settings').ProfileOptions} */ (this._options).scanning;
        // FORCE this option for overlay
        // if (scanningOptions.autoHideResults) {
            this._clearSelectionDelayed(scanningOptions.hideDelay, false, false);
        // }
    }
```