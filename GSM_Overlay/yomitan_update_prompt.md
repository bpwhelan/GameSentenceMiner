# Yomitan Update Automation Prompt

You are tasked with applying specific code modifications to the Yomitan extension files. Make ONLY the changes specified below. Do not make any additional modifications or improvements. If it looks like these changes have already been made, do not reapply them. Make sure the spacing and formatting of the code remains consistent with the existing code.

## Prerequisites
- The latest Yomitan Chrome extension has been unzipped into `GSM_Overlay/yomitan/`
- You have write access to all files in the yomitan directory

## Required Modifications

### 1. Add Event Dispatchers to popup.js

**File:** `yomitan/js/app/popup.js`

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

### 6. Force selectText Off in text-scanner.js

**File:** `yomitan/js/language/text-scanner.js`

**Location:** In the options setter, where `selectText` is assigned to `this._selectText`.

**Action:** Force `this._selectText` to `false`.

**Find this code block:**
```javascript
        if (typeof selectText === 'boolean') {
            this._selectText = selectText;
        }
```

**Replace with:**
```javascript
        if (typeof selectText === 'boolean') {
            this._selectText = false; // force selectText off due weird behavior
        }
```

---

### 7. Add 'overlay' Tag to All Anki Notes

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

### 8. Add External Mining Trigger Hook + postMessage Listener

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
                "homepage": "http://127.0.0.1:7275/database",
                "downloadUrl": "http://127.0.0.1:7275/api/yomitan-dict"
            }
        ]
    },
```

---

### 9. Dispatch gsm-anki-note-added event on successful note save

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

### 10. Remove Electron-Specific "Radical fix" CSS in structured-content.css

**File:** `yomitan/css/structured-content.css`

**Location:** In `.gloss-image-container-overlay` and `.gloss-image`.

**Action:** Remove the `pointer-events`/`z-index` overrides on the overlay, and remove forced visibility/opacity/pointer-events overrides on the image.

**Find this code block:**
```css
.gloss-image-container-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: var(--background-color-light2);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    user-select: none;
    table-layout: fixed;
    white-space: normal;
    color: var(--text-color-light3);
    /* Radical fix: Ensure overlay doesn't block image visibility */
    pointer-events: none;
    z-index: 1;
}
```

**Replace with:**
```css
.gloss-image-container-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: var(--background-color-light2);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    user-select: none;
    table-layout: fixed;
    white-space: normal;
    color: var(--text-color-light3);
}
```

**Find this code block:**
```css
.gloss-image {
    position: relative;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border: none;
    outline: none;
    /* Radical fix: Force visibility in Electron */
    visibility: visible !important;
    opacity: 1 !important;
    pointer-events: auto !important;
}
```

**Replace with:**
```css
.gloss-image {
    position: relative;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border: none;
    outline: none;
}
```

---

### 11. Restore OffscreenCanvas Media Loading in display-content-manager.js

**File:** `yomitan/js/display/display-content-manager.js`

**Location:** `loadMedia` and `executeMediaRequests`

**Action:** Use OffscreenCanvas-based pipeline (call `drawMedia`), remove the blob URL-based Electron workaround.

**Find this code block:**
```javascript
    /**
     * Queues loading media file from a given dictionary.
     * @param {string} path
     * @param {string} dictionary
     * @param {HTMLImageElement|HTMLCanvasElement} element
     */
    loadMedia(path, dictionary, element) {
        this._loadMediaRequests.push({path, dictionary, element});
    }
```

**Replace with:**
```javascript
    /**
     * Queues loading media file from a given dictionary.
     * @param {string} path
     * @param {string} dictionary
     * @param {OffscreenCanvas} canvas
     */
    loadMedia(path, dictionary, canvas) {
        this._loadMediaRequests.push({path, dictionary, canvas});
    }
```

**Find this code block:**
```javascript
    /**
     * Execute media requests
     */
    async executeMediaRequests() {
        // Radical fix: Load images directly as blob URLs instead of using canvas
        console.log(`[DisplayContentManager] Executing ${this._loadMediaRequests.length} media requests`);
        
        for (const {path, dictionary, element} of this._loadMediaRequests) {
            try {
                console.log(`[DisplayContentManager] Loading media: path=${path}, dictionary=${dictionary}`);
                const data = await this._display.application.api.getMedia([{path, dictionary}]);
                
                if (data && data.length > 0 && data[0].content) {
                    console.log(`[DisplayContentManager] Media data received, type=${data[0].mediaType}`);
                    const buffer = base64ToArrayBuffer(data[0].content);
                    const blob = new Blob([buffer], {type: data[0].mediaType});
                    const blobUrl = URL.createObjectURL(blob);
                    console.log(`[DisplayContentManager] Created blob URL: ${blobUrl}`);
                    
                    if (element instanceof HTMLImageElement) {
                        // Force display immediately
                        element.style.display = 'inline-block';
                        element.style.visibility = 'visible';
                        element.style.opacity = '1';
                        
                        element.onload = () => {
                            console.log(`[DisplayContentManager] Image loaded successfully: ${path}`);
                            const link = element.closest('.gloss-image-link');
                            if (link) {
                                link.dataset.imageLoadState = 'loaded';
                                link.dataset.hasImage = 'true';
                            }
                        };
                        element.onerror = (e) => {
                            console.error(`[DisplayContentManager] Image load error:`, e, path);
                            const link = element.closest('.gloss-image-link');
                            if (link) {
                                link.dataset.imageLoadState = 'load-error';
                            }
                        };
                        
                        // Set src last to trigger load
                        element.src = blobUrl;
                        
                    } else if (element instanceof HTMLCanvasElement) {
                        // Fallback for canvas elements
                        const img = new Image();
                        img.onload = () => {
                            console.log(`[DisplayContentManager] Canvas image loaded: ${path}`);
                            const ctx = element.getContext('2d');
                            if (ctx) {
                                element.width = img.naturalWidth || element.width;
                                element.height = img.naturalHeight || element.height;
                                ctx.drawImage(img, 0, 0, element.width, element.height);
                                const link = element.closest('.gloss-image-link');
                                if (link) {
                                    link.dataset.imageLoadState = 'loaded';
                                    link.dataset.hasImage = 'true';
                                }
                            }
                            URL.revokeObjectURL(blobUrl);
                        };
                        img.onerror = (e) => {
                            console.error(`[DisplayContentManager] Canvas image error:`, e, path);
                            const link = element.closest('.gloss-image-link');
                            if (link) {
                                link.dataset.imageLoadState = 'load-error';
                            }
                            URL.revokeObjectURL(blobUrl);
                        };
                        img.src = blobUrl;
                    }
                } else {
                    console.error(`[DisplayContentManager] No media data received for ${path}`);
                }
            } catch (error) {
                console.error('[DisplayContentManager] Failed to load media:', error, path, dictionary);
                const link = element.closest('.gloss-image-link');
                if (link) {
                    link.dataset.imageLoadState = 'load-error';
                }
            }
        }
        this._loadMediaRequests = [];
    }
```

**Replace with:**
```javascript
    /**
     * Execute media requests
     */
    async executeMediaRequests() {
        this._display.application.api.drawMedia(this._loadMediaRequests, this._loadMediaRequests.map(({canvas}) => canvas));
        this._loadMediaRequests = [];
    }
```

---

### 12. Use OffscreenCanvas for DisplayContentManager Images in structured-content-generator.js

**File:** `yomitan/js/display/structured-content-generator.js`

**Location:** In the image creation block when `this._contentManager !== null`.

**Action:** Use `canvas` (transferred to OffscreenCanvas) for `DisplayContentManager`, otherwise keep `img` for `AnkiTemplateRendererContentManager`.

**Find this code block:**
```javascript
        if (this._contentManager !== null) {
            // Radical fix: Always use img elements instead of canvas for Electron compatibility
            const image = /** @type {HTMLImageElement} */ (this._createElement('img', 'gloss-image'));
            if (sizeUnits === 'em' && (hasPreferredWidth || hasPreferredHeight)) {
```

**Replace with:**
```javascript
        if (this._contentManager !== null) {
            const image = this._contentManager instanceof DisplayContentManager ?
                /** @type {HTMLCanvasElement} */ (this._createElement('canvas', 'gloss-image')) :
                /** @type {HTMLImageElement} */ (this._createElement('img', 'gloss-image'));
            if (sizeUnits === 'em' && (hasPreferredWidth || hasPreferredHeight)) {
```

**Find this code block:**
```javascript
            if (this._contentManager instanceof DisplayContentManager) {
                // Use img element directly instead of transferring control to offscreen canvas
                this._contentManager.loadMedia(
                    path,
                    dictionary,
                    image,
                );
            } else if (this._contentManager instanceof AnkiTemplateRendererContentManager) {
```

**Replace with:**
```javascript
            if (this._contentManager instanceof DisplayContentManager) {
                this._contentManager.loadMedia(
                    path,
                    dictionary,
                    (/** @type {HTMLCanvasElement} */(image)).transferControlToOffscreen(),
                );
            } else if (this._contentManager instanceof AnkiTemplateRendererContentManager) {
```

---

### 13. Fix Glossary Structured Content Traversal in anki-template-renderer.js

**File:** `yomitan/js/templates/anki-template-renderer.js`

**Location:** `_extractGlossaryStructuredContentRecursive` and `_extractGlossaryData`

**Action:** Avoid mutating arrays using `shift()`; use indexed loops and introduce `_convertGlossaryStructuredContentRecursive`.

**Find this code block:**
```javascript
    _extractGlossaryStructuredContentRecursive(content) {
        /** @type {import('structured-content.js').Content[]} */
        const extractedContent = [];
        while (content.length > 0) {
            const structuredContent = content.shift();
            if (Array.isArray(structuredContent)) {
                extractedContent.push(...this._extractGlossaryStructuredContentRecursive(structuredContent));
            } else if (typeof structuredContent === 'object' && structuredContent) {
                if (structuredContent.tag === 'ruby') {
                    extractedContent.push(structuredContent);
                    continue;
                }
                extractedContent.push(...this._extractGlossaryStructuredContentRecursive([structuredContent.content]));
            } else {
                extractedContent.push(structuredContent);
            }
        }
        return extractedContent;
    }
```

**Replace with:**
```javascript
    _extractGlossaryStructuredContentRecursive(content) {
        /** @type {import('structured-content.js').Content[]} */
        const extractedContent = [];
        for (let i = 0; i < content.length; i++) {
            const structuredContent = content[i];
            if (Array.isArray(structuredContent)) {
                extractedContent.push(...this._extractGlossaryStructuredContentRecursive(structuredContent));
            } else if (typeof structuredContent === 'object' && structuredContent) {
                if (structuredContent.tag === 'ruby') {
                    extractedContent.push(structuredContent);
                    continue;
                }
                extractedContent.push(...this._extractGlossaryStructuredContentRecursive([structuredContent.content]));
            } else {
                extractedContent.push(structuredContent);
            }
        }
        return extractedContent;
    }
```

**Find this code block:**
```javascript
    /**
     * @param {import('dictionary-data').TermGlossaryStructuredContent} content
     * @param {StructuredContentGenerator} structuredContentGenerator
     * @returns {string[]}
     */
    _extractGlossaryData(content, structuredContentGenerator) {
        /** @type {import('structured-content.js').Content[]} */
        const glossaryContentQueue = this._extractGlossaryStructuredContentRecursive([content.content]);

        /** @type {string[]} */
        const rawGlossaryContent = [];
        while (glossaryContentQueue.length > 0) {
            const structuredGloss = glossaryContentQueue.shift();
            if (typeof structuredGloss === 'string') {
                rawGlossaryContent.push(structuredGloss);
            } else if (Array.isArray(structuredGloss)) {
                glossaryContentQueue.push(...structuredGloss);
            } else if (typeof structuredGloss === 'object' && structuredGloss.content) {
                if (structuredGloss.tag === 'ruby') {
                    const node = structuredContentGenerator.createStructuredContent(structuredGloss.content, '');
                    rawGlossaryContent.push(node !== null ? this._getStructuredContentText(node) : '');
                    continue;
                }
                glossaryContentQueue.push(structuredGloss.content);
            }
        }
        return rawGlossaryContent;
    }
```

**Replace with:**
```javascript
    /**
     * @param {import('structured-content.js').Content[]} content
     * @param {StructuredContentGenerator} structuredContentGenerator
     * @returns {string[]}
     */
    _convertGlossaryStructuredContentRecursive(content, structuredContentGenerator) {
        /** @type {string[]} */
        const rawGlossaryContent = [];
        for (let i = 0; i < content.length; i++) {
            const structuredGloss = content[i];
            if (typeof structuredGloss === 'string') {
                rawGlossaryContent.push(structuredGloss);
            } else if (Array.isArray(structuredGloss)) {
                rawGlossaryContent.push(...this._convertGlossaryStructuredContentRecursive(structuredGloss, structuredContentGenerator));
            } else if (typeof structuredGloss === 'object' && structuredGloss.content) {
                if (structuredGloss.tag === 'ruby') {
                    const node = structuredContentGenerator.createStructuredContent(structuredGloss.content, '');
                    rawGlossaryContent.push(node !== null ? this._getStructuredContentText(node) : '');
                    continue;
                }
                rawGlossaryContent.push(...this._convertGlossaryStructuredContentRecursive([structuredGloss.content], structuredContentGenerator));
            }
        }
        return rawGlossaryContent;
    }

    /**
     * @param {import('dictionary-data').TermGlossaryStructuredContent} content
     * @param {StructuredContentGenerator} structuredContentGenerator
     * @returns {string[]}
     */
    _extractGlossaryData(content, structuredContentGenerator) {
        /** @type {import('structured-content.js').Content[]} */
        const glossaryContentQueue = this._extractGlossaryStructuredContentRecursive([content.content]);

        /** @type {string[]} */
        return this._convertGlossaryStructuredContentRecursive(glossaryContentQueue, structuredContentGenerator);
    }
```

## Verification

After making all changes, verify:
1. All 13 modifications have been applied
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
