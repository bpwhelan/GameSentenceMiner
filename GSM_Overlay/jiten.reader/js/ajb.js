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
    showParseButton: true,
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
/* 8 */,
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
/* 11 */,
/* 12 */,
/* 13 */,
/* 14 */,
/* 15 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getURL: () => (/* binding */ getURL)
/* harmony export */ });
const getURL = (url) => chrome.runtime.getURL(url);


/***/ }),
/* 16 */,
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
/* 19 */,
/* 20 */,
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
/* 24 */,
/* 25 */,
/* 26 */,
/* 27 */,
/* 28 */,
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
/* 35 */,
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
/* 38 */,
/* 39 */,
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
/* 41 */,
/* 42 */,
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
/* 44 */,
/* 45 */,
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
/* 47 */,
/* 48 */,
/* 49 */,
/* 50 */,
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
/* 52 */,
/* 53 */,
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
/* 55 */,
/* 56 */,
/* 57 */,
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
/* 59 */,
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
/* 61 */,
/* 62 */,
/* 63 */,
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
/* 65 */,
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
/* 67 */,
/* 68 */,
/* 69 */,
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
/* 71 */,
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
/* 73 */,
/* 74 */,
/* 75 */,
/* 76 */,
/* 77 */,
/* 78 */,
/* 79 */,
/* 80 */,
/* 81 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   debug: () => (/* binding */ debug)
/* harmony export */ });
let debugEnabled = undefined;
const bufferedDebugMessages = [];
chrome.storage.local.onChanged.addListener((changes) => {
    if (changes.enableDebugMode) {
        debugEnabled = changes.enableDebugMode.newValue;
    }
});
chrome.storage.local.get('enableDebugMode', (result) => {
    debugEnabled = result.enableDebugMode ? result.enableDebugMode === 'true' : false;
    drainBufferedDebugMessages();
});
const debug = (message, ...optionalParams) => {
    if (debugEnabled === undefined) {
        bufferedDebugMessages.push([message, ...optionalParams]);
        return;
    }
    if (!debugEnabled) {
        return;
    }
    console.log(`[DEBUG] ${message}`, ...optionalParams);
};
const drainBufferedDebugMessages = () => {
    if (debugEnabled === undefined || debugEnabled === false) {
        return;
    }
    for (const [message, ...optionalParams] of bufferedDebugMessages) {
        console.log(`[DEBUG] ${message}`, ...optionalParams);
    }
    bufferedDebugMessages.length = 0;
};


/***/ }),
/* 82 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   receiveBackgroundMessage: () => (/* binding */ receiveBackgroundMessage)
/* harmony export */ });
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);

const receiveBackgroundMessage = (event, handler) => {
    _extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.onMessage.addListener((request, _, sendResponse) => {
        const args = request.args;
        if (request.event !== event) {
            return false;
        }
        const handlerResult = handler(...args);
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
};


/***/ }),
/* 83 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getFeatures: () => (/* binding */ getFeatures)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_features_features__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(84);
/* harmony import */ var _shared_match_url__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(85);
/* harmony import */ var _crunchyroll_com_feature__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(86);




async function getFeatures() {
    const isMainFrame = window === window.top;
    const enabledFeatures = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('enabledFeatures');
    const features = {
        [_shared_features_features__WEBPACK_IMPORTED_MODULE_1__.CRUNCHYROLL.id]: [_shared_features_features__WEBPACK_IMPORTED_MODULE_1__.CRUNCHYROLL, _crunchyroll_com_feature__WEBPACK_IMPORTED_MODULE_3__.CrunchyrollFeature],
    };
    const active = [];
    for (const featureId of enabledFeatures) {
        const feature = features[featureId];
        if (!feature) {
            continue;
        }
        const [featureDef, featureClass] = feature;
        if (!featureDef.allFrames && !isMainFrame) {
            continue;
        }
        const hostDef = featureDef.host;
        const host = Array.isArray(hostDef) ? hostDef : [hostDef];
        const isActive = feature && host.some((h) => (0,_shared_match_url__WEBPACK_IMPORTED_MODULE_2__.matchUrl)(h, window.location.href));
        if (isActive) {
            active.push(new featureClass());
        }
    }
    return active;
}


/***/ }),
/* 84 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CRUNCHYROLL: () => (/* binding */ CRUNCHYROLL),
/* harmony export */   FEATURES: () => (/* binding */ FEATURES)
/* harmony export */ });
const CRUNCHYROLL = {
    id: 'crunchyroll.com',
    name: 'Crunchyroll',
    description: 'Force removes Crunchyroll subtitles',
    host: '*://static.crunchyroll.com/*',
    allFrames: true,
};
const FEATURES = [CRUNCHYROLL];


/***/ }),
/* 85 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   matchUrl: () => (/* binding */ matchUrl)
/* harmony export */ });
const matchUrl = (matchPattern, host) => {
    if (matchPattern === '<all_urls>') {
        return true;
    }
    let [patternSchema, patternUrl] = matchPattern.split('://', 2);
    const [patternHost, patternPath] = patternUrl.split(/\/(.*)/, 2);
    const [hostSchema, hostUrl] = host.split('://', 2);
    const [hostHost, hostPath] = hostUrl.split(/\/(.*)/, 2);
    if (patternSchema === '') {
        patternSchema = '*';
    }
    if (patternSchema === '*' && !['http', 'https'].includes(hostSchema)) {
        return false;
    }
    if (patternSchema !== '*' && patternSchema !== hostSchema) {
        return false;
    }
    const hostRegex = new RegExp(`^${patternHost.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
    const pathRegex = new RegExp(`^${patternPath.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
    if (!hostHost.match(hostRegex)) {
        return false;
    }
    if (!hostPath.match(pathRegex)) {
        return false;
    }
    return true;
};


/***/ }),
/* 86 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CrunchyrollFeature: () => (/* binding */ CrunchyrollFeature)
/* harmony export */ });
class CrunchyrollFeature {
    apply() {
        const style = document.createElement('style');
        style.textContent = `
      #velocity-canvas {
        display: none !important;
      }

      [data-testid="vilos-settings_texttrack_submenu"] {
        display: none !important;
      }
    `;
        document.head.append(style);
    }
}


/***/ }),
/* 87 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   KeybindManager: () => (/* binding */ KeybindManager)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(17);
/* harmony import */ var _no_focus_trigger__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(88);
/* harmony import */ var _registry__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(89);




class KeybindManager {
    constructor(_events, extraListeners) {
        this._events = _events;
        this._keyMap = {};
        this._sortedKeylist = [];
        this._downListener = this.handleKeydown.bind(this);
        this._upListener = this.handleKeyUp.bind(this);
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', () => this.buildKeyMap(), true);
        this._keydown = extraListeners?.keydown;
        this._keyup = extraListeners?.keyup;
    }
    addKeys(keys, skipBuild = false) {
        this._events = [...new Set([...this._events, ...keys])];
        if (!skipBuild) {
            return this.buildKeyMap();
        }
    }
    removeKeys(keys, skipBuild = false) {
        this._events = this._events.filter((key) => !keys.includes(key));
        if (!skipBuild) {
            return this.buildKeyMap();
        }
    }
    activate() {
        _no_focus_trigger__WEBPACK_IMPORTED_MODULE_2__.NoFocusTrigger.get().register(this, this._downListener);
        window.addEventListener('keydown', this._downListener);
        window.addEventListener('mousedown', this._downListener);
        window.addEventListener('keyup', this._upListener);
        window.addEventListener('mouseup', this._upListener);
    }
    deactivate() {
        _no_focus_trigger__WEBPACK_IMPORTED_MODULE_2__.NoFocusTrigger.get().unregister(this);
        window.removeEventListener('keydown', this._downListener);
        window.removeEventListener('mousedown', this._downListener);
        window.removeEventListener('keyup', this._upListener);
        window.removeEventListener('mouseup', this._upListener);
    }
    async buildKeyMap() {
        this._keyMap = {};
        this._sortedKeylist = [];
        for (const key of this._events) {
            const raw = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)(key);
            const value = (Array.isArray(raw) ? raw.filter((v) => v?.code) : raw.code ? [raw] : null);
            if (value?.length) {
                this._keyMap[key] = value;
            }
        }
        this._sortedKeylist = Object.entries(this._keyMap)
            .map(([key, val]) => val.map((v) => ({ key, val: v })))
            .flat()
            .sort((l, r) => {
            if (l.val.modifiers.length !== r.val.modifiers.length) {
                return r.val.modifiers.length - l.val.modifiers.length;
            }
            return l.val.code.localeCompare(r.val.code);
        });
    }
    handleKeydown(e) {
        const { events } = _registry__WEBPACK_IMPORTED_MODULE_3__.Registry;
        if (this.shouldCancel()) {
            return;
        }
        events.emit('keydown', e);
        this._keydown?.(e);
        const keybind = this.getActiveKeybind(e);
        if (keybind) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            events.emit(keybind, e);
        }
    }
    handleKeyUp(e) {
        const { events } = _registry__WEBPACK_IMPORTED_MODULE_3__.Registry;
        if (this.shouldCancel()) {
            return;
        }
        events.emit('keyup', e);
        this._keyup?.(e);
        const keybind = this.getActiveKeybind(e);
        if (keybind) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            events.emit(`${keybind}Released`, e);
        }
    }
    shouldCancel() {
        return ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '');
    }
    getActiveKeybind(e) {
        return this._sortedKeylist.find(({ val }) => this.checkKeybind(val, e))?.key;
    }
    checkKeybind(keybind, event) {
        if (!keybind) {
            return false;
        }
        if (event instanceof MouseEvent && event.type === 'mousemove') {
            return this.checkMoveEvent(keybind, event);
        }
        const code = event instanceof KeyboardEvent ? event.code : `Mouse${event.button}`;
        return code === keybind.code && keybind.modifiers.every((name) => event.getModifierState(name));
    }
    checkMoveEvent(keybind, event) {
        const modifierMap = {
            ShiftLeft: 'Shift',
            ShiftRight: 'Shift',
            ControlLeft: 'Control',
            ControlRight: 'Control',
            AltLeft: 'Alt',
            AltRight: 'Alt',
        };
        const required = [...keybind.modifiers, modifierMap[keybind.code] ?? keybind.code].filter(Boolean);
        return required.length > 0 && required.every((name) => event.getModifierState(name));
    }
}


/***/ }),
/* 88 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   NoFocusTrigger: () => (/* binding */ NoFocusTrigger)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(17);


class NoFocusTrigger {
    constructor() {
        this._touchscreenSupport = false;
        this._activeKeybindManagers = new Map();
    }
    static get() {
        if (!this._instance) {
            this._instance = new NoFocusTrigger();
        }
        return this._instance;
    }
    install() {
        const onMouseMove = (e) => this.onMouseMove(e);
        this.installEvents(onMouseMove);
    }
    register(keybindManager, e) {
        this._activeKeybindManagers.set(keybindManager, e);
    }
    unregister(keybindManager) {
        this._activeKeybindManagers.delete(keybindManager);
    }
    installEvents(handler) {
        let hasEvent = false;
        window.addEventListener('blur', () => {
            if (this._touchscreenSupport) {
                return;
            }
            document.addEventListener('mousemove', handler);
            hasEvent = true;
        });
        window.addEventListener('focus', () => {
            document.removeEventListener('mousemove', handler);
            hasEvent = false;
        });
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', async () => {
            this._touchscreenSupport = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenSupport');
            if (this._touchscreenSupport) {
                document.removeEventListener('mousemove', handler);
                hasEvent = false;
                return;
            }
            if (hasEvent || document.hasFocus()) {
                return;
            }
            document.addEventListener('mousemove', handler);
            hasEvent = true;
        }, true);
    }
    onMouseMove(e) {
        if (document.hasFocus()) {
            return;
        }
        const currentModifierStates = [
            e.getModifierState('Control'),
            e.getModifierState('Shift'),
            e.getModifierState('Alt'),
        ];
        if (currentModifierStates.includes(true)) {
            for (const handler of this._activeKeybindManagers.values()) {
                handler(e);
            }
        }
    }
}
NoFocusTrigger._instance = null;


/***/ }),
/* 89 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Registry: () => (/* binding */ Registry)
/* harmony export */ });
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(4);
/* harmony import */ var _batches_batch_controller__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(90);
/* harmony import */ var _sequence_sequence_manager__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(98);
/* harmony import */ var _event_collection__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(99);
/* harmony import */ var _host_evaluator__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(100);
/* harmony import */ var _sentence_manager__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(103);
/* harmony import */ var _word_event_delegator__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(104);







class Registry {
    static addCard(card, element, conjugations) {
        const key = `${card.wordId}/${card.readingIndex}`;
        this.cards.set(key, card);
        if (conjugations && conjugations.length > 0) {
            conjugations = conjugations
                .filter((conj) => !conj.startsWith('('))
                .filter((conj) => conj != '');
            conjugations.reverse();
            this.conjugations.set(element, conjugations);
        }
    }
    static updateCard(wordId, readingIndex, state) {
        const card = this.getCard(wordId, readingIndex);
        const managedStates = Object.values(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState);
        if (!card) {
            return;
        }
        card.cardState = state;
        document
            .querySelectorAll(`[wordId="${wordId}"][readingIndex="${readingIndex}"]`)
            .forEach((element) => {
            const classes = Array.from(element.classList).filter((x) => !managedStates.includes(x));
            classes.push(...state);
            element.classList.value = classes.join(' ');
        });
        this.sentenceManager.updateCardState(wordId, readingIndex, state);
    }
    static getCard(wordId, readingIndex) {
        return this.cards.get(`${wordId}/${readingIndex}`);
    }
    static getConjugations(element) {
        return this.conjugations.get(element);
    }
    static getCardFromElement(element) {
        const wordId = element.getAttribute('wordId');
        const readingIndex = element.getAttribute('readingIndex');
        if (!wordId || !readingIndex) {
            return;
        }
        return this.getCard(parseInt(wordId, 10), parseInt(readingIndex, 10));
    }
    static getAllCards() {
        return this.cards;
    }
}
Registry.isMainFrame = window === window.top;
Registry.events = new _event_collection__WEBPACK_IMPORTED_MODULE_3__.EventCollection();
Registry.hostEvaluator = new _host_evaluator__WEBPACK_IMPORTED_MODULE_4__.HostEvaluator();
Registry.wordEventDelegator = _word_event_delegator__WEBPACK_IMPORTED_MODULE_6__.WordEventDelegator.getInstance();
Registry.parsers = [];
Registry.batchController = new _batches_batch_controller__WEBPACK_IMPORTED_MODULE_1__.BatchController();
Registry.sequenceManager = new _sequence_sequence_manager__WEBPACK_IMPORTED_MODULE_2__.SequenceManager();
Registry.sentenceManager = new _sentence_manager__WEBPACK_IMPORTED_MODULE_5__.SentenceManager();
Registry.textHighlighterOptions = {
    skipFurigana: false,
    generatePitch: false,
    markFrequency: false,
    markAll: false,
    markIPlus1: false,
    minSentenceLength: 3,
    markOnlyFrequent: false,
    newStates: [],
};
Registry.skipTouchEvents = false;
Registry.cards = new Map();
Registry.conjugations = new WeakMap();


/***/ }),
/* 90 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BatchController: () => (/* binding */ BatchController)
/* harmony export */ });
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(29);
/* harmony import */ var _shared_messages_background_parse_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(70);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(89);
/* harmony import */ var _sequence_canceled__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(91);
/* harmony import */ var _apply_tokens__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(92);
/* harmony import */ var _get_paragraphs__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(95);






class BatchController {
    constructor() {
        this._pendingBatches = new Map();
    }
    registerNodes(nodes, options = {}) {
        nodes.forEach((node) => this.registerNode(node, options));
    }
    registerNode(node, options = {}) {
        const { filter, onEmpty, getParagraphsFn = _get_paragraphs__WEBPACK_IMPORTED_MODULE_5__.getParagraphs, applyFn = _apply_tokens__WEBPACK_IMPORTED_MODULE_4__.applyTokens } = options;
        if (this._pendingBatches.has(node)) {
            return;
        }
        const paragraphs = getParagraphsFn(node, filter);
        if (!paragraphs.length) {
            return onEmpty?.(node);
        }
        this.prepareNode(node, paragraphs, applyFn);
    }
    dismissNode(node) {
        this._pendingBatches.get(node)?.forEach((batch) => batch.abort());
        this._pendingBatches.delete(node);
    }
    parseBatches(afterSend) {
        const batches = Array.from(this._pendingBatches.values());
        const sequences = batches.flatMap((b) => b);
        const sequenceData = sequences.map((s) => [s.sequenceId, s.data.map((f) => f.node.data).join('')]);
        new _shared_messages_background_parse_command__WEBPACK_IMPORTED_MODULE_1__.ParseCommand(sequenceData).send(afterSend);
        this._pendingBatches.clear();
    }
    prepareNode(node, paragraphs, applyFn) {
        const batches = paragraphs.map((paragraph) => _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.sequenceManager.getAbortableSequence(paragraph));
        this._pendingBatches.set(node, batches);
        this.prepareBatches(node, applyFn);
    }
    prepareBatches(node, applyFn) {
        const batches = this._pendingBatches.get(node);
        void batches.reduce((previousPromise, batch) => previousPromise.then(async () => {
            try {
                const value = await batch.promise;
                await applyFn(batch.data, value);
            }
            catch (error) {
                if (error instanceof _sequence_canceled__WEBPACK_IMPORTED_MODULE_3__.Canceled) {
                    return;
                }
                if (error.message === 'Failed to fetch') {
                    (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('error', 'api.jiten.moe is unreachable', error.message);
                    return;
                }
                console.error(error);
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('error', 'An error occurred while parsing the text', error.message);
            }
        }), Promise.resolve());
    }
}


/***/ }),
/* 91 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Canceled: () => (/* binding */ Canceled)
/* harmony export */ });
class Canceled extends Error {
}


/***/ }),
/* 92 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   applyTokens: () => (/* binding */ applyTokens)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(89);
/* harmony import */ var _text_highlighter_text_highlighter__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(93);


let statsUpdateTimeout;
const applyTokens = async (fragments, tokens) => {
    await new _text_highlighter_text_highlighter__WEBPACK_IMPORTED_MODULE_1__.TextHighlighter(fragments, tokens).apply();
    if (statsUpdateTimeout) {
        clearTimeout(statsUpdateTimeout);
    }
    statsUpdateTimeout = window.setTimeout(() => {
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.statusBar?.recalculateStats();
        statsUpdateTimeout = undefined;
    }, 100);
};


/***/ }),
/* 93 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TextHighlighter: () => (/* binding */ TextHighlighter)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(31);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(89);
/* harmony import */ var _base_text_highlighter__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(94);



class TextHighlighter extends _base_text_highlighter__WEBPACK_IMPORTED_MODULE_2__.BaseTextHighlighter {
    constructor() {
        super(...arguments);
        this._fragments = new Set(this.fragments);
        this._tokens = new Set(this.tokens);
        this._tokenToFragmentsMap = new Map();
        this._fragmentToTokensMap = new Map();
    }
    async apply() {
        await this.preprocess();
        this.patchUnparsedFragments();
        await this.yieldToMainThread();
        await this.patchNonRubyTokensChunked();
        await this.patchContainedRubyElementsChunked();
        await this.patchFragmentedRubyTokensChunked();
        this.patchRemainingMisparses();
        if (_integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.textHighlighterOptions.markIPlus1) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.sentenceManager.calculateTargetSentences();
        }
    }
    yieldToMainThread() {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    async processInChunks(items, processor) {
        const entries = [...items.entries()];
        let processed = 0;
        for (const [item, fragments] of entries) {
            processor(item, fragments);
            processed++;
            if (processed % TextHighlighter.CHUNK_SIZE === 0 && processed < entries.length) {
                await this.yieldToMainThread();
            }
        }
    }
    async splitMultiTokenFragmentsChunked() {
        const filtered = this.filterMap(this._fragmentToTokensMap, (tokens, _fragment) => tokens.length > 1);
        const entries = [...filtered.entries()];
        let processed = 0;
        for (const [fragment, tokens] of entries) {
            let token;
            while ((token = tokens.pop())) {
                this.cutoffTokenEnd(token, fragment);
                if (token.start < fragment.start) {
                    tokens.push(token);
                    this._tokenToFragmentsMap.get(token)?.push(fragment);
                    break;
                }
                const newFragmentNode = this.splitFragmentsNode(fragment, token.start);
                const newFragment = this.insertNewFragment(newFragmentNode, token.start, fragment.rubyElement);
                this._fragmentToTokensMap.set(newFragment, [token]);
                this._tokenToFragmentsMap.set(token, [newFragment]);
                this.fixFragmentParameters(fragment);
            }
            if (fragment.length && !this._fragmentToTokensMap.get(fragment)?.length) {
                this.patchOrWrap(fragment);
                this.dismissElements(fragment);
            }
            processed++;
            if (processed % TextHighlighter.CHUNK_SIZE === 0 && processed < entries.length) {
                await this.yieldToMainThread();
            }
        }
    }
    async adjustUnmatchedFragmentsChunked() {
        const filtered = this.filterMap(this._tokenToFragmentsMap, (fragments, token) => !this.areBoundariesExactMatch(token, fragments));
        const entries = [...filtered.entries()];
        let processed = 0;
        for (const [token, fragments] of entries) {
            this.adjustFragmentEnds(fragments, token);
            this.adjustFragmentStarts(fragments, token);
            processed++;
            if (processed % TextHighlighter.CHUNK_SIZE === 0 && processed < entries.length) {
                await this.yieldToMainThread();
            }
        }
    }
    async patchNonRubyTokensChunked() {
        const filtered = this.filterMap(this._tokenToFragmentsMap, (fragments, token) => !token.rubies.length && this.areBoundariesExactMatch(token, fragments));
        await this.processInChunks(filtered, (token, fragments) => {
            fragments.forEach((fragment) => this.patchOrWrap(fragment, token));
        });
    }
    async patchContainedRubyElementsChunked() {
        const filtered = this.filterMap(this._tokenToFragmentsMap, (fragments, token) => !!token.rubies.length &&
            this.areBoundariesExactMatch(token, fragments) &&
            this.fragmentsShareSingleRuby(fragments));
        await this.processInChunks(filtered, (token, fragments) => {
            const rubyElement = this.getSharedRubyElement(fragments);
            fragments.forEach((fragment) => this.dismissElements(fragment, token));
            if (!rubyElement) {
                return this.applyRubiesToFragment(fragments[0], token);
            }
            if (this.isMisparsedRuby(rubyElement, token)) {
                return this.markElementAsMisparsed(rubyElement);
            }
            this.patchElement(rubyElement, token);
        });
    }
    async patchFragmentedRubyTokensChunked() {
        const filtered = this.filterMap(this._tokenToFragmentsMap, (fragments) => fragments.length > 0);
        await this.processInChunks(filtered, (token, fragments) => {
            if (this.applyOnSharedParent(fragments, token)) {
                return;
            }
            fragments.forEach((fragment) => {
                const fragmentsRuby = this.findParent(fragment.node, 'RUBY');
                if (fragmentsRuby) {
                    this.patchElement(fragmentsRuby, token);
                    this.dismissElements(fragment, token);
                    return;
                }
                const fragmentRubies = token.rubies.filter((ruby) => ruby.start >= fragment.start && ruby.end <= fragment.end);
                if (fragmentRubies?.length) {
                    return this.applyRubiesToFragment(fragment, token, fragmentRubies);
                }
                this.patchOrWrap(fragment, token);
            });
        });
    }
    async preprocess() {
        this.buildMaps();
        await this.splitMultiTokenFragmentsChunked();
        await this.adjustUnmatchedFragmentsChunked();
        this.rebuildMaps();
        await this.splitMultiTokenFragmentsChunked();
    }
    rebuildMaps() {
        this._fragments = new Set([...this._fragments].sort((a, b) => a.start - b.start));
        this._tokens = new Set([...this._tokens].sort((a, b) => a.start - b.start));
        this._fragmentToTokensMap.clear();
        this._tokenToFragmentsMap.clear();
        this.buildMaps();
    }
    buildMaps() {
        const sortedTokens = [...this._tokens].sort((a, b) => a.start - b.start);
        const sortedFragments = [...this._fragments].sort((a, b) => a.start - b.start);
        for (const fragment of sortedFragments) {
            this._fragmentToTokensMap.set(fragment, []);
        }
        let fragIndex = 0;
        for (const token of sortedTokens) {
            const matchingFragments = [];
            while (fragIndex < sortedFragments.length && sortedFragments[fragIndex].end <= token.start) {
                fragIndex++;
            }
            let scanIndex = fragIndex;
            while (scanIndex < sortedFragments.length && sortedFragments[scanIndex].start < token.end) {
                const fragment = sortedFragments[scanIndex];
                if (this.isFragmentWithinToken(fragment, token)) {
                    matchingFragments.push(fragment);
                    this._fragmentToTokensMap.get(fragment).push(token);
                }
                scanIndex++;
            }
            this._tokenToFragmentsMap.set(token, matchingFragments);
        }
    }
    splitMultiTokenFragments() {
        this.filterMap(this._fragmentToTokensMap, (tokens, _fragment) => tokens.length > 1).forEach((tokens, fragment) => {
            let token;
            while ((token = tokens.pop())) {
                this.cutoffTokenEnd(token, fragment);
                if (token.start < fragment.start) {
                    this._fragmentToTokensMap.get(fragment)?.push(token);
                    this._tokenToFragmentsMap.get(token)?.push(fragment);
                    break;
                }
                const newFragmentNode = this.splitFragmentsNode(fragment, token.start);
                const newFragment = this.insertNewFragment(newFragmentNode, token.start, fragment.rubyElement);
                this._fragmentToTokensMap.set(newFragment, [token]);
                this._tokenToFragmentsMap.set(token, [newFragment]);
                this.fixFragmentParameters(fragment);
            }
            if (fragment.length && !this._fragmentToTokensMap.get(fragment)?.length) {
                this.patchOrWrap(fragment);
            }
            this.dismissElements(fragment);
        });
    }
    cutoffTokenEnd(token, fragment) {
        if (token.end < fragment.end) {
            this.patchOrWrap(this.splitFragmentsNode(fragment, token.end));
            this.fixFragmentParameters(fragment);
        }
    }
    adjustUnmatchedFragments() {
        this.filterMap(this._tokenToFragmentsMap, (fragments, tokens) => !this.areBoundariesExactMatch(tokens, fragments)).forEach((fragments, token) => {
            this.adjustFragmentEnds(fragments, token);
            this.adjustFragmentStarts(fragments, token);
        });
    }
    adjustFragmentEnds(fragments, token) {
        fragments
            .filter((fragment) => this.isFragmentWithinToken(fragment, token))
            .forEach((fragment) => {
            if (fragment.end > token.end) {
                const overlap = this.splitFragmentsNode(fragment, token.end);
                this.fixFragmentParameters(fragment);
                this.insertNewFragment(overlap, token.end, fragment.rubyElement);
            }
        });
    }
    adjustFragmentStarts(fragments, token) {
        fragments
            .filter((fragment) => this.isFragmentWithinToken(fragment, token))
            .forEach((fragment) => {
            if (fragment.start < token.start) {
                const correctedFragmentTextNode = this.splitFragmentsNode(fragment, token.start);
                fragment.node = correctedFragmentTextNode;
                fragment.start = token.start;
                this.fixFragmentParameters(fragment);
            }
        });
    }
    patchUnparsedFragments() {
        this.filterMap(this._fragmentToTokensMap, (tokens) => !tokens.length).forEach((_, fragment) => this.patchOrWrap(fragment));
    }
    patchNonRubyTokens() {
        this.filterMap(this._tokenToFragmentsMap, (fragments, token) => !token.rubies.length && this.areBoundariesExactMatch(token, fragments)).forEach((fragments, token) => fragments.forEach((fragment) => this.patchOrWrap(fragment, token)));
    }
    patchContainedRubyElements() {
        this.filterMap(this._tokenToFragmentsMap, (fragments, token) => !!token.rubies.length &&
            this.areBoundariesExactMatch(token, fragments) &&
            this.fragmentsShareSingleRuby(fragments)).forEach((fragments, token) => {
            const rubyElement = this.getSharedRubyElement(fragments);
            fragments.forEach((fragment) => this.dismissElements(fragment, token));
            if (!rubyElement) {
                return this.applyRubiesToFragment(fragments[0], token);
            }
            if (this.isMisparsedRuby(rubyElement, token)) {
                return this.markElementAsMisparsed(rubyElement);
            }
            this.patchElement(rubyElement, token);
        });
    }
    applyRubiesToFragment(fragment, token, rubies = token.rubies) {
        const newRuby = this.wrapElement(fragment.node, token);
        if (_integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.textHighlighterOptions.skipFurigana) {
            return;
        }
        const docFrag = this.createRubyNodesForFragment(fragment, rubies);
        newRuby.textContent = '';
        newRuby.append(docFrag);
    }
    createRubyNodesForFragment(fragment, rubies) {
        const nodeText = fragment.node.textContent;
        let lastIndex = 0;
        const docFrag = document.createDocumentFragment();
        const sortedRubies = [...rubies].sort((a, b) => a.start - b.start);
        for (const ruby of sortedRubies) {
            const rubyStart = ruby.start - fragment.start;
            const rubyEnd = ruby.end - fragment.start;
            if (rubyStart > lastIndex) {
                docFrag.append(document.createTextNode(nodeText.slice(lastIndex, rubyStart)));
            }
            const rubyElem = document.createElement('ruby');
            const rt = document.createElement('rt');
            rubyElem.append(document.createTextNode(nodeText.slice(rubyStart, rubyEnd)));
            rt.className = 'jiten-furi';
            rt.textContent = ruby.text;
            rubyElem.append(rt);
            docFrag.append(rubyElem);
            lastIndex = rubyEnd;
        }
        if (lastIndex < nodeText.length) {
            docFrag.append(document.createTextNode(nodeText.slice(lastIndex)));
        }
        return docFrag;
    }
    patchFragmentedRubyTokens() {
        this.filterMap(this._tokenToFragmentsMap, (fragments, token) => this.areBoundariesExactMatch(token, fragments)).forEach((fragments, token) => {
            if (this.applyOnSharedParent(fragments, token)) {
                return;
            }
            fragments.forEach((fragment) => {
                const fragmentsRuby = this.findParent(fragment.node, 'RUBY');
                if (fragmentsRuby) {
                    this.patchElement(fragmentsRuby, token);
                    this.dismissElements(fragment, token);
                    return;
                }
                const fragmentRubies = token.rubies.filter((ruby) => ruby.start >= fragment.start && ruby.end <= fragment.end);
                if (fragmentRubies?.length) {
                    return this.applyRubiesToFragment(fragment, token, fragmentRubies);
                }
                this.patchOrWrap(fragment, token);
            });
        });
    }
    applyOnSharedParent(fragments, token) {
        const anyHasRuby = fragments.some((fragment) => this.findParent(fragment.node, 'RUBY'));
        const sharedParentNode = this.findSharedParent(fragments[0].node, fragments[fragments.length - 1].node);
        if (sharedParentNode && anyHasRuby) {
            const clone = sharedParentNode.cloneNode(true);
            if (!_integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.textHighlighterOptions.skipFurigana) {
                clone.querySelectorAll('rt').forEach((rt) => rt.remove());
            }
            const cloneText = clone.textContent;
            const fragmentText = fragments.map((fragment) => fragment.node.textContent).join('');
            if (cloneText === fragmentText) {
                this.patchElement(sharedParentNode, token);
                fragments.forEach((fragment) => {
                    this.dismissElements(fragment, token);
                });
                return true;
            }
        }
        return false;
    }
    findSharedParent(nodeA, NodeB) {
        let parent = nodeA.parentElement;
        while (parent) {
            if (parent.contains(NodeB)) {
                return parent;
            }
            parent = parent.parentElement;
        }
        return null;
    }
    patchRemainingMisparses() {
        this._tokenToFragmentsMap.forEach((fragments, token) => {
            if (this.checkUnmatchedFragmentMisparse(token, fragments)) {
                fragments.forEach((fragment) => this.dismissElements(fragment, token));
            }
        });
    }
    checkUnmatchedFragmentMisparse(token, fragments) {
        let isMisparse = false;
        if (token.rubies.length && fragments.some((fragment) => fragment.hasRuby)) {
            fragments.forEach((fragment) => {
                if (!fragment.hasRuby) {
                    return;
                }
                const parentRuby = this.findParent(fragment.node, 'RUBY');
                isMisparse = isMisparse || (parentRuby ? this.isMisparsedRuby(parentRuby, token) : false);
            });
            if (isMisparse) {
                fragments.forEach((fragment) => {
                    const rubyParent = this.findParent(fragment.node, 'RUBY');
                    if (rubyParent) {
                        this.markElementAsMisparsed(rubyParent);
                    }
                    this.markNodeAsMisparsed(fragment.node);
                });
            }
        }
        return isMisparse;
    }
    markNodeAsMisparsed(node) {
        const parent = node.parentElement;
        if (!parent) {
            return;
        }
        const wrapper = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('span', {
            class: ['jiten-word', 'misparsed'],
            attributes: { ajb: 'true' },
        });
        parent.replaceChild(wrapper, node);
        wrapper.appendChild(node);
    }
    isFragmentWithinToken(fragment, token) {
        return fragment.end > token.start && fragment.start < token.end;
    }
    splitFragmentsNode(fragment, start) {
        const node = fragment.node;
        try {
            return node.splitText(start - fragment.start);
        }
        catch (error) {
            console.error('Error splitting fragment node', {
                fragment,
                start,
                internalLength: node.data.length,
            });
            throw error;
        }
    }
    fixFragmentParameters(fragment) {
        fragment.length = fragment.node.data.length;
        fragment.end = fragment.start + fragment.length;
    }
    insertNewFragment(node, start, rubyElement) {
        const length = node.data.length;
        const newFragment = {
            node,
            start: start,
            end: start + length,
            length: length,
            hasRuby: !!rubyElement,
            rubyElement,
        };
        this._fragments.add(newFragment);
        return newFragment;
    }
    filterMap(map, filter) {
        const result = new Map();
        map.forEach((values, key) => {
            if (filter(values, key)) {
                result.set(key, values);
            }
        });
        return result;
    }
    patchOrWrap(fragment, token) {
        const isFragment = this.isFragment(fragment);
        const node = isFragment ? fragment.node : fragment;
        const fragmentsParent = isFragment ? node.parentElement : node.parentElement;
        if (!fragmentsParent) {
            return null;
        }
        if (isFragment) {
            this.dismissElements(fragment, token);
        }
        const rubyParent = this.findParent(node, 'RUBY');
        if (rubyParent && !rubyParent.hasAttribute('ajb')) {
            this.patchElement(rubyParent, token);
            if (!_integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.textHighlighterOptions.skipFurigana) {
                rubyParent.querySelectorAll('rt').forEach((rt) => rt.classList.add('jiten-furi'));
            }
            return rubyParent;
        }
        if (fragmentsParent.childNodes.length > 1) {
            const element = this.wrapElement(node, token);
            if (!_integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.textHighlighterOptions.skipFurigana) {
                element.querySelectorAll('rt').forEach((rt) => rt.classList.add('jiten-furi'));
            }
            return element;
        }
        this.patchElement(fragmentsParent, token);
        return fragmentsParent;
    }
    isFragment(element) {
        return 'node' in element;
    }
    dismissElements(fragment, token) {
        if (fragment) {
            this._fragments.delete(fragment);
            this._fragmentToTokensMap.delete(fragment);
        }
        if (token) {
            this._tokens.delete(token);
            this._tokenToFragmentsMap.delete(token);
        }
    }
    wrapElement(node, token) {
        const element = document.createElement('span');
        this.patchElement(element, token);
        node.parentElement?.replaceChild(element, node);
        element.appendChild(node);
        return element;
    }
    patchElement(element, token) {
        const { skipFurigana, markFrequency, markAll, generatePitch, markIPlus1, newStates } = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.textHighlighterOptions;
        const { card, pitchClass, sentence, conjugations } = token ?? {};
        if (element.hasAttribute('ajb')) {
            return;
        }
        element.setAttribute('ajb', 'true');
        if (markIPlus1) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.sentenceManager.addElement(element, token);
        }
        if (!skipFurigana) {
            element.querySelectorAll('rt').forEach((rt) => rt.classList.add('jiten-furi'));
        }
        if (card) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.addCard(card, element, conjugations);
            element.classList.add('jiten-word', ...card.cardState);
            if (markFrequency && card.frequencyRank <= markFrequency) {
                const states = card.cardState;
                const isNew = states.some((s) => newStates.includes(s));
                if (markAll || isNew) {
                    element.classList.add('frequent');
                }
            }
            if (pitchClass && generatePitch) {
                element.classList.add(pitchClass);
            }
            element.setAttribute('wordId', card.wordId.toString());
            element.setAttribute('readingIndex', card.readingIndex.toString());
            _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.wordEventDelegator.setSentence(element, sentence);
            return;
        }
        element.classList.add('jiten-word', 'unparsed');
    }
    areBoundariesExactMatch(reference, targets) {
        if (!targets.length) {
            return false;
        }
        return (reference.start === targets[0].start && reference.end === targets[targets.length - 1].end);
    }
    findParent(node, tag) {
        let parent = node.parentElement;
        while (parent && parent.tagName !== tag) {
            parent = parent.parentElement;
        }
        return parent;
    }
    fragmentsShareSingleRuby(fragments) {
        if (fragments.length === 0)
            return false;
        const rubyElements = fragments
            .map((f) => f.rubyElement ?? this.findParent(f.node, 'RUBY'))
            .filter((el) => el !== null);
        if (rubyElements.length !== fragments.length)
            return false;
        const firstRuby = rubyElements[0];
        return rubyElements.every((ruby) => ruby === firstRuby);
    }
    getSharedRubyElement(fragments) {
        if (fragments.length === 0)
            return null;
        const first = fragments[0];
        return first.rubyElement ?? this.findParent(first.node, 'RUBY');
    }
    isMisparsedRuby(rubyElement, token) {
        const originalRubyText = Array.from(rubyElement.querySelectorAll('rt'))
            .map((rt) => rt.innerText)
            .join('');
        return false;
    }
    markElementAsMisparsed(element) {
        if (element.hasAttribute('ajb')) {
            return;
        }
        element.classList.add('jiten-word', 'misparsed');
        element.setAttribute('ajb', 'true');
    }
}
TextHighlighter.CHUNK_SIZE = 40;


/***/ }),
/* 94 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BaseTextHighlighter: () => (/* binding */ BaseTextHighlighter)
/* harmony export */ });
class BaseTextHighlighter {
    constructor(fragments, tokens) {
        this.fragments = fragments;
        this.tokens = tokens;
    }
}


/***/ }),
/* 95 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getParagraphs: () => (/* binding */ getParagraphs)
/* harmony export */ });
/* harmony import */ var _paragraph_reader_paragraph_reader__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(96);

const getParagraphs = (node, filter) => {
    return new _paragraph_reader_paragraph_reader__WEBPACK_IMPORTED_MODULE_0__.ParagraphReader(node, filter).read();
};


/***/ }),
/* 96 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParagraphReader: () => (/* binding */ ParagraphReader)
/* harmony export */ });
/* harmony import */ var _base_paragraph_reader__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(97);

class ParagraphReader extends _base_paragraph_reader__WEBPACK_IMPORTED_MODULE_0__.BaseParagraphReader {
    constructor() {
        super(...arguments);
        this._styleCache = new WeakMap();
    }
    read() {
        const fragments = [];
        const paragraphs = [];
        this.recurse(paragraphs, fragments, 0, this.node, false, null, this.filter);
        if (!paragraphs.length && fragments.length) {
            paragraphs.push(fragments);
        }
        return paragraphs;
    }
    recurse(paragraphs, fragments, offset, node, hasRuby, currentRubyElement, filter) {
        if (node instanceof Element && node.hasAttribute('ajb')) {
            return offset;
        }
        const display = this.displayCategory(node);
        const breakIfBlock = () => {
            if (display === 'block') {
                offset = this.breakParagraph(paragraphs, fragments);
                fragments = [];
            }
        };
        breakIfBlock();
        if (display === 'none' || display === 'ruby-text' || filter?.(node) === false) {
            return offset;
        }
        if (display === 'text') {
            return this.pushText(fragments, offset, node, hasRuby, currentRubyElement);
        }
        if (display === 'ruby') {
            hasRuby = true;
            currentRubyElement = node;
        }
        for (const child of node.childNodes) {
            offset = this.recurse(paragraphs, fragments, offset, child, hasRuby, currentRubyElement, filter);
        }
        if (display === 'block') {
            breakIfBlock();
        }
        return offset;
    }
    breakParagraph(paragraphs, fragments) {
        let end = fragments.length - 1;
        for (; end >= 0; end--) {
            if (fragments[end].node.data.trim().length > 0) {
                break;
            }
        }
        const trimmedFragments = fragments.slice(0, end + 1);
        if (trimmedFragments.length) {
            paragraphs.push(trimmedFragments);
        }
        return 0;
    }
    pushText(fragments, offset, text, hasRuby, rubyElement) {
        if (text.data.length > 0 && !(fragments.length === 0 && text.data.trim().length === 0)) {
            fragments.push({
                start: offset,
                length: text.length,
                end: (offset += text.length),
                node: text,
                hasRuby,
                rubyElement: rubyElement ?? undefined,
            });
        }
        return offset;
    }
    displayCategory(node) {
        if (node instanceof Text || node instanceof CDATASection) {
            return 'text';
        }
        if (node instanceof Element) {
            let style = this._styleCache.get(node);
            if (!style) {
                style = getComputedStyle(node);
                this._styleCache.set(node, style);
            }
            const display = style.display.split(/\s/g);
            const [first] = display;
            if (first === 'none') {
                return 'none';
            }
            if (node.tagName === 'RUBY') {
                return 'ruby';
            }
            if (node.tagName === 'RP') {
                return 'none';
            }
            if (node.tagName === 'RT') {
                return 'ruby-text';
            }
            if (node.tagName === 'RB') {
                return 'inline';
            }
            if (display.some((x) => x.startsWith('block'))) {
                return 'block';
            }
            if (display.some((x) => x.startsWith('inline'))) {
                return 'inline';
            }
            if (first === 'flex') {
                return 'block';
            }
            if (first === '-webkit-box') {
                return 'block';
            }
            if (first === 'grid') {
                return 'block';
            }
            if (first.startsWith('table')) {
                return 'block';
            }
            if (first.startsWith('flow')) {
                return 'block';
            }
            if (first === 'ruby') {
                return 'ruby';
            }
            if (first.startsWith('ruby-text')) {
                return 'ruby-text';
            }
            if (first.startsWith('ruby-base')) {
                return 'inline';
            }
            if (first.startsWith('math')) {
                return 'inline';
            }
            if (display.includes('list-item')) {
                return 'block';
            }
            if (first === 'contents') {
                return 'inline';
            }
            if (first === 'run-in') {
                return 'block';
            }
        }
        return 'none';
    }
}


/***/ }),
/* 97 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BaseParagraphReader: () => (/* binding */ BaseParagraphReader)
/* harmony export */ });
class BaseParagraphReader {
    constructor(node, filter) {
        this.node = node;
        this.filter = filter;
    }
}


/***/ }),
/* 98 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SequenceManager: () => (/* binding */ SequenceManager)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_abort_request_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(66);
/* harmony import */ var _shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(82);
/* harmony import */ var _canceled__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(91);



class SequenceManager {
    get sequenceId() {
        return ++this._nextSequenceId;
    }
    constructor() {
        this._nextSequenceId = 0;
        this._requests = new Map();
        (0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_1__.receiveBackgroundMessage)('sequenceAborted', (sequenceId) => this.handleBackgroundMessage(sequenceId, (request) => request.reject(new _canceled__WEBPACK_IMPORTED_MODULE_2__.Canceled())));
        (0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_1__.receiveBackgroundMessage)('sequenceError', (sequenceId, error) => this.handleBackgroundMessage(sequenceId, (request) => request.reject(new Error(error))));
        (0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_1__.receiveBackgroundMessage)('sequenceSuccess', (sequenceId, data) => this.handleBackgroundMessage(sequenceId, (request) => request.resolve(data)));
    }
    getSequence(data) {
        const { sequenceId } = this;
        const promise = new Promise((resolve, reject) => {
            this._requests.set(sequenceId, { resolve, reject });
        });
        return {
            sequenceId,
            promise,
            data,
        };
    }
    getAbortableSequence(data) {
        const { sequenceId } = this;
        const abortController = new AbortController();
        const promise = new Promise((resolve, reject) => {
            abortController.signal.addEventListener('abort', () => new _shared_messages_background_abort_request_command__WEBPACK_IMPORTED_MODULE_0__.AbortRequestCommand(sequenceId).send());
            this._requests.set(sequenceId, { resolve, reject });
        });
        return {
            abort: () => abortController.abort(),
            sequenceId,
            promise,
            data,
        };
    }
    handleBackgroundMessage(sequenceId, fn) {
        const request = this._requests.get(sequenceId);
        if (!request) {
            return;
        }
        fn(request);
        this._requests.delete(sequenceId);
    }
}


/***/ }),
/* 99 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   EventCollection: () => (/* binding */ EventCollection)
/* harmony export */ });
class EventCollection {
    constructor() {
        this._map = new Map();
    }
    on(event, listener) {
        const listeners = this._map.get(event) ?? new Set();
        listeners.add(listener);
        this._map.set(event, listeners);
    }
    emit(event, ...args) {
        const listeners = this._map.get(event);
        if (!listeners?.size) {
            return;
        }
        for (const listener of listeners) {
            void listener(...args);
        }
    }
}


/***/ }),
/* 100 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HostEvaluator: () => (/* binding */ HostEvaluator)
/* harmony export */ });
/* harmony import */ var _shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(101);

class HostEvaluator {
    get relevantMeta() {
        const result = [];
        if (this._targetedTriggerMeta) {
            result.push(this._targetedTriggerMeta);
        }
        if (this._targetedAutomaticMeta.length) {
            result.push(...this._targetedAutomaticMeta);
        }
        if (!result.length && this._defaultTriggerMeta) {
            result.push(this._defaultTriggerMeta);
        }
        result.push(...this._defaultAutomaticMeta);
        const seen = new Set();
        return result.filter((meta) => {
            const id = ('id' in meta && meta.id) || JSON.stringify(meta);
            if (seen.has(id)) {
                return false;
            }
            seen.add(id);
            return true;
        });
    }
    get canBeTriggered() {
        if (this._targetedTriggerMeta?.disabled || this._targetedAutomaticMeta.length) {
            return false;
        }
        return !!this.relevantMeta.length;
    }
    get rejectionReason() {
        return this._targetedTriggerMeta;
    }
    constructor() {
        this._isMainFrame = window === window.top;
        this._host = window.location.href;
    }
    async load() {
        this._targetedTriggerMeta = await (0,_shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.getHostMeta)(this._host, 'targetedTrigger', ({ auto, host, allFrames }) => !auto && host !== '<all_urls>' && (allFrames || this._isMainFrame));
        this._targetedAutomaticMeta = await (0,_shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.getHostMeta)(this._host, 'targetedAutomatic', ({ auto, host, allFrames }) => auto && host !== '<all_urls>' && (allFrames || this._isMainFrame), true);
        this._defaultTriggerMeta = await (0,_shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.getHostMeta)(this._host, 'defaultTrigger', ({ auto, host, allFrames }) => auto === false && host === '<all_urls>' && (allFrames || this._isMainFrame));
        this._defaultAutomaticMeta = await (0,_shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.getHostMeta)(this._host, 'defaultAutomatic', ({ auto, host, allFrames }) => auto && host === '<all_urls>' && (allFrames || this._isMainFrame), true);
        return this;
    }
}


/***/ }),
/* 101 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getHostMeta: () => (/* binding */ getHostMeta)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _debug__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(81);
/* harmony import */ var _dom_display_toast__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(29);
/* harmony import */ var _match_url__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(85);
/* harmony import */ var _default_hosts__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(102);





async function getHostMeta(host, role, filter = () => true, multiple) {
    const disabledHosts = await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('disabledParsers');
    const additionalHosts = await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('additionalHosts');
    const additionalMeta = await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('additionalMeta');
    const hostsMeta = _default_hosts__WEBPACK_IMPORTED_MODULE_4__.DEFAULT_HOSTS;
    const isPredefined = (meta) => 'id' in meta;
    (0,_debug__WEBPACK_IMPORTED_MODULE_1__.debug)(`[${role}] getHostMeta called with host: ${host}`, 'filter:', filter, 'multiple:', multiple);
    if (!host?.length) {
        (0,_debug__WEBPACK_IMPORTED_MODULE_1__.debug)(`[${role}] getHostMeta called with empty host string`);
        return multiple ? [] : undefined;
    }
    try {
        const meta = JSON.parse(additionalMeta?.length ? additionalMeta : '[]');
        (0,_debug__WEBPACK_IMPORTED_MODULE_1__.debug)(`[${role}] Loaded additional meta:`, meta);
        hostsMeta.push(...meta.map(({ host, auto = true, allFrames = false, disabled, parse, filter, css, parseVisibleObserver, addedObserver, parserClass, }) => ({
            host,
            auto,
            allFrames,
            disabled,
            parse,
            filter,
            css,
            parseVisibleObserver,
            addedObserver,
            parserClass,
        })));
    }
    catch (e) {
        console.error(`[${role}] Failed to parse additional meta:`, e);
        (0,_dom_display_toast__WEBPACK_IMPORTED_MODULE_2__.displayToast)('error', 'Failed to parse additional meta. Please check your configuration.', e.message);
    }
    additionalHosts
        .trim()
        .replace(/\r\n?/g, ' ')
        .split(/[\s;,]/)
        .filter(Boolean)
        .forEach((host) => {
        const additionalHostObject = {
            host,
            auto: true,
            allFrames: true,
            parse: 'body',
            parserClass: 'custom-parser',
        };
        (0,_debug__WEBPACK_IMPORTED_MODULE_1__.debug)(`[${role}] Adding additional host:`, additionalHostObject);
        hostsMeta.push(additionalHostObject);
    });
    const hostFilter = (meta) => {
        const isMatch = (matchPattern) => {
            if (isPredefined(meta) && meta.optOut && disabledHosts.includes(meta.id)) {
                return false;
            }
            return (0,_match_url__WEBPACK_IMPORTED_MODULE_3__.matchUrl)(matchPattern, host);
        };
        return Array.isArray(meta.host) ? meta.host.some(isMatch) : isMatch(meta.host);
    };
    const enabledHosts = hostsMeta.filter(hostFilter);
    const result = multiple ? enabledHosts.filter(filter) : enabledHosts.find(filter);
    (0,_debug__WEBPACK_IMPORTED_MODULE_1__.debug)(`[${role}] getHostMeta result:`, { host, result });
    return result;
}


/***/ }),
/* 102 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DEFAULT_HOSTS: () => (/* binding */ DEFAULT_HOSTS)
/* harmony export */ });
const DEFAULT_HOSTS = [
    {
        id: 'disable-apps',
        name: '_disable_apps',
        description: 'Disable certain Apps',
        host: ['*://*.crunchyroll.com/*', '*://music.youtube.com/*'],
        auto: false,
        allFrames: false,
        disabled: true,
    },
    {
        id: 'trigger-parser',
        name: '_trigger_parser_',
        description: 'Trigger Parser',
        host: '<all_urls>',
        auto: false,
        allFrames: false,
        parse: 'body',
    },
    {
        id: 'kochounoyume-cde-parser',
        name: 'CDE Parser',
        description: 'Parses dictionary entries for the JPDB CDE user script',
        host: [
            '*://jpdb.io/vocabulary/*',
            '*://jpdb.io/review*',
            '*://jpdb.io/deck*',
            '*://jpdb.io/search*',
        ],
        auto: true,
        optOut: true,
        allFrames: false,
        parserClass: 'kochounoyume-parser',
        filter: '.meaning-subsection-label',
        addedObserver: {
            notifyFor: '.custom-dictionary-entry',
            checkNested: '.result.vocabulary',
        },
    },
    {
        id: 'luna-translator-parser',
        name: 'Luna Translator Parser',
        description: 'Parse lunatranslator span content from local HTML file',
        host: ['file:///*LunaTranslator*mainui.html', 'file:///*LunaTranslator*transhist.html'],
        auto: true,
        optOut: true,
        allFrames: false,
        parseVisibleObserver: true,
        parserClass: 'luna-translator-parser',
        addedObserver: {
            notifyFor: '.lunatranslator_clickword, .lunatranslator_text_all, .origin',
            observeFrom: 'body',
            config: {
                childList: true,
                subtree: true,
            },
        },
    },
    {
        id: 'texthooker-parser',
        name: 'Texthooker Parser',
        description: 'Parse hooked texts (anacreondjt, renji-xd and learnjapanese.moe)',
        host: [
            '*://anacreondjt.gitlab.io/texthooker.html',
            '*://learnjapanese.moe/texthooker.html',
            '*://renji-xd.github.io/texthooker-ui/',
            '*://*/texthooker$',
        ],
        auto: true,
        optOut: true,
        allFrames: false,
        parseVisibleObserver: true,
        parserClass: 'texthooker-parser',
        addedObserver: {
            notifyFor: '.textline, .line_box, .my-2.cursor-pointer, p',
            observeFrom: ['#textlog, main', 'body'],
        },
    },
    {
        id: 'exstatic-parser',
        name: 'ExStatic Parser',
        description: 'Enables parsing for ExStatic',
        host: '*://kamwithk.github.io/exSTATic/tracker.html',
        auto: true,
        optOut: true,
        allFrames: false,
        parseVisibleObserver: true,
        custom: 'ExStaticParser',
        addedObserver: {
            notifyFor: '.sentence-entry',
            observeFrom: '#entry_holder',
        },
    },
    {
        id: 'readwok-parser',
        name: 'Readwok Parser',
        description: 'Parses Readwok books',
        host: '*://app.readwok.com/*',
        auto: true,
        optOut: true,
        allFrames: false,
        parseVisibleObserver: true,
        custom: 'ReadwokParser',
        addedObserver: {
            notifyFor: 'div[class*="styles_paragraph_"], div[class*="styles_reader_"]',
        },
    },
    {
        id: 'ttsu-parser',
        name: 'Ttsu Parser',
        description: 'Parses Ttsu books',
        host: '*://reader.ttsu.app/*',
        auto: true,
        optOut: true,
        allFrames: false,
        custom: 'TtsuParser',
        parseVisibleObserver: true,
        addedObserver: {
            notifyFor: 'div.book-content',
        },
    },
    {
        id: 'mokuro-parser',
        name: 'Mokuro Parser',
        description: 'Parses manga on Mokuro',
        host: '*://reader.mokuro.app/*',
        auto: true,
        optOut: true,
        allFrames: true,
        custom: 'MokuroParser',
        parseVisibleObserver: true,
        addedObserver: {
            notifyFor: '#manga-panel',
        },
    },
    {
        id: 'mokuro-legacy-parser',
        name: 'Mokuro Legacy Parser',
        description: 'Parses manga on Mokuro (legacy)',
        host: 'file:///*mokuro*.html',
        auto: true,
        optOut: true,
        allFrames: true,
        custom: 'MokuroLegacyParser',
        parseVisibleObserver: true,
    },
    {
        id: 'wikipedia-parser',
        name: 'Wikipedia Parser',
        description: 'Parses Japanese Wikipedia',
        host: ['*://ja.wikipedia.org/*', '*://ja.m.wikipedia.org/*'],
        auto: true,
        optOut: true,
        allFrames: false,
        parserClass: 'wikipedia-parser',
        parseVisibleObserver: true,
        filter: '.p-lang-btn, .vector-menu-heading-label, .vector-toc-toggle, .vector-page-toolbar, .mw-editsection, sup.reference',
        addedObserver: {
            notifyFor: '#firstHeading, #mw-content-text .mw-parser-output > *, .mwe-popups-extract > *',
        },
    },
    {
        id: 'satori-reader-parser',
        name: 'Satori Reader Parser',
        description: 'Parses Satori Reader articles',
        host: '*://*.satorireader.com/articles/*',
        auto: true,
        optOut: true,
        allFrames: false,
        parserClass: 'satori-reader-parser',
        parse: '#article-content',
        filter: '.play-button-container, .notes-button-container, .fg, .wpr',
        custom: 'SatoriReaderParser',
    },
    {
        id: 'nhk-parser',
        name: 'NHK Parser',
        description: 'Parses NHK articles and content',
        host: [
            '*://*.nhk.or.jp/news/html/*',
            '*://*.nhk.or.jp/news/easy/*',
            '*://news.web.nhk/news/easy/*',
            '*://news.web.nhk/news/html/*',
            '*://news.web.nhk/news/newsweb/*',
        ],
        auto: true,
        optOut: true,
        allFrames: false,
        parserClass: 'nhk-parser',
        parseVisibleObserver: true,
        addedObserver: {
            notifyFor: '#main, #js-article-body, #js-article-date, .article-title',
        },
    },
    {
        id: 'bunpro-parser',
        name: 'Bunpro Parser',
        description: 'Parses Bunpro graded reader sections',
        host: '*://bunpro.jp/*',
        auto: true,
        optOut: true,
        allFrames: false,
        parserClass: 'bunpro-parser',
        parseVisibleObserver: true,
        addedObserver: {
            notifyFor: 'div.mx-auto',
        },
    },
    {
        id: 'asbplayer-parser',
        name: 'asbplayer Parser',
        description: 'Parses asbplayer subtitles',
        host: '<all_urls>',
        auto: true,
        optOut: true,
        allFrames: true,
        css: '.asbplayer-subtitles-container-bottom { z-index: 2147483646 }',
        parserClass: 'asb-player-parser',
        addedObserver: {
            notifyFor: '.asbplayer-offscreen',
        },
    },
    {
        id: 'aozora-parser',
        name: 'Aozora Bunko Parser',
        description: 'Parses Aozora Bunko literature',
        host: '*://*.aozora.gr.jp/*',
        auto: true,
        optOut: true,
        allFrames: false,
        parserClass: 'aozora-parser',
        custom: 'AozoraParser',
    },
];


/***/ }),
/* 103 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SentenceManager: () => (/* binding */ SentenceManager)
/* harmony export */ });
/* harmony import */ var _registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(89);

class SentenceManager {
    constructor() {
        this._sentenceToCards = new Map();
        this._sentenceToElements = new Map();
        this._cardToState = new Map();
        this._cardToSentence = new Map();
        this._cardToElements = new Map();
        this._cardToFrequency = new Map();
        this._elementToCard = new Map();
        this._elementsToSentence = new Map();
        this._processedSentences = new Set();
        this._disabled = false;
    }
    disable() {
        this._disabled = true;
    }
    updateCardState(wordId, readingIndex, state) {
        if (this._disabled) {
            return;
        }
        const key = `${wordId}/${readingIndex}`;
        this._cardToState.set(key, state);
        this.calculateTargetSentencesByKey(key);
    }
    addElement(element, token) {
        if (this._disabled) {
            return;
        }
        if (!token?.sentence?.length) {
            return;
        }
        const { sentence, card } = token;
        const { wordId, readingIndex, cardState, frequencyRank } = card;
        const cardKey = `${wordId}/${readingIndex}`;
        this.addToMap(this._sentenceToCards, sentence, cardKey);
        this.addToMap(this._sentenceToElements, sentence, element);
        this.addToMap(this._cardToSentence, cardKey, sentence);
        this.addToMap(this._cardToElements, cardKey, element);
        this._elementToCard.set(element, cardKey);
        this._elementsToSentence.set(element, sentence);
        this._cardToState.set(cardKey, cardState);
        this._cardToFrequency.set(cardKey, frequencyRank);
    }
    calculateTargetSentences() {
        if (this._disabled) {
            return;
        }
        for (const sentence of this._sentenceToCards.keys()) {
            if (this._processedSentences.has(sentence)) {
                continue;
            }
            this.calculateSentence(sentence);
        }
    }
    reprocess() {
        if (this._disabled) {
            return;
        }
        this._processedSentences.clear();
        this.calculateTargetSentences();
    }
    reset() {
        this._sentenceToCards.clear();
        this._sentenceToElements.clear();
        this._cardToState.clear();
        this._cardToSentence.clear();
        this._cardToElements.clear();
        this._cardToFrequency.clear();
        this._elementToCard.clear();
        this._elementsToSentence.clear();
        this._processedSentences.clear();
        document.querySelectorAll('.i-plus-one').forEach((element) => {
            element.classList.remove('i-plus-one');
        });
    }
    resetProcessedSentences() {
        this._processedSentences.clear();
    }
    dismissNode(element) {
        const sentence = this._elementsToSentence.get(element);
        if (!sentence) {
            return;
        }
        this.filterMap(this._sentenceToElements, sentence, element);
        const card = this._elementToCard.get(element);
        if (card) {
            this.filterMap(this._cardToElements, card, element);
            this._elementToCard.delete(element);
        }
        this._elementsToSentence.delete(element);
        element.classList.remove('i-plus-one');
        if (!this._sentenceToElements.get(sentence)?.length) {
            this._sentenceToElements.delete(sentence);
            this._sentenceToCards.delete(sentence);
            this._processedSentences.delete(sentence);
        }
        if (card && !this._cardToElements.get(card)?.length) {
            this._cardToElements.delete(card);
            this._cardToSentence.delete(card);
            this._cardToState.delete(card);
            this._cardToFrequency.delete(card);
        }
    }
    dismissContainer(container) {
        if (this._disabled) {
            return;
        }
        const elements = Array.from(container.querySelectorAll('[ajb]'));
        elements.forEach((element) => {
            this.dismissNode(element);
        });
    }
    removeFromMap(map, key, withElement) {
        const elements = map.get(key);
        if (!elements) {
            return;
        }
        elements.forEach(withElement);
        map.delete(key);
    }
    filterMap(map, key, value) {
        const values = map.get(key);
        if (!values) {
            return;
        }
        const filteredValues = values.filter((v) => v !== value);
        if (filteredValues.length === 0) {
            map.delete(key);
        }
        else {
            map.set(key, filteredValues);
        }
    }
    addToMap(map, key, value) {
        if (!map.has(key)) {
            map.set(key, []);
        }
        map.get(key)?.push(value);
    }
    calculateTargetSentencesByKey(key) {
        const sentences = this._cardToSentence.get(key) ?? [];
        sentences.forEach((sentence) => this.calculateSentence(sentence));
    }
    calculateSentence(sentence) {
        const { markOnlyFrequent, markFrequency, minSentenceLength, newStates } = _registry__WEBPACK_IMPORTED_MODULE_0__.Registry.textHighlighterOptions;
        this._processedSentences.add(sentence);
        const cards = this._sentenceToCards.get(sentence) ?? [];
        const unknownCards = cards.filter((card) => {
            const states = this._cardToState.get(card);
            return states.some((s) => newStates.includes(s));
        });
        let notIPlusOne = unknownCards.length === 0 || unknownCards.length > 1 || cards.length < minSentenceLength;
        if (markFrequency && markOnlyFrequent && !notIPlusOne) {
            const relevantFrequency = this._cardToFrequency.get(unknownCards[0]);
            if (relevantFrequency > markFrequency) {
                notIPlusOne = true;
            }
        }
        if (notIPlusOne) {
            this._sentenceToElements.get(sentence)?.forEach((element) => {
                element.classList.remove('i-plus-one');
            });
            return;
        }
        const [wordId, readingIndex] = unknownCards[0].split('/');
        this._sentenceToElements.get(sentence)?.forEach((element) => {
            const e = element;
            if (e.getAttribute('wordId') === wordId && e.getAttribute('readingIndex') === readingIndex) {
                e.classList.add('i-plus-one');
            }
        });
    }
}


/***/ }),
/* 104 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   WordEventDelegator: () => (/* binding */ WordEventDelegator)
/* harmony export */ });
/* harmony import */ var _registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(89);

class WordEventDelegator {
    constructor() {
        this._initialised = false;
        this._sentenceMap = new WeakMap();
        this.handleMouseEnter = (event) => {
            const target = this.findWordElement(event);
            if (target) {
                const sentence = this._sentenceMap.get(target);
                _registry__WEBPACK_IMPORTED_MODULE_0__.Registry.popupManager?.enter(target, sentence);
                this.findAdjacentWordElements(target).forEach((el) => el.classList.add('hovered'));
            }
        };
        this.handleMouseLeave = (event) => {
            const target = this.findWordElement(event);
            if (target) {
                _registry__WEBPACK_IMPORTED_MODULE_0__.Registry.popupManager?.leave();
                this.findAdjacentWordElements(target).forEach((el) => el.classList.remove('hovered'));
            }
        };
        this.handleClick = (event) => {
            const target = this.findWordElement(event);
            if (target) {
                const sentence = this._sentenceMap.get(target);
                _registry__WEBPACK_IMPORTED_MODULE_0__.Registry.popupManager?.touch(target, event, sentence);
            }
        };
    }
    static getInstance() {
        if (!this._instance) {
            this._instance = new WordEventDelegator();
        }
        return this._instance;
    }
    initialise() {
        if (this._initialised)
            return;
        this._initialised = true;
        document.addEventListener('mouseenter', this.handleMouseEnter, true);
        document.addEventListener('mouseleave', this.handleMouseLeave, true);
        document.addEventListener('click', this.handleClick, true);
    }
    setSentence(element, sentence) {
        this._sentenceMap.set(element, sentence);
    }
    getSentence(element) {
        return this._sentenceMap.get(element);
    }
    findWordElement(event) {
        const target = event.target;
        return target.closest?.('.jiten-word[wordId]');
    }
    findAdjacentWordElements(element) {
        const wordId = element.getAttribute('wordId');
        const readingIndex = element.getAttribute('readingIndex');
        if (!wordId)
            return [element];
        const elements = [element];
        let prev = element.previousElementSibling;
        while (prev?.getAttribute('wordId') === wordId &&
            prev?.getAttribute('readingIndex') === readingIndex) {
            elements.unshift(prev);
            prev = prev.previousElementSibling;
        }
        let next = element.nextElementSibling;
        while (next?.getAttribute('wordId') === wordId &&
            next?.getAttribute('readingIndex') === readingIndex) {
            elements.push(next);
            next = next.nextElementSibling;
        }
        return elements;
    }
}
WordEventDelegator._instance = null;


/***/ }),
/* 105 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AutomaticParser: () => (/* binding */ AutomaticParser)
/* harmony export */ });
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(81);
/* harmony import */ var _shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(106);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(17);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(89);
/* harmony import */ var _base_parser__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(107);





class AutomaticParser extends _base_parser__WEBPACK_IMPORTED_MODULE_4__.BaseParser {
    constructor(meta) {
        super(meta);
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_2__.onBroadcastMessage)('parsingPaused', (paused) => {
            if (paused) {
                this.disconnectObservers();
            }
            else {
                this.reconnectObservers();
            }
        });
        setTimeout(() => {
            void (0,_shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_1__.getParsingPaused)().then((paused) => {
                if (paused) {
                    (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('AutomaticParser: Parsing is paused, skipping setup');
                    return;
                }
                this.startParsing();
            });
        }, 1);
    }
    startParsing() {
        if (this._meta.parseVisibleObserver) {
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('AutomaticParser: Setting up visible observer', this._meta.parseVisibleObserver);
            this.setupVisibleObserver();
        }
        if (this._meta.addedObserver) {
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('AutomaticParser: Setting up added observer', this._meta.addedObserver);
            this.setupAddedObserver();
        }
        if (this._meta.parse) {
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('AutomaticParser: Parsing page with parse function', this._meta.parse);
            this.parsePage();
        }
        this.init();
    }
    disconnectObservers() {
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('AutomaticParser: Disconnecting observers due to pause');
        this._visibleObserver?.disconnect();
        this._addedObserver?.disconnect();
    }
    reconnectObservers() {
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('AutomaticParser: Reconnecting observers after unpause');
        this.startParsing();
    }
    init() {
    }
    setupVisibleObserver() {
        let filter;
        if (typeof this._meta.parseVisibleObserver === 'object') {
            const obs = this._meta.parseVisibleObserver;
            const { include = '', exclude = '' } = obs;
            const isInclude = include?.length > 0;
            const isExclude = exclude?.length > 0;
            filter = (node) => {
                if (node instanceof Text) {
                    return true;
                }
                if (isInclude && !node.matches(include)) {
                    return false;
                }
                if (isExclude && node.matches(exclude)) {
                    return false;
                }
                return true;
            };
        }
        this._visibleObserver = this.getParseVisibleObserver(filter ?? this.filter);
    }
    setupAddedObserver() {
        this._addedObserver = this.getAddedObserver(this._meta.addedObserver.observeFrom ?? 'body', this._meta.addedObserver.notifyFor, this._meta.addedObserver.checkNested, this._meta.addedObserver.config ?? { childList: true, subtree: true }, (nodes) => this.addedObserverCallback(nodes), (nodes) => this.removedObserverCallback(nodes));
    }
    addedObserverCallback(nodes) {
        if (!this._visibleObserver) {
            return this.parseNodes(nodes, this.filter);
        }
        nodes.forEach((node) => this._visibleObserver?.observe(node));
    }
    removedObserverCallback(nodes) {
        nodes.forEach((node) => {
            _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry.sentenceManager.dismissContainer(node);
        });
        if (!this._visibleObserver) {
            return;
        }
        nodes.forEach((node) => this._visibleObserver?.unobserve(node));
    }
}


/***/ }),
/* 106 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getParsingPaused: () => (/* binding */ getParsingPaused)
/* harmony export */ });
const getParsingPaused = async () => {
    const result = await chrome.storage.local.get('parsingPaused');
    return result.parsingPaused ?? false;
};


/***/ }),
/* 107 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BaseParser: () => (/* binding */ BaseParser)
/* harmony export */ });
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(81);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(89);


class BaseParser {
    get root() {
        const { parse } = this._meta;
        return parse ? document.querySelector(parse) : document.body;
    }
    get filter() {
        const { filter } = this._meta;
        return filter
            ? (node) => {
                if (node instanceof Element && node.matches(filter)) {
                    return false;
                }
                return true;
            }
            : () => true;
    }
    constructor(_meta) {
        this._meta = _meta;
        this._hasInjectedClass = false;
    }
    parseSelection() {
        const selection = window.getSelection();
        const range = selection.getRangeAt(0);
        this.parseNode(range.commonAncestorContainer, (node) => range.intersectsNode(node) && this.filter(node));
    }
    parsePage() {
        const { root } = this;
        if (!root) {
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('parsePage: No root element found, aborting parsing');
            return;
        }
        this.parseNode(root, this.filter);
    }
    parseNode(node, filter) {
        this.parseNodes([node], filter);
    }
    parseNodes(nodes, filter) {
        this.installAppStyles();
        const { batchController } = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry;
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('parseNodes called with nodes:', nodes, 'filter:', filter);
        batchController.registerNodes(nodes, { filter });
        batchController.parseBatches();
    }
    getAddedObserver(observeFrom, notifyFor, checkNested, config, onAdded, onRemoved) {
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('getAddedObserver', { observeFrom, notifyFor, config });
        const observeTargets = Array.isArray(observeFrom) ? observeFrom : [observeFrom];
        let root;
        while (observeTargets.length && !root) {
            root = document.querySelector(observeTargets.shift());
        }
        const initialNodes = Array.from(root?.querySelectorAll(notifyFor) ?? []);
        if (initialNodes.length) {
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('getAddedObserver: Initial nodes found:', initialNodes);
            onAdded(initialNodes);
            this.watchForNodeRemove(initialNodes, onRemoved);
        }
        const observer = new MutationObserver((mutations) => {
            const isAffectedNode = (node, mode) => {
                if (node instanceof HTMLElement) {
                    const isBreaderToken = node.matches('.jiten-word');
                    if (isBreaderToken) {
                        return false;
                    }
                    if (node.matches(notifyFor)) {
                        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)(`getAddedObserver: Node ${mode}, matches notifyFor -> validate:`, node);
                        return true;
                    }
                    if (!checkNested) {
                        return false;
                    }
                    if (node.matches(checkNested) && node.querySelector(notifyFor)) {
                        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)(`getAddedObserver: Node ${mode}, matches checkNested and contains notifyFor -> validate:`, node);
                        return true;
                    }
                    return false;
                }
                return false;
            };
            const childList = mutations.filter((mutation) => mutation.type === 'childList');
            const addedNodes = childList
                .map((mutation) => Array.from(mutation.addedNodes))
                .flat()
                .filter((node) => isAffectedNode(node, 'added'));
            if (addedNodes.length) {
                const relevantNodes = !checkNested
                    ? addedNodes
                    : addedNodes.flatMap((node) => {
                        if (node.matches(notifyFor)) {
                            return node;
                        }
                        return Array.from(node.querySelectorAll(notifyFor));
                    });
                (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('getAddedObserver: Matching nodes added:', relevantNodes);
                onAdded(relevantNodes);
            }
            const removedNodes = childList
                .map((mutation) => Array.from(mutation.removedNodes))
                .flat()
                .filter((node) => isAffectedNode(node, 'removed'));
            if (removedNodes.length && onRemoved) {
                (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('getAddedObserver: Matching nodes removed:', removedNodes);
                onRemoved(removedNodes);
            }
        });
        if (root) {
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('getAddedObserver: Observing root:', root, 'with config:', config);
            observer.observe(root, config);
        }
        return observer;
    }
    watchForNodeRemove(nodes, onRemoved) {
        nodes.forEach((node) => {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.removedNodes.forEach((removed) => {
                        if (removed === node) {
                            onRemoved([node]);
                            observer.disconnect();
                        }
                    });
                });
            });
            if (node.parentNode) {
                observer.observe(node.parentNode, { childList: true });
            }
        });
    }
    getVisibleObserver(onEnter, onExit) {
        return new IntersectionObserver((entries) => {
            const withItems = (intersecting, cb) => {
                const elements = entries
                    .filter((entry) => entry.isIntersecting === intersecting)
                    .map((entry) => entry.target);
                if (elements.length) {
                    cb(elements);
                }
            };
            withItems(false, onExit);
            withItems(true, onEnter);
        }, {
            rootMargin: '50% 50% 50% 50%',
        });
    }
    getParseVisibleObserver(filter) {
        const observer = this.getVisibleObserver((elements) => this.visibleObserverOnEnter(elements, observer, filter), (elements) => this.visibleObserverOnExit(elements, observer));
        return observer;
    }
    visibleObserverOnEnter(elements, observer, filter) {
        const { batchController } = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry;
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('visibleObserverOnEnter', elements);
        this.installAppStyles();
        batchController.registerNodes(elements, {
            filter,
            onEmpty: (e) => e instanceof Element && observer.unobserve(e),
            getParagraphsFn: this.getParagraphsFn,
        });
        batchController.parseBatches();
    }
    visibleObserverOnExit(elements, _observer) {
        const { batchController } = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry;
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('visibleObserverOnExit', elements);
        elements.forEach((node) => batchController.dismissNode(node));
    }
    installAppStyles() {
        if (!this._hasInjectedClass) {
            this._hasInjectedClass = true;
            const parserClass = this._meta.parserClass ?? this.pascalCaseToKebabCase(this.constructor.name);
            document.body.classList.add(parserClass);
            if (this._meta.css) {
                const style = document.createElement('style');
                style.textContent = this._meta.css;
                document.head.appendChild(style);
            }
        }
    }
    pascalCaseToKebabCase(str) {
        return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    }
}


/***/ }),
/* 108 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getCustomParser: () => (/* binding */ getCustomParser)
/* harmony export */ });
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(81);
/* harmony import */ var _custom_parsers_aozora_parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(109);
/* harmony import */ var _custom_parsers_bunpro_parser__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(110);
/* harmony import */ var _custom_parsers_ex_static_parser__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(111);
/* harmony import */ var _custom_parsers_mokuro_legacy_parser__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(112);
/* harmony import */ var _custom_parsers_mokuro_parser__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(114);
/* harmony import */ var _custom_parsers_readwok_parser__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(115);
/* harmony import */ var _custom_parsers_satori_reader_parser__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(116);
/* harmony import */ var _custom_parsers_ttsu_parser__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(122);









const getCustomParser = (name, meta) => {
    const parsers = {
        AozoraParser: _custom_parsers_aozora_parser__WEBPACK_IMPORTED_MODULE_1__.AozoraParser,
        BunproParser: _custom_parsers_bunpro_parser__WEBPACK_IMPORTED_MODULE_2__.BunproParser,
        MokuroParser: _custom_parsers_mokuro_parser__WEBPACK_IMPORTED_MODULE_5__.MokuroParser,
        MokuroLegacyParser: _custom_parsers_mokuro_legacy_parser__WEBPACK_IMPORTED_MODULE_4__.MokuroLegacyParser,
        ReadwokParser: _custom_parsers_readwok_parser__WEBPACK_IMPORTED_MODULE_6__.ReadwokParser,
        TtsuParser: _custom_parsers_ttsu_parser__WEBPACK_IMPORTED_MODULE_8__.TtsuParser,
        ExStaticParser: _custom_parsers_ex_static_parser__WEBPACK_IMPORTED_MODULE_3__.ExStaticParser,
        SatoriReaderParser: _custom_parsers_satori_reader_parser__WEBPACK_IMPORTED_MODULE_7__.SatoriReaderParser,
    };
    const parser = parsers[name];
    (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)(`getCustomParser called with name: ${name}`, 'meta:', meta);
    return new parser(meta);
};


/***/ }),
/* 109 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AozoraParser: () => (/* binding */ AozoraParser)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(89);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(105);


class AozoraParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_1__.AutomaticParser {
    init() {
        const mainText = document.querySelector('.main_text');
        if (!mainText) {
            return;
        }
        this.installAppStyles();
        this.wrapAndParseSections(mainText);
    }
    wrapAndParseSections(mainText) {
        const dividers = Array.from(mainText.querySelectorAll('div[class^="jisage"], .naka-midashi, .o-midashi, .ko-midashi'));
        if (dividers.length === 0) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.registerNode(mainText, { filter: this.filter });
            _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.parseBatches();
            return;
        }
        for (const divider of dividers) {
            if (divider.textContent?.trim()) {
                _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.registerNode(divider, { filter: this.filter });
                _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.parseBatches();
            }
        }
        this.parseTextBetweenDividers(mainText, dividers);
    }
    parseTextBetweenDividers(mainText, dividers) {
        const dividerSet = new Set(dividers);
        let currentWrapper = null;
        const wrappers = [];
        for (const child of Array.from(mainText.childNodes)) {
            if (child instanceof HTMLElement && dividerSet.has(child)) {
                if (currentWrapper) {
                    wrappers.push(currentWrapper);
                    currentWrapper = null;
                }
                continue;
            }
            if (child instanceof Text && !child.data.trim()) {
                continue;
            }
            if (child instanceof HTMLBRElement) {
                continue;
            }
            if (!currentWrapper) {
                currentWrapper = document.createElement('span');
                currentWrapper.className = 'aozora-section';
                currentWrapper.style.display = 'contents';
            }
            mainText.insertBefore(currentWrapper, child);
            currentWrapper.appendChild(child);
        }
        if (currentWrapper) {
            wrappers.push(currentWrapper);
        }
        for (const wrapper of wrappers) {
            if (wrapper.textContent?.trim()) {
                _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.registerNode(wrapper, { filter: this.filter });
                _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.parseBatches();
            }
        }
    }
}


/***/ }),
/* 110 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BunproParser: () => (/* binding */ BunproParser)
/* harmony export */ });
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(105);

class BunproParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_0__.AutomaticParser {
    addedObserverCallback(nodes) {
        nodes.forEach((node) => {
            const childDiv = node.querySelector('div.text-center');
            if (childDiv?.children.length) {
                this._visibleObserver?.observe(childDiv);
            }
        });
    }
}


/***/ }),
/* 111 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ExStaticParser: () => (/* binding */ ExStaticParser)
/* harmony export */ });
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(105);

class ExStaticParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_0__.AutomaticParser {
    getAddedObserver(observeFrom, notifyFor, checkNested, config, onAdded, onRemoved) {
        const observer = new MutationObserver((mutations) => {
            const addedNodes = mutations
                .filter((mutation) => mutation.type === 'childList')
                .map((mutation) => Array.from(mutation.addedNodes))
                .flat()
                .filter((node) => {
                if (node instanceof HTMLElement) {
                    return node.matches(notifyFor);
                }
                return false;
            });
            if (addedNodes.length) {
                onAdded(addedNodes);
            }
            const removedNodes = mutations
                .filter((mutation) => mutation.type === 'childList')
                .map((mutation) => Array.from(mutation.removedNodes))
                .flat()
                .filter((node) => {
                if (node instanceof HTMLElement) {
                    return node.matches(notifyFor);
                }
                return false;
            });
            if (removedNodes.length) {
                onRemoved(removedNodes);
            }
        });
        setTimeout(() => {
            const observeTargets = Array.isArray(observeFrom) ? observeFrom : [observeFrom];
            let root;
            while (observeTargets.length && !root) {
                root = document.querySelector(observeTargets.shift());
            }
            const initialNodes = Array.from(root?.querySelectorAll(notifyFor) ?? []);
            if (initialNodes.length) {
                onAdded(initialNodes);
                this.watchForNodeRemove(initialNodes, onRemoved);
            }
            if (root) {
                observer.observe(root, config);
            }
        }, 2000);
        return observer;
    }
}


/***/ }),
/* 112 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MokuroLegacyParser: () => (/* binding */ MokuroLegacyParser)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(89);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(105);
/* harmony import */ var _mokuro_get_mokuro_paragraphs__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(113);



class MokuroLegacyParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_1__.AutomaticParser {
    constructor() {
        super(...arguments);
        this.getParagraphsFn = _mokuro_get_mokuro_paragraphs__WEBPACK_IMPORTED_MODULE_2__.getMokuroParagraphs;
    }
    init() {
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.sentenceManager.disable();
        for (const page of document.querySelectorAll('#pagesContainer > div')) {
            this._visibleObserver.observe(page);
        }
    }
}


/***/ }),
/* 113 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getMokuroParagraphs: () => (/* binding */ getMokuroParagraphs)
/* harmony export */ });
const getMokuroParagraphs = (page) => {
    return [...page.querySelectorAll('.textBox')].map((box) => {
        const fragments = [];
        let offset = 0;
        const p = box.querySelector('p');
        if (!p) {
            return fragments;
        }
        for (const child of p.childNodes) {
            if (child.nodeType !== Node.TEXT_NODE) {
                continue;
            }
            const text = child;
            if (!text.data?.length) {
                continue;
            }
            text.data = text.data
                .replaceAll('．．．', '…')
                .replaceAll('．．', '…')
                .replaceAll('！！', '‼')
                .replaceAll('！？', '⁉');
            const start = offset;
            const length = text.length;
            const end = (offset += length);
            fragments.push({
                node: text,
                start,
                end,
                length,
                hasRuby: false,
            });
        }
        return fragments;
    });
};


/***/ }),
/* 114 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MokuroParser: () => (/* binding */ MokuroParser)
/* harmony export */ });
/* harmony import */ var _batches_apply_tokens__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(92);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(89);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(105);
/* harmony import */ var _mokuro_get_mokuro_paragraphs__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(113);




class MokuroMangaPanel {
    constructor(_panel) {
        this._panel = _panel;
        this._imageContainerId = 'page-num';
        this._debounceTime = 500;
        this._currentId = 0;
        this._pages = new Set();
        this.setupImageObserver();
        this.triggerParse();
    }
    destroy() {
        this.cancelParse();
        this._imageObserver?.disconnect();
    }
    setupImageObserver() {
        const imageContainer = document.getElementById(this._imageContainerId);
        if (!imageContainer) {
            return;
        }
        this._imageContainer = imageContainer;
        this._imageObserver = new MutationObserver(() => {
            this._currentId++;
            this.triggerParse();
        });
        this._imageObserver.observe(this._imageContainer, {
            subtree: true,
            childList: true,
            characterData: true,
        });
    }
    triggerParse() {
        if (this._debounceTimeout) {
            clearTimeout(this._debounceTimeout);
            this.cancelParse();
            this._debounceTimeout = setTimeout(() => {
                this._debounceTimeout = undefined;
                this.initParse();
            }, this._debounceTime);
            return;
        }
        this.initParse();
        this._debounceTimeout = setTimeout(() => {
            this._debounceTimeout = undefined;
        }, this._debounceTime);
    }
    initParse() {
        this.cleanup();
        this.parse();
    }
    cancelParse() {
        this._pages.forEach((page) => {
            _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.batchController.dismissNode(page);
            this._pages.delete(page);
        });
    }
    cleanup() {
        [...this._panel.querySelectorAll('.textBox p')].forEach((p) => {
            const newChildren = [];
            for (const child of [...p.childNodes]) {
                if (child instanceof HTMLBRElement) {
                    newChildren.push(child.cloneNode());
                    continue;
                }
                if (child instanceof Text) {
                    newChildren.push(child);
                    continue;
                }
                const textContent = child.textContent || '';
                if (textContent) {
                    newChildren.push(document.createTextNode(textContent));
                }
            }
            p.replaceChildren(...newChildren);
        });
    }
    parse() {
        this._panel.querySelectorAll(':scope > div > div.relative').forEach((page) => {
            if (this._pages.has(page)) {
                return;
            }
            const currentId = this._currentId;
            this._pages.add(page);
            _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.batchController.registerNode(page, {
                getParagraphsFn: _mokuro_get_mokuro_paragraphs__WEBPACK_IMPORTED_MODULE_3__.getMokuroParagraphs,
                applyFn: (paragraph, tokens) => {
                    if (currentId === this._currentId) {
                        (0,_batches_apply_tokens__WEBPACK_IMPORTED_MODULE_0__.applyTokens)(paragraph, tokens);
                    }
                },
            });
        });
        _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.batchController.parseBatches(() => this._pages.clear());
    }
}
class MokuroParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_2__.AutomaticParser {
    constructor() {
        super(...arguments);
        this._mangaPanels = new Map();
        this._observedElements = new Set();
    }
    init() {
        _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.sentenceManager.disable();
        const checkForPanel = () => {
            const panel = document.getElementById('manga-panel');
            if (!panel) {
                if (this._mangaPanels.size > 0) {
                    this._mangaPanels.forEach((instance) => instance.destroy());
                    this._mangaPanels.clear();
                }
                return;
            }
            const hasContent = panel.querySelector('.textBox') !== null;
            if (!hasContent) {
                if (this._mangaPanels.has(panel)) {
                    this._mangaPanels.get(panel)?.destroy();
                    this._mangaPanels.delete(panel);
                }
                return;
            }
            if (!this._mangaPanels.has(panel)) {
                this._mangaPanels.set(panel, new MokuroMangaPanel(panel));
                this.installAppStyles();
            }
        };
        checkForPanel();
        setInterval(checkForPanel, 500);
    }
    setupVisibleObserver() {
        this._visibleObserver = this.getParseVisibleObserver();
    }
    visibleObserverOnEnter(elements) {
        for (const element of elements) {
            this._mangaPanels.set(element, new MokuroMangaPanel(element));
        }
        this.installAppStyles();
    }
    visibleObserverOnExit(elements) {
        for (const element of elements) {
            this._mangaPanels.get(element)?.destroy();
            this._mangaPanels.delete(element);
        }
    }
    addedObserverCallback(elements) {
        for (const element of elements) {
            if (this._observedElements.has(element)) {
                continue;
            }
            this._visibleObserver?.observe(element);
            this._observedElements.add(element);
        }
    }
}


/***/ }),
/* 115 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ReadwokParser: () => (/* binding */ ReadwokParser)
/* harmony export */ });
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(105);

class ReadwokParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_0__.AutomaticParser {
    visibleObserverOnEnter(elements, observer, filter) {
        elements.forEach((element) => {
            element.querySelectorAll('rt[style]').forEach((furi) => {
                furi.removeAttribute('style');
            });
        });
        super.visibleObserverOnEnter(elements, observer, filter);
    }
}


/***/ }),
/* 116 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SatoriReaderParser: () => (/* binding */ SatoriReaderParser)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(17);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(89);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(105);
/* harmony import */ var _satori_desktop__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(117);
/* harmony import */ var _satori_mobile__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(120);






class SatoriReaderParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_3__.AutomaticParser {
    constructor() {
        super(...arguments);
        this.desktop = new _satori_desktop__WEBPACK_IMPORTED_MODULE_4__.SatoriDesktop((useBreader) => {
            this.enableBreader(useBreader);
        });
        this.mobile = new _satori_mobile__WEBPACK_IMPORTED_MODULE_5__.SatoriMobile((useBreader) => {
            this.enableBreader(useBreader);
        });
    }
    init() {
        this.desktop.setMode(true);
        this.mobile.setMode(true);
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', async () => {
            const touchActive = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenSupport');
            this.desktop.setDisplay(touchActive);
            this.mobile.setDisplay(touchActive);
        }, true);
    }
    enableBreader(isActive) {
        this.desktop.setMode(isActive);
        this.mobile.setMode(isActive);
        _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.skipTouchEvents = !isActive;
    }
}


/***/ }),
/* 117 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SatoriDesktop: () => (/* binding */ SatoriDesktop)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(31);
/* harmony import */ var _shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(34);
/* harmony import */ var _shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(118);



class SatoriDesktop {
    constructor(switchMode) {
        this.switchMode = switchMode;
        this.articleControls = (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__.findElement)('#article-controls-container .article-controls');
        this.breaderSection = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            class: 'controls-section',
            children: [
                {
                    tag: 'h3',
                    innerText: 'Jiten Reader',
                },
                {
                    tag: 'div',
                    class: 'control-group',
                    id: 'jiten-reader',
                    children: [
                        {
                            tag: 'span',
                            class: ['radio', 'use-breader'],
                            handler: () => this.activeBreaderEvents(),
                        },
                        {
                            tag: 'span',
                            class: ['label', 'use-breader'],
                            handler: () => this.activeBreaderEvents(),
                            innerText: 'Enable Lookup Events',
                        },
                        { tag: 'br' },
                        {
                            tag: 'span',
                            class: ['radio', 'use-satori'],
                            handler: () => this.activeSatoriEvents(),
                        },
                        {
                            tag: 'span',
                            class: ['label', 'use-satori'],
                            handler: () => this.activeSatoriEvents(),
                            innerText: 'Enable Satori Events',
                        },
                        { tag: 'br' },
                    ],
                },
            ],
        });
        this.articleControls?.insertAdjacentElement('afterbegin', this.breaderSection);
    }
    setMode(breader) {
        this.setClasses(breader);
    }
    setDisplay(touchActive) {
        this.breaderSection.style.display = touchActive ? 'block' : 'none';
    }
    activeBreaderEvents() {
        this.switchMode(true);
        this.setClasses(true);
    }
    activeSatoriEvents() {
        this.switchMode(false);
        this.setClasses(false);
    }
    setClasses(breader) {
        (0,_shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_2__.withElements)(this.breaderSection, '.use-breader', (el) => {
            el.classList.toggle('on', breader);
            el.classList.toggle('off', !breader);
        });
        (0,_shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_2__.withElements)(this.breaderSection, '.use-satori', (el) => {
            el.classList.toggle('on', !breader);
            el.classList.toggle('off', breader);
        });
    }
}


/***/ }),
/* 118 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   withElements: () => (/* binding */ withElements)
/* harmony export */ });
/* harmony import */ var _find_elements__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(119);

function withElements(p0, p1, p2) {
    const e = p2
        ? (0,_find_elements__WEBPACK_IMPORTED_MODULE_0__.findElements)(p0, p1)
        : (0,_find_elements__WEBPACK_IMPORTED_MODULE_0__.findElements)(p0);
    const fn = p2 ?? p1;
    return e.map((c) => fn(c));
}


/***/ }),
/* 119 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   findElements: () => (/* binding */ findElements)
/* harmony export */ });
function findElements(p0, p1, _) {
    const root = typeof p0 === 'string' ? document : p0;
    const selector = typeof p0 === 'string' ? p0 : p1;
    return Array.from(root.querySelectorAll(selector));
}


/***/ }),
/* 120 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SatoriMobile: () => (/* binding */ SatoriMobile)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(31);
/* harmony import */ var _shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(34);
/* harmony import */ var _shared_dom_find_elements__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(119);
/* harmony import */ var _shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(121);




class SatoriMobile {
    constructor(switchMode) {
        this.switchMode = switchMode;
        this.displayCategory = (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__.findElement)('#nav-mobile-category-display');
        this.displayCategoryAll = (0,_shared_dom_find_elements__WEBPACK_IMPORTED_MODULE_2__.findElements)(this.displayCategory, '.tab');
        this.displayCategoryBreader = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            class: ['tab', 'off'],
            innerText: 'Jiten Reader',
            id: 'nav-mobile-category-display-breader-tab',
            handler: () => this.activateTab('nav-mobile-category-display-breader-tab'),
        });
        this.displayMenu = (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__.findElement)('#nav-mobile-category-display-all');
        this.displayMenuAll = (0,_shared_dom_find_elements__WEBPACK_IMPORTED_MODULE_2__.findElements)(this.displayMenu, '.leaf-set');
        this.displayMenuBreader = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            class: ['leaf-set'],
            style: { display: 'none' },
            id: 'nav-mobile-category-display-breader',
            children: [
                {
                    tag: 'div',
                    class: ['selection', 'on'],
                    id: 'nav-mobile-touch-breader',
                    innerText: 'Enable Lookup Events',
                    handler: () => this.activeBreaderEvents(),
                },
                {
                    tag: 'div',
                    class: ['selection', 'off'],
                    id: 'nav-mobile-touch-satori',
                    innerText: 'Enable Satori Events',
                    handler: () => this.activeSatoriEvents(),
                },
            ],
        });
        this.displayCategory?.insertAdjacentElement('afterbegin', this.displayCategoryBreader);
        this.displayMenu?.insertAdjacentElement('afterbegin', this.displayMenuBreader);
        this.initControls();
        this.activateTab('nav-mobile-category-display-breader-tab');
    }
    setMode(breader) {
        this.setClasses(breader);
    }
    setDisplay(touchActive) {
        this.displayCategoryBreader.style.display = touchActive ? '' : 'none';
        if (!touchActive) {
            if (this.displayCategoryBreader.classList.contains('on')) {
                this.activateTab(this.displayCategoryAll[0].id);
            }
        }
    }
    initControls() {
        this.displayCategoryAll.forEach((el) => {
            el.addEventListener('click', () => {
                this.activateTab(el.id);
            });
        });
    }
    activateTab(id) {
        const activeTabType = id.split('-')[4];
        [...this.displayCategoryAll, this.displayCategoryBreader].forEach((el) => {
            el.classList.toggle('on', el.id === id);
            el.classList.toggle('off', el.id !== id);
        });
        [...this.displayMenuAll, this.displayMenuBreader].forEach((el) => {
            const isActive = el.id.includes(activeTabType);
            el.style.display = isActive ? 'block' : 'none';
        });
    }
    activeBreaderEvents() {
        this.switchMode(true);
        this.setClasses(true);
    }
    activeSatoriEvents() {
        this.switchMode(false);
        this.setClasses(false);
    }
    setClasses(breader) {
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__.withElement)(this.displayMenuBreader, '#nav-mobile-touch-breader', (el) => {
            el.classList.toggle('on', breader);
            el.classList.toggle('off', !breader);
        });
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__.withElement)(this.displayMenuBreader, '#nav-mobile-touch-satori', (el) => {
            el.classList.toggle('on', !breader);
            el.classList.toggle('off', breader);
        });
    }
}


/***/ }),
/* 121 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   withElement: () => (/* binding */ withElement)
/* harmony export */ });
/* harmony import */ var _find_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(34);

function withElement(p0, p1, p2) {
    const e = p2
        ? (0,_find_element__WEBPACK_IMPORTED_MODULE_0__.findElement)(p0, p1)
        : (0,_find_element__WEBPACK_IMPORTED_MODULE_0__.findElement)(p0);
    const fn = p2 ?? p1;
    if (e) {
        return fn(e);
    }
}


/***/ }),
/* 122 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TtsuParser: () => (/* binding */ TtsuParser)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(89);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(105);


class TtsuParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_1__.AutomaticParser {
    setupVisibleObserver() {
        this._visibleObserver = this.getParseVisibleObserver();
    }
    visibleObserverOnEnter(elements) {
        const [element] = elements;
        const container = element.querySelector('.book-content-container');
        const chapters = element.querySelectorAll('[id^="ttu');
        if (container) {
            this._pageObserver = new MutationObserver(() => {
                _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.sentenceManager.reset();
                this.parseNode(container);
            });
            this._pageObserver.observe(container, {
                attributes: true,
                attributeFilter: ['id'],
            });
            return;
        }
        this.setupChapterObservers(chapters);
    }
    visibleObserverOnExit() {
        this._pageObserver?.disconnect();
        this._chapterObserver?.disconnect();
    }
    setupChapterObservers(chapters) {
        this._chapterObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    this.parseNode(entry.target);
                    continue;
                }
                _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.dismissNode(entry.target);
            }
        });
        for (const chapter of chapters) {
            this._chapterObserver.observe(chapter);
        }
    }
}


/***/ }),
/* 123 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   NoParser: () => (/* binding */ NoParser)
/* harmony export */ });
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(29);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(89);
/* harmony import */ var _trigger_parser__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(124);



class NoParser extends _trigger_parser__WEBPACK_IMPORTED_MODULE_2__.TriggerParser {
    parsePage() {
        this.reject();
    }
    parseSelection() {
        this.reject();
    }
    reject() {
        if (!_integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.isMainFrame) {
            return;
        }
        (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('error', 'This page has been disabled for manual parsing.');
    }
}


/***/ }),
/* 124 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TriggerParser: () => (/* binding */ TriggerParser)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(81);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(31);
/* harmony import */ var _shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(106);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(30);
/* harmony import */ var _shared_host_meta_is_disabled__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(125);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(17);
/* harmony import */ var _shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(82);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(87);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(89);
/* harmony import */ var _base_parser__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(107);











class TriggerParser extends _base_parser__WEBPACK_IMPORTED_MODULE_10__.BaseParser {
    constructor(meta) {
        super(meta);
        this._parseKeyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_8__.KeybindManager(['parseKey']);
        this._buttonRoot = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            id: 'ajb-parse-button',
        });
        this._parseKeyManager.activate();
        _integration_registry__WEBPACK_IMPORTED_MODULE_9__.Registry.events.on('parseKey', () => {
            this.initParse();
        });
        (0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_7__.receiveBackgroundMessage)('parsePage', () => this.parsePage());
        (0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_7__.receiveBackgroundMessage)('parseSelection', () => this.parseSelection());
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_6__.onBroadcastMessage)('configurationUpdated', async () => {
            const show = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showParseButton');
            const paused = await (0,_shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_3__.getParsingPaused)();
            this._buttonRoot.style.display = show && !paused ? 'block' : 'none';
        }, true);
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_6__.onBroadcastMessage)('parsingPaused', async (paused) => {
            if (paused) {
                this._buttonRoot.style.display = 'none';
                this._parseKeyManager.deactivate();
            }
            else {
                const show = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showParseButton');
                this._buttonRoot.style.display = show ? 'block' : 'none';
                this._parseKeyManager.activate();
            }
        });
        void Promise.all([(0,_shared_host_meta_is_disabled__WEBPACK_IMPORTED_MODULE_5__.isDisabled)(window.location.href), (0,_shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_3__.getParsingPaused)()]).then(([disabled, paused]) => {
            if (!disabled && !paused) {
                this.installParseButton();
            }
            if (paused) {
                this._parseKeyManager.deactivate();
            }
        });
    }
    initParse() {
        this._buttonRoot.style.display = 'none';
        if (window.getSelection()?.toString()) {
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_1__.debug)('TriggerParser: Parsing selection');
            return this.parseSelection();
        }
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_1__.debug)('TriggerParser: Parsing page');
        return this.parsePage();
    }
    installParseButton() {
        const shadowRoot = this._buttonRoot.attachShadow({ mode: 'open' });
        shadowRoot.append((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('link', {
            attributes: { rel: 'stylesheet', href: (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_4__.getStyleUrl)('parse') },
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', { innerText: 'Parse', handler: () => this.initParse() }));
        document.body.appendChild(this._buttonRoot);
    }
}


/***/ }),
/* 125 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   isDisabled: () => (/* binding */ isDisabled)
/* harmony export */ });
/* harmony import */ var _get_host_meta__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(101);

const isDisabled = async (host) => {
    const meta = await (0,_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.getHostMeta)(host, 'isDisabled', ({ host }) => host !== '<all_urls>');
    if (!meta) {
        return false;
    }
    if (meta.disabled) {
        return true;
    }
    return meta.auto;
};


/***/ }),
/* 126 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   PopupManager: () => (/* binding */ PopupManager)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(17);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(87);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(89);
/* harmony import */ var _actions_grading_actions__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(127);
/* harmony import */ var _actions_grading_controller__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(128);
/* harmony import */ var _actions_mining_actions__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(130);
/* harmony import */ var _actions_mining_controller__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(131);
/* harmony import */ var _actions_rotation_actions__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(132);
/* harmony import */ var _actions_rotation_controller__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(133);
/* harmony import */ var _popup__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(134);











class PopupManager {
    constructor() {
        this._keyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_2__.KeybindManager(['showPopupKey', 'showAdvancedDialogKey']);
        this._miningController = new _actions_mining_controller__WEBPACK_IMPORTED_MODULE_7__.MiningController();
        this._rotationController = new _actions_rotation_controller__WEBPACK_IMPORTED_MODULE_9__.RotationController();
        this._gradingController = new _actions_grading_controller__WEBPACK_IMPORTED_MODULE_5__.GradingController();
        this._miningActions = new _actions_mining_actions__WEBPACK_IMPORTED_MODULE_6__.MiningActions(this._miningController);
        this._rotationActions = new _actions_rotation_actions__WEBPACK_IMPORTED_MODULE_8__.RotationActions(this._rotationController);
        this._gradingActions = new _actions_grading_actions__WEBPACK_IMPORTED_MODULE_4__.GradingActions(this._gradingController);
        this._popup = new _popup__WEBPACK_IMPORTED_MODULE_10__.Popup(this._miningController, this._rotationController, this._gradingController);
        this._observer = new MutationObserver((m) => {
            if (m[0].removedNodes.length > 0 && m[0].removedNodes[0] === this._currentHover) {
                this._popup.hide();
            }
        });
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', async () => {
            this._showPopupOnHover = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showPopupOnHover');
            this._touchscreenSupport = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenSupport');
        }, true);
        _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry.events.on('showPopupKey', () => this.handlePopup());
        _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry.events.on('showAdvancedDialogKey', () => this.handleAdvancedDialog());
    }
    enter(element, sentence) {
        this._currentHover = element;
        this._currentSentence = sentence;
        this._keyManager.activate();
        this._miningActions.activate(this._currentHover, sentence);
        this._rotationActions.activate(this._currentHover);
        this._gradingActions.activate(this._currentHover);
        if (this._showPopupOnHover) {
            this.handlePopup();
        }
    }
    touch(element, event, sentence) {
        if (!this._touchscreenSupport || !element || _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry.skipTouchEvents) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this._currentHover = element;
        this._currentSentence = sentence;
        this._keyManager.activate();
        this._miningActions.activate(this._currentHover, sentence);
        this._rotationActions.activate(this._currentHover);
        this._gradingActions.activate(this._currentHover);
        this.handlePopup();
    }
    leave() {
        this._currentHover = undefined;
        this._currentSentence = undefined;
        this._keyManager.deactivate();
        this._miningActions.deactivate();
        this._rotationActions.deactivate();
        this._gradingActions.deactivate();
        this._popup.initHide();
    }
    handlePopup() {
        if (!this._currentHover) {
            return;
        }
        this._popup.show(this._currentHover, this._currentSentence);
        if (this._currentHover.parentElement) {
            this._observer.observe(this._currentHover.parentElement, { childList: true });
        }
    }
    handleAdvancedDialog() {
    }
}


/***/ }),
/* 127 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   GradingActions: () => (/* binding */ GradingActions)
/* harmony export */ });
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(87);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(89);


class GradingActions {
    constructor(_controller) {
        this._controller = _controller;
        this._keyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_0__.KeybindManager([
            'jitenReviewNothing',
            'jitenReviewSomething',
            'jitenReviewHard',
            'jitenReviewOkay',
            'jitenReviewEasy',
            'jitenReviewFail',
            'jitenReviewPass',
        ]);
        const { events } = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry;
        events.on('jitenReviewNothing', () => this.reviewCard('unknown'));
        events.on('jitenReviewSomething', () => this.reviewCard('again'));
        events.on('jitenReviewHard', () => this.reviewCard('hard'));
        events.on('jitenReviewOkay', () => this.reviewCard('good'));
        events.on('jitenReviewEasy', () => this.reviewCard('easy'));
        events.on('jitenReviewFail', () => this.reviewCard('again'));
        events.on('jitenReviewPass', () => this.reviewCard('good'));
    }
    activate(context) {
        this._card = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.getCardFromElement(context);
        this._keyManager.activate();
    }
    deactivate() {
        this._card = undefined;
        this._keyManager.deactivate();
    }
    reviewCard(rating) {
        if (!this._card) {
            return;
        }
        this._controller.gradeCard(this._card, rating);
    }
}


/***/ }),
/* 128 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   GradingController: () => (/* binding */ GradingController)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_background_grade_card_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(46);
/* harmony import */ var _base_controller__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(129);



class GradingController extends _base_controller__WEBPACK_IMPORTED_MODULE_2__.BaseController {
    get gradingEnabled() {
        return !this._disableReviews;
    }
    get showActions() {
        return this._showActions && this.gradingEnabled;
    }
    getGradingActions() {
        return this._useTwoPointGrading ? ['again', 'good'] : ['again', 'hard', 'good', 'easy'];
    }
    gradeCard(card, rating) {
        if (!this.gradingEnabled || !this.getGradingActions().includes(rating)) {
            return;
        }
        const { wordId, readingIndex } = card;
        new _shared_messages_background_grade_card_command__WEBPACK_IMPORTED_MODULE_1__.GradeCardCommand(wordId, readingIndex, rating).send(() => this.updateCardState(card));
    }
    async applyConfiguration() {
        this._useTwoPointGrading = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenUseTwoGrades');
        this._disableReviews = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenDisableReviews');
        this._showActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showGradingActions');
    }
}


/***/ }),
/* 129 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BaseController: () => (/* binding */ BaseController)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(54);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(17);


class BaseController {
    constructor() {
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', () => this.applyConfiguration(), true);
    }
    suspendUpdateWordStates() {
        BaseController._suspendUpdateWordStates = true;
    }
    resumeUpdateWordStates(card) {
        BaseController._suspendUpdateWordStates = false;
        this.updateCardState(card);
    }
    updateCardState(card) {
        const { wordId, readingIndex } = card;
        if (BaseController._suspendUpdateWordStates) {
            return;
        }
        new _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_0__.UpdateCardStateCommand(wordId, readingIndex).send();
    }
}
BaseController._suspendUpdateWordStates = false;


/***/ }),
/* 130 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MiningActions: () => (/* binding */ MiningActions)
/* harmony export */ });
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(87);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(89);


class MiningActions {
    constructor(_controller) {
        this._controller = _controller;
        this._keyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_0__.KeybindManager([
            'addToMiningKey',
            'addToBlacklistKey',
            'addToNeverForgetKey',
            'addToSuspendedKey',
        ]);
        const { events } = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry;
        events.on('addToMiningKey', () => this.addToDeck('mining'));
        events.on('addToBlacklistKey', () => this.addToDeck('blacklist'));
        events.on('addToNeverForgetKey', () => this.addToDeck('neverForget'));
        events.on('addToSuspendedKey', () => this.addToDeck('suspend'));
    }
    activate(context, sentence) {
        this._card = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.getCardFromElement(context);
        this._sentence = sentence;
        this._keyManager.activate();
    }
    deactivate() {
        this._card = undefined;
        this._sentence = undefined;
        this._keyManager.deactivate();
    }
    addToDeck(key) {
        if (!this._card) {
            return;
        }
        this._controller.addOrRemove('add', key, this._card, this._sentence);
    }
}


/***/ }),
/* 131 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MiningController: () => (/* binding */ MiningController)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(51);
/* harmony import */ var _base_controller__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(129);



class MiningController extends _base_controller__WEBPACK_IMPORTED_MODULE_2__.BaseController {
    get showActions() {
        return this._showActions;
    }
    addOrRemove(action, key, card, sentence) {
        const { wordId, readingIndex } = card;
        new _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_1__.RunDeckActionCommand(wordId, readingIndex, key, action, sentence).send(() => this.updateCardState(card));
    }
    async applyConfiguration() {
        this._showActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showMiningActions');
    }
}


/***/ }),
/* 132 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RotationActions: () => (/* binding */ RotationActions)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(17);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(87);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(89);




class RotationActions {
    constructor(_controller) {
        this._controller = _controller;
        this._keyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_2__.KeybindManager(['jitenRotateForward', 'jitenRotateBackward']);
        this._rotateCycle = false;
        this._cycleNeverForget = false;
        this._cycleBlacklist = false;
        this._cycleSuspended = false;
        const { events } = _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry;
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', async () => {
            this._rotateCycle = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenRotateCycle');
            this._cycleNeverForget = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenCycleNeverForget');
            this._cycleBlacklist = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenCycleBlacklist');
            this._cycleSuspended = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenCycleSuspended');
        }, true);
        events.on('jitenRotateForward', () => this.rotateFlags(true));
        events.on('jitenRotateBackward', () => this.rotateFlags(false));
    }
    activate(context) {
        this._card = _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry.getCardFromElement(context);
        this._keyManager.activate();
    }
    deactivate() {
        this._card = undefined;
        this._keyManager.deactivate();
    }
    rotateFlags(forward) {
        if (!this._card) {
            return;
        }
        this._controller.rotate(this._card, forward ? 1 : -1);
    }
}


/***/ }),
/* 133 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RotationController: () => (/* binding */ RotationController)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(51);
/* harmony import */ var _base_controller__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(129);



class RotationController extends _base_controller__WEBPACK_IMPORTED_MODULE_2__.BaseController {
    constructor() {
        super(...arguments);
        this._jitenRotateFlags = false;
    }
    get rotateFlags() {
        return this._jitenRotateFlags;
    }
    get showActions() {
        return this._showActions && this.rotateFlags;
    }
    get states() {
        const states = [
            this._neverForget ? 'neverForget' : undefined,
            this._blacklist ? 'blacklist' : undefined,
            this._suspend ? 'suspend' : undefined,
        ].filter(Boolean);
        return this._remove ? [...states, undefined] : states;
    }
    rotate(card, direction) {
        if (!this.rotateFlags) {
            return;
        }
        const next = this.getNextCardState(card, direction);
        const instructions = this.getInstructions(card, next);
        this.suspendUpdateWordStates();
        const executeInstructions = (index) => {
            if (index < instructions.length) {
                instructions[index].send(() => executeInstructions(index + 1));
            }
            else {
                this.resumeUpdateWordStates(card);
            }
        };
        executeInstructions(0);
    }
    getNextCardState(card, direction) {
        const current = this.getCurrentCardState(card);
        const currentIndex = this.states.indexOf(current);
        let nextIndex = currentIndex === -1
            ? direction === 1
                ? 0
                : this.states.length - 1
            : (currentIndex + direction) % this.states.length;
        if (nextIndex < 0) {
            nextIndex = this.states.length - 1;
        }
        const nextState = this.states[nextIndex];
        return nextState;
    }
    getInstructions(card, nextState) {
        const instructions = [];
        this.states.filter(Boolean).forEach((state) => {
            instructions.push(new _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_1__.RunDeckActionCommand(card.wordId, card.readingIndex, state, state === nextState ? 'add' : 'remove'));
        });
        return instructions;
    }
    getCurrentCardState(card) {
        void card;
        return undefined;
    }
    async applyConfiguration() {
        this._jitenRotateFlags = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenRotateFlags');
        this._neverForget = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenCycleNeverForget');
        this._blacklist = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenCycleBlacklist');
        this._suspend = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenCycleSuspended');
        this._remove = !(await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenRotateCycle'));
        this._showActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showRotateActions');
    }
}


/***/ }),
/* 134 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Popup: () => (/* binding */ Popup)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(31);
/* harmony import */ var _shared_dom_find_elements__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(119);
/* harmony import */ var _shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(121);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(30);
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(4);
/* harmony import */ var _shared_messages_background_forget_card_command__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(43);
/* harmony import */ var _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(54);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(17);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(72);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(87);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(89);
/* harmony import */ var _confirm_dialog__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(135);
/* harmony import */ var _part_of_speech__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(136);














class Popup {
    constructor(_mining, _rotation, _grading) {
        this._mining = _mining;
        this._rotation = _rotation;
        this._grading = _grading;
        this._keyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_10__.KeybindManager([], {
            keydown: (e) => this.handleKeydown(e),
        });
        this._root = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            id: 'ajb-popup',
            events: {
                onmousedown: (ev) => ev.stopPropagation(),
                onclick: (ev) => ev.stopPropagation(),
                onwheel: (ev) => ev.stopPropagation(),
            },
            style: {
                all: 'initial',
                zIndex: '2147483647',
                position: 'absolute',
                top: '0',
                left: '0',
                opacity: '0',
                visibility: 'hidden',
            },
        });
        this._themeStyles = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('style');
        this._customStyles = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('style');
        this._closeButton = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('section', {
            id: 'close',
            class: ['controls'],
            style: {
                display: 'none',
            },
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('a', {
                    id: 'close-btn',
                    class: ['outline', 'close'],
                    handler: () => this.hide(),
                }),
            ],
        });
        this._mineButtons = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('section', { id: 'mining', class: ['controls'] });
        this._rotateButtons = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('section', { id: 'rotation', class: ['controls'] });
        this._gradeButtons = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('section', { id: 'grading', class: ['controls'] });
        this._context = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('section', { id: 'context' });
        this._details = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('section', { id: 'details' });
        this._popup = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            class: ['popup'],
            events: {
                onmouseenter: () => this.startHover(),
                onmouseleave: () => this.stopHover(),
            },
            children: [],
        });
        this._popupLeft = 0;
        this._popupTop = 0;
        this.renderNodes();
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_8__.onBroadcastMessage)('cardStateUpdated', (wordId, readingIndex) => {
            setTimeout(() => {
                this._card = _integration_registry__WEBPACK_IMPORTED_MODULE_11__.Registry.getCard(wordId, readingIndex);
                if (this._hideAfterAction) {
                    return this.hide();
                }
                this.rerender();
            }, 1);
        });
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_8__.onBroadcastMessage)('configurationUpdated', () => this.applyConfiguration(), true);
    }
    show(context, sentence) {
        this._cardContext = context;
        this._card = _integration_registry__WEBPACK_IMPORTED_MODULE_11__.Registry.getCardFromElement(context);
        this._sentence = sentence;
        this._conjugations = _integration_registry__WEBPACK_IMPORTED_MODULE_11__.Registry.getConjugations(context);
        this.clearTimer();
        this.updateParentElement();
        this.rerender();
        this.setPosition();
        Object.assign(this._root.style, {
            transition: this._disableFadeAnimation ? 'none' : 'opacity 60ms ease-in, visibility 60ms',
            opacity: '1',
            visibility: 'visible',
        });
        this._keyManager.activate();
    }
    hide() {
        Object.assign(this._root.style, {
            transition: this._disableFadeAnimation ? 'none' : 'opacity 200ms ease-in, visibility 20ms',
            opacity: '0',
            visibility: 'hidden',
        });
        this._keyManager.deactivate();
    }
    initHide() {
        if (!this._hidePopupAutomatically) {
            return;
        }
        if (!this._hidePopupDelay) {
            this.hide();
            return;
        }
        this.startTimer();
    }
    disablePointerEvents() {
        this._root.style.pointerEvents = 'none';
        this._root.style.userSelect = 'none';
    }
    enablePointerEvents() {
        this._root.style.pointerEvents = '';
        this._root.style.userSelect = '';
    }
    async applyConfiguration() {
        this._hidePopupAutomatically = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('hidePopupAutomatically');
        this._hidePopupDelay = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('hidePopupDelay');
        this._hideAfterAction = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('hideAfterAction');
        this._disableFadeAnimation = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('disableFadeAnimation');
        this._leftAlignPopupToWord = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('leftAlignPopupToWord');
        this._renderCloseButton = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('renderCloseButton');
        this._touchscreenSupport = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenSupport');
        this._moveMiningActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('moveMiningActions');
        this._moveRotationActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('moveRotateActions');
        this._moveGradingActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('moveGradingActions');
        this._showConjugations = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showConjugations');
        this._themeStyles.textContent = await (0,_shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_9__.getThemeCssVars)();
        this._customStyles.textContent = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('customPopupCSS');
        this._closeButton.style.display =
            this._touchscreenSupport && this._renderCloseButton ? 'flex' : 'none';
        this.updateMiningButtons();
        this.updateRotationButtons();
        this.updateGradingButtons();
        this.applyPositions();
    }
    renderNodes() {
        const shadowRoot = this._root.attachShadow({ mode: 'closed' });
        shadowRoot.append((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('link', { attributes: { rel: 'stylesheet', href: (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_4__.getStyleUrl)('popup') } }), this._themeStyles, this._customStyles, this._popup);
        this._confirmDialog = new _confirm_dialog__WEBPACK_IMPORTED_MODULE_12__.ConfirmDialog(shadowRoot, () => ({
            x: this._popupLeft,
            y: this._popupTop,
        }));
    }
    updateParentElement() {
        const parentElement = this.getParentElement();
        if (!this._root.parentElement?.isSameNode(parentElement)) {
            parentElement.appendChild(this._root);
        }
    }
    getParentElement() {
        const fullscreenVideoElement = this.getFullscreenVideoElement();
        if (fullscreenVideoElement?.parentElement) {
            return this.findElementForFullscreenVideoDisplay(fullscreenVideoElement);
        }
        return document.body;
    }
    getFullscreenVideoElement() {
        if (!document.fullscreenElement) {
            return;
        }
        return (0,_shared_dom_find_elements__WEBPACK_IMPORTED_MODULE_2__.findElements)('video').find((videoElement) => document.fullscreenElement.contains(videoElement));
    }
    findElementForFullscreenVideoDisplay(videoElement) {
        let currentNode = videoElement.parentElement;
        let chosenNode;
        const testNode = document.createElement('div');
        testNode.style.position = 'absolute';
        testNode.style.zIndex = '2147483647';
        testNode.innerText = '&nbsp;';
        while (currentNode && !currentNode.isSameNode(document.body.parentElement)) {
            const rect = currentNode.getBoundingClientRect();
            if (rect.height > 0 &&
                (chosenNode === undefined || rect.height >= chosenNode.getBoundingClientRect().height) &&
                this.elementIsClickableInsideContainer(currentNode, testNode)) {
                chosenNode = currentNode;
                break;
            }
            currentNode = currentNode.parentElement;
        }
        return chosenNode ?? document.body;
    }
    elementIsClickableInsideContainer(container, element) {
        container.appendChild(element);
        const rect = element.getBoundingClientRect();
        const clickedElement = document.elementFromPoint(rect.x, rect.y);
        const clickable = element.isSameNode(clickedElement) || element.contains(clickedElement);
        element.remove();
        return clickable;
    }
    setPosition() {
        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
        const { writingMode } = getComputedStyle(this._cardContext);
        const { x, y } = this._cardContext.getBoundingClientRect();
        const { offsetWidth: popupWidth, offsetHeight: popupHeight } = this._popup;
        const { innerWidth, innerHeight, scrollX, scrollY } = window;
        const { top, right, bottom, left } = this.getClosestClientRect(this._cardContext, x, y);
        const wordLeft = scrollX + left;
        const wordTop = scrollY + top;
        const wordRight = scrollX + right;
        const wordBottom = scrollY + bottom;
        const leftSpace = left;
        const topSpace = top;
        const rightSpace = innerWidth - right;
        const bottomSpace = innerHeight - bottom;
        const minLeft = scrollX;
        const maxLeft = scrollX + innerWidth - popupWidth;
        const minTop = scrollY;
        const maxTop = scrollY + innerHeight - popupHeight;
        let popupLeft;
        let popupTop;
        if (writingMode.startsWith('horizontal')) {
            popupTop = clamp(bottomSpace > topSpace ? wordBottom : wordTop - popupHeight, minTop, maxTop);
            popupLeft = clamp(rightSpace > leftSpace ? wordLeft : wordRight - popupWidth, minLeft, maxLeft);
        }
        else {
            popupTop = clamp(bottomSpace > topSpace ? wordTop : wordBottom - popupHeight, minTop, maxTop);
            popupLeft = clamp(rightSpace > leftSpace ? wordRight : wordLeft - popupWidth, minLeft, maxLeft);
        }
        if (this._leftAlignPopupToWord) {
            popupLeft = Math.min(wordLeft, innerWidth - popupWidth - 8);
        }
        if (innerWidth < 450) {
            popupLeft = 8;
            this._root.style.width = `${innerWidth - 32}px`;
            this._popup.style.width = `${innerWidth - 32}px`;
        }
        this._popupLeft = popupLeft;
        this._popupTop = popupTop;
        this._root.style.transform = `translate(${popupLeft}px, ${popupTop}px)`;
    }
    getClosestClientRect(elem, x, y) {
        const rects = elem.getClientRects();
        if (rects.length === 1) {
            return rects[0];
        }
        const { writingMode } = getComputedStyle(elem);
        const horizontal = writingMode.startsWith('horizontal');
        const mergedRects = [];
        for (const rect of rects) {
            if (mergedRects.length === 0) {
                mergedRects.push(rect);
                continue;
            }
            const prevRect = mergedRects[mergedRects.length - 1];
            if (horizontal) {
                if (rect.bottom === prevRect.bottom && rect.left === prevRect.right) {
                    mergedRects[mergedRects.length - 1] = new DOMRect(prevRect.x, prevRect.y, rect.right - prevRect.left, prevRect.height);
                }
                else {
                    mergedRects.push(rect);
                }
            }
            else {
                if (rect.right === prevRect.right && rect.top === prevRect.bottom) {
                    mergedRects[mergedRects.length - 1] = new DOMRect(prevRect.x, prevRect.y, prevRect.width, rect.bottom - prevRect.top);
                }
                else {
                    mergedRects.push(rect);
                }
            }
        }
        return mergedRects
            .map((rect) => ({
            rect,
            distance: Math.max(rect.left - x, 0, x - rect.right) ** 2 +
                Math.max(rect.top - y, 0, y - rect.bottom) ** 2,
        }))
            .reduce((a, b) => (a.distance <= b.distance ? a : b)).rect;
    }
    updateMiningButtons() {
        const performDeckAction = (action, key, sentence) => this._mining.addOrRemove(action, key, this._card, sentence);
        const performFlaggedDeckAction = (key) => {
            const action = this.cardHasState(key, this._card) ? 'remove' : 'add';
            performDeckAction(action, key);
        };
        this._mineButtons.replaceChildren();
        this._mineButtons.style.display = this._mining.showActions ? '' : 'none';
        this.addMiningButton('neverForget', 'never-forget', undefined, () => performFlaggedDeckAction('neverForget'));
        this.addMiningButton('blacklist', 'blacklist', undefined, () => performFlaggedDeckAction('blacklist'));
        this._mineButtons.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('a', {
            id: 'forget-deck',
            class: ['outline', 'forget'],
            innerText: 'Forget',
            handler: () => this.handleForgetClick(),
        }));
    }
    async handleForgetClick() {
        if (!this._card || !this._confirmDialog) {
            return;
        }
        const confirmed = await this._confirmDialog.show({
            message: 'Forget this card? The card state and all reviews will be permanently deleted.',
            confirmText: 'Forget',
            cancelText: 'Cancel',
            confirmClass: 'forget',
        });
        if (!confirmed) {
            return;
        }
        const { wordId, readingIndex } = this._card;
        new _shared_messages_background_forget_card_command__WEBPACK_IMPORTED_MODULE_6__.ForgetCardCommand(wordId, readingIndex).send(() => {
            new _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_7__.UpdateCardStateCommand(wordId, readingIndex).send();
        });
    }
    addMiningButton(deck, id, text, handler) {
        if (!deck?.length) {
            return;
        }
        this._mineButtons.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('a', {
            id: `${id}-deck`,
            class: ['outline', id],
            innerText: text,
            handler,
        }));
    }
    updateRotationButtons() {
        const previous = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('a', {
            id: 'previous',
            class: ['outline', 'previous'],
            innerText: 'Previous',
            handler: () => this._rotation.rotate(this._card, -1),
        });
        const next = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('a', {
            id: 'next',
            class: ['outline', 'next'],
            innerText: 'Next',
            handler: () => this._rotation.rotate(this._card, 1),
        });
        this._rotateButtons.replaceChildren(previous, next);
        this._rotateButtons.style.display = this._rotation.showActions ? '' : 'none';
    }
    updateGradingButtons() {
        const gradeButtons = this._grading.getGradingActions().map((grade) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('a', {
            id: grade,
            class: ['outline', grade],
            innerText: grade,
            handler: () => this._grading.gradeCard(this._card, grade),
        }));
        this._gradeButtons.replaceChildren(...gradeButtons);
        this._gradeButtons.style.display = this._grading.showActions ? '' : 'none';
    }
    applyPositions() {
        const sections = [this._closeButton, this._context, this._details];
        const before = [];
        const after = [];
        const miningTarget = this._moveMiningActions ? after : before;
        const rotationTarget = this._moveRotationActions ? after : before;
        const gradingTarget = this._moveGradingActions ? after : before;
        miningTarget.push(this._mineButtons);
        rotationTarget.push(this._rotateButtons);
        gradingTarget.push(this._gradeButtons);
        sections.unshift(...before);
        sections.push(...after);
        this._popup.replaceChildren(...sections);
    }
    cardHasState(state, card) {
        const stateMap = {
            neverForget: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_5__.JitenCardState.MASTERED,
            blacklist: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_5__.JitenCardState.BLACKLISTED,
            suspend: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_5__.JitenCardState.BLACKLISTED,
        };
        return card.cardState.includes(stateMap[state]);
    }
    rerender() {
        if (!this._card) {
            return;
        }
        this.adjustMiningButtons(this._card);
        this.adjustRotateButtons(this._card);
        this.adjustContext(this._card);
        this.adjustDetails(this._card);
        this._popup.setAttribute('class', `popup ${this._card.cardState.join(' ')}`);
    }
    adjustMiningButtons(card) {
        const isNF = this.cardHasState('neverForget', card);
        const isBL = this.cardHasState('blacklist', card);
        const isSP = this.cardHasState('suspend', card);
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__.withElement)(this._mineButtons, '#never-forget-deck', (el) => {
            el.innerText = isNF ? 'Remove Never Forget' : 'Never forget';
        });
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__.withElement)(this._mineButtons, '#blacklist-deck', (el) => {
            el.innerText = isBL ? 'Remove Blacklist' : 'Blacklist';
        });
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__.withElement)(this._mineButtons, '#suspend-deck', (el) => {
            el.innerText = isSP ? 'Unsuspend' : 'Suspend';
        });
    }
    adjustRotateButtons(card) {
        const previous = this._rotation.getNextCardState(card, -1);
        const next = this._rotation.getNextCardState(card, 1);
        const same = previous === next;
        const getText = (state, arrow) => {
            const text = !state
                ? 'Unflag'
                : state
                    .replace(/^\w/, (c) => c.toUpperCase())
                    .replace(/([a-z])([A-Z])/g, (c) => `${c[0]} ${c[1].toLowerCase()}`);
            if (arrow === 'left') {
                return `← ${text}`;
            }
            if (arrow === 'right') {
                return `${text} →`;
            }
            return text;
        };
        const getCls = (state) => {
            if (!state) {
                return '';
            }
            return state.replace(/([a-z])([A-Z])/g, (c) => `${c[0]}-${c[1].toLowerCase()}`);
        };
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__.withElement)(this._rotateButtons, '#previous', (el) => {
            el.style.display = same ? 'none' : '';
            el.innerText = getText(previous, 'left');
            el.setAttribute('class', `outline previous ${getCls(previous)}`);
        });
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__.withElement)(this._rotateButtons, '#next', (el) => {
            el.innerText = getText(next, same ? undefined : 'right');
            el.setAttribute('class', `outline next ${getCls(next)}`);
        });
    }
    adjustContext(card) {
        this._context.replaceChildren((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            id: 'header',
            class: 'subsection',
            children: [this.getReadingBlock(card), this.getCardStateBlock(card)],
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            id: 'meta',
            class: 'subsection',
            children: [this.getPitchAccentBlock(card), this.getFrequencyBlock(card)],
        }));
    }
    getReadingBlock(card) {
        const { wordId, spelling, readingIndex, wordWithReading } = card;
        const url = `https://jiten.moe/vocabulary/${wordId}/${readingIndex}`;
        const a = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('a', {
            id: 'link',
            attributes: { href: url, target: '_blank', lang: 'ja' },
        });
        a.append(...this.convertToRubyNodes(wordWithReading ?? spelling));
        return a;
    }
    convertToRubyNodes(wordWithReading) {
        if (!wordWithReading.includes('[')) {
            return [document.createTextNode(wordWithReading)];
        }
        const regex = /([^\u3040-\u309F\u30A0-\u30FF]+)\[(.+?)\]/g;
        const nodes = [];
        let lastIndex = 0;
        let match;
        while ((match = regex.exec(wordWithReading)) !== null) {
            if (match.index > lastIndex) {
                nodes.push(document.createTextNode(wordWithReading.slice(lastIndex, match.index)));
            }
            const ruby = document.createElement('ruby');
            const rt = document.createElement('rt');
            rt.textContent = match[2];
            ruby.append(document.createTextNode(match[1]));
            ruby.append(rt);
            nodes.push(ruby);
            lastIndex = regex.lastIndex;
        }
        if (lastIndex < wordWithReading.length) {
            nodes.push(document.createTextNode(wordWithReading.slice(lastIndex)));
        }
        return nodes;
    }
    getCardStateBlock(card) {
        const { cardState } = card;
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            id: 'state',
            children: cardState.map((s) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('span', { class: [s], innerText: s })),
        });
    }
    getPitchAccentBlock(card) {
        const { reading, pitchAccent } = card;
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            id: 'pitch-accent',
            children: pitchAccent.map((pitch) => this.renderPitch(reading, pitch)),
        });
    }
    getFrequencyBlock(card) {
        const { frequencyRank } = card;
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            id: 'frequency',
            innerText: `#${frequencyRank}`,
        });
    }
    getConjugationsBlock(conjugations) {
        if (!conjugations || conjugations.length === 0) {
            return null;
        }
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            id: 'conjugations',
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('span', {
                    class: 'label',
                    innerText: 'Conjugations: ',
                }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('span', {
                    innerText: conjugations.join(' ; '),
                }),
            ],
        });
    }
    renderPitch(reading, pitch) {
        if (reading.length != pitch.length - 1) {
            return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('span', { innerText: 'Error: invalid pitch' });
        }
        try {
            const parts = [];
            const borders = Array.from(pitch.matchAll(/L(?=H)|H(?=L)/g), (x) => x.index + 1);
            let lastBorder = 0;
            let low = pitch.startsWith('L');
            for (const border of borders) {
                parts.push((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('span', {
                    class: [low ? 'low' : 'high'],
                    innerText: reading.slice(lastBorder, border),
                }));
                lastBorder = border;
                low = !low;
            }
            if (lastBorder != reading.length) {
                parts.push((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('span', {
                    class: [low ? 'low-final' : 'high-final'],
                    innerText: reading.slice(lastBorder),
                }));
            }
            return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('span', { class: 'pitch', children: parts });
        }
        catch (_e) {
            return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('span', { innerText: 'Error: invalid pitch' });
        }
    }
    adjustDetails(card) {
        const groupedMeanings = this.getGroupedMeanings(card);
        const conjugationsBlock = this._conjugations && this._showConjugations
            ? this.getConjugationsBlock(this._conjugations)
            : null;
        const children = [];
        if (conjugationsBlock) {
            children.push(conjugationsBlock);
        }
        children.push(...groupedMeanings.flatMap(({ partsOfSpeech, glosses, startIndex }) => [
            (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
                class: 'pos',
                children: partsOfSpeech
                    .map((pos) => _part_of_speech__WEBPACK_IMPORTED_MODULE_13__.PARTS_OF_SPEECH[pos] ?? 'Unknown')
                    .filter(Boolean)
                    .map((pos) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('span', { innerText: pos })),
            }),
            (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('ol', {
                attributes: {
                    start: (startIndex + 1).toString(),
                },
                children: glosses.map((g) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('li', {
                    innerText: g.join('; '),
                })),
            }),
        ]));
        this._details.replaceChildren(...children);
    }
    getGroupedMeanings(card) {
        const { meanings } = card;
        const groupedMeanings = [];
        let lastPos = [];
        for (const [index, meaning] of meanings.entries()) {
            const currentPartsOfSpeech = Array.isArray(meaning.partsOfSpeech)
                ? meaning.partsOfSpeech
                : [meaning.partsOfSpeech];
            if (currentPartsOfSpeech.length == lastPos.length &&
                currentPartsOfSpeech.every((p, i) => p === lastPos[i])) {
                groupedMeanings[groupedMeanings.length - 1].glosses.push(meaning.glosses);
                continue;
            }
            groupedMeanings.push({
                partsOfSpeech: currentPartsOfSpeech,
                glosses: [meaning.glosses],
                startIndex: index,
            });
            lastPos = meaning.partsOfSpeech;
        }
        return groupedMeanings;
    }
    isVisibile() {
        return this._root.style.visibility === 'visible';
    }
    startHover() {
        if (!this.isVisibile()) {
            return;
        }
        this._isHover = true;
        this.clearTimer();
    }
    stopHover() {
        this._isHover = false;
        if (!this.isVisibile()) {
            return;
        }
        if (this._confirmDialog?.isOpen) {
            return;
        }
        if (!this._hidePopupAutomatically) {
            return;
        }
        if (!this._hidePopupDelay) {
            this.hide();
            return;
        }
        this.startTimer();
    }
    handleKeydown(e) {
        if (!document.hasFocus()) {
            return;
        }
        if (e && 'key' in e && e.key === 'Escape' && this.isVisibile()) {
            e.stopPropagation();
            this.hide();
        }
        if ('button' in e && e.button === 0 && this.isVisibile() && !this._isHover) {
            e.stopPropagation();
            this.hide();
        }
    }
    clearTimer() {
        if (this._hideTimer) {
            clearTimeout(this._hideTimer);
        }
    }
    startTimer() {
        this.clearTimer();
        this._hideTimer = setTimeout(() => this.hide(), this._hidePopupDelay);
    }
}


/***/ }),
/* 135 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ConfirmDialog: () => (/* binding */ ConfirmDialog)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(31);

class ConfirmDialog {
    constructor(_shadowRoot, _getPopupPosition) {
        this._shadowRoot = _shadowRoot;
        this._getPopupPosition = _getPopupPosition;
        this._overlay = null;
    }
    get isOpen() {
        return this._overlay !== null;
    }
    show(options) {
        const { message, confirmText = 'Confirm', cancelText = 'Cancel', confirmClass = 'forget', } = options;
        this._overlay = this.createOverlay();
        const dialog = this.createDialog(message, confirmText, cancelText, confirmClass);
        this._overlay.appendChild(dialog);
        this._shadowRoot.appendChild(this._overlay);
        return new Promise((resolve) => {
            this._resolvePromise = resolve;
        });
    }
    createOverlay() {
        const { x, y } = this._getPopupPosition();
        const overlay = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            id: 'confirm-overlay',
            handler: () => this.close(false),
        });
        overlay.style.transform = `translate(${-x}px, ${-y}px)`;
        return overlay;
    }
    createDialog(message, confirmText, cancelText, confirmClass) {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            id: 'confirm-dialog',
            events: {
                onclick: (e) => e.stopPropagation(),
            },
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('p', {
                    id: 'confirm-message',
                    innerText: message,
                }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
                    id: 'confirm-buttons',
                    children: [
                        (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('a', {
                            class: ['outline'],
                            innerText: cancelText,
                            handler: () => this.close(false),
                        }),
                        (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('a', {
                            class: ['outline', confirmClass],
                            innerText: confirmText,
                            handler: () => this.close(true),
                        }),
                    ],
                }),
            ],
        });
    }
    close(confirmed) {
        this._overlay?.remove();
        this._overlay = null;
        this._resolvePromise?.(confirmed);
    }
}


/***/ }),
/* 136 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   PARTS_OF_SPEECH: () => (/* binding */ PARTS_OF_SPEECH)
/* harmony export */ });
const PARTS_OF_SPEECH = {
    bra: 'Brazilian',
    hob: 'Hokkaido-ben',
    ksb: 'Kansai-ben',
    ktb: 'Kantou-ben',
    kyb: 'Kyoto-ben',
    kyu: 'Kyuushuu-ben',
    nab: 'Nagano-ben',
    osb: 'Osaka-ben',
    rkb: 'Ryuukyuu-ben',
    thb: 'Touhoku-ben',
    tsb: 'Tosa-ben',
    tsug: 'Tsugaru-ben',
    agric: 'agriculture',
    anat: 'anatomy',
    archeol: 'archeology',
    archit: 'architecture',
    art: 'art, aesthetics',
    astron: 'astronomy',
    audvid: 'audiovisual',
    aviat: 'aviation',
    baseb: 'baseball',
    biochem: 'biochemistry',
    biol: 'biology',
    bot: 'botany',
    Buddh: 'Buddhism',
    bus: 'business',
    cards: 'card games',
    chem: 'chemistry',
    Christn: 'Christianity',
    cloth: 'clothing',
    comp: 'computing',
    cryst: 'crystallography',
    name: 'name',
    'name-fem': 'female name',
    'name-male': 'male name',
    'name-given': 'given name',
    'name-surname': 'surname',
    'name-place': 'place name',
    'name-person': 'person name',
    'name-unclass': 'unclassified name',
    'name-station': 'station name',
    'name-organization': 'organization name',
    'name-company': 'company name',
    'name-product': 'product name',
    'name-work': 'work name',
    dent: 'dentistry',
    ecol: 'ecology',
    econ: 'economics',
    elec: 'electricity, elec. eng.',
    electr: 'electronics',
    embryo: 'embryology',
    engr: 'engineering',
    ent: 'entomology',
    film: 'film',
    finc: 'finance',
    fish: 'fishing',
    food: 'food, cooking',
    gardn: 'gardening, horticulture',
    genet: 'genetics',
    geogr: 'geography',
    geol: 'geology',
    geom: 'geometry',
    go: 'go (game)',
    golf: 'golf',
    gramm: 'grammar',
    grmyth: 'Greek mythology',
    hanaf: 'hanafuda',
    horse: 'horse racing',
    kabuki: 'kabuki',
    law: 'law',
    ling: 'linguistics',
    logic: 'logic',
    MA: 'martial arts',
    mahj: 'mahjong',
    manga: 'manga',
    math: 'mathematics',
    mech: 'mechanical engineering',
    med: 'medicine',
    met: 'meteorology',
    mil: 'military',
    mining: 'mining',
    music: 'music',
    noh: 'noh',
    ornith: 'ornithology',
    paleo: 'paleontology',
    pathol: 'pathology',
    pharm: 'pharmacology',
    phil: 'philosophy',
    photo: 'photography',
    physics: 'physics',
    physiol: 'physiology',
    politics: 'politics',
    print: 'printing',
    psy: 'psychiatry',
    psyanal: 'psychoanalysis',
    psych: 'psychology',
    rail: 'railway',
    rommyth: 'Roman mythology',
    Shinto: 'Shinto',
    shogi: 'shogi',
    ski: 'skiing',
    sports: 'sports',
    stat: 'statistics',
    stockm: 'stock market',
    sumo: 'sumo',
    telec: 'telecommunications',
    tradem: 'trademark',
    tv: 'television',
    vidg: 'video games',
    zool: 'zoology',
    abbr: 'abbreviation',
    arch: 'archaic',
    char: 'character',
    chn: "children's language",
    col: 'colloquial',
    company: 'company name',
    creat: 'creature',
    dated: 'dated term',
    dei: 'deity',
    derog: 'derogatory',
    doc: 'document',
    euph: 'euphemistic',
    ev: 'event',
    fam: 'familiar language',
    fem: 'female term or language',
    fict: 'fiction',
    form: 'formal or literary term',
    given: 'given name or forename, gender not specified',
    group: 'group',
    hist: 'historical term',
    hon: 'honorific or respectful (sonkeigo)',
    hum: 'humble (kenjougo)',
    id: 'idiomatic expression',
    joc: 'jocular, humorous term',
    leg: 'legend',
    'm-sl': 'manga slang',
    male: 'male term or language',
    myth: 'mythology',
    'net-sl': 'Internet slang',
    obj: 'object',
    obs: 'obsolete term',
    'on-mim': 'onomatopoeic or mimetic',
    organization: 'organization name',
    oth: 'other',
    person: 'full name of a particular person',
    place: 'place name',
    poet: 'poetical term',
    pol: 'polite (teineigo)',
    product: 'product name',
    proverb: 'proverb',
    quote: 'quotation',
    rare: 'rare term',
    relig: 'religion',
    sens: 'sensitive',
    serv: 'service',
    ship: 'ship name',
    sl: 'slang',
    station: 'railway station',
    surname: 'family or surname',
    uk: 'usually written using kana',
    unclass: 'unclassified name',
    vulg: 'vulgar',
    work: 'work of art, literature, music, etc. name',
    X: 'rude or X-rated term (not displayed in educational software)',
    yoji: 'yojijukugo',
    'adj-f': 'noun or verb acting prenominally',
    'adj-i': 'adjective (keiyoushi)',
    'adj-ix': 'adjective (keiyoushi) - yoi/ii class',
    'adj-kari': "'kari' adjective (archaic)",
    'adj-ku': "'ku' adjective (archaic)",
    'adj-na': 'adjectival nouns or quasi-adjectives (keiyodoshi)',
    'adj-nari': 'archaic/formal form of na-adjective',
    'adj-no': "nouns which may take the genitive case particle 'no'",
    'adj-pn': 'pre-noun adjectival (rentaishi)',
    'adj-shiku': "'shiku' adjective (archaic)",
    'adj-t': "'taru' adjective",
    adv: 'adverb (fukushi)',
    'adv-to': "adverb taking the 'to' particle",
    aux: 'auxiliary',
    'aux-adj': 'auxiliary adjective',
    'aux-v': 'auxiliary verb',
    conj: 'conjunction',
    cop: 'copula',
    ctr: 'counter',
    exp: 'expressions (phrases, clauses, etc.)',
    int: 'interjection (kandoushi)',
    n: 'noun (common) (futsuumeishi)',
    'n-adv': 'adverbial noun (fukushitekimeishi)',
    'n-pr': 'proper noun',
    'n-pref': 'noun, used as a prefix',
    'n-suf': 'noun, used as a suffix',
    'n-t': 'noun (temporal) (jisoumeishi)',
    num: 'numeric',
    pn: 'pronoun',
    pref: 'prefix',
    prt: 'particle',
    suf: 'suffix',
    unc: 'unclassified',
    'v-unspec': 'verb unspecified',
    v1: 'Ichidan verb',
    'v1-s': 'Ichidan verb - kureru special class',
    'v2a-s': "Nidan verb with 'u' ending (archaic)",
    'v2b-k': "Nidan verb (upper class) with 'bu' ending (archaic)",
    'v2b-s': "Nidan verb (lower class) with 'bu' ending (archaic)",
    'v2d-k': "Nidan verb (upper class) with 'dzu' ending (archaic)",
    'v2d-s': "Nidan verb (lower class) with 'dzu' ending (archaic)",
    'v2g-k': "Nidan verb (upper class) with 'gu' ending (archaic)",
    'v2g-s': "Nidan verb (lower class) with 'gu' ending (archaic)",
    'v2h-k': "Nidan verb (upper class) with 'hu/fu' ending (archaic)",
    'v2h-s': "Nidan verb (lower class) with 'hu/fu' ending (archaic)",
    'v2k-k': "Nidan verb (upper class) with 'ku' ending (archaic)",
    'v2k-s': "Nidan verb (lower class) with 'ku' ending (archaic)",
    'v2m-k': "Nidan verb (upper class) with 'mu' ending (archaic)",
    'v2m-s': "Nidan verb (lower class) with 'mu' ending (archaic)",
    'v2n-s': "Nidan verb (lower class) with 'nu' ending (archaic)",
    'v2r-k': "Nidan verb (upper class) with 'ru' ending (archaic)",
    'v2r-s': "Nidan verb (lower class) with 'ru' ending (archaic)",
    'v2s-s': "Nidan verb (lower class) with 'su' ending (archaic)",
    'v2t-k': "Nidan verb (upper class) with 'tsu' ending (archaic)",
    'v2t-s': "Nidan verb (lower class) with 'tsu' ending (archaic)",
    'v2w-s': "Nidan verb (lower class) with 'u' ending and 'we' conjugation (archaic)",
    'v2y-k': "Nidan verb (upper class) with 'yu' ending (archaic)",
    'v2y-s': "Nidan verb (lower class) with 'yu' ending (archaic)",
    'v2z-s': "Nidan verb (lower class) with 'zu' ending (archaic)",
    v4b: "Yodan verb with 'bu' ending (archaic)",
    v4g: "Yodan verb with 'gu' ending (archaic)",
    v4h: "Yodan verb with 'hu/fu' ending (archaic)",
    v4k: "Yodan verb with 'ku' ending (archaic)",
    v4m: "Yodan verb with 'mu' ending (archaic)",
    v4n: "Yodan verb with 'nu' ending (archaic)",
    v4r: "Yodan verb with 'ru' ending (archaic)",
    v4s: "Yodan verb with 'su' ending (archaic)",
    v4t: "Yodan verb with 'tsu' ending (archaic)",
    v5aru: 'Godan verb - -aru special class',
    v5b: "Godan verb with 'bu' ending",
    v5g: "Godan verb with 'gu' ending",
    v5k: "Godan verb with 'ku' ending",
    'v5k-s': 'Godan verb - Iku/Yuku special class',
    v5m: "Godan verb with 'mu' ending",
    v5n: "Godan verb with 'nu' ending",
    v5r: "Godan verb with 'ru' ending",
    'v5r-i': "Godan verb with 'ru' ending (irregular verb)",
    v5s: "Godan verb with 'su' ending",
    v5t: "Godan verb with 'tsu' ending",
    v5u: "Godan verb with 'u' ending",
    'v5u-s': "Godan verb with 'u' ending (special class)",
    v5uru: 'Godan verb - Uru old class verb (old form of Eru)',
    vi: 'intransitive verb',
    vk: 'Kuru verb - special class',
    vn: 'irregular nu verb',
    vr: 'irregular ru verb, plain form ends with -ri',
    vs: 'noun or participle which takes the aux. verb suru',
    'vs-c': 'su verb - precursor to the modern suru',
    'vs-i': 'suru verb - included',
    'vs-s': 'suru verb - special class',
    vt: 'transitive verb',
    vz: 'Ichidan verb - zuru verb (alternative form of -jiru verbs)',
    gikun: 'gikun (meaning as reading) or jukujikun (special kanji reading)',
    ik: 'irregular kana usage',
    ok: 'out-dated or obsolete kana usage',
    sk: 'search-only kana form',
    boxing: 'boxing',
    chmyth: 'Chinese mythology',
    civeng: 'civil engineering',
    figskt: 'figure skating',
    internet: 'Internet',
    jpmyth: 'Japanese mythology',
    min: 'mineralogy',
    motor: 'motorsport',
    prowres: 'professional wrestling',
    surg: 'surgery',
    vet: 'veterinary terms',
    ateji: 'ateji (phonetic) reading',
    iK: 'word containing irregular kanji usage',
    io: 'irregular okurigana usage',
    oK: 'word containing out-dated kanji or kanji usage',
    rK: 'rarely used kanji form',
    sK: 'search-only kanji form',
    rk: 'rarely used kana form',
};


/***/ }),
/* 137 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   StatusBar: () => (/* binding */ StatusBar)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(9);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(31);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(30);
/* harmony import */ var _shared_extension_get_url__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(15);
/* harmony import */ var _shared_messages_background_open_settings_command__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(58);
/* harmony import */ var _shared_messages_background_update_badge_command__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(60);
/* harmony import */ var _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(138);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(17);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(72);
/* harmony import */ var _stats_calculator__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(139);











class StatusBar {
    constructor() {
        this._themeStyles = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('style');
        this._root = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            id: 'ajb-status-bar',
            style: {
                all: 'initial',
                zIndex: '2147483646',
                position: 'fixed',
                bottom: '0',
                left: '50%',
                transform: 'translateX(-50%)',
                visibility: 'hidden',
            },
        });
        this._bar = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['status-bar', 'hidden'],
            events: {
                onmouseenter: () => this.onMouseEnter(),
                onmouseleave: () => this.onMouseLeave(),
            },
        });
        this._icon = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['status-icon', 'hidden'],
            events: {
                onclick: () => this.show(),
                onmouseenter: () => this.onMouseEnter(),
                onmouseleave: () => this.onMouseLeave(),
            },
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('img', {
                    attributes: { src: (0,_shared_extension_get_url__WEBPACK_IMPORTED_MODULE_4__.getURL)('assets/32.png'), alt: 'Jiten Reader' },
                }),
            ],
        });
        this._coverageContainer = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['coverage-container'],
        });
        this._coverageLabel = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', {
            class: ['coverage-label'],
            innerText: 'Coverage:',
        });
        this._coverageValue = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['coverage-value'] });
        this._buttonsContainer = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['buttons-container'],
        });
        this._statsButton = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
            class: ['status-btn', 'stats-btn'],
            attributes: { title: 'View statistics' },
            innerText: '📊',
            events: {
                onmouseenter: () => this.onStatsMouseEnter(),
                onmouseleave: () => this.onStatsMouseLeave(),
            },
        });
        this._statsDropdown = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['stats-dropdown'],
            events: {
                onmouseenter: () => this.onStatsMouseEnter(),
                onmouseleave: () => this.onStatsMouseLeave(),
            },
        });
        this._totalEl = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat', 'total'] });
        this._masteredEl = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat', 'mastered'] });
        this._matureEl = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat', 'mature'] });
        this._youngEl = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat', 'young'] });
        this._blacklistedEl = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', {
            class: ['stat', 'blacklisted'],
        });
        this._newEl = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat', 'new'] });
        this._dueEl = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat', 'due'] });
        this._lockButton = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
            class: ['status-btn', 'lock-btn'],
            attributes: { title: 'Toggle auto-hide' },
            handler: () => void this.toggleAutoHide(),
        });
        this._settingsButton = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
            class: ['status-btn', 'settings-btn'],
            attributes: { title: 'Open settings' },
            innerText: '⚙',
            handler: () => this.openSettings(),
        });
        this._stats = { total: 0, mastered: 0, mature: 0, young: 0, blacklisted: 0, new: 0, due: 0 };
        this._isVisible = false;
        this._isHovering = false;
        this._isStatsHovering = false;
        this._enabled = true;
        this._autoHide = true;
        this._hideIcon = false;
        this._showBadge = true;
        this._position = 'bottom';
        this._hasContent = false;
        this.renderNodes();
        void this.applyConfiguration();
        this.setupEventListeners();
    }
    show() {
        if (!this._enabled || !this._hasContent) {
            return;
        }
        this._isVisible = true;
        this.cancelHideTimer();
        this._bar.classList.remove('hidden');
        this._bar.classList.add('visible');
        this._statsDropdown.classList.remove('hidden');
        this._icon.classList.remove('visible');
    }
    hide() {
        this._isVisible = false;
        this._bar.classList.remove('visible');
        this._bar.classList.add('hidden');
        this._statsDropdown.classList.add('hidden');
        if (!this._hideIcon && this._hasContent) {
            this._icon.classList.remove('hidden');
            this._icon.classList.add('visible');
        }
        else {
            this._icon.classList.remove('visible');
        }
    }
    toggle() {
        if (!this._enabled || !this._hasContent) {
            return;
        }
        if (this._isVisible) {
            this.hide();
        }
        else {
            this.show();
        }
    }
    recalculateStats() {
        this._stats = (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.calculateStatsFromRegistry)();
        const coverage = (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.calculateCoverageFromDOM)();
        this.updateStatsDisplay(coverage);
        const isInitialLoad = !this._hasContent && this._stats.total > 0;
        if (isInitialLoad) {
            this._hasContent = true;
            if (this._enabled) {
                if (this._autoHide) {
                    this.hide();
                }
                else {
                    this.show();
                }
            }
        }
    }
    addButton(button) {
        const btn = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
            id: button.id,
            class: ['status-btn'],
            attributes: { title: button.tooltip },
            innerText: button.icon,
            handler: button.handler,
        });
        this._buttonsContainer.insertBefore(btn, this._settingsButton);
    }
    renderNodes() {
        const shadowRoot = this._root.attachShadow({ mode: 'closed' });
        this._coverageContainer.append(this._coverageLabel, this._coverageValue);
        this._statsDropdown.append((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['stat-row'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat-label'], innerText: 'Total:' }),
                this._totalEl,
            ],
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['stat-row'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat-label'], innerText: 'Mastered:' }),
                this._masteredEl,
            ],
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['stat-row'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat-label'], innerText: 'Mature:' }),
                this._matureEl,
            ],
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['stat-row'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat-label'], innerText: 'Young:' }),
                this._youngEl,
            ],
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['stat-row'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat-label'], innerText: 'New:' }),
                this._newEl,
            ],
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['stat-row'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat-label'], innerText: 'Due:' }),
                this._dueEl,
            ],
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['stat-row'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['stat-label'], innerText: 'Blacklisted:' }),
                this._blacklistedEl,
            ],
        }));
        this._buttonsContainer.append(this._statsButton, this._lockButton, this._settingsButton);
        this._bar.append(this._coverageContainer, this._buttonsContainer, this._statsDropdown);
        const stylesheet = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('link', {
            attributes: { rel: 'stylesheet', href: (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_3__.getStyleUrl)('status-bar') },
            events: { onload: () => (this._root.style.visibility = 'visible') },
        });
        shadowRoot.append(this._themeStyles, stylesheet, this._bar, this._icon);
        document.body.appendChild(this._root);
    }
    async applyConfiguration() {
        this._enabled = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('statusBarEnabled');
        this._autoHide = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('statusBarAutoHide');
        this._hideIcon = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('statusBarHideIcon');
        this._showBadge = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('statusBarShowBadge');
        this._position = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('statusBarPosition');
        this._themeStyles.textContent = await (0,_shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_9__.getThemeCssVars)();
        this.updateLockButton();
        this.updatePosition();
        this.updateBadge();
        if (!this._enabled || !this._hasContent) {
            this._bar.classList.remove('visible');
            this._icon.classList.remove('visible');
            return;
        }
        if (this._autoHide) {
            if (!this._isHovering) {
                this.hide();
            }
        }
        else {
            this.show();
        }
    }
    setupEventListeners() {
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_8__.onBroadcastMessage)('configurationUpdated', () => void this.applyConfiguration());
    }
    onMouseEnter() {
        this._isHovering = true;
        this.cancelHideTimer();
        if (this._enabled && !this._isVisible) {
            this.show();
        }
    }
    onMouseLeave() {
        this._isHovering = false;
        if (this._autoHide && this._isVisible) {
            this.startHideTimer();
        }
    }
    startHideTimer() {
        this.cancelHideTimer();
        this._hideTimeout = setTimeout(() => {
            this.hide();
        }, 2000);
    }
    cancelHideTimer() {
        if (this._hideTimeout) {
            clearTimeout(this._hideTimeout);
            this._hideTimeout = undefined;
        }
    }
    updateStatsDisplay(coverage) {
        const coverageStats = coverage ?? (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.calculateCoverageFromDOM)();
        const comprehension = (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.calculateComprehension)(coverageStats);
        const uniqueComprehension = (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.calculateUniqueComprehension)(coverageStats);
        const colour = (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.getComprehensionColour)(comprehension);
        this._coverageValue.innerText = `${comprehension}% (Unique ${uniqueComprehension}%)`;
        this._coverageValue.style.color = colour;
        this._totalEl.innerText = this._stats.total.toString();
        this._masteredEl.innerText = this._stats.mastered.toString();
        this._matureEl.innerText = this._stats.mature.toString();
        this._youngEl.innerText = this._stats.young.toString();
        this._blacklistedEl.innerText = this._stats.blacklisted.toString();
        this._newEl.innerText = this._stats.new.toString();
        this._dueEl.innerText = this._stats.due.toString();
        this.updateBadge();
    }
    updateBadge() {
        if (!this._showBadge || !this._hasContent) {
            new _shared_messages_background_update_badge_command__WEBPACK_IMPORTED_MODULE_6__.UpdateBadgeCommand(null).send();
            return;
        }
        const coverage = (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.calculateCoverageFromDOM)();
        const comprehension = (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.calculateComprehension)(coverage);
        new _shared_messages_background_update_badge_command__WEBPACK_IMPORTED_MODULE_6__.UpdateBadgeCommand(comprehension).send();
    }
    updateLockButton() {
        this._lockButton.innerText = this._autoHide ? '🔓' : '🔒';
        this._lockButton.classList.toggle('locked', !this._autoHide);
    }
    updatePosition() {
        const isTop = this._position === 'top';
        this._root.style.top = isTop ? '0' : '';
        this._root.style.bottom = isTop ? '' : '0';
        this._bar.classList.toggle('top', isTop);
        this._icon.classList.toggle('top', isTop);
        this._statsDropdown.classList.toggle('top', isTop);
    }
    async toggleAutoHide() {
        this._autoHide = !this._autoHide;
        this.updateLockButton();
        if (this._autoHide) {
            if (!this._isHovering) {
                this.startHideTimer();
            }
        }
        else {
            this.cancelHideTimer();
        }
        await (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.setConfiguration)('statusBarAutoHide', this._autoHide);
        new _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_7__.ConfigurationUpdatedCommand().send();
    }
    openSettings() {
        new _shared_messages_background_open_settings_command__WEBPACK_IMPORTED_MODULE_5__.OpenSettingsCommand().send();
    }
    onStatsMouseEnter() {
        this._isStatsHovering = true;
        this.cancelStatsDropdownTimer();
        this._statsDropdown.classList.add('visible');
    }
    onStatsMouseLeave() {
        this._isStatsHovering = false;
        this.startStatsDropdownTimer();
    }
    startStatsDropdownTimer() {
        this.cancelStatsDropdownTimer();
        this._statsDropdownTimeout = setTimeout(() => {
            if (!this._isStatsHovering) {
                this._statsDropdown.classList.remove('visible');
            }
        }, 200);
    }
    cancelStatsDropdownTimer() {
        if (this._statsDropdownTimeout) {
            clearTimeout(this._statsDropdownTimeout);
            this._statsDropdownTimeout = undefined;
        }
    }
}


/***/ }),
/* 138 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ConfigurationUpdatedCommand: () => (/* binding */ ConfigurationUpdatedCommand)
/* harmony export */ });
/* harmony import */ var _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(36);

class ConfigurationUpdatedCommand extends _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__.BroadcastCommand {
    constructor() {
        super(...arguments);
        this.key = 'configurationUpdated';
    }
}


/***/ }),
/* 139 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   calculateComprehension: () => (/* binding */ calculateComprehension),
/* harmony export */   calculateCoverageFromDOM: () => (/* binding */ calculateCoverageFromDOM),
/* harmony export */   calculateStatsFromRegistry: () => (/* binding */ calculateStatsFromRegistry),
/* harmony export */   calculateUniqueComprehension: () => (/* binding */ calculateUniqueComprehension),
/* harmony export */   getComprehensionColour: () => (/* binding */ getComprehensionColour)
/* harmony export */ });
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(4);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(89);


function calculateStatsFromRegistry() {
    const stats = {
        total: 0,
        mastered: 0,
        mature: 0,
        young: 0,
        blacklisted: 0,
        new: 0,
        due: 0,
    };
    for (const card of _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.getAllCards().values()) {
        stats.total++;
        if (card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.MATURE)) {
            stats.mature++;
        }
        if (card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.YOUNG)) {
            stats.young++;
        }
        if (card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.BLACKLISTED)) {
            stats.blacklisted++;
        }
        if (card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.MASTERED)) {
            stats.mastered++;
        }
        if (card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.DUE)) {
            stats.due++;
        }
        if (card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.NEW)) {
            stats.new++;
        }
    }
    return stats;
}
function calculateCoverageFromDOM() {
    const stats = { total: 0, known: 0, uniqueTotal: 0, uniqueKnown: 0 };
    const seenWords = new Set();
    const elements = document.querySelectorAll('.jiten-word');
    for (const element of elements) {
        if (element.classList.contains('unparsed')) {
            continue;
        }
        stats.total++;
        const wordId = element.getAttribute('wordId');
        const readingIndex = element.getAttribute('readingIndex');
        const key = `${wordId}/${readingIndex}`;
        const isUnique = !seenWords.has(key);
        if (isUnique) {
            seenWords.add(key);
            stats.uniqueTotal++;
        }
        if (element.classList.contains('mature') ||
            element.classList.contains('mastered') ||
            element.classList.contains('blacklisted')) {
            stats.known++;
            if (isUnique) {
                stats.uniqueKnown++;
            }
        }
    }
    return stats;
}
function calculateComprehension(stats) {
    if (stats.total === 0) {
        return 0;
    }
    return Math.round((stats.known / stats.total) * 100);
}
function calculateUniqueComprehension(stats) {
    if (stats.uniqueTotal === 0) {
        return 0;
    }
    return Math.round((stats.uniqueKnown / stats.uniqueTotal) * 100);
}
function getComprehensionColour(percentage) {
    const hue = Math.round(percentage * 1.42);
    return `hsl(${hue}, 78%, 52%)`;
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
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AJB: () => (/* binding */ AJB)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(9);
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(81);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(29);
/* harmony import */ var _shared_messages_background_lookup_text_command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(64);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(17);
/* harmony import */ var _shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(82);
/* harmony import */ var _features_get_features__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(83);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(87);
/* harmony import */ var _integration_no_focus_trigger__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(88);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(89);
/* harmony import */ var _parser_automatic_parser__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(105);
/* harmony import */ var _parser_get_custom_parser__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(108);
/* harmony import */ var _parser_no_parser__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(123);
/* harmony import */ var _parser_trigger_parser__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(124);
/* harmony import */ var _popup_popup_manager__WEBPACK_IMPORTED_MODULE_15__ = __webpack_require__(126);
/* harmony import */ var _status_bar_status_bar__WEBPACK_IMPORTED_MODULE_16__ = __webpack_require__(137);

















class AJB {
    constructor() {
        this._lookupKeyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_8__.KeybindManager(['lookupSelectionKey']);
        this._statusBarKeyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_8__.KeybindManager(['toggleStatusBarKey']);
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_2__.debug)('Initialize AJB', { mainFrame: window === window.top });
        this._lookupKeyManager.activate();
        _integration_no_focus_trigger__WEBPACK_IMPORTED_MODULE_9__.NoFocusTrigger.get().install();
        _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.wordEventDelegator.initialise();
        (0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_6__.receiveBackgroundMessage)('toast', _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast);
        _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.events.on('lookupSelectionKey', () => {
            this.withHiddenRT(() => {
                this.lookupText(window.getSelection()?.toString());
            });
        });
        this.installParsers();
        _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.popupManager = new _popup_popup_manager__WEBPACK_IMPORTED_MODULE_15__.PopupManager();
        if (_integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.isMainFrame) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.statusBar = new _status_bar_status_bar__WEBPACK_IMPORTED_MODULE_16__.StatusBar();
            this._statusBarKeyManager.activate();
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.events.on('toggleStatusBarKey', () => {
                _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.statusBar?.toggle();
            });
        }
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__.onBroadcastMessage)('cardStateUpdated', (wordId, readingIndex, state) => {
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.updateCard(wordId, readingIndex, state);
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.statusBar?.recalculateStats();
        });
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__.onBroadcastMessage)('configurationUpdated', async () => {
            const skipFurigana = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('skipFurigana');
            const generatePitch = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('generatePitch');
            const markTopX = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markTopX');
            const markTopXCount = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markTopXCount');
            const markAllTypes = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markAllTypes');
            const markIPlus1 = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markIPlus1');
            const minSentenceLength = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('minSentenceLength');
            const markOnlyFrequent = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markOnlyFrequent');
            const newStates = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('newStates');
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.textHighlighterOptions.skipFurigana = skipFurigana;
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.textHighlighterOptions.generatePitch = generatePitch;
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.textHighlighterOptions.markIPlus1 = markIPlus1;
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.textHighlighterOptions.markAll = markAllTypes;
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.textHighlighterOptions.markFrequency = markTopX ? markTopXCount : false;
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.textHighlighterOptions.minSentenceLength = minSentenceLength;
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.textHighlighterOptions.markOnlyFrequent = markOnlyFrequent;
            _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry.textHighlighterOptions.newStates = newStates;
        }, true);
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__.onBroadcastMessage)('profileSwitched', (_profileId) => {
            (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.invalidateProfileCache)();
            (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.invalidateSetConfigurationCache)();
        });
        void this.installFeatures();
    }
    lookupText(text) {
        if (!text?.length) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast)('error', 'No text to lookup!');
            return;
        }
        new _shared_messages_background_lookup_text_command__WEBPACK_IMPORTED_MODULE_4__.LookupTextCommand(text).send();
    }
    withHiddenRT(action) {
        const style = document.createElement('style');
        style.innerText = 'rt { display: none !important; }';
        document.head.appendChild(style);
        try {
            action();
        }
        finally {
            document.head.removeChild(style);
        }
    }
    installParsers() {
        const { hostEvaluator, parsers } = _integration_registry__WEBPACK_IMPORTED_MODULE_10__.Registry;
        const isPredefined = (meta) => 'id' in meta;
        void hostEvaluator.load().then(({ canBeTriggered, relevantMeta }) => {
            if (!canBeTriggered) {
                parsers.push(new _parser_no_parser__WEBPACK_IMPORTED_MODULE_13__.NoParser(hostEvaluator.rejectionReason));
            }
            for (const meta of relevantMeta) {
                if (!meta.auto) {
                    if (!meta.disabled) {
                        parsers.push(new _parser_trigger_parser__WEBPACK_IMPORTED_MODULE_14__.TriggerParser(meta));
                    }
                    continue;
                }
                if (isPredefined(meta) && meta.custom) {
                    parsers.push((0,_parser_get_custom_parser__WEBPACK_IMPORTED_MODULE_12__.getCustomParser)(meta.custom, meta));
                    continue;
                }
                parsers.push(new _parser_automatic_parser__WEBPACK_IMPORTED_MODULE_11__.AutomaticParser(meta));
            }
        });
    }
    async installFeatures() {
        const features = await (0,_features_get_features__WEBPACK_IMPORTED_MODULE_7__.getFeatures)();
        for (const feature of features) {
            feature.apply();
        }
    }
}
new AJB();

})();

/******/ })()
;