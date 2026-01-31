# Yomitan Update Automation Prompt

You are tasked with applying specific code modifications to the Yomitan extension files. Make ONLY the changes specified below. Do not make any additional modifications or improvements. If it looks like these changes have already been made, do not reapply them. Make sure the spacing and formatting of the code remains consistent with the existing code.

## Prerequisites
- The latest Yomitan Chrome extension has been unzipped into `GSM_Overlay/yomitan/`
- You have write access to all files in the yomitan directory

## Required Modifications

### 1. Add Event Dispatchers to popup.js

**File:** `yomitan/js/display/popup.js`

**Location:** In the `_onVisibleChange` method

**Action:** Add the window event dispatchers at the end of the method, after the existing `invokeSafe` call.

**Find this code block:**
```javascript
    _onVisibleChange({value}) {
        if (this._visibleValue === value) { return; }
        this._visibleValue = value;
        this._frame.style.setProperty('visibility', value ? 'visible' : 'hidden', 'important');
        void this._invokeSafe('displayVisibilityChanged', {value});
    }
```

**Replace with:**
```javascript
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

---

### 2. Disable layoutAwareScan by Default

**File:** `yomitan/data/schemas/options-schema.json`

**Location:** In the `layoutAwareScan` property definition

**Action:** Change the default value from `true` to `false`.

**Find this code block:**
```json
                                        "layoutAwareScan": {
                                            "type": "boolean",
                                            "default": true
                                        },
```

**Replace with:**
```json
                                        "layoutAwareScan": {
                                            "type": "boolean",
                                            "default": false
                                        },
```

---

### 3. Disable selectText by Default

**File:** `yomitan/data/schemas/options-schema.json`

**Location:** In the `selectText` property definition

**Action:** Change the default value from `true` to `false`.

**Find this code block:**
```json
                                        "selectText": {
                                            "type": "boolean",
                                            "default": true
                                        },
```

**Replace with:**
```json
                                        "selectText": {
                                            "type": "boolean",
                                            "default": false
                                        },
```

---

### 4. Apply YomiNinja Permissions Fix

**File:** `yomitan/js/data/permissions-util.js`

**Location:** The entire `getAllPermissions` function

**Action:** Replace the function to return hardcoded permissions instead of querying Chrome API.

**Find this code block:**
```javascript
export function getAllPermissions() {
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

**Replace with:**
```javascript
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

---

### 5. Force terminationCharacterMode to "newlines"

**File:** `yomitan/js/language/text-scanner.js`

**Location:** In the setter for sentenceParsingOptions, before the `terminationCharacterMode` validation

**Action:** Add a line to force the mode to "newlines".

**Find this code block:**
```javascript
        if (typeof sentenceParsingOptions === 'object' && sentenceParsingOptions !== null) {
            let {scanExtent, terminationCharacterMode, terminationCharacters} = sentenceParsingOptions;
            if (typeof scanExtent === 'number') {
```

**Replace with:**
```javascript
        if (typeof sentenceParsingOptions === 'object' && sentenceParsingOptions !== null) {
            let {scanExtent, terminationCharacterMode, terminationCharacters} = sentenceParsingOptions;
            terminationCharacterMode = "newlines"; // force to newlines to get everything
            if (typeof scanExtent === 'number') {
```

---

### 6. Add 'overlay' Tag to All Anki Notes

**File:** `yomitan/js/display/display-anki.js`

**Location:** In the `_onOptionsUpdated` method, where `this._noteTags` is set

**Action:** Spread the existing tags array and append 'overlay' to it.

**Find this code block:**
```javascript
        this._noteGuiMode = noteGuiMode;
        this._noteTags = tags;
```

**Replace with:**
```javascript
        this._noteGuiMode = noteGuiMode;
        this._noteTags = [...tags, 'overlay'];
```

---

### 7. Add External Mining Trigger Hook + postMessage Listener

**File:** `yomitan/js/display/display-anki.js`

**Location:** In the `prepare` method, after the existing event listeners

**Action:** Expose `window.gsmTriggerAnkiAdd` and handle `postMessage` events with `type: "gsm-trigger-anki-add"`.

**Find this code block:**
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
    }
```

**Replace with:**
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

---

### 8. Dispatch gsm-anki-note-added event on successful note save

**File:** `yomitan/js/display/display-anki.js`

**Location:** In `_saveAnkiNote` method, in the success `else` block (after `this._hideErrorNotification(true)`).

**Action:** Add code to dispatch the custom event.

**Find this code block:**
```javascript
        if (allErrors.length > 0) {
            this._showErrorNotification(allErrors);
        } else {
            this._hideErrorNotification(true);
        }
```

**Replace with:**
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

---

## Verification

After making all changes, verify:
1. All 8 modifications have been applied
2. No syntax errors were introduced
3. No additional changes were made beyond what's specified
4. The exact code blocks were replaced as shown

## Do NOT Apply

The following modifications mentioned in the original document should NOT be applied:
- Forcing `layoutAwareScan` to false in `text-scanner.js` code (only change the schema default)
- Setting include/exclude arrays to empty in scan modifiers
- Forcing `autoHideResults` behavior in `frontend.js`
