/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
import {AccessibilityController} from '../accessibility/accessibility-controller.js';
import {AnkiConnect} from '../comm/anki-connect.js';
import {ClipboardMonitor} from '../comm/clipboard-monitor.js';
import {ClipboardReader} from '../comm/clipboard-reader.js';
import {Mecab} from '../comm/mecab.js';
import {YomitanApi} from '../comm/yomitan-api.js';
import {createApiMap, invokeApiMapHandler} from '../core/api-map.js';
import {ExtensionError} from '../core/extension-error.js';
import {fetchText} from '../core/fetch-utilities.js';
import {logErrorLevelToNumber} from '../core/log-utilities.js';
import {log} from '../core/log.js';
import {isObjectNotArray} from '../core/object-utilities.js';
import {clone, deferPromise, promiseTimeout} from '../core/utilities.js';
import {generateAnkiNoteMediaFileName, INVALID_NOTE_ID, isNoteDataValid} from '../data/anki-util.js';
import {arrayBufferToBase64} from '../data/array-buffer-util.js';
import {OptionsUtil} from '../data/options-util.js';
import {getAllPermissions, hasPermissions, hasRequiredPermissionsForOptions} from '../data/permissions-util.js';
import {DictionaryDatabase} from '../dictionary/dictionary-database.js';
import {Environment} from '../extension/environment.js';
import {ObjectPropertyAccessor} from '../general/object-property-accessor.js';
import {distributeFuriganaInflected, isCodePointJapanese, convertKatakanaToHiragana as jpConvertKatakanaToHiragana} from '../language/ja/japanese.js';
import {getLanguageSummaries, isTextLookupWorthy} from '../language/languages.js';
import {Translator} from '../language/translator.js';
import {AudioDownloader} from '../media/audio-downloader.js';
import {getFileExtensionFromAudioMediaType, getFileExtensionFromImageMediaType} from '../media/media-util.js';
import {ClipboardReaderProxy, DictionaryDatabaseProxy, OffscreenProxy, TranslatorProxy} from './offscreen-proxy.js';
import {createSchema, normalizeContext} from './profile-conditions-util.js';
import {RequestBuilder} from './request-builder.js';
import {injectStylesheet} from './script-manager.js';

/**
 * This class controls the core logic of the extension, including API calls
 * and various forms of communication between browser tabs and external applications.
 */
export class Backend {
    /**
     * @param {import('../extension/web-extension.js').WebExtension} webExtension
     */
    constructor(webExtension) {
        /** @type {import('../extension/web-extension.js').WebExtension} */
        this._webExtension = webExtension;
        /** @type {Environment} */
        this._environment = new Environment();
        /** @type {AnkiConnect} */
        this._anki = new AnkiConnect();
        /** @type {Mecab} */
        this._mecab = new Mecab();

        if (!chrome.offscreen) {
            /** @type {?OffscreenProxy} */
            this._offscreen = null;
            /** @type {DictionaryDatabase|DictionaryDatabaseProxy} */
            this._dictionaryDatabase = new DictionaryDatabase();
            /** @type {Translator|TranslatorProxy} */
            this._translator = new Translator(this._dictionaryDatabase);
            /** @type {ClipboardReader|ClipboardReaderProxy} */
            this._clipboardReader = new ClipboardReader(
                (typeof document === 'object' && document !== null ? document : null),
                '#clipboard-paste-target',
                '#clipboard-rich-content-paste-target',
            );
        } else {
            /** @type {?OffscreenProxy} */
            this._offscreen = new OffscreenProxy(webExtension);
            /** @type {DictionaryDatabase|DictionaryDatabaseProxy} */
            this._dictionaryDatabase = new DictionaryDatabaseProxy(this._offscreen);
            /** @type {Translator|TranslatorProxy} */
            this._translator = new TranslatorProxy(this._offscreen);
            /** @type {ClipboardReader|ClipboardReaderProxy} */
            this._clipboardReader = new ClipboardReaderProxy(this._offscreen);
        }

        /** @type {ClipboardMonitor} */
        this._clipboardMonitor = new ClipboardMonitor(this._clipboardReader);
        /** @type {?import('settings').Options} */
        this._options = null;
        /** @type {import('../data/json-schema.js').JsonSchema[]} */
        this._profileConditionsSchemaCache = [];
        /** @type {?string} */
        this._ankiClipboardImageFilenameCache = null;
        /** @type {?string} */
        this._ankiClipboardImageDataUrlCache = null;
        /** @type {?string} */
        this._defaultAnkiFieldTemplates = null;
        /** @type {RequestBuilder} */
        this._requestBuilder = new RequestBuilder();
        /** @type {AudioDownloader} */
        this._audioDownloader = new AudioDownloader(this._requestBuilder);
        /** @type {OptionsUtil} */
        this._optionsUtil = new OptionsUtil();
        /** @type {AccessibilityController} */
        this._accessibilityController = new AccessibilityController();

        /** @type {?number} */
        this._searchPopupTabId = null;
        /** @type {?Promise<{tab: chrome.tabs.Tab, created: boolean}>} */
        this._searchPopupTabCreatePromise = null;

        /** @type {boolean} */
        this._isPrepared = false;
        /** @type {boolean} */
        this._prepareError = false;
        /** @type {?Promise<void>} */
        this._preparePromise = null;
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const {promise, resolve, reject} = deferPromise();
        /** @type {Promise<void>} */
        this._prepareCompletePromise = promise;
        /** @type {() => void} */
        this._prepareCompleteResolve = resolve;
        /** @type {(reason?: unknown) => void} */
        this._prepareCompleteReject = reject;

        /** @type {?string} */
        this._defaultBrowserActionTitle = null;
        /** @type {?import('core').Timeout} */
        this._badgePrepareDelayTimer = null;
        /** @type {?import('log').LogLevel} */
        this._logErrorLevel = null;
        /** @type {?chrome.permissions.Permissions} */
        this._permissions = null;
        /** @type {Map<string, (() => void)[]>} */
        this._applicationReadyHandlers = new Map();

        /* eslint-disable @stylistic/no-multi-spaces */
        /** @type {import('api').ApiMap} */
        this._apiMap = createApiMap([
            ['applicationReady',             this._onApiApplicationReady.bind(this)],
            ['requestBackendReadySignal',    this._onApiRequestBackendReadySignal.bind(this)],
            ['optionsGet',                   this._onApiOptionsGet.bind(this)],
            ['optionsGetFull',               this._onApiOptionsGetFull.bind(this)],
            ['kanjiFind',                    this._onApiKanjiFind.bind(this)],
            ['termsFind',                    this._onApiTermsFind.bind(this)],
            ['parseText',                    this._onApiParseText.bind(this)],
            ['getAnkiConnectVersion',        this._onApiGetAnkiConnectVersion.bind(this)],
            ['isAnkiConnected',              this._onApiIsAnkiConnected.bind(this)],
            ['addAnkiNote',                  this._onApiAddAnkiNote.bind(this)],
            ['updateAnkiNote',               this._onApiUpdateAnkiNote.bind(this)],
            ['getAnkiNoteInfo',              this._onApiGetAnkiNoteInfo.bind(this)],
            ['injectAnkiNoteMedia',          this._onApiInjectAnkiNoteMedia.bind(this)],
            ['viewNotes',                    this._onApiViewNotes.bind(this)],
            ['suspendAnkiCardsForNote',      this._onApiSuspendAnkiCardsForNote.bind(this)],
            ['commandExec',                  this._onApiCommandExec.bind(this)],
            ['getTermAudioInfoList',         this._onApiGetTermAudioInfoList.bind(this)],
            ['sendMessageToFrame',           this._onApiSendMessageToFrame.bind(this)],
            ['broadcastTab',                 this._onApiBroadcastTab.bind(this)],
            ['frameInformationGet',          this._onApiFrameInformationGet.bind(this)],
            ['injectStylesheet',             this._onApiInjectStylesheet.bind(this)],
            ['getStylesheetContent',         this._onApiGetStylesheetContent.bind(this)],
            ['getEnvironmentInfo',           this._onApiGetEnvironmentInfo.bind(this)],
            ['clipboardGet',                 this._onApiClipboardGet.bind(this)],
            ['getZoom',                      this._onApiGetZoom.bind(this)],
            ['getDefaultAnkiFieldTemplates', this._onApiGetDefaultAnkiFieldTemplates.bind(this)],
            ['getDictionaryInfo',            this._onApiGetDictionaryInfo.bind(this)],
            ['purgeDatabase',                this._onApiPurgeDatabase.bind(this)],
            ['getMedia',                     this._onApiGetMedia.bind(this)],
            ['logGenericErrorBackend',       this._onApiLogGenericErrorBackend.bind(this)],
            ['logIndicatorClear',            this._onApiLogIndicatorClear.bind(this)],
            ['modifySettings',               this._onApiModifySettings.bind(this)],
            ['getSettings',                  this._onApiGetSettings.bind(this)],
            ['setAllSettings',               this._onApiSetAllSettings.bind(this)],
            ['getOrCreateSearchPopup',       this._onApiGetOrCreateSearchPopup.bind(this)],
            ['isTabSearchPopup',             this._onApiIsTabSearchPopup.bind(this)],
            ['triggerDatabaseUpdated',       this._onApiTriggerDatabaseUpdated.bind(this)],
            ['testMecab',                    this._onApiTestMecab.bind(this)],
            ['testYomitanApi',               this._onApiTestYomitanApi.bind(this)],
            ['isTextLookupWorthy',           this._onApiIsTextLookupWorthy.bind(this)],
            ['getTermFrequencies',           this._onApiGetTermFrequencies.bind(this)],
            ['findAnkiNotes',                this._onApiFindAnkiNotes.bind(this)],
            ['openCrossFramePort',           this._onApiOpenCrossFramePort.bind(this)],
            ['getLanguageSummaries',         this._onApiGetLanguageSummaries.bind(this)],
            ['heartbeat',                    this._onApiHeartbeat.bind(this)],
            ['forceSync',                    this._onApiForceSync.bind(this)],
        ]);

        /** @type {import('api').PmApiMap} */
        this._pmApiMap = createApiMap([
            ['connectToDatabaseWorker', this._onPmConnectToDatabaseWorker.bind(this)],
            ['registerOffscreenPort',   this._onPmApiRegisterOffscreenPort.bind(this)],
        ]);
        /* eslint-enable @stylistic/no-multi-spaces */

        /** @type {Map<string, (params?: import('core').SerializableObject) => void>} */
        this._commandHandlers = new Map(/** @type {[name: string, handler: (params?: import('core').SerializableObject) => void][]} */ ([
            ['toggleTextScanning', this._onCommandToggleTextScanning.bind(this)],
            ['openInfoPage', this._onCommandOpenInfoPage.bind(this)],
            ['openSettingsPage', this._onCommandOpenSettingsPage.bind(this)],
            ['openSearchPage', this._onCommandOpenSearchPage.bind(this)],
            ['openPopupWindow', this._onCommandOpenPopupWindow.bind(this)],
        ]));

        /** @type {YomitanApi} */
        this._yomitanApi = new YomitanApi(this._apiMap, this._offscreen);
    }

    /**
     * Initializes the instance.
     * @returns {Promise<void>} A promise which is resolved when initialization completes.
     */
    prepare() {
        if (this._preparePromise === null) {
            const promise = this._prepareInternal();
            promise.then(
                () => {
                    this._isPrepared = true;
                    this._prepareCompleteResolve();
                },
                (error) => {
                    this._prepareError = true;
                    this._prepareCompleteReject(error);
                },
            );
            void promise.finally(() => this._updateBadge());
            this._preparePromise = promise;
        }
        return this._prepareCompletePromise;
    }

    // Private

    /**
     * @returns {void}
     */
    _prepareInternalSync() {
        if (isObjectNotArray(chrome.commands) && isObjectNotArray(chrome.commands.onCommand)) {
            const onCommand = this._onWebExtensionEventWrapper(this._onCommand.bind(this));
            chrome.commands.onCommand.addListener(onCommand);
        }

        if (isObjectNotArray(chrome.tabs) && isObjectNotArray(chrome.tabs.onZoomChange)) {
            const onZoomChange = this._onWebExtensionEventWrapper(this._onZoomChange.bind(this));
            chrome.tabs.onZoomChange.addListener(onZoomChange);
        }

        const onMessage = this._onMessageWrapper.bind(this);
        chrome.runtime.onMessage.addListener(onMessage);

        // On Chrome, this is for receiving messages sent with navigator.serviceWorker, which has the benefit of being able to transfer objects, but doesn't accept callbacks
        (/** @type {ServiceWorkerGlobalScope & typeof globalThis} */ (globalThis)).addEventListener('message', this._onPmMessage.bind(this));
        (/** @type {ServiceWorkerGlobalScope & typeof globalThis} */ (globalThis)).addEventListener('messageerror', this._onPmMessageError.bind(this));

        if (this._canObservePermissionsChanges()) {
            const onPermissionsChanged = this._onWebExtensionEventWrapper(this._onPermissionsChanged.bind(this));
            chrome.permissions.onAdded.addListener(onPermissionsChanged);
            chrome.permissions.onRemoved.addListener(onPermissionsChanged);
        }

        chrome.runtime.onInstalled.addListener(this._onInstalled.bind(this));
    }

    /** @type {import('api').PmApiHandler<'connectToDatabaseWorker'>} */
    async _onPmConnectToDatabaseWorker(_params, ports) {
        if (ports !== null && ports.length > 0) {
            await this._dictionaryDatabase.connectToDatabaseWorker(ports[0]);
        }
    }

    /** @type {import('api').PmApiHandler<'registerOffscreenPort'>} */
    async _onPmApiRegisterOffscreenPort(_params, ports) {
        if (ports !== null && ports.length > 0) {
            await this._offscreen?.registerOffscreenPort(ports[0]);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _prepareInternal() {
        try {
            this._prepareInternalSync();

            this._permissions = await getAllPermissions();
            this._defaultBrowserActionTitle = this._getBrowserIconTitle();
            this._badgePrepareDelayTimer = setTimeout(() => {
                this._badgePrepareDelayTimer = null;
                this._updateBadge();
            }, 1000);
            this._updateBadge();

            log.on('logGenericError', this._onLogGenericError.bind(this));

            await this._requestBuilder.prepare();
            await this._environment.prepare();
            if (this._offscreen !== null) {
                await this._offscreen.prepare();
            }
            this._clipboardReader.browser = this._environment.getInfo().browser;

            // if this is Firefox and therefore not running in Service Worker, we need to use a SharedWorker to setup a MessageChannel to postMessage with the popup
            if (self.constructor.name === 'Window') {
                const sharedWorkerBridge = new SharedWorker(new URL('../comm/shared-worker-bridge.js', import.meta.url), {type: 'module'});
                sharedWorkerBridge.port.postMessage({action: 'registerBackendPort'});
                sharedWorkerBridge.port.addEventListener('message', (/** @type {MessageEvent} */ e) => {
                    // connectToBackend2
                    e.ports[0].onmessage = this._onPmMessage.bind(this);
                });
                sharedWorkerBridge.port.addEventListener('messageerror', this._onPmMessageError.bind(this));
                sharedWorkerBridge.port.start();
            }
            try {
                await this._dictionaryDatabase.prepare();
            } catch (e) {
                log.error(e);
            }

            void this._translator.prepare();

            await this._optionsUtil.prepare();
            this._defaultAnkiFieldTemplates = (await fetchText('/data/templates/default-anki-field-templates.handlebars')).trim();
            this._options = await this._optionsUtil.load();

            this._applyOptions('background');

            this._attachOmniboxListener();

            const options = this._getProfileOptions({current: true}, false);
            if (options.general.showGuide) {
                void this._openWelcomeGuidePageOnce();
            }

            this._clipboardMonitor.on('change', this._onClipboardTextChange.bind(this));

            this._sendMessageAllTabsIgnoreResponse({action: 'applicationBackendReady'});
            this._sendMessageIgnoreResponse({action: 'applicationBackendReady'});
        } catch (e) {
            log.error(e);
            throw e;
        } finally {
            if (this._badgePrepareDelayTimer !== null) {
                clearTimeout(this._badgePrepareDelayTimer);
                this._badgePrepareDelayTimer = null;
            }
        }
    }

    // Event handlers

    /**
     * @param {import('clipboard-monitor').EventArgument<'change'>} details
     */
    async _onClipboardTextChange({text}) {
        // Only update if tab does not exist
        if (await this._tabExists('/search.html')) { return; }

        const {
            general: {language},
            clipboard: {maximumSearchLength},
        } = this._getProfileOptions({current: true}, false);
        if (!isTextLookupWorthy(text, language)) { return; }
        if (text.length > maximumSearchLength) {
            text = text.substring(0, maximumSearchLength);
        }
        try {
            const {tab, created} = await this._getOrCreateSearchPopupWrapper();
            const {id} = tab;
            if (typeof id !== 'number') {
                throw new Error('Tab does not have an id');
            }
            await this._focusTab(tab);
            await this._updateSearchQuery(id, text, !created);
        } catch (e) {
            // NOP
        }
    }

    /**
     * @param {import('log').Events['logGenericError']} params
     */
    _onLogGenericError({level}) {
        const levelValue = logErrorLevelToNumber(level);
        const currentLogErrorLevel = this._logErrorLevel !== null ? logErrorLevelToNumber(this._logErrorLevel) : 0;
        if (levelValue <= currentLogErrorLevel) { return; }

        this._logErrorLevel = level;
        this._updateBadge();
    }

    // WebExtension event handlers (with prepared checks)

    /**
     * @template {(...args: import('core').SafeAny[]) => void} T
     * @param {T} handler
     * @returns {T}
     */
    _onWebExtensionEventWrapper(handler) {
        return /** @type {T} */ ((...args) => {
            if (this._isPrepared) {
                // This is using SafeAny to just forward the parameters
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                handler(...args);
                return;
            }

            this._prepareCompletePromise.then(
                () => {
                    // This is using SafeAny to just forward the parameters
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                    handler(...args);
                },
                () => {}, // NOP
            );
        });
    }

    /** @type {import('extension').ChromeRuntimeOnMessageCallback<import('api').ApiMessageAny>} */
    _onMessageWrapper(message, sender, sendResponse) {
        if (this._isPrepared) {
            return this._onMessage(message, sender, sendResponse);
        }

        this._prepareCompletePromise.then(
            () => { this._onMessage(message, sender, sendResponse); },
            () => { sendResponse(); },
        );
        return true;
    }

    // WebExtension event handlers

    /**
     * @param {string} command
     */
    _onCommand(command) {
        this._runCommand(command, void 0);
    }

    /**
     * @param {import('api').ApiMessageAny} message
     * @param {chrome.runtime.MessageSender} sender
     * @param {(response?: unknown) => void} callback
     * @returns {boolean}
     */
    _onMessage({action, params}, sender, callback) {
        return invokeApiMapHandler(this._apiMap, action, params, [sender], callback);
    }

    /**
     * @param {MessageEvent<import('api').PmApiMessageAny>} event
     * @returns {boolean}
     */
    _onPmMessage(event) {
        const {action, params} = event.data;
        return invokeApiMapHandler(this._pmApiMap, action, params, [event.ports], () => {});
    }

    /**
     * @param {MessageEvent<import('api').PmApiMessageAny>} event
     */
    _onPmMessageError(event) {
        const error = new ExtensionError('Backend: Error receiving message via postMessage');
        error.data = event;
        log.error(error);
    }


    /**
     * @param {chrome.tabs.ZoomChangeInfo} event
     */
    _onZoomChange({tabId, oldZoomFactor, newZoomFactor}) {
        this._sendMessageTabIgnoreResponse(tabId, {action: 'applicationZoomChanged', params: {oldZoomFactor, newZoomFactor}}, {});
    }

    /**
     * @returns {void}
     */
    _onPermissionsChanged() {
        void this._checkPermissions();
    }

    /**
     * @param {chrome.runtime.InstalledDetails} event
     */
    _onInstalled({reason}) {
        if (reason !== 'install') { return; }
        void this._requestPersistentStorage();
    }

    // Message handlers

    /** @type {import('api').ApiHandler<'applicationReady'>} */
    _onApiApplicationReady(_params, sender) {
        const {tab, frameId} = sender;
        if (!tab || typeof frameId !== 'number') { return; }
        const {id} = tab;
        if (typeof id !== 'number') { return; }
        const key = `${id}:${frameId}`;
        const handlers = this._applicationReadyHandlers.get(key);
        if (typeof handlers === 'undefined') { return; }
        for (const handler of handlers) {
            handler();
        }
        this._applicationReadyHandlers.delete(key);
    }

    /** @type {import('api').ApiHandler<'requestBackendReadySignal'>} */
    _onApiRequestBackendReadySignal(_params, sender) {
        // Tab ID isn't set in background (e.g. browser_action)
        /** @type {import('application').ApiMessage<'applicationBackendReady'>} */
        const data = {action: 'applicationBackendReady'};
        if (typeof sender.tab === 'undefined') {
            this._sendMessageIgnoreResponse(data);
            return false;
        } else {
            const {id} = sender.tab;
            if (typeof id === 'number') {
                this._sendMessageTabIgnoreResponse(id, data, {});
            }
            return true;
        }
    }

    /** @type {import('api').ApiHandler<'optionsGet'>} */
    _onApiOptionsGet({optionsContext}) {
        return this._getProfileOptions(optionsContext, false);
    }

    /** @type {import('api').ApiHandler<'optionsGetFull'>} */
    _onApiOptionsGetFull() {
        return this._getOptionsFull(false);
    }

    /** @type {import('api').ApiHandler<'kanjiFind'>} */
    async _onApiKanjiFind({text, optionsContext}) {
        const options = this._getProfileOptions(optionsContext, false);
        const {general: {maxResults}} = options;
        const findKanjiOptions = this._getTranslatorFindKanjiOptions(options);
        const dictionaryEntries = await this._translator.findKanji(text, findKanjiOptions);
        dictionaryEntries.splice(maxResults);
        return dictionaryEntries;
    }

    /** @type {import('api').ApiHandler<'termsFind'>} */
    async _onApiTermsFind({text, details, optionsContext}) {
        const options = this._getProfileOptions(optionsContext, false);
        const {general: {resultOutputMode: mode, maxResults}} = options;
        const findTermsOptions = this._getTranslatorFindTermsOptions(mode, details, options);
        const {dictionaryEntries, originalTextLength} = await this._translator.findTerms(mode, text, findTermsOptions);
        dictionaryEntries.splice(maxResults);
        return {dictionaryEntries, originalTextLength};
    }

    /** @type {import('api').ApiHandler<'parseText'>} */
    async _onApiParseText({text, optionsContext, scanLength, useInternalParser, useMecabParser}) {
        const [internalResults, mecabResults] = await Promise.all([
            (useInternalParser ? this._textParseScanning(text, scanLength, optionsContext) : null),
            (useMecabParser ? this._textParseMecab(text) : null),
        ]);

        /** @type {import('api').ParseTextResultItem[]} */
        const results = [];

        if (internalResults !== null) {
            results.push({
                id: 'scan',
                source: 'scanning-parser',
                dictionary: null,
                content: internalResults,
            });
        }

        if (mecabResults !== null) {
            for (const [dictionary, content] of mecabResults) {
                results.push({
                    id: `mecab-${dictionary}`,
                    source: 'mecab',
                    dictionary,
                    content,
                });
            }
        }

        return results;
    }

    /** @type {import('api').ApiHandler<'getAnkiConnectVersion'>} */
    async _onApiGetAnkiConnectVersion() {
        return await this._anki.getVersion();
    }

    /** @type {import('api').ApiHandler<'isAnkiConnected'>} */
    async _onApiIsAnkiConnected() {
        return await this._anki.isConnected();
    }

    /** @type {import('api').ApiHandler<'addAnkiNote'>} */
    async _onApiAddAnkiNote({note}) {
        return await this._anki.addNote(note);
    }

    /** @type {import('api').ApiHandler<'updateAnkiNote'>} */
    async _onApiUpdateAnkiNote({noteWithId}) {
        return await this._anki.updateNoteFields(noteWithId);
    }

    /**
     * Removes all fields except the first field from an array of notes
     * @param {import('anki').Note[]} notes
     * @returns {import('anki').Note[]}
     */
    _stripNotesArray(notes) {
        const newNotes = structuredClone(notes);
        for (let i = 0; i < newNotes.length; i++) {
            if (Object.keys(newNotes[i].fields).length === 0) { continue; }
            const [firstField, firstFieldValue] = Object.entries(newNotes[i].fields)[0];
            newNotes[i].fields = {};
            newNotes[i].fields[firstField] = firstFieldValue;
        }
        return newNotes;
    }

    /**
     * @param {import('anki').Note[]} notes
     * @returns {Promise<import('backend').CanAddResults>}
     */
    async partitionAddibleNotes(notes) {
        // strip all fields except the first from notes before dupe checking
        // minimizes the amount of data being sent and reduce network latency and AnkiConnect latency
        const strippedNotes = this._stripNotesArray(notes);

        // `allowDuplicate` is on for all notes by default, so we temporarily set it to false
        // to check which notes are duplicates.
        const notesNoDuplicatesAllowed = strippedNotes.map((note) => ({...note, options: {...note.options, allowDuplicate: false}}));

        // If only older AnkiConnect available, use `canAddNotes`.
        const withDuplicatesAllowed = await this._anki.canAddNotes(strippedNotes);
        const noDuplicatesAllowed = await this._anki.canAddNotes(notesNoDuplicatesAllowed);

        /** @type {{ note: import('anki').Note, isDuplicate: boolean }[]} */
        const canAddArray = [];

        /** @type {import('anki').Note[]} */
        const cannotAddArray = [];

        for (let i = 0; i < withDuplicatesAllowed.length; i++) {
            if (withDuplicatesAllowed[i] === noDuplicatesAllowed[i]) {
                canAddArray.push({note: notes[i], isDuplicate: false});
            } else {
                canAddArray.push({note: notes[i], isDuplicate: true});
            }
        }

        return {canAddArray, cannotAddArray};
    }

    /** @type {import('api').ApiHandler<'getAnkiNoteInfo'>} */
    async _onApiGetAnkiNoteInfo({notes, fetchAdditionalInfo}) {
        const {canAddArray, cannotAddArray} = await this.partitionAddibleNotes(notes);

        /** @type {import('anki').NoteInfoWrapper[]} */
        const results = cannotAddArray
            .filter((note) => isNoteDataValid(note))
            .map(() => ({canAdd: false, valid: false, noteIds: null}));

        /** @type {import('anki').Note[]} */
        const duplicateNotes = [];

        /** @type {number[]} */
        const originalIndices = [];

        for (let i = 0; i < canAddArray.length; i++) {
            if (canAddArray[i].isDuplicate) {
                duplicateNotes.push(canAddArray[i].note);
                // Keep original indices to locate duplicate inside `duplicateNoteIds`
                originalIndices.push(i);
            }
        }

        const duplicateNoteIds = await this._anki.findNoteIds(duplicateNotes);

        for (let i = 0; i < canAddArray.length; ++i) {
            const {note, isDuplicate} = canAddArray[i];

            const valid = isNoteDataValid(note);

            if (isDuplicate && duplicateNoteIds[originalIndices.indexOf(i)].length === 0) {
                duplicateNoteIds[originalIndices.indexOf(i)] = [INVALID_NOTE_ID];
            }

            const noteIds = isDuplicate ? duplicateNoteIds[originalIndices.indexOf(i)] : null;
            const noteInfos = (fetchAdditionalInfo && noteIds !== null && noteIds.length > 0) ? await this._notesCardsInfo(noteIds) : [];

            const info = {
                canAdd: valid,
                valid,
                noteIds: noteIds,
                noteInfos: noteInfos,
            };

            results.push(info);
        }

        return results;
    }

    /**
     * @param {number[]} noteIds
     * @returns {Promise<(?import('anki').NoteInfo)[]>}
     */
    async _notesCardsInfo(noteIds) {
        const notesInfo = await this._anki.notesInfo(noteIds);
        /** @type {number[]} */
        // @ts-expect-error - ts is not smart enough to realize that filtering !!x removes null and undefined
        const cardIds = notesInfo.flatMap((x) => x?.cards).filter((x) => !!x);
        const cardsInfo = await this._anki.cardsInfo(cardIds);
        for (let i = 0; i < notesInfo.length; i++) {
            if (notesInfo[i] !== null) {
                const cardInfo = cardsInfo.find((x) => x?.noteId === notesInfo[i]?.noteId);
                if (cardInfo) {
                    notesInfo[i]?.cardsInfo.push(cardInfo);
                }
            }
        }
        return notesInfo;
    }

    /** @type {import('api').ApiHandler<'injectAnkiNoteMedia'>} */
    async _onApiInjectAnkiNoteMedia({timestamp, definitionDetails, audioDetails, screenshotDetails, clipboardDetails, dictionaryMediaDetails}) {
        return await this._injectAnkNoteMedia(
            this._anki,
            timestamp,
            definitionDetails,
            audioDetails,
            screenshotDetails,
            clipboardDetails,
            dictionaryMediaDetails,
        );
    }

    /** @type {import('api').ApiHandler<'viewNotes'>} */
    async _onApiViewNotes({noteIds, mode, allowFallback}) {
        if (noteIds.length === 1 && mode === 'edit') {
            try {
                await this._anki.guiEditNote(noteIds[0]);
                return 'edit';
            } catch (e) {
                if (!(e instanceof Error && this._anki.isErrorUnsupportedAction(e))) {
                    throw e;
                } else if (!allowFallback) {
                    throw new Error('Mode not supported');
                }
            }
        }
        await this._anki.guiBrowseNotes(noteIds);
        return 'browse';
    }

    /** @type {import('api').ApiHandler<'suspendAnkiCardsForNote'>} */
    async _onApiSuspendAnkiCardsForNote({noteId}) {
        const cardIds = await this._anki.findCardsForNote(noteId);
        const count = cardIds.length;
        if (count > 0) {
            const okay = await this._anki.suspendCards(cardIds);
            if (!okay) { return 0; }
        }
        return count;
    }

    /** @type {import('api').ApiHandler<'commandExec'>} */
    _onApiCommandExec({command, params}) {
        return this._runCommand(command, params);
    }

    /** @type {import('api').ApiHandler<'getTermAudioInfoList'>} */
    async _onApiGetTermAudioInfoList({source, term, reading, languageSummary}) {
        return await this._audioDownloader.getTermAudioInfoList(source, term, reading, languageSummary);
    }

    /** @type {import('api').ApiHandler<'sendMessageToFrame'>} */
    _onApiSendMessageToFrame({frameId: targetFrameId, message}, sender) {
        if (!sender) { return false; }
        const {tab} = sender;
        if (!tab) { return false; }
        const {id} = tab;
        if (typeof id !== 'number') { return false; }
        const {frameId} = sender;
        /** @type {import('application').ApiMessageAny} */
        const message2 = {...message, frameId};
        this._sendMessageTabIgnoreResponse(id, message2, {frameId: targetFrameId});
        return true;
    }

    /** @type {import('api').ApiHandler<'broadcastTab'>} */
    _onApiBroadcastTab({message}, sender) {
        if (!sender) { return false; }
        const {tab} = sender;
        if (!tab) { return false; }
        const {id} = tab;
        if (typeof id !== 'number') { return false; }
        const {frameId} = sender;
        /** @type {import('application').ApiMessageAny} */
        const message2 = {...message, frameId};
        this._sendMessageTabIgnoreResponse(id, message2, {});
        return true;
    }

    /** @type {import('api').ApiHandler<'frameInformationGet'>} */
    _onApiFrameInformationGet(_params, sender) {
        const tab = sender.tab;
        const tabId = tab ? tab.id : void 0;
        const frameId = sender.frameId;
        return {
            tabId: typeof tabId === 'number' ? tabId : null,
            frameId: typeof frameId === 'number' ? frameId : null,
        };
    }

    /** @type {import('api').ApiHandler<'injectStylesheet'>} */
    async _onApiInjectStylesheet({type, value}, sender) {
        const {frameId, tab} = sender;
        if (typeof tab !== 'object' || tab === null || typeof tab.id !== 'number') { throw new Error('Invalid tab'); }
        return await injectStylesheet(type, value, tab.id, frameId, false);
    }

    /** @type {import('api').ApiHandler<'getStylesheetContent'>} */
    async _onApiGetStylesheetContent({url}) {
        if (!url.startsWith('/') || url.startsWith('//') || !url.endsWith('.css')) {
            throw new Error('Invalid URL');
        }
        return await fetchText(url);
    }

    /** @type {import('api').ApiHandler<'getEnvironmentInfo'>} */
    _onApiGetEnvironmentInfo() {
        return this._environment.getInfo();
    }

    /** @type {import('api').ApiHandler<'clipboardGet'>} */
    async _onApiClipboardGet() {
        return this._clipboardReader.getText(false);
    }

    /** @type {import('api').ApiHandler<'getZoom'>} */
    _onApiGetZoom(_params, sender) {
        return new Promise((resolve, reject) => {
            if (!sender || !sender.tab) {
                reject(new Error('Invalid tab'));
                return;
            }

            const tabId = sender.tab.id;
            if (!(
                typeof tabId === 'number' &&
                chrome.tabs !== null &&
                typeof chrome.tabs === 'object' &&
                typeof chrome.tabs.getZoom === 'function'
            )) {
                // Not supported
                resolve({zoomFactor: 1});
                return;
            }
            chrome.tabs.getZoom(tabId, (zoomFactor) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve({zoomFactor});
                }
            });
        });
    }

    /** @type {import('api').ApiHandler<'getDefaultAnkiFieldTemplates'>} */
    _onApiGetDefaultAnkiFieldTemplates() {
        return /** @type {string} */ (this._defaultAnkiFieldTemplates);
    }

    /** @type {import('api').ApiHandler<'getDictionaryInfo'>} */
    async _onApiGetDictionaryInfo() {
        return await this._dictionaryDatabase.getDictionaryInfo();
    }

    /** @type {import('api').ApiHandler<'purgeDatabase'>} */
    async _onApiPurgeDatabase() {
        await this._dictionaryDatabase.purge();
        this._triggerDatabaseUpdated('dictionary', 'purge');
    }

    /** @type {import('api').ApiHandler<'getMedia'>} */
    async _onApiGetMedia({targets}) {
        return await this._getNormalizedDictionaryDatabaseMedia(targets);
    }

    /** @type {import('api').ApiHandler<'logGenericErrorBackend'>} */
    _onApiLogGenericErrorBackend({error, level, context}) {
        log.logGenericError(ExtensionError.deserialize(error), level, context);
    }

    /** @type {import('api').ApiHandler<'logIndicatorClear'>} */
    _onApiLogIndicatorClear() {
        if (this._logErrorLevel === null) { return; }
        this._logErrorLevel = null;
        this._updateBadge();
    }

    /** @type {import('api').ApiHandler<'modifySettings'>} */
    _onApiModifySettings({targets, source}) {
        return this._modifySettings(targets, source);
    }

    /** @type {import('api').ApiHandler<'getSettings'>} */
    _onApiGetSettings({targets}) {
        const results = [];
        for (const target of targets) {
            try {
                const result = this._getSetting(target);
                results.push({result: clone(result)});
            } catch (e) {
                results.push({error: ExtensionError.serialize(e)});
            }
        }
        return results;
    }

    /** @type {import('api').ApiHandler<'setAllSettings'>} */
    async _onApiSetAllSettings({value, source}) {
        this._optionsUtil.validate(value);
        this._options = clone(value);
        await this._saveOptions(source);
    }

    /** @type {import('api').ApiHandlerNoExtraArgs<'getOrCreateSearchPopup'>} */
    async _onApiGetOrCreateSearchPopup({focus = false, text}) {
        const {tab, created} = await this._getOrCreateSearchPopupWrapper();
        if (focus === true || (focus === 'ifCreated' && created)) {
            await this._focusTab(tab);
        }
        if (typeof text === 'string') {
            const {id} = tab;
            if (typeof id === 'number') {
                await this._updateSearchQuery(id, text, !created);
            }
        }
        const {id} = tab;
        return {tabId: typeof id === 'number' ? id : null, windowId: tab.windowId};
    }

    /** @type {import('api').ApiHandler<'isTabSearchPopup'>} */
    async _onApiIsTabSearchPopup({tabId}) {
        const baseUrl = chrome.runtime.getURL('/search.html');
        const tab = typeof tabId === 'number' ? await this._checkTabUrl(tabId, (url) => url !== null && url.startsWith(baseUrl)) : null;
        return (tab !== null);
    }

    /** @type {import('api').ApiHandler<'triggerDatabaseUpdated'>} */
    _onApiTriggerDatabaseUpdated({type, cause}) {
        this._triggerDatabaseUpdated(type, cause);
    }

    /** @type {import('api').ApiHandler<'testMecab'>} */
    async _onApiTestMecab() {
        if (!this._mecab.isEnabled()) {
            throw new Error('MeCab not enabled');
        }

        let permissionsOkay = false;
        try {
            permissionsOkay = await hasPermissions({permissions: ['nativeMessaging']});
        } catch (e) {
            // NOP
        }
        if (!permissionsOkay) {
            throw new Error('Insufficient permissions');
        }

        const disconnect = !this._mecab.isConnected();
        try {
            const version = await this._mecab.getVersion();
            if (version === null) {
                throw new Error('Could not connect to native MeCab component');
            }

            const localVersion = this._mecab.getLocalVersion();
            if (version !== localVersion) {
                throw new Error(`MeCab component version not supported: ${version}`);
            }
        } finally {
            // Disconnect if the connection was previously disconnected
            if (disconnect && this._mecab.isEnabled() && this._mecab.isActive()) {
                this._mecab.disconnect();
            }
        }

        return true;
    }

    /** @type {import('api').ApiHandler<'testYomitanApi'>} */
    async _onApiTestYomitanApi({url}) {
        if (!this._yomitanApi.isEnabled()) {
            throw new Error('Yomitan Api not enabled');
        }

        let permissionsOkay = false;
        try {
            permissionsOkay = await hasPermissions({permissions: ['nativeMessaging']});
        } catch (e) {
            // NOP
        }
        if (!permissionsOkay) {
            throw new Error('Insufficient permissions');
        }

        const disconnect = !this._yomitanApi.isConnected();
        try {
            const version = await this._yomitanApi.getRemoteVersion(url);
            if (version === null) {
                throw new Error('Could not connect to native Yomitan API component');
            }

            const localVersion = this._yomitanApi.getLocalVersion();
            if (version !== localVersion) {
                throw new Error(`Yomitan API component version not supported: ${version}`);
            }
        } finally {
            // Disconnect if the connection was previously disconnected
            if (disconnect && this._yomitanApi.isEnabled()) {
                this._yomitanApi.disconnect();
            }
        }

        return true;
    }

    /** @type {import('api').ApiHandler<'isTextLookupWorthy'>} */
    _onApiIsTextLookupWorthy({text, language}) {
        return isTextLookupWorthy(text, language);
    }

    /** @type {import('api').ApiHandler<'getTermFrequencies'>} */
    async _onApiGetTermFrequencies({termReadingList, dictionaries}) {
        return await this._translator.getTermFrequencies(termReadingList, dictionaries);
    }

    /** @type {import('api').ApiHandler<'findAnkiNotes'>} */
    async _onApiFindAnkiNotes({query}) {
        return await this._anki.findNotes(query);
    }

    /** @type {import('api').ApiHandler<'openCrossFramePort'>} */
    _onApiOpenCrossFramePort({targetTabId, targetFrameId}, sender) {
        const sourceTabId = (sender && sender.tab ? sender.tab.id : null);
        if (typeof sourceTabId !== 'number') {
            throw new Error('Port does not have an associated tab ID');
        }
        const sourceFrameId = sender.frameId;
        if (typeof sourceFrameId !== 'number') {
            throw new Error('Port does not have an associated frame ID');
        }

        /** @type {import('cross-frame-api').CrossFrameCommunicationPortDetails} */
        const sourceDetails = {
            name: 'cross-frame-communication-port',
            otherTabId: targetTabId,
            otherFrameId: targetFrameId,
        };
        /** @type {import('cross-frame-api').CrossFrameCommunicationPortDetails} */
        const targetDetails = {
            name: 'cross-frame-communication-port',
            otherTabId: sourceTabId,
            otherFrameId: sourceFrameId,
        };
        /** @type {?chrome.runtime.Port} */
        let sourcePort = chrome.tabs.connect(sourceTabId, {frameId: sourceFrameId, name: JSON.stringify(sourceDetails)});
        /** @type {?chrome.runtime.Port} */
        let targetPort = chrome.tabs.connect(targetTabId, {frameId: targetFrameId, name: JSON.stringify(targetDetails)});

        const cleanup = () => {
            this._checkLastError(chrome.runtime.lastError);
            if (targetPort !== null) {
                targetPort.disconnect();
                targetPort = null;
            }
            if (sourcePort !== null) {
                sourcePort.disconnect();
                sourcePort = null;
            }
        };

        sourcePort.onMessage.addListener((message) => {
            if (targetPort !== null) { targetPort.postMessage(message); }
        });
        targetPort.onMessage.addListener((message) => {
            if (sourcePort !== null) { sourcePort.postMessage(message); }
        });
        sourcePort.onDisconnect.addListener(cleanup);
        targetPort.onDisconnect.addListener(cleanup);

        return {targetTabId, targetFrameId};
    }

    /** @type {import('api').ApiHandler<'getLanguageSummaries'>} */
    _onApiGetLanguageSummaries() {
        return getLanguageSummaries();
    }

    /** @type {import('api').ApiHandler<'heartbeat'>} */
    _onApiHeartbeat() {
        return void 0;
    }

    /** @type {import('api').ApiHandler<'forceSync'>} */
    async _onApiForceSync() {
        try {
            await this._anki.makeAnkiSync();
        } catch (e) {
            log.error(e);
            throw e;
        }
        return void 0;
    }

    // Command handlers

    /**
     * @param {undefined|{mode: import('backend').Mode, query?: string}} params
     */
    async _onCommandOpenSearchPage(params) {
        /** @type {import('backend').Mode} */
        let mode = 'existingOrNewTab';
        let query = '';
        if (typeof params === 'object' && params !== null) {
            mode = this._normalizeOpenSettingsPageMode(params.mode, mode);
            const paramsQuery = params.query;
            if (typeof paramsQuery === 'string') { query = paramsQuery; }
        }

        const baseUrl = chrome.runtime.getURL('/search.html');
        /** @type {{[key: string]: string}} */
        const queryParams = {};
        if (query.length > 0) { queryParams.query = query; }
        const queryString = new URLSearchParams(queryParams).toString();
        let queryUrl = baseUrl;
        if (queryString.length > 0) {
            queryUrl += `?${queryString}`;
        }

        /** @type {import('backend').FindTabsPredicate} */
        const predicate = ({url}) => {
            if (url === null || !url.startsWith(baseUrl)) { return false; }
            const parsedUrl = new URL(url);
            const parsedBaseUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
            const parsedMode = parsedUrl.searchParams.get('mode');
            return parsedBaseUrl === baseUrl && (parsedMode === mode || (!parsedMode && mode === 'existingOrNewTab'));
        };

        const openInTab = async () => {
            const tabInfo = /** @type {?import('backend').TabInfo} */ (await this._findTabs(1000, false, predicate, false));
            if (tabInfo !== null) {
                const {tab} = tabInfo;
                const {id} = tab;
                if (typeof id === 'number') {
                    await this._focusTab(tab);
                    if (queryParams.query) {
                        await this._updateSearchQuery(id, queryParams.query, true);
                    }
                    return true;
                }
            }
            return false;
        };

        switch (mode) {
            case 'existingOrNewTab':
                try {
                    if (await openInTab()) { return; }
                } catch (e) {
                    // NOP
                }
                await this._createTab(queryUrl);
                return;
            case 'newTab':
                await this._createTab(queryUrl);
                return;
            case 'popup':
                return;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _onCommandOpenInfoPage() {
        await this._openInfoPage();
    }

    /**
     * @param {undefined|{mode: import('backend').Mode}} params
     */
    async _onCommandOpenSettingsPage(params) {
        /** @type {import('backend').Mode} */
        let mode = 'existingOrNewTab';
        if (typeof params === 'object' && params !== null) {
            mode = this._normalizeOpenSettingsPageMode(params.mode, mode);
        }
        await this._openSettingsPage(mode);
    }

    /**
     * @returns {Promise<void>}
     */
    async _onCommandToggleTextScanning() {
        const options = this._getProfileOptions({current: true}, false);
        /** @type {import('settings-modifications').ScopedModificationSet} */
        const modification = {
            action: 'set',
            path: 'general.enable',
            value: !options.general.enable,
            scope: 'profile',
            optionsContext: {current: true},
        };
        await this._modifySettings([modification], 'backend');
    }

    /**
     * @returns {Promise<void>}
     */
    async _onCommandOpenPopupWindow() {
        await this._onApiGetOrCreateSearchPopup({focus: true});
    }

    // Utilities

    /**
     * @param {import('settings-modifications').ScopedModification[]} targets
     * @param {string} source
     * @returns {Promise<import('core').Response<import('settings-modifications').ModificationResult>[]>}
     */
    async _modifySettings(targets, source) {
        /** @type {import('core').Response<import('settings-modifications').ModificationResult>[]} */
        const results = [];
        for (const target of targets) {
            try {
                const result = this._modifySetting(target);
                results.push({result: clone(result)});
            } catch (e) {
                results.push({error: ExtensionError.serialize(e)});
            }
        }
        await this._saveOptions(source);
        return results;
    }

    /**
     * @returns {Promise<{tab: chrome.tabs.Tab, created: boolean}>}
     */
    _getOrCreateSearchPopupWrapper() {
        if (this._searchPopupTabCreatePromise === null) {
            const promise = this._getOrCreateSearchPopup();
            this._searchPopupTabCreatePromise = promise;
            void promise.then(() => { this._searchPopupTabCreatePromise = null; });
        }
        return this._searchPopupTabCreatePromise;
    }

    /**
     * @returns {Promise<{tab: chrome.tabs.Tab, created: boolean}>}
     */
    async _getOrCreateSearchPopup() {
        // Use existing tab
        const baseUrl = chrome.runtime.getURL('/search.html');
        /**
         * @param {?string} url
         * @returns {boolean}
         */
        const urlPredicate = (url) => url !== null && url.startsWith(baseUrl);
        if (this._searchPopupTabId !== null) {
            const tab = await this._checkTabUrl(this._searchPopupTabId, urlPredicate);
            if (tab !== null) {
                return {tab, created: false};
            }
            this._searchPopupTabId = null;
        }

        // Find existing tab
        const existingTabInfo = await this._findSearchPopupTab(urlPredicate);
        if (existingTabInfo !== null) {
            const existingTab = existingTabInfo.tab;
            const {id} = existingTab;
            if (typeof id === 'number') {
                this._searchPopupTabId = id;
                return {tab: existingTab, created: false};
            }
        }

        // chrome.windows not supported (e.g. on Firefox mobile)
        if (!isObjectNotArray(chrome.windows)) {
            throw new Error('Window creation not supported');
        }

        // Create a new window
        const options = this._getProfileOptions({current: true}, false);
        const createData = this._getSearchPopupWindowCreateData(baseUrl, options);
        const {popupWindow: {windowState}} = options;
        const popupWindow = await this._createWindow(createData);
        if (windowState !== 'normal' && typeof popupWindow.id === 'number') {
            await this._updateWindow(popupWindow.id, {state: windowState});
        }

        const {tabs} = popupWindow;
        if (!Array.isArray(tabs) || tabs.length === 0) {
            throw new Error('Created window did not contain a tab');
        }

        const tab = tabs[0];
        const {id} = tab;
        if (typeof id !== 'number') {
            throw new Error('Tab does not have an id');
        }
        await this._waitUntilTabFrameIsReady(id, 0, 2000);

        await this._sendMessageTabPromise(
            id,
            {action: 'searchDisplayControllerSetMode', params: {mode: 'popup'}},
            {frameId: 0},
        );

        this._searchPopupTabId = id;
        return {tab, created: true};
    }

    /**
     * @param {(url: ?string) => boolean} urlPredicate
     * @returns {Promise<?import('backend').TabInfo>}
     */
    async _findSearchPopupTab(urlPredicate) {
        /** @type {import('backend').FindTabsPredicate} */
        const predicate = async ({url, tab}) => {
            const {id} = tab;
            if (typeof id === 'undefined' || !urlPredicate(url)) { return false; }
            try {
                const mode = await this._sendMessageTabPromise(
                    id,
                    {action: 'searchDisplayControllerGetMode'},
                    {frameId: 0},
                );
                return mode === 'popup';
            } catch (e) {
                return false;
            }
        };
        return /** @type {?import('backend').TabInfo} */ (await this._findTabs(1000, false, predicate, true));
    }

    /**
     * @param {string} urlParam
     * @returns {Promise<boolean>}
     */
    async _tabExists(urlParam) {
        const baseUrl = chrome.runtime.getURL(urlParam);
        const urlPredicate = (/** @type {?string} */ url) => url !== null && url.startsWith(baseUrl);
        return await this._findSearchPopupTab(urlPredicate) !== null;
    }

    /**
     * @param {string} url
     * @param {import('settings').ProfileOptions} options
     * @returns {chrome.windows.CreateData}
     */
    _getSearchPopupWindowCreateData(url, options) {
        const {popupWindow: {width, height, left, top, useLeft, useTop, windowType}} = options;
        return {
            url,
            width,
            height,
            left: useLeft ? left : void 0,
            top: useTop ? top : void 0,
            type: windowType,
            state: 'normal',
        };
    }

    /**
     * @param {chrome.windows.CreateData} createData
     * @returns {Promise<chrome.windows.Window>}
     */
    _createWindow(createData) {
        return new Promise((resolve, reject) => {
            chrome.windows.create(
                createData,
                (result) => {
                    const error = chrome.runtime.lastError;
                    if (error) {
                        reject(new Error(error.message));
                    } else {
                        resolve(/** @type {chrome.windows.Window} */ (result));
                    }
                },
            );
        });
    }

    /**
     * @param {number} windowId
     * @param {chrome.windows.UpdateInfo} updateInfo
     * @returns {Promise<chrome.windows.Window>}
     */
    _updateWindow(windowId, updateInfo) {
        return new Promise((resolve, reject) => {
            chrome.windows.update(
                windowId,
                updateInfo,
                (result) => {
                    const error = chrome.runtime.lastError;
                    if (error) {
                        reject(new Error(error.message));
                    } else {
                        resolve(result);
                    }
                },
            );
        });
    }

    /**
     * @param {number} tabId
     * @param {string} text
     * @param {boolean} animate
     * @returns {Promise<void>}
     */
    async _updateSearchQuery(tabId, text, animate) {
        await this._sendMessageTabPromise(
            tabId,
            {action: 'searchDisplayControllerUpdateSearchQuery', params: {text, animate}},
            {frameId: 0},
        );
    }

    /**
     * @param {string} source
     */
    _applyOptions(source) {
        const options = this._getProfileOptions({current: true}, false);
        this._updateBadge();

        const enabled = options.general.enable;

        /** @type {?string} */
        let apiKey = options.anki.apiKey;
        if (apiKey === '') { apiKey = null; }
        this._anki.server = options.anki.server;
        this._anki.enabled = options.anki.enable;
        this._anki.apiKey = apiKey;

        this._mecab.setEnabled(options.parsing.enableMecabParser && enabled);

        void this._yomitanApi.setEnabled(options.general.enableYomitanApi && enabled);

        if (options.clipboard.enableBackgroundMonitor && enabled) {
            this._clipboardMonitor.start();
        } else {
            this._clipboardMonitor.stop();
        }

        this._setupContextMenu(options);

        void this._accessibilityController.update(this._getOptionsFull(false));

        this._sendMessageAllTabsIgnoreResponse({action: 'applicationOptionsUpdated', params: {source}});
    }

    /**
     * @param {import('settings').ProfileOptions} options
     */
    _setupContextMenu(options) {
        try {
            if (!chrome.contextMenus) { return; }

            if (options.general.enableContextMenuScanSelected) {
                chrome.contextMenus.create({
                    id: 'yomitan_lookup',
                    title: 'Lookup in Yomitan',
                    contexts: ['selection'],
                }, () => this._checkLastError(chrome.runtime.lastError));
                chrome.contextMenus.onClicked.addListener((info) => {
                    if (info.selectionText) {
                        this._sendMessageAllTabsIgnoreResponse({action: 'frontendScanSelectedText'});
                    }
                });
            } else {
                chrome.contextMenus.remove('yomitan_lookup', () => this._checkLastError(chrome.runtime.lastError));
            }
        } catch (e) {
            log.error(e);
        }
    }

    /** */
    _attachOmniboxListener() {
        try {
            if (!chrome.omnibox) { return; }
            chrome.omnibox.onInputEntered.addListener((text) => {
                const newURL = 'search.html?query=' + encodeURIComponent(text);
                void chrome.tabs.create({url: newURL});
            });
        } catch (e) {
            log.error(e);
        }
    }

    /**
     * @param {boolean} useSchema
     * @returns {import('settings').Options}
     * @throws {Error}
     */
    _getOptionsFull(useSchema) {
        const options = this._options;
        if (options === null) { throw new Error('Options is null'); }
        return useSchema ? /** @type {import('settings').Options} */ (this._optionsUtil.createValidatingProxy(options)) : options;
    }

    /**
     * @param {import('settings').OptionsContext} optionsContext
     * @param {boolean} useSchema
     * @returns {import('settings').ProfileOptions}
     */
    _getProfileOptions(optionsContext, useSchema) {
        return this._getProfile(optionsContext, useSchema).options;
    }

    /**
     * @param {import('settings').OptionsContext} optionsContext
     * @param {boolean} useSchema
     * @returns {import('settings').Profile}
     * @throws {Error}
     */
    _getProfile(optionsContext, useSchema) {
        const options = this._getOptionsFull(useSchema);
        const profiles = options.profiles;
        if (!optionsContext.current) {
            // Specific index
            const {index} = optionsContext;
            if (typeof index === 'number') {
                if (index < 0 || index >= profiles.length) {
                    throw this._createDataError(`Invalid profile index: ${index}`, optionsContext);
                }
                return profiles[index];
            }
            // From context
            const profile = this._getProfileFromContext(options, optionsContext);
            if (profile !== null) {
                return profile;
            }
        }
        // Default
        const {profileCurrent} = options;
        if (profileCurrent < 0 || profileCurrent >= profiles.length) {
            throw this._createDataError(`Invalid current profile index: ${profileCurrent}`, optionsContext);
        }
        return profiles[profileCurrent];
    }

    /**
     * @param {import('settings').Options} options
     * @param {import('settings').OptionsContext} optionsContext
     * @returns {?import('settings').Profile}
     */
    _getProfileFromContext(options, optionsContext) {
        const normalizedOptionsContext = normalizeContext(optionsContext);

        let index = 0;
        for (const profile of options.profiles) {
            const conditionGroups = profile.conditionGroups;

            let schema;
            if (index < this._profileConditionsSchemaCache.length) {
                schema = this._profileConditionsSchemaCache[index];
            } else {
                schema = createSchema(conditionGroups);
                this._profileConditionsSchemaCache.push(schema);
            }

            if (conditionGroups.length > 0 && schema.isValid(normalizedOptionsContext)) {
                return profile;
            }
            ++index;
        }

        return null;
    }

    /**
     * @param {string} message
     * @param {unknown} data
     * @returns {ExtensionError}
     */
    _createDataError(message, data) {
        const error = new ExtensionError(message);
        error.data = data;
        return error;
    }

    /**
     * @returns {void}
     */
    _clearProfileConditionsSchemaCache() {
        this._profileConditionsSchemaCache = [];
    }

    /**
     * @param {unknown} _ignore
     */
    _checkLastError(_ignore) {
        // NOP
    }

    /**
     * @param {string} command
     * @param {import('core').SerializableObject|undefined} params
     * @returns {boolean}
     */
    _runCommand(command, params) {
        const handler = this._commandHandlers.get(command);
        if (typeof handler !== 'function') { return false; }

        handler(params);
        return true;
    }

    /**
     * @param {string} text
     * @param {number} scanLength
     * @param {import('settings').OptionsContext} optionsContext
     * @returns {Promise<import('api').ParseTextLine[]>}
     */
    async _textParseScanning(text, scanLength, optionsContext) {
        /** @type {import('translator').FindTermsMode} */
        const mode = 'simple';
        const options = this._getProfileOptions(optionsContext, false);

        /** @type {import('api').FindTermsDetails} */
        const details = {matchType: 'exact', deinflect: true};
        const findTermsOptions = this._getTranslatorFindTermsOptions(mode, details, options);
        /** @type {import('api').ParseTextLine[]} */
        const results = [];
        let previousUngroupedSegment = null;
        let i = 0;
        const ii = text.length;
        while (i < ii) {
            const {dictionaryEntries, originalTextLength} = await this._translator.findTerms(
                mode,
                text.substring(i, i + scanLength),
                findTermsOptions,
            );
            const codePoint = /** @type {number} */ (text.codePointAt(i));
            const character = String.fromCodePoint(codePoint);
            if (
                dictionaryEntries.length > 0 &&
                originalTextLength > 0 &&
                (originalTextLength !== character.length || isCodePointJapanese(codePoint))
            ) {
                previousUngroupedSegment = null;
                const {headwords: [{term, reading}]} = dictionaryEntries[0];
                const source = text.substring(i, i + originalTextLength);
                const textSegments = [];
                for (const {text: text2, reading: reading2} of distributeFuriganaInflected(term, reading, source)) {
                    textSegments.push({text: text2, reading: reading2});
                }
                results.push(textSegments);
                i += originalTextLength;
            } else {
                if (previousUngroupedSegment === null) {
                    previousUngroupedSegment = {text: character, reading: ''};
                    results.push([previousUngroupedSegment]);
                } else {
                    previousUngroupedSegment.text += character;
                }
                i += character.length;
            }
        }
        return results;
    }

    /**
     * @param {string} text
     * @returns {Promise<import('backend').MecabParseResults>}
     */
    async _textParseMecab(text) {
        let parseTextResults;
        try {
            parseTextResults = await this._mecab.parseText(text);
        } catch (e) {
            return [];
        }

        /** @type {import('backend').MecabParseResults} */
        const results = [];
        for (const {name, lines} of parseTextResults) {
            /** @type {import('api').ParseTextLine[]} */
            const result = [];
            for (const line of lines) {
                for (const {term, reading, source} of line) {
                    const termParts = [];
                    for (const {text: text2, reading: reading2} of distributeFuriganaInflected(
                        term.length > 0 ? term : source,
                        jpConvertKatakanaToHiragana(reading),
                        source,
                    )) {
                        termParts.push({text: text2, reading: reading2});
                    }
                    result.push(termParts);
                }
                result.push([{text: '\n', reading: ''}]);
            }
            results.push([name, result]);
        }
        return results;
    }

    /**
     * @param {import('settings-modifications').OptionsScope} target
     * @returns {import('settings').Options|import('settings').ProfileOptions}
     * @throws {Error}
     */
    _getModifySettingObject(target) {
        const scope = target.scope;
        switch (scope) {
            case 'profile':
            {
                const {optionsContext} = target;
                if (typeof optionsContext !== 'object' || optionsContext === null) { throw new Error('Invalid optionsContext'); }
                return /** @type {import('settings').ProfileOptions} */ (this._getProfileOptions(optionsContext, true));
            }
            case 'global':
                return /** @type {import('settings').Options} */ (this._getOptionsFull(true));
            default:
                throw new Error(`Invalid scope: ${scope}`);
        }
    }

    /**
     * @param {import('settings-modifications').OptionsScope&import('settings-modifications').Read} target
     * @returns {unknown}
     * @throws {Error}
     */
    _getSetting(target) {
        const options = this._getModifySettingObject(target);
        const accessor = new ObjectPropertyAccessor(options);
        const {path} = target;
        if (typeof path !== 'string') { throw new Error('Invalid path'); }
        return accessor.get(ObjectPropertyAccessor.getPathArray(path));
    }

    /**
     * @param {import('settings-modifications').ScopedModification} target
     * @returns {import('settings-modifications').ModificationResult}
     * @throws {Error}
     */
    _modifySetting(target) {
        const options = this._getModifySettingObject(target);
        const accessor = new ObjectPropertyAccessor(options);
        const action = target.action;
        switch (action) {
            case 'set':
            {
                const {path, value} = target;
                if (typeof path !== 'string') { throw new Error('Invalid path'); }
                const pathArray = ObjectPropertyAccessor.getPathArray(path);
                accessor.set(pathArray, value);
                return accessor.get(pathArray);
            }
            case 'delete':
            {
                const {path} = target;
                if (typeof path !== 'string') { throw new Error('Invalid path'); }
                accessor.delete(ObjectPropertyAccessor.getPathArray(path));
                return true;
            }
            case 'swap':
            {
                const {path1, path2} = target;
                if (typeof path1 !== 'string') { throw new Error('Invalid path1'); }
                if (typeof path2 !== 'string') { throw new Error('Invalid path2'); }
                accessor.swap(ObjectPropertyAccessor.getPathArray(path1), ObjectPropertyAccessor.getPathArray(path2));
                return true;
            }
            case 'splice':
            {
                const {path, start, deleteCount, items} = target;
                if (typeof path !== 'string') { throw new Error('Invalid path'); }
                if (typeof start !== 'number' || Math.floor(start) !== start) { throw new Error('Invalid start'); }
                if (typeof deleteCount !== 'number' || Math.floor(deleteCount) !== deleteCount) { throw new Error('Invalid deleteCount'); }
                if (!Array.isArray(items)) { throw new Error('Invalid items'); }
                const array = accessor.get(ObjectPropertyAccessor.getPathArray(path));
                if (!Array.isArray(array)) { throw new Error('Invalid target type'); }
                return array.splice(start, deleteCount, ...items);
            }
            case 'push':
            {
                const {path, items} = target;
                if (typeof path !== 'string') { throw new Error('Invalid path'); }
                if (!Array.isArray(items)) { throw new Error('Invalid items'); }
                const array = accessor.get(ObjectPropertyAccessor.getPathArray(path));
                if (!Array.isArray(array)) { throw new Error('Invalid target type'); }
                const start = array.length;
                array.push(...items);
                return start;
            }
            default:
                throw new Error(`Unknown action: ${action}`);
        }
    }

    /**
     * Returns the action's default title.
     * @throws {Error}
     * @returns {string}
     */
    _getBrowserIconTitle() {
        const manifest = /** @type {chrome.runtime.ManifestV3} */ (chrome.runtime.getManifest());
        const action = manifest.action;
        if (typeof action === 'undefined') { throw new Error('Failed to find action'); }
        const defaultTitle = action.default_title;
        if (typeof defaultTitle === 'undefined') { throw new Error('Failed to find default_title'); }

        return defaultTitle;
    }

    /**
     * @returns {void}
     */
    _updateBadge() {
        let title = this._defaultBrowserActionTitle;
        if (title === null || !isObjectNotArray(chrome.action)) {
            // Not ready or invalid
            return;
        }

        let text = '';
        let color = null;
        let status = null;

        if (this._logErrorLevel !== null) {
            switch (this._logErrorLevel) {
                case 'error':
                    text = '!!';
                    color = '#f04e4e';
                    status = 'Error';
                    break;
                default: // 'warn'
                    text = '!';
                    color = '#f0ad4e';
                    status = 'Warning';
                    break;
            }
        } else if (!this._isPrepared) {
            if (this._prepareError) {
                text = '!!';
                color = '#f04e4e';
                status = 'Error';
            } else if (this._badgePrepareDelayTimer === null) {
                text = '...';
                color = '#f0ad4e';
                status = 'Loading';
            }
        } else {
            const options = this._getProfileOptions({current: true}, false);
            if (!options.general.enable) {
                text = 'off';
                color = '#555555';
                status = 'Disabled';
            } else if (!this._hasRequiredPermissionsForSettings(options)) {
                text = '!';
                color = '#f0ad4e';
                status = 'Some settings require additional permissions';
            } else if (!this._isAnyDictionaryEnabled(options)) {
                text = '!';
                color = '#f0ad4e';
                status = 'No dictionaries installed';
            }
        }

        if (color !== null && typeof chrome.action.setBadgeBackgroundColor === 'function') {
            void chrome.action.setBadgeBackgroundColor({color});
        }
        if (text !== null && typeof chrome.action.setBadgeText === 'function') {
            void chrome.action.setBadgeText({text});
        }
        if (typeof chrome.action.setTitle === 'function') {
            if (status !== null) {
                title = `${title} - ${status}`;
            }
            void chrome.action.setTitle({title});
        }
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @returns {boolean}
     */
    _isAnyDictionaryEnabled(options) {
        for (const {enabled} of options.dictionaries) {
            if (enabled) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param {number} tabId
     * @returns {Promise<?string>}
     */
    async _getTabUrl(tabId) {
        try {
            const response = await this._sendMessageTabPromise(
                tabId,
                {action: 'applicationGetUrl'},
                {frameId: 0},
            );
            const url = typeof response === 'object' && response !== null ? /** @type {import('core').SerializableObject} */ (response).url : void 0;
            if (typeof url === 'string') {
                return url;
            }
        } catch (e) {
            // NOP
        }
        return null;
    }

    /**
     * @returns {Promise<chrome.tabs.Tab[]>}
     */
    _getAllTabs() {
        return new Promise((resolve, reject) => {
            chrome.tabs.query({}, (tabs) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(tabs);
                }
            });
        });
    }

    /**
     * This function works around the need to have the "tabs" permission to access tab.url.
     * @param {number} timeout
     * @param {boolean} multiple
     * @param {import('backend').FindTabsPredicate} predicate
     * @param {boolean} predicateIsAsync
     * @returns {Promise<import('backend').TabInfo[]|(?import('backend').TabInfo)>}
     */
    async _findTabs(timeout, multiple, predicate, predicateIsAsync) {
        const tabs = await this._getAllTabs();

        let done = false;
        /**
         * @param {chrome.tabs.Tab} tab
         * @param {(tabInfo: import('backend').TabInfo) => boolean} add
         */
        const checkTab = async (tab, add) => {
            const {id} = tab;
            const url = typeof id === 'number' ? await this._getTabUrl(id) : null;

            if (done) { return; }

            let okay = false;
            const item = {tab, url};
            try {
                const okayOrPromise = predicate(item);
                okay = predicateIsAsync ? await okayOrPromise : /** @type {boolean} */ (okayOrPromise);
            } catch (e) {
                // NOP
            }

            if (okay && !done && add(item)) {
                done = true;
            }
        };

        if (multiple) {
            /** @type {import('backend').TabInfo[]} */
            const results = [];
            /**
             * @param {import('backend').TabInfo} value
             * @returns {boolean}
             */
            const add = (value) => {
                results.push(value);
                return false;
            };
            const checkTabPromises = tabs.map((tab) => checkTab(tab, add));
            await Promise.race([
                Promise.all(checkTabPromises),
                promiseTimeout(timeout),
            ]);
            return results;
        } else {
            const {promise, resolve} = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
            /** @type {?import('backend').TabInfo} */
            let result = null;
            /**
             * @param {import('backend').TabInfo} value
             * @returns {boolean}
             */
            const add = (value) => {
                result = value;
                resolve();
                return true;
            };
            const checkTabPromises = tabs.map((tab) => checkTab(tab, add));
            await Promise.race([
                promise,
                Promise.all(checkTabPromises),
                promiseTimeout(timeout),
            ]);
            resolve();
            return result;
        }
    }

    /**
     * @param {chrome.tabs.Tab} tab
     */
    async _focusTab(tab) {
        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const {id} = tab;
            if (typeof id !== 'number') {
                reject(new Error('Cannot focus a tab without an id'));
                return;
            }
            chrome.tabs.update(id, {active: true}, () => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve();
                }
            });
        }));

        if (!(typeof chrome.windows === 'object' && chrome.windows !== null)) {
            // Windows not supported (e.g. on Firefox mobile)
            return;
        }

        try {
            const tabWindow = await this._getWindow(tab.windowId);
            if (!tabWindow.focused) {
                await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
                    chrome.windows.update(tab.windowId, {focused: true}, () => {
                        const e = chrome.runtime.lastError;
                        if (e) {
                            reject(new Error(e.message));
                        } else {
                            resolve();
                        }
                    });
                }));
            }
        } catch (e) {
            // Edge throws exception for no reason here.
        }
    }

    /**
     * @param {number} windowId
     * @returns {Promise<chrome.windows.Window>}
     */
    _getWindow(windowId) {
        return new Promise((resolve, reject) => {
            chrome.windows.get(windowId, {}, (value) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(value);
                }
            });
        });
    }

    /**
     * @param {number} tabId
     * @param {number} frameId
     * @param {?number} [timeout=null]
     * @returns {Promise<void>}
     */
    _waitUntilTabFrameIsReady(tabId, frameId, timeout = null) {
        return new Promise((resolve, reject) => {
            /** @type {?import('core').Timeout} */
            let timer = null;

            const readyHandler = () => {
                cleanup();
                resolve();
            };
            const cleanup = () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                this._removeApplicationReadyHandler(tabId, frameId, readyHandler);
            };

            this._addApplicationReadyHandler(tabId, frameId, readyHandler);

            this._sendMessageTabPromise(tabId, {action: 'applicationIsReady'}, {frameId})
                .then(
                    (value) => {
                        if (!value) { return; }
                        cleanup();
                        resolve();
                    },
                    () => {}, // NOP
                );

            if (timeout !== null) {
                timer = setTimeout(() => {
                    timer = null;
                    cleanup();
                    reject(new Error('Timeout'));
                }, timeout);
            }
        });
    }

    /**
     * @template {import('application').ApiNames} TName
     * @param {import('application').ApiMessage<TName>} message
     */
    _sendMessageIgnoreResponse(message) {
        this._webExtension.sendMessageIgnoreResponse(message);
    }

    /**
     * @param {number} tabId
     * @param {import('application').ApiMessageAny} message
     * @param {chrome.tabs.MessageSendOptions} options
     */
    _sendMessageTabIgnoreResponse(tabId, message, options) {
        const callback = () => this._checkLastError(chrome.runtime.lastError);
        chrome.tabs.sendMessage(tabId, message, options, callback);
    }

    /**
     * @param {import('application').ApiMessageAny} message
     */
    _sendMessageAllTabsIgnoreResponse(message) {
        const callback = () => this._checkLastError(chrome.runtime.lastError);
        chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
                const {id} = tab;
                if (typeof id !== 'number') { continue; }
                chrome.tabs.sendMessage(id, message, callback);
            }
        });
    }

    /**
     * @template {import('application').ApiNames} TName
     * @param {number} tabId
     * @param {import('application').ApiMessage<TName>} message
     * @param {chrome.tabs.MessageSendOptions} options
     * @returns {Promise<import('application').ApiReturn<TName>>}
     */
    _sendMessageTabPromise(tabId, message, options) {
        return new Promise((resolve, reject) => {
            /**
             * @param {unknown} response
             */
            const callback = (response) => {
                try {
                    resolve(/** @type {import('application').ApiReturn<TName>} */ (this._getMessageResponseResult(response)));
                } catch (error) {
                    reject(error);
                }
            };

            chrome.tabs.sendMessage(tabId, message, options, callback);
        });
    }

    /**
     * @param {unknown} response
     * @returns {unknown}
     * @throws {Error}
     */
    _getMessageResponseResult(response) {
        const error = chrome.runtime.lastError;
        if (error) {
            throw new Error(error.message);
        }
        if (typeof response !== 'object' || response === null) {
            throw new Error('Tab did not respond');
        }
        const responseError = /** @type {import('core').Response<unknown>} */ (response).error;
        if (typeof responseError === 'object' && responseError !== null) {
            throw ExtensionError.deserialize(responseError);
        }
        return /** @type {import('core').Response<unknown>} */ (response).result;
    }

    /**
     * @param {number} tabId
     * @param {(url: ?string) => boolean} urlPredicate
     * @returns {Promise<?chrome.tabs.Tab>}
     */
    async _checkTabUrl(tabId, urlPredicate) {
        let tab;
        try {
            tab = await this._getTabById(tabId);
        } catch (e) {
            return null;
        }

        const url = await this._getTabUrl(tabId);
        const isValidTab = urlPredicate(url);
        return isValidTab ? tab : null;
    }

    /**
     * @param {number} tabId
     * @param {number} frameId
     * @param {'jpeg'|'png'} format
     * @param {number} quality
     * @returns {Promise<string>}
     */
    async _getScreenshot(tabId, frameId, format, quality) {
        const tab = await this._getTabById(tabId);
        const {windowId} = tab;

        let token = null;
        try {
            if (typeof tabId === 'number' && typeof frameId === 'number') {
                const action = 'frontendSetAllVisibleOverride';
                const params = {value: false, priority: 0, awaitFrame: true};
                token = await this._sendMessageTabPromise(tabId, {action, params}, {frameId});
            }

            return await new Promise((resolve, reject) => {
                chrome.tabs.captureVisibleTab(windowId, {format, quality}, (result) => {
                    const e = chrome.runtime.lastError;
                    if (e) {
                        reject(new Error(e.message));
                    } else {
                        resolve(result);
                    }
                });
            });
        } finally {
            if (token !== null) {
                const action = 'frontendClearAllVisibleOverride';
                const params = {token};
                try {
                    await this._sendMessageTabPromise(tabId, {action, params}, {frameId});
                } catch (e) {
                    // NOP
                }
            }
        }
    }

    /**
     * @param {AnkiConnect} ankiConnect
     * @param {number} timestamp
     * @param {import('api').InjectAnkiNoteMediaDefinitionDetails} definitionDetails
     * @param {?import('api').InjectAnkiNoteMediaAudioDetails} audioDetails
     * @param {?import('api').InjectAnkiNoteMediaScreenshotDetails} screenshotDetails
     * @param {?import('api').InjectAnkiNoteMediaClipboardDetails} clipboardDetails
     * @param {import('api').InjectAnkiNoteMediaDictionaryMediaDetails[]} dictionaryMediaDetails
     * @returns {Promise<import('api').ApiReturn<'injectAnkiNoteMedia'>>}
     */
    async _injectAnkNoteMedia(ankiConnect, timestamp, definitionDetails, audioDetails, screenshotDetails, clipboardDetails, dictionaryMediaDetails) {
        let screenshotFileName = null;
        let clipboardImageFileName = null;
        let clipboardText = null;
        let audioFileName = null;
        const errors = [];

        try {
            if (screenshotDetails !== null) {
                screenshotFileName = await this._injectAnkiNoteScreenshot(ankiConnect, timestamp, screenshotDetails);
            }
        } catch (e) {
            errors.push(ExtensionError.serialize(e));
        }

        try {
            if (clipboardDetails !== null && clipboardDetails.image) {
                clipboardImageFileName = await this._injectAnkiNoteClipboardImage(ankiConnect, timestamp);
            }
        } catch (e) {
            errors.push(ExtensionError.serialize(e));
        }

        try {
            if (clipboardDetails !== null && clipboardDetails.text) {
                clipboardText = await this._clipboardReader.getText(false);
            }
        } catch (e) {
            errors.push(ExtensionError.serialize(e));
        }

        try {
            if (audioDetails !== null) {
                audioFileName = await this._injectAnkiNoteAudio(ankiConnect, timestamp, definitionDetails, audioDetails);
            }
        } catch (e) {
            errors.push(ExtensionError.serialize(e));
        }

        /** @type {import('api').InjectAnkiNoteDictionaryMediaResult[]} */
        let dictionaryMedia;
        try {
            let errors2;
            ({results: dictionaryMedia, errors: errors2} = await this._injectAnkiNoteDictionaryMedia(ankiConnect, timestamp, dictionaryMediaDetails));
            for (const error of errors2) {
                errors.push(ExtensionError.serialize(error));
            }
        } catch (e) {
            dictionaryMedia = [];
            errors.push(ExtensionError.serialize(e));
        }

        return {
            screenshotFileName,
            clipboardImageFileName,
            clipboardText,
            audioFileName,
            dictionaryMedia,
            errors: errors,
        };
    }

    /**
     * @param {AnkiConnect} ankiConnect
     * @param {number} timestamp
     * @param {import('api').InjectAnkiNoteMediaDefinitionDetails} definitionDetails
     * @param {import('api').InjectAnkiNoteMediaAudioDetails} details
     * @returns {Promise<?string>}
     */
    async _injectAnkiNoteAudio(ankiConnect, timestamp, definitionDetails, details) {
        if (definitionDetails.type !== 'term') { return null; }
        const {term, reading} = definitionDetails;
        if (term.length === 0 && reading.length === 0) { return null; }

        const {sources, preferredAudioIndex, idleTimeout, languageSummary, enableDefaultAudioSources} = details;
        let data;
        let contentType;
        try {
            ({data, contentType} = await this._audioDownloader.downloadTermAudio(
                sources,
                preferredAudioIndex,
                term,
                reading,
                idleTimeout,
                languageSummary,
                enableDefaultAudioSources,
            ));
        } catch (e) {
            const error = this._getAudioDownloadError(e);
            if (error !== null) { throw error; }
            // No audio
            log.logGenericError(e, 'log');
            return null;
        }

        let extension = contentType !== null ? getFileExtensionFromAudioMediaType(contentType) : null;
        if (extension === null) { extension = '.mp3'; }
        let fileName = generateAnkiNoteMediaFileName('yomitan_audio', extension, timestamp);
        fileName = fileName.replace(/\]/g, '');
        return await ankiConnect.storeMediaFile(fileName, data);
    }

    /**
     * @param {AnkiConnect} ankiConnect
     * @param {number} timestamp
     * @param {import('api').InjectAnkiNoteMediaScreenshotDetails} details
     * @returns {Promise<?string>}
     */
    async _injectAnkiNoteScreenshot(ankiConnect, timestamp, details) {
        const {tabId, frameId, format, quality} = details;
        const dataUrl = await this._getScreenshot(tabId, frameId, format, quality);

        const {mediaType, data} = this._getDataUrlInfo(dataUrl);
        const extension = getFileExtensionFromImageMediaType(mediaType);
        if (extension === null) {
            throw new Error('Unknown media type for screenshot image');
        }

        const fileName = generateAnkiNoteMediaFileName('yomitan_browser_screenshot', extension, timestamp);
        return await ankiConnect.storeMediaFile(fileName, data);
    }

    /**
     * @param {AnkiConnect} ankiConnect
     * @param {number} timestamp
     * @returns {Promise<?string>}
     */
    async _injectAnkiNoteClipboardImage(ankiConnect, timestamp) {
        const dataUrl = await this._clipboardReader.getImage();
        if (dataUrl === null) {
            return null;
        }

        const {mediaType, data} = this._getDataUrlInfo(dataUrl);
        const extension = getFileExtensionFromImageMediaType(mediaType);
        if (extension === null) {
            throw new Error('Unknown media type for clipboard image');
        }

        const fileName = dataUrl === this._ankiClipboardImageDataUrlCache && this._ankiClipboardImageFilenameCache ?
            this._ankiClipboardImageFilenameCache :
            generateAnkiNoteMediaFileName('yomitan_clipboard_image', extension, timestamp);

        const storedFileName = await ankiConnect.storeMediaFile(fileName, data);

        if (storedFileName !== null) {
            this._ankiClipboardImageDataUrlCache = dataUrl;
            this._ankiClipboardImageFilenameCache = storedFileName;
        }

        return storedFileName;
    }

    /**
     * @param {AnkiConnect} ankiConnect
     * @param {number} timestamp
     * @param {import('api').InjectAnkiNoteMediaDictionaryMediaDetails[]} dictionaryMediaDetails
     * @returns {Promise<{results: import('api').InjectAnkiNoteDictionaryMediaResult[], errors: unknown[]}>}
     */
    async _injectAnkiNoteDictionaryMedia(ankiConnect, timestamp, dictionaryMediaDetails) {
        const targets = [];
        const detailsList = [];
        /** @type {Map<string, {dictionary: string, path: string, media: ?import('dictionary-database').MediaDataStringContent}>} */
        const detailsMap = new Map();
        for (const {dictionary, path} of dictionaryMediaDetails) {
            const target = {dictionary, path};
            const details = {dictionary, path, media: null};
            const key = JSON.stringify(target);
            targets.push(target);
            detailsList.push(details);
            detailsMap.set(key, details);
        }
        const mediaList = await this._getNormalizedDictionaryDatabaseMedia(targets);

        for (const media of mediaList) {
            const {dictionary, path} = media;
            const key = JSON.stringify({dictionary, path});
            const details = detailsMap.get(key);
            if (typeof details === 'undefined' || details.media !== null) { continue; }
            details.media = media;
        }

        const errors = [];
        /** @type {import('api').InjectAnkiNoteDictionaryMediaResult[]} */
        const results = [];
        for (let i = 0, ii = detailsList.length; i < ii; ++i) {
            const {dictionary, path, media} = detailsList[i];
            let fileName = null;
            if (media !== null) {
                const {content, mediaType} = media;
                const extension = getFileExtensionFromImageMediaType(mediaType);
                fileName = generateAnkiNoteMediaFileName(
                    `yomitan_dictionary_media_${i + 1}`,
                    extension !== null ? extension : '',
                    timestamp,
                );
                try {
                    fileName = await ankiConnect.storeMediaFile(fileName, content);
                } catch (e) {
                    errors.push(e);
                    fileName = null;
                }
            }
            results.push({dictionary, path, fileName});
        }

        return {results, errors};
    }

    /**
     * @param {unknown} error
     * @returns {?ExtensionError}
     */
    _getAudioDownloadError(error) {
        if (error instanceof ExtensionError && typeof error.data === 'object' && error.data !== null) {
            const {errors} = /** @type {import('core').SerializableObject} */ (error.data);
            if (Array.isArray(errors)) {
                for (const errorDetail of errors) {
                    if (!(errorDetail instanceof Error)) { continue; }
                    if (errorDetail.name === 'AbortError') {
                        return this._createAudioDownloadError('Audio download was cancelled due to an idle timeout', 'audio-download-idle-timeout', errors);
                    }
                    if (!(errorDetail instanceof ExtensionError)) { continue; }
                    const {data} = errorDetail;
                    if (!(typeof data === 'object' && data !== null)) { continue; }
                    const {details} = /** @type {import('core').SerializableObject} */ (data);
                    if (!(typeof details === 'object' && details !== null)) { continue; }
                    const error3 = /** @type {import('core').SerializableObject} */ (details).error;
                    if (typeof error3 !== 'string') { continue; }
                    switch (error3) {
                        case 'net::ERR_FAILED':
                            // This is potentially an error due to the extension not having enough URL privileges.
                            // The message logged to the console looks like this:
                            //  Access to fetch at '<URL>' from origin 'chrome-extension://<ID>' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. If an opaque response serves your needs, set the request's mode to 'no-cors' to fetch the resource with CORS disabled.
                            return this._createAudioDownloadError('Audio download failed due to possible extension permissions error', 'audio-download-failed-permissions-error', errors);
                        case 'net::ERR_CERT_DATE_INVALID': // Chrome
                        case 'Peer’s Certificate has expired.': // Firefox
                            // This error occurs when a server certificate expires.
                            return this._createAudioDownloadError('Audio download failed due to an expired server certificate', 'audio-download-failed-expired-server-certificate', errors);
                    }
                }
            }
        }
        return null;
    }

    /**
     * @param {string} message
     * @param {?string} issueId
     * @param {?(Error[])} errors
     * @returns {ExtensionError}
     */
    _createAudioDownloadError(message, issueId, errors) {
        const error = new ExtensionError(message);
        const hasErrors = Array.isArray(errors);
        const hasIssueId = (typeof issueId === 'string');
        if (hasErrors || hasIssueId) {
            /** @type {{errors?: import('core').SerializedError[], referenceUrl?: string}} */
            const data = {};
            error.data = {};
            if (hasErrors) {
                // Errors need to be serialized since they are passed to other frames
                data.errors = errors.map((e) => ExtensionError.serialize(e));
            }
            if (hasIssueId) {
                data.referenceUrl = `/issues.html#${issueId}`;
            }
        }
        return error;
    }

    /**
     * @param {string} dataUrl
     * @returns {{mediaType: string, data: string}}
     * @throws {Error}
     */
    _getDataUrlInfo(dataUrl) {
        const match = /^data:([^,]*?)(;base64)?,/.exec(dataUrl);
        if (match === null) {
            throw new Error('Invalid data URL');
        }

        let mediaType = match[1];
        if (mediaType.length === 0) { mediaType = 'text/plain'; }

        let data = dataUrl.substring(match[0].length);
        if (typeof match[2] === 'undefined') { data = btoa(data); }

        return {mediaType, data};
    }

    /**
     * @param {import('backend').DatabaseUpdateType} type
     * @param {import('backend').DatabaseUpdateCause} cause
     */
    _triggerDatabaseUpdated(type, cause) {
        void this._translator.clearDatabaseCaches();
        this._sendMessageAllTabsIgnoreResponse({action: 'applicationDatabaseUpdated', params: {type, cause}});
    }

    /**
     * @param {string} source
     */
    async _saveOptions(source) {
        this._clearProfileConditionsSchemaCache();
        const options = this._getOptionsFull(false);
        await this._optionsUtil.save(options);
        this._applyOptions(source);
    }

    /**
     * Creates an options object for use with `Translator.findTerms`.
     * @param {import('translator').FindTermsMode} mode The display mode for the dictionary entries.
     * @param {import('api').FindTermsDetails} details Custom info for finding terms.
     * @param {import('settings').ProfileOptions} options The options.
     * @returns {import('translation').FindTermsOptions} An options object.
     */
    _getTranslatorFindTermsOptions(mode, details, options) {
        let {matchType, deinflect, primaryReading} = details;
        if (typeof matchType !== 'string') { matchType = /** @type {import('translation').FindTermsMatchType} */ ('exact'); }
        if (typeof deinflect !== 'boolean') { deinflect = true; }
        if (typeof primaryReading !== 'string') { primaryReading = ''; }
        const enabledDictionaryMap = this._getTranslatorEnabledDictionaryMap(options);
        const {
            general: {mainDictionary, sortFrequencyDictionary, sortFrequencyDictionaryOrder, language},
            scanning: {alphanumeric},
            translation: {
                textReplacements: textReplacementsOptions,
                searchResolution,
            },
        } = options;
        const textReplacements = this._getTranslatorTextReplacements(textReplacementsOptions);
        let excludeDictionaryDefinitions = null;
        if (mode === 'merge' && !enabledDictionaryMap.has(mainDictionary)) {
            enabledDictionaryMap.set(mainDictionary, {
                index: enabledDictionaryMap.size,
                alias: mainDictionary,
                allowSecondarySearches: false,
                partsOfSpeechFilter: true,
                useDeinflections: true,
            });
            excludeDictionaryDefinitions = new Set();
            excludeDictionaryDefinitions.add(mainDictionary);
        }
        return {
            matchType,
            deinflect,
            primaryReading,
            mainDictionary,
            sortFrequencyDictionary,
            sortFrequencyDictionaryOrder,
            removeNonJapaneseCharacters: !alphanumeric,
            searchResolution,
            textReplacements,
            enabledDictionaryMap,
            excludeDictionaryDefinitions,
            language,
        };
    }

    /**
     * Creates an options object for use with `Translator.findKanji`.
     * @param {import('settings').ProfileOptions} options The options.
     * @returns {import('translation').FindKanjiOptions} An options object.
     */
    _getTranslatorFindKanjiOptions(options) {
        const enabledDictionaryMap = this._getTranslatorEnabledDictionaryMap(options);
        return {
            enabledDictionaryMap,
            removeNonJapaneseCharacters: !options.scanning.alphanumeric,
        };
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @returns {Map<string, import('translation').FindTermDictionary>}
     */
    _getTranslatorEnabledDictionaryMap(options) {
        const enabledDictionaryMap = new Map();
        for (const dictionary of options.dictionaries) {
            if (!dictionary.enabled) { continue; }
            const {name, alias, allowSecondarySearches, partsOfSpeechFilter, useDeinflections} = dictionary;
            enabledDictionaryMap.set(name, {
                index: enabledDictionaryMap.size,
                alias,
                allowSecondarySearches,
                partsOfSpeechFilter,
                useDeinflections,
            });
        }
        return enabledDictionaryMap;
    }

    /**
     * @param {import('settings').TranslationTextReplacementOptions} textReplacementsOptions
     * @returns {(?(import('translation').FindTermsTextReplacement[]))[]}
     */
    _getTranslatorTextReplacements(textReplacementsOptions) {
        /** @type {(?(import('translation').FindTermsTextReplacement[]))[]} */
        const textReplacements = [];
        for (const group of textReplacementsOptions.groups) {
            /** @type {import('translation').FindTermsTextReplacement[]} */
            const textReplacementsEntries = [];
            for (const {pattern, ignoreCase, replacement} of group) {
                let patternRegExp;
                try {
                    patternRegExp = ignoreCase ?
                        new RegExp(pattern.replace(/['’]/g, "['’]"), 'gi') :
                        new RegExp(pattern, 'g');
                } catch (e) {
                    // Invalid pattern
                    continue;
                }
                textReplacementsEntries.push({pattern: patternRegExp, replacement});
            }
            if (textReplacementsEntries.length > 0) {
                textReplacements.push(textReplacementsEntries);
            }
        }
        if (textReplacements.length === 0 || textReplacementsOptions.searchOriginal) {
            textReplacements.unshift(null);
        }
        return textReplacements;
    }

    /**
     * @returns {Promise<void>}
     */
    async _openWelcomeGuidePageOnce() {
        const result = await chrome.storage.session.get(['openedWelcomePage']);
        if (!result.openedWelcomePage) {
            await Promise.all([
                this._openWelcomeGuidePage(),
                chrome.storage.session.set({openedWelcomePage: true}),
            ]);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _openWelcomeGuidePage() {
        await this._createTab(chrome.runtime.getURL('/welcome.html'));
    }

    /**
     * @returns {Promise<void>}
     */
    async _openInfoPage() {
        await this._createTab(chrome.runtime.getURL('/info.html'));
    }

    /**
     * @param {import('backend').Mode} mode
     */
    async _openSettingsPage(mode) {
        const manifest = chrome.runtime.getManifest();
        const optionsUI = manifest.options_ui;
        if (typeof optionsUI === 'undefined') { throw new Error('Failed to find options_ui'); }
        const {page} = optionsUI;
        if (typeof page === 'undefined') { throw new Error('Failed to find options_ui.page'); }
        const url = chrome.runtime.getURL(page);
        switch (mode) {
            case 'existingOrNewTab':
                await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
                    chrome.runtime.openOptionsPage(() => {
                        const e = chrome.runtime.lastError;
                        if (e) {
                            reject(new Error(e.message));
                        } else {
                            resolve();
                        }
                    });
                }));
                break;
            case 'newTab':
                await this._createTab(url);
                break;
        }
    }

    /**
     * @param {string} url
     * @returns {Promise<chrome.tabs.Tab>}
     */
    _createTab(url) {
        return new Promise((resolve, reject) => {
            chrome.tabs.create({url}, (tab) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(tab);
                }
            });
        });
    }

    /**
     * @param {number} tabId
     * @returns {Promise<chrome.tabs.Tab>}
     */
    _getTabById(tabId) {
        return new Promise((resolve, reject) => {
            chrome.tabs.get(
                tabId,
                (result) => {
                    const e = chrome.runtime.lastError;
                    if (e) {
                        reject(new Error(e.message));
                    } else {
                        resolve(result);
                    }
                },
            );
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async _checkPermissions() {
        this._permissions = await getAllPermissions();
        this._updateBadge();
    }

    /**
     * @returns {boolean}
     */
    _canObservePermissionsChanges() {
        return isObjectNotArray(chrome.permissions) && isObjectNotArray(chrome.permissions.onAdded) && isObjectNotArray(chrome.permissions.onRemoved);
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @returns {boolean}
     */
    _hasRequiredPermissionsForSettings(options) {
        if (!this._canObservePermissionsChanges()) { return true; }
        return this._permissions === null || hasRequiredPermissionsForOptions(this._permissions, options);
    }

    /**
     * Only request this permission for Firefox versions >= 77.
     * https://bugzilla.mozilla.org/show_bug.cgi?id=1630413
     * @returns {Promise<void>}
     */
    async _requestPersistentStorage() {
        try {
            if (await navigator.storage.persisted()) { return; }

            const {vendor, version} = await browser.runtime.getBrowserInfo();
            if (vendor !== 'Mozilla') { return; }

            const match = /^\d+/.exec(version);
            if (match === null) { return; }

            const versionNumber = Number.parseInt(match[0], 10);
            if (!(Number.isFinite(versionNumber) && versionNumber >= 77)) { return; }

            await navigator.storage.persist();
        } catch (e) {
            // NOP
        }
    }

    /**
     * @param {{path: string, dictionary: string}[]} targets
     * @returns {Promise<import('dictionary-database').MediaDataStringContent[]>}
     */
    async _getNormalizedDictionaryDatabaseMedia(targets) {
        const results = [];
        for (const item of await this._dictionaryDatabase.getMedia(targets)) {
            const {content, dictionary, height, mediaType, path, width} = item;
            const content2 = arrayBufferToBase64(content);
            results.push({content: content2, dictionary, height, mediaType, path, width});
        }
        return results;
    }

    /**
     * @param {unknown} mode
     * @param {import('backend').Mode} defaultValue
     * @returns {import('backend').Mode}
     */
    _normalizeOpenSettingsPageMode(mode, defaultValue) {
        switch (mode) {
            case 'existingOrNewTab':
            case 'newTab':
            case 'popup':
                return mode;
            default:
                return defaultValue;
        }
    }

    /**
     * @param {number} tabId
     * @param {number} frameId
     * @param {() => void} handler
     */
    _addApplicationReadyHandler(tabId, frameId, handler) {
        const key = `${tabId}:${frameId}`;
        let handlers = this._applicationReadyHandlers.get(key);
        if (typeof handlers === 'undefined') {
            handlers = [];
            this._applicationReadyHandlers.set(key, handlers);
        }
        handlers.push(handler);
    }

    /**
     * @param {number} tabId
     * @param {number} frameId
     * @param {() => void} handler
     * @returns {boolean}
     */
    _removeApplicationReadyHandler(tabId, frameId, handler) {
        const key = `${tabId}:${frameId}`;
        const handlers = this._applicationReadyHandlers.get(key);
        if (typeof handlers === 'undefined') { return false; }
        const index = handlers.indexOf(handler);
        if (index < 0) { return false; }
        handlers.splice(index, 1);
        if (handlers.length === 0) {
            this._applicationReadyHandlers.delete(key);
        }
        return true;
    }
}
