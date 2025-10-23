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


## Update `GSM_Overlay/yomitan/js/app/frontend.js` to force autoHideResults to true for overlay, walked this back
```javascript
    _onSearchEmpty() {
        const scanningOptions = /** @type {import('settings').ProfileOptions} */ (this._options).scanning;
        // FORCE this option for overlay
        // if (scanningOptions.autoHideResults) {
            this._clearSelectionDelayed(scanningOptions.hideDelay, false, false);
        // }
    }
```