/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */,
/* 1 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getConfiguration: () => (/* binding */ getConfiguration),
/* harmony export */   invalidateProfileCache: () => (/* binding */ invalidateProfileCache)
/* harmony export */ });
/* harmony import */ var _extension_read_storage__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(2);
/* harmony import */ var _default_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(3);
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(5);
/* harmony import */ var _profiles_state__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(6);




const NUMBER_KEYS = Object.keys(_default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION).filter((key) => typeof _default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION[key] === 'number');
const BOOLEAN_KEYS = Object.keys(_default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION).filter((key) => typeof _default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION[key] === 'boolean');
const OBJECT_KEYS = Object.keys(_default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION).filter((key) => typeof _default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION[key] === 'object');
let cachedProfileId = null;
const invalidateProfileCache = () => {
    cachedProfileId = null;
};
const getConfiguration = async (key) => {
    if (!cachedProfileId) {
        cachedProfileId = await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_3__.getActiveProfileId)();
    }
    const profileKey = (0,_profile_constants__WEBPACK_IMPORTED_MODULE_2__.getProfileKey)(cachedProfileId, key);
    const defaultValue = _default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION[key];
    const stringDefault = typeof defaultValue === 'object' ? JSON.stringify(defaultValue) : defaultValue?.toString();
    const value = await (0,_extension_read_storage__WEBPACK_IMPORTED_MODULE_0__.readStorage)(profileKey, stringDefault);
    if (NUMBER_KEYS.includes(key)) {
        return parseInt(value, 10);
    }
    if (BOOLEAN_KEYS.includes(key)) {
        return (value === 'true');
    }
    if (OBJECT_KEYS.includes(key)) {
        try {
            return JSON.parse(value);
        }
        catch {
            return defaultValue;
        }
    }
    return value;
};


/***/ }),
/* 2 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   readStorage: () => (/* binding */ readStorage)
/* harmony export */ });
const readStorage = async (key, defaultValue) => {
    const result = await chrome.storage.local.get(key);
    return (result?.[key] ?? defaultValue) ?? undefined;
};


/***/ }),
/* 3 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DEFAULT_CONFIGURATION: () => (/* binding */ DEFAULT_CONFIGURATION)
/* harmony export */ });
/* harmony import */ var _jiten_types__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(4);

const DEFAULT_CONFIGURATION = Object.freeze({
    schemaVersion: 1,
    themeBgColour: '#181818',
    themeAccentColour: '#D8B9FA',
    jitenApiKey: '',
    jitenApiEndpoint: 'https://api.jiten.moe/api',
    jitenAddToForq: false,
    setSentences: false,
    jitenDisableReviews: false,
    jitenUseTwoGrades: false,
    jitenRotateFlags: false,
    jitenRotateCycle: false,
    jitenCycleNeverForget: true,
    jitenCycleBlacklist: true,
    jitenCycleSuspended: false,
    hideInactiveTabs: true,
    showCurrentOnTop: true,
    showParseButton: false,
    enabledFeatures: [],
    disabledParsers: [],
    additionalHosts: '',
    additionalMeta: '[]',
    newStates: [_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.NEW],
    markTopX: false,
    markAllTypes: false,
    markTopXCount: 10_000,
    markIPlus1: false,
    minSentenceLength: 3,
    markOnlyFrequent: false,
    skipFurigana: false,
    generatePitch: false,
    customWordCSS: '',
    showPopupOnHover: false,
    renderCloseButton: true,
    touchscreenSupport: false,
    disableFadeAnimation: false,
    leftAlignPopupToWord: false,
    hideAfterAction: true,
    hidePopupAutomatically: true,
    hidePopupDelay: 500,
    showMiningActions: true,
    moveMiningActions: false,
    showGradingActions: true,
    moveGradingActions: false,
    showRotateActions: false,
    moveRotateActions: false,
    showConjugations: true,
    customPopupCSS: '',
    parseKey: [{ key: 'P', code: 'KeyP', modifiers: ['Alt'] }],
    showPopupKey: [{ key: 'Shift', code: 'ShiftLeft', modifiers: [] }],
    showAdvancedDialogKey: [],
    lookupSelectionKey: [{ key: 'L', code: 'KeyL', modifiers: ['Alt'] }],
    addToMiningKey: [],
    addToBlacklistKey: [],
    addToNeverForgetKey: [],
    addToSuspendedKey: [],
    jitenReviewNothing: [],
    jitenReviewSomething: [],
    jitenReviewHard: [],
    jitenReviewOkay: [],
    jitenReviewEasy: [],
    jitenReviewFail: [],
    jitenReviewPass: [],
    jitenRotateForward: [],
    jitenRotateBackward: [],
    enableAnkiIntegration: false,
    ankiUrl: 'http://localhost:8765',
    ankiProxyUrl: '',
    ankiMiningConfig: {
        deck: '',
        model: '',
        proxy: false,
        wordField: '',
        readingField: '',
        templateTargets: [],
    },
    ankiBlacklistConfig: {
        deck: '',
        model: '',
        proxy: false,
        wordField: '',
        readingField: '',
        templateTargets: [],
    },
    ankiNeverForgetConfig: {
        deck: '',
        model: '',
        proxy: false,
        wordField: '',
        readingField: '',
        templateTargets: [],
    },
    ankiReadonlyConfigs: [],
    statusBarEnabled: true,
    statusBarAutoHide: true,
    statusBarHideIcon: false,
    statusBarShowBadge: true,
    statusBarPosition: 'bottom',
    toggleStatusBarKey: [{ key: 'S', code: 'KeyS', modifiers: ['Alt'] }],
    skipReleaseNotes: false,
    enableDebugMode: false,
});


/***/ }),
/* 4 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   JitenCardState: () => (/* binding */ JitenCardState),
/* harmony export */   JitenRatingMap: () => (/* binding */ JitenRatingMap)
/* harmony export */ });
const JitenRatingMap = {
    unknown: 0,
    again: 1,
    hard: 2,
    good: 3,
    easy: 4,
};
var JitenCardState;
(function (JitenCardState) {
    JitenCardState["NEW"] = "new";
    JitenCardState["YOUNG"] = "young";
    JitenCardState["MATURE"] = "mature";
    JitenCardState["MASTERED"] = "mastered";
    JitenCardState["BLACKLISTED"] = "blacklisted";
    JitenCardState["DUE"] = "due";
})(JitenCardState || (JitenCardState = {}));


/***/ }),
/* 5 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   PROFILES_STATE_KEY: () => (/* binding */ PROFILES_STATE_KEY),
/* harmony export */   PROFILE_PREFIX: () => (/* binding */ PROFILE_PREFIX),
/* harmony export */   generateProfileId: () => (/* binding */ generateProfileId),
/* harmony export */   getProfileKey: () => (/* binding */ getProfileKey),
/* harmony export */   parseProfileKey: () => (/* binding */ parseProfileKey)
/* harmony export */ });
const PROFILES_STATE_KEY = '__profiles__';
const PROFILE_PREFIX = 'profile:';
const getProfileKey = (profileId, settingKey) => `${PROFILE_PREFIX}${profileId}:${settingKey}`;
const parseProfileKey = (key) => {
    if (!key.startsWith(PROFILE_PREFIX)) {
        return null;
    }
    const withoutPrefix = key.slice(PROFILE_PREFIX.length);
    const colonIndex = withoutPrefix.indexOf(':');
    if (colonIndex === -1) {
        return null;
    }
    return {
        profileId: withoutPrefix.slice(0, colonIndex),
        settingKey: withoutPrefix.slice(colonIndex + 1),
    };
};
const generateProfileId = () => {
    return crypto.randomUUID();
};


/***/ }),
/* 6 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getActiveProfileId: () => (/* binding */ getActiveProfileId),
/* harmony export */   getProfilesState: () => (/* binding */ getProfilesState),
/* harmony export */   setProfilesState: () => (/* binding */ setProfilesState)
/* harmony export */ });
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(5);
/* harmony import */ var _profile_types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(7);


const createDefaultProfilesState = () => ({
    activeProfileId: _profile_types__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_PROFILE_ID,
    profiles: [
        {
            id: _profile_types__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_PROFILE_ID,
            name: 'Default',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        },
    ],
});
const getProfilesState = async () => {
    const result = await chrome.storage.local.get(_profile_constants__WEBPACK_IMPORTED_MODULE_0__.PROFILES_STATE_KEY);
    const stored = result[_profile_constants__WEBPACK_IMPORTED_MODULE_0__.PROFILES_STATE_KEY];
    if (!stored) {
        const defaultState = createDefaultProfilesState();
        await setProfilesState(defaultState);
        return defaultState;
    }
    try {
        const parsed = JSON.parse(stored);
        if (!parsed.profiles || parsed.profiles.length === 0) {
            const defaultState = createDefaultProfilesState();
            await setProfilesState(defaultState);
            return defaultState;
        }
        return parsed;
    }
    catch {
        const defaultState = createDefaultProfilesState();
        await setProfilesState(defaultState);
        return defaultState;
    }
};
const setProfilesState = async (state) => {
    await chrome.storage.local.set({
        [_profile_constants__WEBPACK_IMPORTED_MODULE_0__.PROFILES_STATE_KEY]: JSON.stringify(state),
    });
};
const getActiveProfileId = async () => {
    const state = await getProfilesState();
    return state.activeProfileId;
};


/***/ }),
/* 7 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DEFAULT_PROFILES_STATE: () => (/* binding */ DEFAULT_PROFILES_STATE),
/* harmony export */   DEFAULT_PROFILE_ID: () => (/* binding */ DEFAULT_PROFILE_ID),
/* harmony export */   MAX_PROFILES: () => (/* binding */ MAX_PROFILES)
/* harmony export */ });
const DEFAULT_PROFILE_ID = 'default';
const MAX_PROFILES = 10;
const DEFAULT_PROFILES_STATE = {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [
        {
            id: DEFAULT_PROFILE_ID,
            name: 'Default',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        },
    ],
};


/***/ }),
/* 8 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   migrateToProfiles: () => (/* binding */ migrateToProfiles)
/* harmony export */ });
/* harmony import */ var _default_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(3);
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(5);
/* harmony import */ var _profile_types__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(7);



const migrateToProfiles = async () => {
    const storage = await chrome.storage.local.get();
    if (storage[_profile_constants__WEBPACK_IMPORTED_MODULE_1__.PROFILES_STATE_KEY]) {
        return;
    }
    const configKeys = Object.keys(_default_configuration__WEBPACK_IMPORTED_MODULE_0__.DEFAULT_CONFIGURATION);
    const newStorage = {};
    const keysToRemove = [];
    const profilesState = {
        ..._profile_types__WEBPACK_IMPORTED_MODULE_2__.DEFAULT_PROFILES_STATE,
        profiles: [
            {
                id: _profile_types__WEBPACK_IMPORTED_MODULE_2__.DEFAULT_PROFILE_ID,
                name: 'Default',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ],
    };
    newStorage[_profile_constants__WEBPACK_IMPORTED_MODULE_1__.PROFILES_STATE_KEY] = JSON.stringify(profilesState);
    for (const key of configKeys) {
        if (key in storage) {
            const profileKey = (0,_profile_constants__WEBPACK_IMPORTED_MODULE_1__.getProfileKey)(_profile_types__WEBPACK_IMPORTED_MODULE_2__.DEFAULT_PROFILE_ID, key);
            newStorage[profileKey] = storage[key];
            keysToRemove.push(key);
        }
    }
    try {
        await chrome.storage.local.set(newStorage);
        await chrome.storage.local.remove(keysToRemove);
    }
    catch (error) {
        console.error('Failed to migrate to profiles:', error);
    }
};


/***/ }),
/* 9 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   invalidateSetConfigurationCache: () => (/* binding */ invalidateSetConfigurationCache),
/* harmony export */   setConfiguration: () => (/* binding */ setConfiguration)
/* harmony export */ });
/* harmony import */ var _extension_write_storage__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(10);
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(5);
/* harmony import */ var _profiles_state__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(6);



let cachedProfileId = null;
const invalidateSetConfigurationCache = () => {
    cachedProfileId = null;
};
const setConfiguration = async (key, value) => {
    if (!cachedProfileId) {
        cachedProfileId = await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_2__.getActiveProfileId)();
    }
    const profileKey = (0,_profile_constants__WEBPACK_IMPORTED_MODULE_1__.getProfileKey)(cachedProfileId, key);
    await (0,_extension_write_storage__WEBPACK_IMPORTED_MODULE_0__.writeStorage)(profileKey, typeof value === 'object' || Array.isArray(value) ? JSON.stringify(value) : value.toString());
};


/***/ }),
/* 10 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   writeStorage: () => (/* binding */ writeStorage)
/* harmony export */ });
const writeStorage = (key, value) => chrome.storage.local.set({ [key]: value });


/***/ }),
/* 11 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   addContextMenu: () => (/* binding */ addContextMenu)
/* harmony export */ });
/* harmony import */ var _add_install_listener__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(12);

let handlers;
const addContextMenu = (options, handler) => {
    if (!handlers) {
        handlers = new Map();
        chrome.contextMenus?.onClicked.addListener((info, tab) => {
            const id = info.menuItemId;
            const handler = handlers.get(id);
            if (!tab || !handler) {
                return;
            }
            void handler(info, tab);
        });
    }
    const { id } = options;
    if (!id || handlers.has(id)) {
        return;
    }
    handlers.set(id, handler);
    (0,_add_install_listener__WEBPACK_IMPORTED_MODULE_0__.addInstallListener)(() => chrome.contextMenus?.create(options));
};


/***/ }),
/* 12 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   OnInstalledReason: () => (/* binding */ OnInstalledReason),
/* harmony export */   addInstallListener: () => (/* binding */ addInstallListener)
/* harmony export */ });
let listeners;
const addInstallListener = (cb) => {
    if (!listeners) {
        listeners = new Set();
        chrome.runtime.onInstalled.addListener((details) => {
            for (const listener of listeners) {
                void listener(details);
            }
        });
    }
    listeners.add(cb);
};
const OnInstalledReason = chrome.runtime.OnInstalledReason;


/***/ }),
/* 13 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   openOptionsPage: () => (/* binding */ openOptionsPage)
/* harmony export */ });
const openOptionsPage = () => chrome.runtime.openOptionsPage();


/***/ }),
/* 14 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   openView: () => (/* binding */ openView)
/* harmony export */ });
/* harmony import */ var _get_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(15);

const openView = (view) => chrome.tabs.create({ url: (0,_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)(`views/${view}.html`) });


/***/ }),
/* 15 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getURL: () => (/* binding */ getURL)
/* harmony export */ });
const getURL = (url) => chrome.runtime.getURL(url);


/***/ }),
/* 16 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   setParsingPaused: () => (/* binding */ setParsingPaused)
/* harmony export */ });
const setParsingPaused = async (paused) => {
    await chrome.storage.local.set({ parsingPaused: paused });
};


/***/ }),
/* 17 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   onBroadcastMessage: () => (/* binding */ onBroadcastMessage)
/* harmony export */ });
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);

const onBroadcastMessage = (event, handler, runNow = false) => {
    _extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.onMessage.addListener((message) => {
        if (message.event !== event) {
            return;
        }
        void handler(...message.args);
    });
    if (runNow) {
        handler();
    }
};


/***/ }),
/* 18 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   runtime: () => (/* binding */ runtime)
/* harmony export */ });
const runtime = chrome.runtime;


/***/ }),
/* 19 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParsePageCommand: () => (/* binding */ ParsePageCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(20);

class ParsePageCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'parsePage';
    }
}


/***/ }),
/* 20 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ForegroundCommand: () => (/* binding */ ForegroundCommand)
/* harmony export */ });
/* harmony import */ var _extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(21);
/* harmony import */ var _extension_tabs__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(22);
/* harmony import */ var _command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(23);



class ForegroundCommand extends _command__WEBPACK_IMPORTED_MODULE_2__.Command {
    send(tabId, afterCall) {
        void this.call(tabId, afterCall);
    }
    call(tabId, afterCall) {
        const promise = new Promise((resolve, reject) => {
            _extension_tabs__WEBPACK_IMPORTED_MODULE_1__.tabs.sendMessage(tabId, {
                event: this.key,
                command: this.constructor.name,
                isBroadcast: false,
                args: this.arguments,
            }, (response) => {
                const lastError = (0,_extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__.getLastError)();
                if (lastError) {
                    reject(lastError);
                }
                resolve(response);
            });
        });
        return afterCall
            ? promise.then(async (r) => {
                await afterCall(r);
                return r;
            })
            : promise;
    }
}


/***/ }),
/* 21 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getLastError: () => (/* binding */ getLastError)
/* harmony export */ });
const getLastError = () => chrome.runtime.lastError;


/***/ }),
/* 22 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   tabs: () => (/* binding */ tabs)
/* harmony export */ });
const tabs = chrome.tabs;


/***/ }),
/* 23 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Command: () => (/* binding */ Command)
/* harmony export */ });
class Command {
    constructor(...args) {
        this.arguments = args;
    }
}


/***/ }),
/* 24 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParseSelectionCommand: () => (/* binding */ ParseSelectionCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(20);

class ParseSelectionCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'parseSelection';
    }
}


/***/ }),
/* 25 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DeckManager: () => (/* binding */ DeckManager)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_jiten_list_user_decks__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(26);
/* harmony import */ var _shared_messages_broadcast_deck_list_updated_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(35);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(17);




class DeckManager {
    constructor() {
        this.jitenApiKey = null;
        this.internalDecks = [
            { id: 'blacklist', name: '[Blacklist]' },
            { id: 'never-forget', name: '[Never forget]' },
            { id: 'forq', name: '[ForQ]' },
        ];
        this.decks = [];
        this.managableDecks = [];
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_3__.onBroadcastMessage)('configurationUpdated', async () => {
            const jitenApiKey = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiKey');
            if (jitenApiKey === this.jitenApiKey) {
                return;
            }
            this.jitenApiKey = jitenApiKey;
            if (this.jitenApiKey) {
                await this.loadDecks();
            }
        }, true);
    }
    async loadDecks() {
        this.decks = [...this.internalDecks, ...(await this.fetchDecks())];
        this.managableDecks = this.decks.filter((deck) => !deck.is_built_in || typeof deck.id === 'string');
        new _shared_messages_broadcast_deck_list_updated_command__WEBPACK_IMPORTED_MODULE_2__.DeckListUpdatedCommand(this.managableDecks).send();
    }
    async fetchDecks() {
        return await (0,_shared_jiten_list_user_decks__WEBPACK_IMPORTED_MODULE_1__.listUserDecks)([
            'id',
            'name',
            'vocabulary_count',
            'word_count',
            'vocabulary_known_coverage',
            'vocabulary_in_progress_coverage',
            'is_built_in',
        ], {
            apiToken: this.jitenApiKey,
        });
    }
}


/***/ }),
/* 26 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   listUserDecks: () => (/* binding */ listUserDecks)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);

const listUserDecks = (fields, options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('list-user-decks', { fields }, options).then(({ decks }) => decks.map((deck) => deck.reduce((acc, value, index) => ({ ...acc, [fields[index]]: value }), {})));


/***/ }),
/* 27 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   request: () => (/* binding */ request)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _request_by_url__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(28);


const request = async (action, params, options) => {
    const baseUrl = await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiEndpoint');
    return await (0,_request_by_url__WEBPACK_IMPORTED_MODULE_1__.requestByUrl)(baseUrl, action, params, options);
};


/***/ }),
/* 28 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   requestByUrl: () => (/* binding */ requestByUrl)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _dom_display_toast__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(29);


const requestByUrl = async (baseUrl = 'https://api.jiten.moe', action, params, options) => {
    const apiToken = options?.apiToken || (await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiKey'));
    if (!apiToken?.length) {
        (0,_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('error', 'API Token is not set');
        throw new Error('API Token is not set');
    }
    const usedUrl = new URL(`${baseUrl}/${action}`);
    let response;
    try {
        response = await fetch(usedUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `ApiKey ${apiToken}`,
                Accept: 'application/json',
            },
            body: params ? JSON.stringify(params) : undefined,
        });
    }
    catch (error) {
        (0,_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('error', 'jiten.moe is unreachable', error.message);
        throw error;
    }
    const responseObject = (await response.json());
    if ('error_message' in responseObject) {
        throw new Error(responseObject.error_message);
    }
    return responseObject;
};


/***/ }),
/* 29 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   displayToast: () => (/* binding */ displayToast)
/* harmony export */ });
/* harmony import */ var _extension_get_style_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(30);
/* harmony import */ var _create_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(31);
/* harmony import */ var _find_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(34);



const toasts = new Map();
function startMessageTimeout(message) {
    const timeout = setTimeout(() => {
        toasts.delete(message);
    }, 5000);
    toasts.set(message, timeout);
}
function restartMessageTimeout(message) {
    const timeout = toasts.get(message);
    if (timeout) {
        clearTimeout(timeout);
        startMessageTimeout(message);
    }
}
function getOrCreateToastContainer() {
    let shadowRoot = (0,_find_element__WEBPACK_IMPORTED_MODULE_2__.findElement)('#ajb-toast-container')?.shadowRoot;
    if (!shadowRoot) {
        const toastContainer = (0,_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            id: 'ajb-toast-container',
        });
        shadowRoot = toastContainer.attachShadow({ mode: 'open' });
        shadowRoot.append((0,_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('link', {
            attributes: { rel: 'stylesheet', href: (0,_extension_get_style_url__WEBPACK_IMPORTED_MODULE_0__.getStyleUrl)('toast') },
        }), (0,_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('ul', { id: 'ajb-toast-item-container', class: 'notifications' }));
        document.body.appendChild(toastContainer);
    }
    return shadowRoot.getElementById('ajb-toast-item-container');
}
function displayToast(type, message, error, skipMessageTimeout) {
    if (typeof document === 'undefined') {
        return;
    }
    const timeoutDuration = 5000;
    if (!skipMessageTimeout) {
        if (toasts.has(message)) {
            restartMessageTimeout(message);
            return;
        }
        startMessageTimeout(message);
    }
    const container = getOrCreateToastContainer();
    const toast = (0,_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('li', {
        class: ['toast', 'outline', type],
        handler: () => toast.classList.add('hide'),
        children: [
            {
                tag: 'div',
                class: ['column'],
                children: [
                    {
                        tag: 'span',
                        innerText: message,
                    },
                    type === 'error'
                        ? {
                            tag: 'span',
                            innerText: '⎘',
                            handler(ev) {
                                ev?.stopPropagation();
                                void navigator.clipboard.writeText(error ?? message);
                            },
                        }
                        : false,
                ],
            },
        ],
    });
    container.appendChild(toast);
    let timeout;
    const startTimeout = (t = timeoutDuration) => {
        if (timeout) {
            return;
        }
        timeout = setTimeout(() => {
            toast.classList.add('hide');
            stopTimeout();
            setTimeout(() => toast.remove(), 500);
        }, t);
    };
    const stopTimeout = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
        }
    };
    startTimeout();
    toast.addEventListener('mouseover', () => stopTimeout());
    toast.addEventListener('mouseout', () => startTimeout(500));
}


/***/ }),
/* 30 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getStyleUrl: () => (/* binding */ getStyleUrl)
/* harmony export */ });
/* harmony import */ var _get_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(15);

const getStyleUrl = (url) => (0,_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)(`css/${url}.css`);


/***/ }),
/* 31 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   createElement: () => (/* binding */ createElement)
/* harmony export */ });
/* harmony import */ var _append_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(32);

function createElement(p0, p1) {
    const tag = typeof p0 === 'string' ? p0 : p0.tag;
    const options = (p1 ?? p0 ?? {});
    const e = document.createElement(tag);
    const id = options.id;
    if (options.id) {
        e.setAttribute('id', id);
    }
    if (options.innerText !== undefined) {
        e.innerText = String(options.innerText);
    }
    if (options.handler) {
        e.onclick = options.handler;
        e.ontouchstart = (e) => options.handler(e);
    }
    if (options.events) {
        for (const key of Object.keys(options.events)) {
            e[key] = options.events[key];
        }
    }
    if (options.attributes) {
        for (const key of Object.keys(options.attributes)) {
            const value = options.attributes[key];
            if (value !== false) {
                e.setAttribute(key, value);
            }
        }
    }
    if (options.style) {
        for (const key of Object.keys(options.style)) {
            const style = options.style[key];
            e.style[key] = style;
        }
    }
    if (options.class) {
        options.class = Array.isArray(options.class) ? options.class : [options.class];
        e.classList.add(...options.class.filter(Boolean));
    }
    (options.children ?? [])
        .filter((ch) => ch)
        .forEach((ch) => (0,_append_element__WEBPACK_IMPORTED_MODULE_0__.appendElement)(e, ch instanceof HTMLElement ? ch : createElement(ch)));
    return e;
}


/***/ }),
/* 32 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   appendElement: () => (/* binding */ appendElement)
/* harmony export */ });
/* harmony import */ var _create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(31);
/* harmony import */ var _resolve_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(33);


function appendElement(parent, child) {
    const e = child instanceof HTMLElement ? child : (0,_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)(child);
    (0,_resolve_element__WEBPACK_IMPORTED_MODULE_1__.resolveElement)(parent)?.append(e);
    return e;
}


/***/ }),
/* 33 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   resolveElement: () => (/* binding */ resolveElement)
/* harmony export */ });
function resolveElement(element) {
    return typeof element === 'string' ? document.querySelector(element) : element;
}


/***/ }),
/* 34 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   findElement: () => (/* binding */ findElement)
/* harmony export */ });
function findElement(p0, p1, _) {
    const root = typeof p0 === 'string' ? document : p0;
    const selector = typeof p0 === 'string' ? p0 : p1;
    return root.querySelector(selector);
}


/***/ }),
/* 35 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DeckListUpdatedCommand: () => (/* binding */ DeckListUpdatedCommand)
/* harmony export */ });
/* harmony import */ var _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(36);

class DeckListUpdatedCommand extends _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__.BroadcastCommand {
    constructor() {
        super(...arguments);
        this.key = 'deckListUpdated';
    }
}


/***/ }),
/* 36 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BroadcastCommand: () => (/* binding */ BroadcastCommand)
/* harmony export */ });
/* harmony import */ var _extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(21);
/* harmony import */ var _extension_get_tabs__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(37);
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(18);
/* harmony import */ var _extension_tabs__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(22);
/* harmony import */ var _command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(23);





class BroadcastCommand extends _command__WEBPACK_IMPORTED_MODULE_4__.Command {
    send() {
        this.toBackground();
        void (0,_extension_get_tabs__WEBPACK_IMPORTED_MODULE_1__.getTabs)({}).then((tabs) => tabs.forEach((tab) => {
            if (tab.id) {
                this.toForeground(tab.id);
            }
        }));
    }
    getArguments() {
        return {
            event: this.key,
            command: this.constructor.name,
            isBroadcast: true,
            args: this.arguments,
        };
    }
    supressError() {
        (0,_extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__.getLastError)();
        return true;
    }
    toForeground(tabId) {
        _extension_tabs__WEBPACK_IMPORTED_MODULE_3__.tabs.sendMessage(tabId, this.getArguments(), this.supressError);
    }
    toBackground() {
        _extension_runtime__WEBPACK_IMPORTED_MODULE_2__.runtime.sendMessage(this.getArguments(), this.supressError);
    }
}


/***/ }),
/* 37 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getTabs: () => (/* binding */ getTabs)
/* harmony export */ });
const getTabs = (queryInfo) => {
    return new Promise((resolve) => {
        chrome.tabs.query(queryInfo, (tabs) => {
            resolve(tabs);
        });
    });
};


/***/ }),
/* 38 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   FetchDecksCommandHandler: () => (/* binding */ FetchDecksCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_fetch_decks_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(39);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(41);


class FetchDecksCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_1__.BackgroundCommandHandler {
    constructor(_deckManager) {
        super();
        this._deckManager = _deckManager;
        this.command = _shared_messages_background_fetch_decks_command__WEBPACK_IMPORTED_MODULE_0__.FetchDecksCommand;
    }
    async handle() {
        await this._deckManager.loadDecks();
    }
}


/***/ }),
/* 39 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   FetchDecksCommand: () => (/* binding */ FetchDecksCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class FetchDecksCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'fetchDecks';
    }
}


/***/ }),
/* 40 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BackgroundCommand: () => (/* binding */ BackgroundCommand)
/* harmony export */ });
/* harmony import */ var _extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(21);
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(18);
/* harmony import */ var _lib_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(23);



class BackgroundCommand extends _lib_command__WEBPACK_IMPORTED_MODULE_2__.Command {
    send(afterCall) {
        this.call(afterCall).catch((error) => {
            console.error(`[BackgroundCommand] ${this.constructor.name} failed:`, error);
        });
    }
    call(afterCall) {
        const promise = new Promise((resolve, reject) => {
            _extension_runtime__WEBPACK_IMPORTED_MODULE_1__.runtime.sendMessage({
                event: this.key,
                command: this.constructor.name,
                isBroadcast: false,
                args: this.arguments,
            }, (response) => {
                const lastError = (0,_extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__.getLastError)();
                if (lastError) {
                    return reject(lastError);
                }
                if (!response || !response.success) {
                    return reject(new Error('Command failed or received invalid response'));
                }
                resolve(response.result);
            });
        });
        return afterCall
            ? promise.then(async (r) => {
                await afterCall(r);
                return r;
            })
            : promise;
    }
}


/***/ }),
/* 41 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BackgroundCommandHandler: () => (/* binding */ BackgroundCommandHandler)
/* harmony export */ });
class BackgroundCommandHandler {
}


/***/ }),
/* 42 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ForgetCardCommandHandler: () => (/* binding */ ForgetCardCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_jiten_request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);
/* harmony import */ var _shared_messages_background_forget_card_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(43);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(41);



class ForgetCardCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_forget_card_command__WEBPACK_IMPORTED_MODULE_1__.ForgetCardCommand;
    }
    async handle(sender, wordId, readingIndex) {
        await (0,_shared_jiten_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/set-vocabulary-state', {
            wordId,
            readingIndex,
            state: 'forget-add',
        });
    }
}


/***/ }),
/* 43 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ForgetCardCommand: () => (/* binding */ ForgetCardCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class ForgetCardCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor(wordId, readingIndex) {
        super(wordId, readingIndex);
        this.key = 'forgetCard';
    }
}


/***/ }),
/* 44 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   GradeCardCommandHandler: () => (/* binding */ GradeCardCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_jiten_review__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(45);
/* harmony import */ var _shared_messages_background_grade_card_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(46);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(41);



class GradeCardCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_grade_card_command__WEBPACK_IMPORTED_MODULE_1__.GradeCardCommand;
    }
    async handle(sender, wordId, readingIndex, rating) {
        await (0,_shared_jiten_review__WEBPACK_IMPORTED_MODULE_0__.review)(rating, wordId, readingIndex);
    }
}


/***/ }),
/* 45 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   review: () => (/* binding */ review)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);
/* harmony import */ var _types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(4);


const review = (rating, wordId, readingIndex, options) => {
    const ratingValue = _types__WEBPACK_IMPORTED_MODULE_1__.JitenRatingMap[rating];
    return (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/review', { wordId, readingIndex, rating: ratingValue }, options);
};


/***/ }),
/* 46 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   GradeCardCommand: () => (/* binding */ GradeCardCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class GradeCardCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'gradeCard';
    }
}


/***/ }),
/* 47 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RunDeckActionCommandHandler: () => (/* binding */ RunDeckActionCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_jiten_add_vocabulary__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(48);
/* harmony import */ var _shared_jiten_remove_vocabulary__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(49);
/* harmony import */ var _shared_jiten_set_card_sentence__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(50);
/* harmony import */ var _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(51);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(41);






class RunDeckActionCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_5__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_4__.RunDeckActionCommand;
    }
    async handle(sender, wordId, readingIndex, deck, action, sentence) {
        const addSentence = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('setSentences');
        const fn = action === 'add' ? _shared_jiten_add_vocabulary__WEBPACK_IMPORTED_MODULE_1__.addVocabulary : _shared_jiten_remove_vocabulary__WEBPACK_IMPORTED_MODULE_2__.removeVocabulary;
        await fn(deck, wordId, readingIndex);
        if (addSentence && sentence?.length && action === 'add' && deck === 'mining') {
            await (0,_shared_jiten_set_card_sentence__WEBPACK_IMPORTED_MODULE_3__.setCardSentence)(wordId, readingIndex, sentence);
        }
    }
}


/***/ }),
/* 48 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   addVocabulary: () => (/* binding */ addVocabulary)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);

const addVocabulary = async (deckName, wordId, readingIndex, options) => {
    await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/set-vocabulary-state', {
        wordId,
        readingIndex,
        state: `${deckName}-add`,
    }, options);
};


/***/ }),
/* 49 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   removeVocabulary: () => (/* binding */ removeVocabulary)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);

const removeVocabulary = async (deckName, wordId, readingIndex, options) => {
    await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/set-vocabulary-state', {
        wordId,
        readingIndex,
        state: `${deckName}-remove`,
    }, options);
};


/***/ }),
/* 50 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   setCardSentence: () => (/* binding */ setCardSentence)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);

const setCardSentence = (wordId, readingIndex, sentence, options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('set-card-sentence', {
    wordId,
    readingIndex,
    sentence,
}, options);


/***/ }),
/* 51 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RunDeckActionCommand: () => (/* binding */ RunDeckActionCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class RunDeckActionCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'runDeckAction';
    }
}


/***/ }),
/* 52 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   UpdateCardStateCommandHandler: () => (/* binding */ UpdateCardStateCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_jiten_get_card_state__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(53);
/* harmony import */ var _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(54);
/* harmony import */ var _shared_messages_broadcast_card_state_updated_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(55);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(41);




class UpdateCardStateCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_3__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_1__.UpdateCardStateCommand;
    }
    async handle(sender, wordId, readingIndex) {
        const newCardState = await (0,_shared_jiten_get_card_state__WEBPACK_IMPORTED_MODULE_0__.getCardState)(wordId, readingIndex);
        new _shared_messages_broadcast_card_state_updated_command__WEBPACK_IMPORTED_MODULE_2__.CardStateUpdatedCommand(wordId, readingIndex, newCardState).send();
    }
}


/***/ }),
/* 53 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getCardState: () => (/* binding */ getCardState)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);
/* harmony import */ var _types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(4);


const CARD_STATE_MAP = {
    0: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.NEW,
    1: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.YOUNG,
    2: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MATURE,
    3: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.BLACKLISTED,
    4: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.DUE,
    5: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MASTERED,
};
const getCardState = async (wordId, readingIndex, options) => {
    const result = await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('reader/lookup-vocabulary', {
        words: [[wordId, readingIndex]],
    }, options);
    const [firstWord] = result.result;
    if (!Array.isArray(firstWord) || firstWord.length === 0) {
        return [_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.NEW];
    }
    const states = firstWord
        .map((state) => CARD_STATE_MAP[state])
        .filter((s) => s !== undefined);
    return states.length > 0 ? states : [_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.NEW];
};


/***/ }),
/* 54 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   UpdateCardStateCommand: () => (/* binding */ UpdateCardStateCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class UpdateCardStateCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'updateCardState';
    }
}


/***/ }),
/* 55 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CardStateUpdatedCommand: () => (/* binding */ CardStateUpdatedCommand)
/* harmony export */ });
/* harmony import */ var _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(36);

class CardStateUpdatedCommand extends _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__.BroadcastCommand {
    constructor() {
        super(...arguments);
        this.key = 'cardStateUpdated';
    }
}


/***/ }),
/* 56 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BackgroundCommandHandlerCollection: () => (/* binding */ BackgroundCommandHandlerCollection)
/* harmony export */ });
/* harmony import */ var _shared_extension_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);

class BackgroundCommandHandlerCollection {
    constructor(...handlers) {
        this.handlers = new Map();
        handlers.forEach((handler) => {
            this.handlers.set(handler.command.name, handler);
        });
    }
    register(handler) {
        this.handlers.set(handler.command.name, handler);
    }
    listen() {
        _shared_extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.onMessage.addListener((request, sender, sendResponse) => {
            const handler = this.handlers.get(request.command);
            if (!handler) {
                return false;
            }
            const handlerResult = handler.handle(sender, ...request.args);
            const promise = Promise.resolve(handlerResult);
            promise
                .then((result) => {
                sendResponse({ success: true, result });
            })
                .catch((error) => {
                sendResponse({ success: false, error });
            });
            return true;
        });
    }
}


/***/ }),
/* 57 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   OpenSettingsCommandHandler: () => (/* binding */ OpenSettingsCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(13);
/* harmony import */ var _shared_messages_background_open_settings_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(58);
/* harmony import */ var _background_command_handler__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(41);



class OpenSettingsCommandHandler extends _background_command_handler__WEBPACK_IMPORTED_MODULE_2__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_open_settings_command__WEBPACK_IMPORTED_MODULE_1__.OpenSettingsCommand;
    }
    handle() {
        void (0,_shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_0__.openOptionsPage)();
    }
}


/***/ }),
/* 58 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   OpenSettingsCommand: () => (/* binding */ OpenSettingsCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class OpenSettingsCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'openSettings';
    }
}


/***/ }),
/* 59 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   UpdateBadgeCommandHandler: () => (/* binding */ UpdateBadgeCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_update_badge_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(60);
/* harmony import */ var _background_command_handler__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(41);


function getComprehensionColour(percentage) {
    const hue = Math.round(percentage * 1.42);
    return `hsl(${hue}, 78%, 52%)`;
}
class UpdateBadgeCommandHandler extends _background_command_handler__WEBPACK_IMPORTED_MODULE_1__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_update_badge_command__WEBPACK_IMPORTED_MODULE_0__.UpdateBadgeCommand;
    }
    handle(sender, percentage) {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            return;
        }
        if (percentage === null) {
            void chrome.action.setBadgeText({ text: '', tabId });
            return;
        }
        const text = percentage === 100 ? '100' : `${percentage}%`;
        const colour = getComprehensionColour(percentage);
        void chrome.action.setBadgeText({ text, tabId });
        void chrome.action.setBadgeBackgroundColor({ color: colour, tabId });
    }
}


/***/ }),
/* 60 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   UpdateBadgeCommand: () => (/* binding */ UpdateBadgeCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class UpdateBadgeCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'updateBadge';
    }
}


/***/ }),
/* 61 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   LookupController: () => (/* binding */ LookupController)
/* harmony export */ });
/* harmony import */ var _shared_extension_add_context_menu__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(11);
/* harmony import */ var _shared_extension_open_new_tab__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(62);


class LookupController {
    constructor() {
        (0,_shared_extension_add_context_menu__WEBPACK_IMPORTED_MODULE_0__.addContextMenu)({
            id: 'lookup-selection',
            title: 'Lookup selected text',
            contexts: ['selection'],
        }, (info) => this.lookupText(info.selectionText));
    }
    lookupText(text) {
        if (!text?.length) {
            return;
        }
        const urlEncoded = encodeURIComponent(text);
        const url = `https://jiten.moe/parse?text=${urlEncoded}`;
        void (0,_shared_extension_open_new_tab__WEBPACK_IMPORTED_MODULE_1__.openNewTab)(url);
    }
}


/***/ }),
/* 62 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   openNewTab: () => (/* binding */ openNewTab)
/* harmony export */ });
const openNewTab = (url) => chrome.tabs.create({ url });


/***/ }),
/* 63 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   LookupTextCommandHandler: () => (/* binding */ LookupTextCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_lookup_text_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(64);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(41);


class LookupTextCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_1__.BackgroundCommandHandler {
    constructor(_lookupController) {
        super();
        this._lookupController = _lookupController;
        this.command = _shared_messages_background_lookup_text_command__WEBPACK_IMPORTED_MODULE_0__.LookupTextCommand;
    }
    handle(sender, text) {
        this._lookupController.lookupText(text);
    }
}


/***/ }),
/* 64 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   LookupTextCommand: () => (/* binding */ LookupTextCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class LookupTextCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'lookupText';
    }
}


/***/ }),
/* 65 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AbortRequestCommandHandler: () => (/* binding */ AbortRequestCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_abort_request_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(66);
/* harmony import */ var _shared_messages_foreground_sequence_aborted_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(67);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(41);



class AbortRequestCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__.BackgroundCommandHandler {
    constructor(_parseController) {
        super();
        this._parseController = _parseController;
        this.command = _shared_messages_background_abort_request_command__WEBPACK_IMPORTED_MODULE_0__.AbortRequestCommand;
    }
    async handle(sender, sequence) {
        this._parseController.abortSequence(sequence);
        await new _shared_messages_foreground_sequence_aborted_command__WEBPACK_IMPORTED_MODULE_1__.SequenceAbortedCommand(sequence).call(sender.tab.id);
    }
}


/***/ }),
/* 66 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AbortRequestCommand: () => (/* binding */ AbortRequestCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class AbortRequestCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'abortRequest';
    }
}


/***/ }),
/* 67 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SequenceAbortedCommand: () => (/* binding */ SequenceAbortedCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(20);

class SequenceAbortedCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'sequenceAborted';
    }
}


/***/ }),
/* 68 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParseCommandHandler: () => (/* binding */ ParseCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_extension_inject_style__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(69);
/* harmony import */ var _shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(13);
/* harmony import */ var _shared_messages_background_parse_command__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(70);
/* harmony import */ var _shared_messages_foreground_toast_command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(71);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(17);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(72);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(41);








class ParseCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_7__.BackgroundCommandHandler {
    constructor(_parseController) {
        super();
        this._parseController = _parseController;
        this.command = _shared_messages_background_parse_command__WEBPACK_IMPORTED_MODULE_3__.ParseCommand;
        this._failToast = new _shared_messages_foreground_toast_command__WEBPACK_IMPORTED_MODULE_4__.ToastCommand('error', 'Jiten API key is not set. Please set it in the extension settings.');
    }
    async handle(sender, data) {
        const jitenApiKey = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiKey');
        if (!jitenApiKey?.length) {
            await this._failToast.call(sender.tab.id);
            await (0,_shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_2__.openOptionsPage)();
            return;
        }
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__.onBroadcastMessage)('configurationUpdated', async () => {
            const themeVars = await (0,_shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_6__.getThemeCssVars)();
            const customWordCSS = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('customWordCSS');
            await (0,_shared_extension_inject_style__WEBPACK_IMPORTED_MODULE_1__.injectStyle)(sender.tab.id, 'word', `${themeVars}\n${customWordCSS}`);
        }, true);
        this._parseController.parseSequences(sender, data);
    }
}


/***/ }),
/* 69 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   injectStyle: () => (/* binding */ injectStyle)
/* harmony export */ });
const tabs = new Map();
chrome.tabs.onRemoved.addListener((tabId) => {
    tabs.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        tabs.delete(tabId);
    }
});
const getPath = (file) => `css/${file}.css`;
const insert = (tabId, cfg) => chrome.scripting.insertCSS({
    target: { tabId, allFrames: true },
    ...cfg,
});
const remove = (tabId, cfg) => chrome.scripting
    .removeCSS({
    target: { tabId, allFrames: true },
    ...cfg,
})
    .catch(() => {
});
const replaceFile = async (tabId, oldFile, newFile) => {
    if (oldFile) {
        await remove(tabId, { files: [oldFile] });
    }
    if (newFile) {
        await insert(tabId, { files: [newFile] });
    }
};
const replaceRaw = async (tabId, oldRaw, newRaw) => {
    if (oldRaw) {
        await remove(tabId, { css: oldRaw });
    }
    if (newRaw) {
        await insert(tabId, { css: newRaw });
    }
};
const injectStyle = async (tabId, file, raw) => {
    const currentConfig = tabs.get(tabId) || {};
    const filePath = file?.length ? getPath(file) : undefined;
    if (currentConfig.raw === raw && currentConfig.file === filePath) {
        return;
    }
    if (currentConfig.file !== filePath) {
        await replaceFile(tabId, currentConfig.file, filePath);
    }
    if (currentConfig.raw !== raw) {
        await replaceRaw(tabId, currentConfig.raw, raw);
    }
    tabs.set(tabId, { file: filePath, raw });
};


/***/ }),
/* 70 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParseCommand: () => (/* binding */ ParseCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class ParseCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'parse';
    }
}


/***/ }),
/* 71 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ToastCommand: () => (/* binding */ ToastCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(20);

class ToastCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'toast';
    }
}


/***/ }),
/* 72 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getThemeCssVars: () => (/* binding */ getThemeCssVars)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);

const getThemeCssVars = async () => {
    const bg = await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('themeBgColour');
    const accent = await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('themeAccentColour');
    return `:root, :host { --jiten-bg: ${bg}; --jiten-accent: ${accent}; }`;
};


/***/ }),
/* 73 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParseController: () => (/* binding */ ParseController)
/* harmony export */ });
/* harmony import */ var _shared_messages_foreground_sequence_error_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(74);
/* harmony import */ var _shared_messages_foreground_sequence_success_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(75);
/* harmony import */ var _parser__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(76);
/* harmony import */ var _worker_queue__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(79);




class ParseController {
    constructor() {
        this.BATCH_SIZE = 80000;
        this.JITEN_TIMEOUT = 50;
        this._pendingParagraphs = new Map();
        this._workerQueue = new _worker_queue__WEBPACK_IMPORTED_MODULE_3__.WorkerQueue();
    }
    abortSequence(sequence) {
        this._pendingParagraphs.delete(sequence);
    }
    parseSequences(sender, data) {
        data.forEach(([sequenceId, text]) => this.queueParagraph(sequenceId, sender, text));
        this.queueBatches(this.getParagraphBatches());
    }
    queueParagraph(sequenceId, sender, text) {
        const promise = new Promise((resolve, reject) => {
            this._pendingParagraphs.set(sequenceId, {
                resolve,
                reject,
                text,
                length: new TextEncoder().encode(text).length + 7,
            });
        });
        promise
            .then((tokens) => this.succeedSequence(sequenceId, tokens, sender))
            .catch((e) => this.failSequence(sequenceId, e, sender))
            .finally(() => this._pendingParagraphs.delete(sequenceId));
    }
    succeedSequence(sequenceId, tokens, sender) {
        new _shared_messages_foreground_sequence_success_command__WEBPACK_IMPORTED_MODULE_1__.SequenceSuccessCommand(sequenceId, tokens).send(sender.tab.id);
    }
    failSequence(sequenceId, error, sender) {
        new _shared_messages_foreground_sequence_error_command__WEBPACK_IMPORTED_MODULE_0__.SequenceErrorCommand(sequenceId, error.message).send(sender.tab.id);
    }
    getParagraphBatches() {
        const batches = [];
        let currentBatch = { strings: [], handles: [] };
        let length = 0;
        for (const [seq, paragraph] of this._pendingParagraphs) {
            length += paragraph.length;
            if (length > this.BATCH_SIZE) {
                batches.push(currentBatch);
                currentBatch = { strings: [], handles: [] };
                length = paragraph.length;
            }
            currentBatch.strings.push(paragraph.text);
            currentBatch.handles.push(paragraph);
            this._pendingParagraphs.delete(seq);
        }
        if (currentBatch.strings.length > 0) {
            batches.push(currentBatch);
        }
        return batches;
    }
    queueBatches(batches) {
        for (const batch of batches) {
            this._workerQueue.push(() => new _parser__WEBPACK_IMPORTED_MODULE_2__.Parser(batch).parse(), (e) => batch.handles.forEach((handle) => handle.reject(e)), this.JITEN_TIMEOUT);
        }
    }
}


/***/ }),
/* 74 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SequenceErrorCommand: () => (/* binding */ SequenceErrorCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(20);

class SequenceErrorCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'sequenceError';
    }
}


/***/ }),
/* 75 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SequenceSuccessCommand: () => (/* binding */ SequenceSuccessCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(20);

class SequenceSuccessCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'sequenceSuccess';
    }
}


/***/ }),
/* 76 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Parser: () => (/* binding */ Parser)
/* harmony export */ });
/* harmony import */ var _shared_jiten_parse__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(77);
/* harmony import */ var _pitch_accent_utils__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(78);


class Parser {
    constructor(batch) {
        this.batch = batch;
    }
    async parse() {
        const paragraphs = this.batch.strings;
        const { tokens, vocabulary } = await (0,_shared_jiten_parse__WEBPACK_IMPORTED_MODULE_0__.parse)(paragraphs);
        const cards = this.vocabToCard(vocabulary);
        const parsedTokens = this.parseTokens(tokens, cards, vocabulary);
        this.addSentenceInfo(paragraphs, parsedTokens);
        for (const [i, handle] of this.batch.handles.entries()) {
            handle.resolve(parsedTokens[i]);
        }
    }
    extractRubiesFromAnnotated(input) {
        const rubies = [];
        const regex = /((?:.|\n)*?)([\u4e00-\u9faf\u3005-\u3007]+)\[([^\]]+)\]/g;
        let match;
        let currentOffset = 0;
        while ((match = regex.exec(input)) !== null) {
            const prefix = match[1];
            const base = match[2];
            const ruby = match[3];
            currentOffset += prefix.length;
            const start = currentOffset;
            const length = base.length;
            const end = start + length;
            rubies.push({
                text: ruby,
                start,
                end,
                length,
            });
            currentOffset += length;
        }
        return rubies;
    }
    vocabToCard(vocabulary) {
        const CARD_STATE_MAP = {
            0: 'new',
            1: 'young',
            2: 'mature',
            3: 'blacklisted',
            4: 'due',
            5: 'mastered',
        };
        return vocabulary.map((vocab) => {
            const { wordId, readingIndex, spelling, reading, frequencyRank, partsOfSpeech, meaningsChunks, meaningsPartOfSpeech, knownState, pitchAccent, } = vocab;
            const cardState = knownState
                .map((state) => CARD_STATE_MAP[state])
                .filter((s) => s !== undefined);
            if (cardState.length === 0) {
                cardState.push('mature');
            }
            return {
                wordId,
                readingIndex,
                spelling,
                reading,
                frequencyRank,
                partsOfSpeech: Array.isArray(partsOfSpeech) ? partsOfSpeech : [partsOfSpeech],
                meanings: meaningsChunks.map((glosses, i) => ({
                    glosses,
                    partsOfSpeech: meaningsPartOfSpeech[i],
                })),
                cardState,
                pitchAccent: pitchAccent ?? [],
                wordWithReading: null,
            };
        });
    }
    parseTokens(tokens, cards, vocabulary) {
        return tokens.map((group) => {
            let lastPitchClass = '';
            return group.map((token) => {
                const vocabEntry = vocabulary.find((v) => {
                    return v.wordId === token.wordId && v.readingIndex === token.readingIndex;
                });
                const card = cards.find((c) => c.wordId === token.wordId && c.readingIndex === token.readingIndex);
                const isParticle = card.partsOfSpeech.includes('prt');
                const pitchClass = isParticle ? '' : (0,_pitch_accent_utils__WEBPACK_IMPORTED_MODULE_1__.getPitchClass)(card.pitchAccent, card.reading);
                lastPitchClass = pitchClass || lastPitchClass;
                const rubies = vocabEntry?.reading
                    ? this.extractRubiesFromAnnotated(vocabEntry.reading).map((ruby) => ({
                        ...ruby,
                        start: token.start + ruby.start,
                        end: token.start + ruby.start + ruby.length,
                    }))
                    : [];
                const updated = {
                    ...token,
                    card,
                    pitchClass: lastPitchClass,
                    rubies,
                };
                if (card) {
                    this.assignWordWithReadingJiten(updated, card);
                }
                return updated;
            });
        });
    }
    assignWordWithReadingJiten(token, card) {
        const ruby = token.rubies;
        const offset = token.start;
        const kanji = card.spelling;
        if (!ruby.length) {
            return;
        }
        const word = kanji.split('');
        for (let i = ruby.length - 1; i >= 0; i--) {
            const { text, start, length } = ruby[i];
            word.splice(start - offset + length, 0, `[${text}]`);
        }
        card.wordWithReading = word.join('');
    }
    addSentenceInfo(paragraphs, tokens) {
        paragraphs.forEach((paragraph, i) => {
            const tokenData = tokens[i];
            const sentences = this.splitJapaneseTextIntoSentences(paragraph);
            if (sentences.length === 1) {
                tokenData.forEach((token) => {
                    token.sentence = sentences[0];
                });
                return;
            }
            let offset = 0;
            for (const sentence of sentences) {
                const compareSentence = sentence.replace(/(^[「『])|([。！？」』]$)/g, '');
                const positionInParagraphs = paragraph.substring(offset).indexOf(compareSentence);
                if (positionInParagraphs === -1) {
                    offset += sentence.length;
                    return;
                }
                const sentenceStart = offset + positionInParagraphs;
                const sentenceEnd = sentenceStart + sentence.length;
                for (const token of tokenData) {
                    if (token.start >= sentenceStart && token.end <= sentenceEnd) {
                        token.sentence = sentence;
                    }
                }
                offset += sentence.length;
            }
        });
    }
    splitJapaneseTextIntoSentences(text) {
        const sentenceEndRegex = /.*?[。！？」』](?=\s?|$)|「.*?」|『.*?』/g;
        const sentences = text.match(sentenceEndRegex) || [];
        return sentences.length
            ? sentences
                .map((sentence) => sentence.trim())
                .filter(Boolean)
                .filter((sentence) => !/^[」』]$/.exec(sentence))
                .map((sentence) => {
                if (/「.*?」|『.*?』/.exec(sentence)) {
                    return sentence;
                }
                const trimmed = sentence.replace(/(^「|『)|(」|』$)/, '');
                return /[。！？]$/.exec(trimmed) ? trimmed : `${trimmed}。`;
            })
            : [text];
    }
}


/***/ }),
/* 77 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   parse: () => (/* binding */ parse)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);

const parse = async (paragraphs, options) => {
    const result = await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('reader/parse', {
        text: paragraphs,
    }, options);
    return result;
};


/***/ }),
/* 78 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getPitchClass: () => (/* binding */ getPitchClass)
/* harmony export */ });
const smallNonMora = new Set(['ゃ', 'ゅ', 'ょ', 'ャ', 'ュ', 'ョ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ']);
const countMorae = (reading) => {
    let count = 0;
    for (const ch of reading) {
        if (!smallNonMora.has(ch)) {
            count++;
        }
    }
    return count;
};
const getPitchClass = (pitchAccent, reading) => {
    if (!pitchAccent.length) {
        return '';
    }
    const [accent] = pitchAccent;
    const morae = countMorae(reading);
    if (accent === 0) {
        return 'heiban';
    }
    if (morae === 1 && accent === 1) {
        return 'odaka';
    }
    if (accent === 1) {
        return 'atamadaka';
    }
    if (morae > 0 && accent === morae) {
        return 'odaka';
    }
    if (accent > 1 && accent < morae) {
        return 'nakadaka';
    }
    return 'unknown-pattern';
};


/***/ }),
/* 79 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   WorkerQueue: () => (/* binding */ WorkerQueue)
/* harmony export */ });
class WorkerQueue {
    constructor() {
        this._stack = [];
        this._isProcessing = false;
    }
    push(fn, onFail, wait) {
        this._stack.push({ fn, onFail, wait });
        void this.process();
    }
    async process() {
        if (this._stack.length === 0 || this._isProcessing) {
            return;
        }
        this._isProcessing = true;
        const { fn, onFail, wait } = this._stack.shift();
        try {
            await fn();
        }
        catch (error) {
            onFail(error);
        }
        if (wait) {
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
        this._isProcessing = false;
        await this.process();
    }
}


/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_configuration_migrate_to_profiles__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(8);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(9);
/* harmony import */ var _shared_extension_add_context_menu__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(11);
/* harmony import */ var _shared_extension_add_install_listener__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(12);
/* harmony import */ var _shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(13);
/* harmony import */ var _shared_extension_open_view__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(14);
/* harmony import */ var _shared_extension_set_parsing_paused__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(16);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(17);
/* harmony import */ var _shared_messages_foreground_parse_page_command__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(19);
/* harmony import */ var _shared_messages_foreground_parse_selection_command__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(24);
/* harmony import */ var _jiten_deck_manager__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(25);
/* harmony import */ var _jiten_fetch_decks_command_handler__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(38);
/* harmony import */ var _jiten_card_actions_forget_card_command_handler__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(42);
/* harmony import */ var _jiten_card_actions_grade_card_command_handler__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(44);
/* harmony import */ var _jiten_card_actions_run_deck_action_command_handler__WEBPACK_IMPORTED_MODULE_15__ = __webpack_require__(47);
/* harmony import */ var _jiten_card_actions_update_card_state_command_handler__WEBPACK_IMPORTED_MODULE_16__ = __webpack_require__(52);
/* harmony import */ var _lib_background_command_handler_collection__WEBPACK_IMPORTED_MODULE_17__ = __webpack_require__(56);
/* harmony import */ var _lib_open_settings_command_handler__WEBPACK_IMPORTED_MODULE_18__ = __webpack_require__(57);
/* harmony import */ var _lib_update_badge_command_handler__WEBPACK_IMPORTED_MODULE_19__ = __webpack_require__(59);
/* harmony import */ var _lookup_lookup_controller__WEBPACK_IMPORTED_MODULE_20__ = __webpack_require__(61);
/* harmony import */ var _lookup_lookup_text_command_handler__WEBPACK_IMPORTED_MODULE_21__ = __webpack_require__(63);
/* harmony import */ var _parser_abort_request_command_handler__WEBPACK_IMPORTED_MODULE_22__ = __webpack_require__(65);
/* harmony import */ var _parser_parse_command_handler__WEBPACK_IMPORTED_MODULE_23__ = __webpack_require__(68);
/* harmony import */ var _parser_parse_controller__WEBPACK_IMPORTED_MODULE_24__ = __webpack_require__(73);

























const isMobile = navigator.userAgent.toLowerCase().includes('android') ??
    navigator.userAgentData?.mobile ??
    false;
const parsePageCommand = new _shared_messages_foreground_parse_page_command__WEBPACK_IMPORTED_MODULE_9__.ParsePageCommand();
const parseSelectionCommand = new _shared_messages_foreground_parse_selection_command__WEBPACK_IMPORTED_MODULE_10__.ParseSelectionCommand();
const lookupController = new _lookup_lookup_controller__WEBPACK_IMPORTED_MODULE_20__.LookupController();
const lookupTextCommandHandler = new _lookup_lookup_text_command_handler__WEBPACK_IMPORTED_MODULE_21__.LookupTextCommandHandler(lookupController);
const parseController = new _parser_parse_controller__WEBPACK_IMPORTED_MODULE_24__.ParseController();
const parseCommandHandler = new _parser_parse_command_handler__WEBPACK_IMPORTED_MODULE_23__.ParseCommandHandler(parseController);
const abortRequestCommandHandler = new _parser_abort_request_command_handler__WEBPACK_IMPORTED_MODULE_22__.AbortRequestCommandHandler(parseController);
const deckManager = new _jiten_deck_manager__WEBPACK_IMPORTED_MODULE_11__.DeckManager();
const fetchDecksCommandHandler = new _jiten_fetch_decks_command_handler__WEBPACK_IMPORTED_MODULE_12__.FetchDecksCommandHandler(deckManager);
const updateCardStateCommandHandler = new _jiten_card_actions_update_card_state_command_handler__WEBPACK_IMPORTED_MODULE_16__.UpdateCardStateCommandHandler();
const gradeCardCommandHandler = new _jiten_card_actions_grade_card_command_handler__WEBPACK_IMPORTED_MODULE_14__.GradeCardCommandHandler();
const runDeckActionCommandHandler = new _jiten_card_actions_run_deck_action_command_handler__WEBPACK_IMPORTED_MODULE_15__.RunDeckActionCommandHandler();
const forgetCardCommandHandler = new _jiten_card_actions_forget_card_command_handler__WEBPACK_IMPORTED_MODULE_13__.ForgetCardCommandHandler();
const openSettingsCommandHandler = new _lib_open_settings_command_handler__WEBPACK_IMPORTED_MODULE_18__.OpenSettingsCommandHandler();
const updateBadgeCommandHandler = new _lib_update_badge_command_handler__WEBPACK_IMPORTED_MODULE_19__.UpdateBadgeCommandHandler();
const handlerCollection = new _lib_background_command_handler_collection__WEBPACK_IMPORTED_MODULE_17__.BackgroundCommandHandlerCollection(fetchDecksCommandHandler, lookupTextCommandHandler, parseCommandHandler, abortRequestCommandHandler, updateCardStateCommandHandler, gradeCardCommandHandler, runDeckActionCommandHandler, forgetCardCommandHandler, openSettingsCommandHandler, updateBadgeCommandHandler);
handlerCollection.listen();
void (0,_shared_extension_set_parsing_paused__WEBPACK_IMPORTED_MODULE_7__.setParsingPaused)(false);
(0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_8__.onBroadcastMessage)('profileSwitched', () => {
    (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.invalidateProfileCache)();
    (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__.invalidateSetConfigurationCache)();
});
(0,_shared_extension_add_install_listener__WEBPACK_IMPORTED_MODULE_4__.addInstallListener)(async ({ reason }) => {
    if (reason === _shared_extension_add_install_listener__WEBPACK_IMPORTED_MODULE_4__.OnInstalledReason.INSTALL) {
        await (0,_shared_configuration_migrate_to_profiles__WEBPACK_IMPORTED_MODULE_1__.migrateToProfiles)();
        await (0,_shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_5__.openOptionsPage)();
    }
    if (reason === _shared_extension_add_install_listener__WEBPACK_IMPORTED_MODULE_4__.OnInstalledReason.UPDATE) {
        await (0,_shared_configuration_migrate_to_profiles__WEBPACK_IMPORTED_MODULE_1__.migrateToProfiles)();
        const skipReleaseNotes = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('skipReleaseNotes');
        if (skipReleaseNotes) {
            return;
        }
        await (0,_shared_extension_open_view__WEBPACK_IMPORTED_MODULE_6__.openView)('changelog');
    }
});
if (!isMobile) {
    (0,_shared_extension_add_context_menu__WEBPACK_IMPORTED_MODULE_3__.addContextMenu)({
        id: 'parse-page',
        title: 'Parse Page',
        contexts: ['page'],
    }, (_, { id }) => parsePageCommand.send(id));
    (0,_shared_extension_add_context_menu__WEBPACK_IMPORTED_MODULE_3__.addContextMenu)({
        id: 'parse-selection',
        title: 'Parse Selection',
        contexts: ['selection'],
    }, (_, { id }) => parseSelectionCommand.send(id));
}

})();

/******/ })()
;