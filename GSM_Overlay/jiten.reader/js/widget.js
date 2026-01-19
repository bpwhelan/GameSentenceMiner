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
/* 40 */,
/* 41 */,
/* 42 */,
/* 43 */,
/* 44 */,
/* 45 */,
/* 46 */,
/* 47 */,
/* 48 */,
/* 49 */,
/* 50 */,
/* 51 */,
/* 52 */,
/* 53 */,
/* 54 */,
/* 55 */,
/* 56 */,
/* 57 */,
/* 58 */,
/* 59 */,
/* 60 */,
/* 61 */,
/* 62 */,
/* 63 */,
/* 64 */,
/* 65 */,
/* 66 */,
/* 67 */,
/* 68 */,
/* 69 */,
/* 70 */,
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
/* 82 */,
/* 83 */,
/* 84 */,
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
/* 86 */,
/* 87 */,
/* 88 */,
/* 89 */,
/* 90 */,
/* 91 */,
/* 92 */,
/* 93 */,
/* 94 */,
/* 95 */,
/* 96 */,
/* 97 */,
/* 98 */,
/* 99 */,
/* 100 */,
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
/* 103 */,
/* 104 */,
/* 105 */,
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
/* 107 */,
/* 108 */,
/* 109 */,
/* 110 */,
/* 111 */,
/* 112 */,
/* 113 */,
/* 114 */,
/* 115 */,
/* 116 */,
/* 117 */,
/* 118 */,
/* 119 */,
/* 120 */,
/* 121 */,
/* 122 */,
/* 123 */,
/* 124 */,
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
/* 126 */,
/* 127 */,
/* 128 */,
/* 129 */,
/* 130 */,
/* 131 */,
/* 132 */,
/* 133 */,
/* 134 */,
/* 135 */,
/* 136 */,
/* 137 */,
/* 138 */,
/* 139 */,
/* 140 */,
/* 141 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   onLoaded: () => (/* binding */ onLoaded)
/* harmony export */ });
/* harmony import */ var _on__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(142);

const onLoaded = (listener) => {
    (0,_on__WEBPACK_IMPORTED_MODULE_0__.on)('DOMContentLoaded', listener);
};


/***/ }),
/* 142 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   on: () => (/* binding */ on)
/* harmony export */ });
const on = (event, listener) => {
    document.addEventListener(event, listener);
};


/***/ }),
/* 143 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParsingPausedCommand: () => (/* binding */ ParsingPausedCommand)
/* harmony export */ });
/* harmony import */ var _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(36);

class ParsingPausedCommand extends _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__.BroadcastCommand {
    constructor(paused) {
        super();
        this.key = 'parsingPaused';
        this.arguments = [paused];
    }
}


/***/ }),
/* 144 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLProfileSelectorElement: () => (/* binding */ HTMLProfileSelectorElement)
/* harmony export */ });
/* harmony import */ var _shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(145);
/* harmony import */ var _shared_configuration_profiles_state__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(6);


class HTMLProfileSelectorElement extends HTMLElement {
    constructor() {
        super(...arguments);
        this._profiles = [];
        this._activeProfileId = '';
    }
    get value() {
        return this._select?.value ?? '';
    }
    async connectedCallback() {
        await this.loadProfiles();
        this.buildSelect();
    }
    async loadProfiles() {
        const state = await (0,_shared_configuration_profiles_state__WEBPACK_IMPORTED_MODULE_1__.getProfilesState)();
        this._profiles = state.profiles;
        this._activeProfileId = state.activeProfileId;
    }
    buildSelect() {
        this._select = document.createElement('select');
        this._select.classList.add('outline');
        for (const profile of this._profiles) {
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.name;
            option.selected = profile.id === this._activeProfileId;
            this._select.appendChild(option);
        }
        this._select.addEventListener('change', () => this.onSelectionChange());
        this.appendChild(this._select);
    }
    async onSelectionChange() {
        const newProfileId = this._select.value;
        if (newProfileId !== this._activeProfileId) {
            const success = await (0,_shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__.switchProfile)(newProfileId);
            if (success) {
                this._activeProfileId = newProfileId;
                this.dispatchEvent(new CustomEvent('profilechange', { detail: { profileId: newProfileId } }));
            }
            else {
                this._select.value = this._activeProfileId;
            }
        }
    }
    async refresh() {
        await this.loadProfiles();
        while (this._select.firstChild) {
            this._select.removeChild(this._select.firstChild);
        }
        for (const profile of this._profiles) {
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.name;
            option.selected = profile.id === this._activeProfileId;
            this._select.appendChild(option);
        }
    }
}


/***/ }),
/* 145 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   createProfile: () => (/* binding */ createProfile),
/* harmony export */   deleteProfile: () => (/* binding */ deleteProfile),
/* harmony export */   duplicateProfile: () => (/* binding */ duplicateProfile),
/* harmony export */   renameProfile: () => (/* binding */ renameProfile),
/* harmony export */   switchProfile: () => (/* binding */ switchProfile)
/* harmony export */ });
/* harmony import */ var _messages_broadcast_profile_switched_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(146);
/* harmony import */ var _default_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(3);
/* harmony import */ var _get_configuration__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(1);
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(5);
/* harmony import */ var _profile_types__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(7);
/* harmony import */ var _profiles_state__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(6);
/* harmony import */ var _set_configuration__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(9);







const switchProfile = async (profileId) => {
    const state = await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.getProfilesState)();
    if (!state.profiles.some((p) => p.id === profileId)) {
        return false;
    }
    state.activeProfileId = profileId;
    await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.setProfilesState)(state);
    (0,_get_configuration__WEBPACK_IMPORTED_MODULE_2__.invalidateProfileCache)();
    (0,_set_configuration__WEBPACK_IMPORTED_MODULE_6__.invalidateSetConfigurationCache)();
    new _messages_broadcast_profile_switched_command__WEBPACK_IMPORTED_MODULE_0__.ProfileSwitchedCommand(profileId).send();
    return true;
};
const createProfile = async (name, options = {}) => {
    const { copyFromCurrent = false, forceCreate = false } = options;
    const state = await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.getProfilesState)();
    if (state.profiles.length >= _profile_types__WEBPACK_IMPORTED_MODULE_4__.MAX_PROFILES && !forceCreate) {
        return null;
    }
    const newProfile = {
        id: (0,_profile_constants__WEBPACK_IMPORTED_MODULE_3__.generateProfileId)(),
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    if (copyFromCurrent) {
        const currentProfileId = await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.getActiveProfileId)();
        await copyProfileData(currentProfileId, newProfile.id);
    }
    else {
        await initProfileWithDefaults(newProfile.id);
    }
    state.profiles.push(newProfile);
    await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.setProfilesState)(state);
    return newProfile;
};
const deleteProfile = async (profileId) => {
    const state = await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.getProfilesState)();
    if (state.profiles.length <= 1) {
        return false;
    }
    if (state.activeProfileId === profileId) {
        return false;
    }
    const profileIndex = state.profiles.findIndex((p) => p.id === profileId);
    if (profileIndex === -1) {
        return false;
    }
    await deleteProfileData(profileId);
    state.profiles.splice(profileIndex, 1);
    await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.setProfilesState)(state);
    return true;
};
const renameProfile = async (profileId, newName) => {
    const state = await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.getProfilesState)();
    const profile = state.profiles.find((p) => p.id === profileId);
    if (!profile) {
        return false;
    }
    profile.name = newName;
    profile.updatedAt = Date.now();
    await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.setProfilesState)(state);
    return true;
};
const duplicateProfile = async (profileId, newName) => {
    const state = await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.getProfilesState)();
    const sourceProfile = state.profiles.find((p) => p.id === profileId);
    if (!sourceProfile) {
        return null;
    }
    if (state.profiles.length >= _profile_types__WEBPACK_IMPORTED_MODULE_4__.MAX_PROFILES) {
        return null;
    }
    const newProfile = {
        id: (0,_profile_constants__WEBPACK_IMPORTED_MODULE_3__.generateProfileId)(),
        name: newName ?? `${sourceProfile.name} (Copy)`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    await copyProfileData(profileId, newProfile.id);
    state.profiles.push(newProfile);
    await (0,_profiles_state__WEBPACK_IMPORTED_MODULE_5__.setProfilesState)(state);
    return newProfile;
};
const copyProfileData = async (sourceProfileId, targetProfileId) => {
    const storage = await chrome.storage.local.get();
    const configKeys = Object.keys(_default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION);
    const newData = {};
    for (const key of configKeys) {
        const sourceKey = (0,_profile_constants__WEBPACK_IMPORTED_MODULE_3__.getProfileKey)(sourceProfileId, key);
        if (sourceKey in storage) {
            const targetKey = (0,_profile_constants__WEBPACK_IMPORTED_MODULE_3__.getProfileKey)(targetProfileId, key);
            newData[targetKey] = storage[sourceKey];
        }
    }
    if (Object.keys(newData).length > 0) {
        await chrome.storage.local.set(newData);
    }
};
const initProfileWithDefaults = async (profileId) => {
    const configKeys = Object.keys(_default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION);
    const newData = {};
    for (const key of configKeys) {
        const profileKey = (0,_profile_constants__WEBPACK_IMPORTED_MODULE_3__.getProfileKey)(profileId, key);
        const defaultValue = _default_configuration__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_CONFIGURATION[key];
        newData[profileKey] =
            typeof defaultValue === 'object' || Array.isArray(defaultValue)
                ? JSON.stringify(defaultValue)
                : defaultValue.toString();
    }
    await chrome.storage.local.set(newData);
};
const deleteProfileData = async (profileId) => {
    const storage = await chrome.storage.local.get();
    const prefix = `${_profile_constants__WEBPACK_IMPORTED_MODULE_3__.PROFILE_PREFIX}${profileId}:`;
    const keysToRemove = Object.keys(storage).filter((key) => key.startsWith(prefix));
    if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
    }
};


/***/ }),
/* 146 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ProfileSwitchedCommand: () => (/* binding */ ProfileSwitchedCommand)
/* harmony export */ });
/* harmony import */ var _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(36);

class ProfileSwitchedCommand extends _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__.BroadcastCommand {
    constructor(profileId) {
        super();
        this.key = 'profileSwitched';
        this.arguments = [profileId];
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
/* harmony import */ var _shared_dom_append_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(32);
/* harmony import */ var _shared_dom_on_loaded__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(141);
/* harmony import */ var _shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(106);
/* harmony import */ var _shared_extension_get_tabs__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(37);
/* harmony import */ var _shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(13);
/* harmony import */ var _shared_extension_open_view__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(14);
/* harmony import */ var _shared_extension_set_parsing_paused__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(16);
/* harmony import */ var _shared_host_meta_is_disabled__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(125);
/* harmony import */ var _shared_messages_broadcast_parsing_paused_command__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(143);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(17);
/* harmony import */ var _shared_messages_foreground_parse_page_command__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(19);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(72);
/* harmony import */ var _elements_html_profile_selector_element__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(144);














customElements.define('profile-selector', _elements_html_profile_selector_element__WEBPACK_IMPORTED_MODULE_13__.HTMLProfileSelectorElement);
const applyThemeVars = async () => {
    const cssVars = await (0,_shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_12__.getThemeCssVars)();
    let styleEl = document.getElementById('jiten-theme-vars');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'jiten-theme-vars';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = cssVars;
};
void applyThemeVars();
(0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_10__.onBroadcastMessage)('configurationUpdated', () => void applyThemeVars());
const updatePauseToggle = (toggle, paused) => {
    toggle.innerText = paused ? 'Paused' : 'Enabled';
    toggle.classList.toggle('paused', paused);
};
(0,_shared_dom_on_loaded__WEBPACK_IMPORTED_MODULE_2__.onLoaded)(async () => {
    document.getElementById('settings')?.addEventListener('click', () => {
        void (0,_shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_5__.openOptionsPage)();
    });
    document.getElementById('changelog')?.addEventListener('click', () => {
        void (0,_shared_extension_open_view__WEBPACK_IMPORTED_MODULE_6__.openView)('changelog');
    });
    const pauseToggle = document.getElementById('pause-toggle');
    let isPaused = await (0,_shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_3__.getParsingPaused)();
    updatePauseToggle(pauseToggle, isPaused);
    pauseToggle.addEventListener('click', async () => {
        isPaused = !isPaused;
        await (0,_shared_extension_set_parsing_paused__WEBPACK_IMPORTED_MODULE_7__.setParsingPaused)(isPaused);
        updatePauseToggle(pauseToggle, isPaused);
        new _shared_messages_broadcast_parsing_paused_command__WEBPACK_IMPORTED_MODULE_9__.ParsingPausedCommand(isPaused).send();
    });
    if (isPaused) {
        return;
    }
    const tabsFilter = { currentWindow: true };
    const showCurrentOnTop = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showCurrentOnTop');
    const hideInactiveTabs = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('hideInactiveTabs');
    if (hideInactiveTabs) {
        tabsFilter.active = true;
        document.getElementById('not-parsable').innerText = 'Current tab parsed or disabled';
    }
    const allTabs = await (0,_shared_extension_get_tabs__WEBPACK_IMPORTED_MODULE_4__.getTabs)(tabsFilter);
    const parsePage = new _shared_messages_foreground_parse_page_command__WEBPACK_IMPORTED_MODULE_11__.ParsePageCommand();
    let renderedTabs = [];
    for (const tab of allTabs) {
        if (tab.id &&
            !tab.url?.startsWith('about://') &&
            !tab.url?.startsWith('chrome://') &&
            !(await (0,_shared_host_meta_is_disabled__WEBPACK_IMPORTED_MODULE_8__.isDisabled)(tab.url))) {
            renderedTabs.push(tab);
        }
    }
    if (showCurrentOnTop) {
        renderedTabs = renderedTabs.sort((a, b) => {
            if (a.active) {
                return -1;
            }
            if (b.active) {
                return 1;
            }
            return 0;
        });
    }
    for (const tab of renderedTabs) {
        (0,_shared_dom_append_element__WEBPACK_IMPORTED_MODULE_1__.appendElement)('.pages', {
            tag: 'a',
            class: ['outline'],
            handler: () => parsePage.send(tab.id, () => window.close()),
            innerText: `Parse "${tab.title ?? 'Untitled'}"`,
        });
    }
});

})();

/******/ })()
;