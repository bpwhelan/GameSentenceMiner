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

### 7. Add GSM Character Dictionary to Recommended Dictionaries

**File:** `yomitan/data/recommended-dictionaries.json`

**Location:** In the `ja` (Japanese) language section, within the `terms` array

**Action:** Add the GSM Character Dictionary entry after JMnedict.

**Find this code block:**
```json
            {
                "name": "JMnedict",
                "description": "A dictionary of Japanese proper names maintained by the Electronic Dictionary Research and Development Group.",
                "homepage": "https://github.com/yomidevs/jmdict-yomitan?tab=readme-ov-file#jmnedict-for-yomitan",
                "downloadUrl": "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip"
            }
        ]
    },
```

**Replace with:**
```json
            {
                "name": "JMnedict",
                "description": "A dictionary of Japanese proper names maintained by the Electronic Dictionary Research and Development Group.",
                "homepage": "https://github.com/yomidevs/jmdict-yomitan?tab=readme-ov-file#jmnedict-for-yomitan",
                "downloadUrl": "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip"
            },
            {
                "name": "GSM Character Dictionary",
                "description": "A dictionary of Japanese names from VNDB and Anilist created by GSM.",
                "homepage": "http://127.0.0.1:55000/database",
                "downloadUrl": "http://127.0.0.1:55000/api/yomitan-dict"
            }
        ]
    },
```

---

## Verification

After making all changes, verify:
1. All 7 files have been modified
2. No syntax errors were introduced
3. No additional changes were made beyond what's specified
4. The exact code blocks were replaced as shown

## Do NOT Apply

The following modifications mentioned in the original document should NOT be applied:
- Forcing `layoutAwareScan` to false in `text-scanner.js` code (only change the schema default)
- Setting include/exclude arrays to empty in scan modifiers
- Forcing `autoHideResults` behavior in `frontend.js`
