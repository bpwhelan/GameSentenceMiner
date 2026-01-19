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
/* 81 */,
/* 82 */,
/* 83 */,
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
/* 85 */,
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
/* 101 */,
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
/* 106 */,
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
/* 120 */,
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
/* 122 */,
/* 123 */,
/* 124 */,
/* 125 */,
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
/* 139 */,
/* 140 */,
/* 141 */,
/* 142 */,
/* 143 */,
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


/***/ }),
/* 147 */,
/* 148 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ping: () => (/* binding */ ping)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);

const ping = async (options) => {
    await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('reader/ping', undefined, options);
    return true;
};


/***/ }),
/* 149 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLFeaturesInputElement: () => (/* binding */ HTMLFeaturesInputElement)
/* harmony export */ });
/* harmony import */ var _shared_features_features__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(84);
/* harmony import */ var _lib_checkbox_list_input__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(150);


class HTMLFeaturesInputElement extends _lib_checkbox_list_input__WEBPACK_IMPORTED_MODULE_1__.CheckboxListInput {
    constructor() {
        super(...arguments);
        this.allowInspect = false;
        this.invertList = false;
    }
    getRows() {
        return _shared_features_features__WEBPACK_IMPORTED_MODULE_0__.FEATURES;
    }
}


/***/ }),
/* 150 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CheckboxListInput: () => (/* binding */ CheckboxListInput)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(31);
/* harmony import */ var _shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(34);


const observedAttributes = ['value', 'name'];
class CheckboxListInput extends HTMLElement {
    constructor() {
        super(...arguments);
        this._checkboxes = {};
    }
    get value() {
        return JSON.parse(this.getAttribute('value'));
    }
    set value(value) {
        this.setAttribute('value', JSON.stringify(value));
    }
    get name() {
        return this.getAttribute('name');
    }
    set name(value) {
        this.setAttribute('name', value);
    }
    connectedCallback() {
        this.buildInput();
        this.renderList();
    }
    attributeChangedCallback(name, oldValue, newValue) {
        const pascalCaseName = name.replace(/(^\w|-\w)/g, (a) => a.replace(/-/, '').toUpperCase());
        const functionName = `on${pascalCaseName}Changed`;
        const changeHandler = this[functionName];
        if (changeHandler) {
            changeHandler.apply(this, [oldValue, newValue]);
        }
    }
    onValueChanged(_, newValue) {
        if (this._input && this._input.value !== newValue) {
            this._input.value = newValue;
            this.updateCheckboxes();
            this.dispatchEvent(new Event('change'));
        }
    }
    buildInput() {
        this._input = document.createElement('input');
        this._input.type = 'hidden';
        this._input.name = this.name;
        this._input.addEventListener('change', () => {
            this.value = JSON.parse(this._input.value);
            this.dispatchEvent(new Event('change'));
        });
        this.appendChild(this._input);
    }
    renderList() {
        const items = this.getRows();
        if (items.length === 0) {
            this.innerHTML = '<p>No items available.</p>';
            return;
        }
        if (items.length === 1) {
            this.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
                class: 'checkbox',
                children: [
                    this.createCheckbox(items[0].id),
                    {
                        tag: 'label',
                        attributes: {
                            for: items[0].id,
                        },
                        innerText: items[0].name,
                    },
                ],
            }));
            const description = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
                style: { opacity: '0.8' },
                innerText: items[0].description,
            });
            description.setAttribute('indent', '');
            this.appendChild(description);
            return;
        }
        const tableHost = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            class: 'table-box',
        });
        this.appendChild(tableHost);
        for (const item of items) {
            const row = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', { class: 'row' });
            const checkboxTD = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', { class: 'col', style: { marginRight: '1.5em' } });
            const checkbox = this.createCheckbox(item.id);
            checkboxTD.appendChild(checkbox);
            const name = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
                class: 'col',
                style: { width: '210px' },
                children: [
                    {
                        tag: 'label',
                        attributes: {
                            for: item.id,
                        },
                        innerText: item.name,
                    },
                ],
            });
            const description = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
                class: 'col',
                children: [
                    {
                        tag: 'label',
                        attributes: {
                            for: item.id,
                        },
                        innerText: item.description,
                    },
                ],
            });
            row.appendChild(checkboxTD);
            row.appendChild(name);
            row.appendChild(description);
            if (this.allowInspect) {
                const code = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
                    class: 'col',
                    style: { width: '20px', textAlign: 'right' },
                    children: [
                        {
                            tag: 'i',
                            class: ['fa', 'fa-code'],
                            style: { cursor: 'pointer' },
                            attributes: {
                                ariaHidden: 'true',
                            },
                            handler: () => {
                                this.showCodeOverlay(item);
                            },
                        },
                    ],
                });
                row.appendChild(code);
            }
            tableHost.appendChild(row);
        }
        this.updateCheckboxes();
    }
    createCheckbox(id) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = id;
        checkbox.id = id;
        checkbox.setAttribute('internal', 'true');
        checkbox.addEventListener('change', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (checkbox.checked) {
                this.enable(id);
            }
            else {
                this.disable(id);
            }
            this.dispatchEvent(new Event('change'));
        });
        this._checkboxes[id] = checkbox;
        return checkbox;
    }
    updateCheckboxes() {
        for (const checkbox of Object.values(this._checkboxes)) {
            const inList = (this.value ?? []).includes(checkbox.id);
            checkbox.checked = this.invertList ? !inList : inList;
        }
    }
    enable(id) {
        if (this.invertList) {
            this.removeFromList(id);
        }
        else {
            this.addToList(id);
        }
    }
    disable(id) {
        if (this.invertList) {
            this.addToList(id);
        }
        else {
            this.removeFromList(id);
        }
    }
    addToList(id) {
        this.value = [...new Set([...this.value, id])];
    }
    removeFromList(id) {
        this.value = this.value.filter((value) => value !== id);
    }
    showCodeOverlay(host) {
        const backdrop = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            class: 'backdrop',
            attributes: {
                role: 'dialog',
                'aria-modal': 'true',
                'aria-labelledby': host.id,
                'aria-describedby': host.id,
            },
            handler: () => {
                this.hideCodeOverlay();
            },
        });
        this.appendChild(backdrop);
        const overlay = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            class: 'overlay',
            children: [
                {
                    tag: 'h3',
                    innerText: host.name,
                },
                {
                    tag: 'pre',
                    innerText: JSON.stringify(host, null, 2),
                },
            ],
        });
        this.appendChild(overlay);
    }
    hideCodeOverlay() {
        (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__.findElement)(this, '.backdrop')?.remove();
        (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__.findElement)(this, '.overlay')?.remove();
    }
}
CheckboxListInput.observedAttributes = observedAttributes;


/***/ }),
/* 151 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLKeybindInputElement: () => (/* binding */ HTMLKeybindInputElement)
/* harmony export */ });
const observedAttributes = ['value', 'name'];
class HTMLKeybindInputElement extends HTMLElement {
    constructor() {
        super(...arguments);
        this._buttons = [];
    }
    get value() {
        return JSON.parse(this.getAttribute('value'));
    }
    set value(value) {
        this.setAttribute('value', JSON.stringify(value));
    }
    get name() {
        return this.getAttribute('name');
    }
    set name(value) {
        this.setAttribute('name', value);
    }
    get arrayValue() {
        if (Array.isArray(this.value)) {
            return this.value.filter((keybind) => keybind?.code?.length);
        }
        return this.value?.code?.length ? [this.value] : [];
    }
    connectedCallback() {
        this.buildInput();
        this.buildButtons();
    }
    attributeChangedCallback(name, oldValue, newValue) {
        const pascalCaseName = name.replace(/(^\w|-\w)/g, (a) => a.replace(/-/, '').toUpperCase());
        const functionName = `on${pascalCaseName}Changed`;
        const changeHandler = this[functionName];
        if (changeHandler) {
            changeHandler.apply(this, [oldValue, newValue]);
        }
    }
    onValueChanged(_, newValue) {
        if (this._input && this._input.value !== newValue) {
            this._input.value = newValue;
            if (!HTMLKeybindInputElement.active) {
                this.updateButtonValues();
            }
            this.dispatchEvent(new Event('change'));
        }
    }
    buildInput() {
        this._input = document.createElement('input');
        this._input.type = 'hidden';
        this._input.name = this.name;
        this._input.addEventListener('change', () => {
            this.value = JSON.parse(this._input.value);
            this.dispatchEvent(new Event('change'));
        });
        this.appendChild(this._input);
    }
    buildButtons() {
        const buildButton = (index) => {
            const button = document.createElement('input');
            button.type = 'button';
            button.classList.add('outline');
            button.addEventListener('mousedown', (event) => this.initChooseKey(event, index));
            this._buttons.push(button);
            this.appendChild(button);
        };
        buildButton(0);
        buildButton(1);
    }
    keybindToString(keybind) {
        const { key = '', code = '', modifiers = '' } = keybind ?? {};
        return !key.length && !code.length ? 'None' : `${key} (${[...modifiers, code].join('+')})`;
    }
    updateButtonValues() {
        this._buttons.forEach((button, index) => {
            button.value = this.keybindToString(this.arrayValue[index]);
        });
    }
    initChooseKey(event, index) {
        event.preventDefault();
        event.stopPropagation();
        if (event.button !== 0) {
            return;
        }
        if (HTMLKeybindInputElement.active) {
            if (HTMLKeybindInputElement.active !== this) {
                HTMLKeybindInputElement.active.deactivate();
                return this.activate(event, index);
            }
            return;
        }
        this.activate(event, index);
    }
    activate(event, index) {
        event.target.value = 'Press a key, escape to cancel';
        HTMLKeybindInputElement.EVENTS.forEach((event) => document.addEventListener(event, HTMLKeybindInputElement.keyListener));
        HTMLKeybindInputElement.active = this;
        HTMLKeybindInputElement.index = index;
    }
    deactivate() {
        this.updateButtonValues();
        HTMLKeybindInputElement.EVENTS.forEach((event) => document.removeEventListener(event, HTMLKeybindInputElement.keyListener));
        HTMLKeybindInputElement.active = undefined;
        HTMLKeybindInputElement.index = undefined;
    }
    static keyListener(event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (event instanceof KeyboardEvent &&
            event.type === 'keydown' &&
            HTMLKeybindInputElement.MODIFIERS.includes(event.key)) {
            return;
        }
        const code = event instanceof KeyboardEvent ? event.code : `Mouse${event.button}`;
        const key = event instanceof KeyboardEvent
            ? event.key
            : (HTMLKeybindInputElement.MOUSE_BUTTONS[event.button] ?? code);
        const modifiers = HTMLKeybindInputElement.MODIFIERS.filter((name) => name !== key && event.getModifierState(name));
        if (!modifiers.length && code === 'Mouse0') {
            return;
        }
        if (code === 'Mouse2') {
            return;
        }
        const active = HTMLKeybindInputElement.active;
        const index = HTMLKeybindInputElement.index;
        const arrayValue = active.arrayValue;
        const value = code === 'Escape'
            ? {
                key: '',
                code: '',
                modifiers: [],
            }
            : { key, code, modifiers };
        arrayValue[index] = value;
        active.value = arrayValue;
        active.deactivate();
    }
}
HTMLKeybindInputElement.observedAttributes = observedAttributes;
HTMLKeybindInputElement.EVENTS = ['keydown', 'keyup', 'mousedown', 'mouseup'];
HTMLKeybindInputElement.MODIFIERS = ['Control', 'Alt', 'AltGraph', 'Meta', 'Shift'];
HTMLKeybindInputElement.MOUSE_BUTTONS = [
    'Left Mouse Button',
    'Middle Mouse Button',
    'Right Mouse Button',
];


/***/ }),
/* 152 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLMiningInputElement: () => (/* binding */ HTMLMiningInputElement)
/* harmony export */ });
/* harmony import */ var _shared_anki_get_decks__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(153);
/* harmony import */ var _shared_anki_get_fields__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(155);
/* harmony import */ var _shared_anki_get_models__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(156);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(31);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(29);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(30);






const observedAttributes = ['value', 'name', 'fetch-url', 'title'];
const TemplateTargetTranslations = {
    empty: '[Empty]',
    spelling: 'Word',
    reading: 'Word with Reading',
    hiragana: 'Word in Hiragana',
    meaning: 'Definition',
    sentence: 'Sentence',
    sentenceSanitized: 'Sanitized Sentence',
    isKanji: 'Is Kanji?',
    frequency: 'Frequecy',
    frequencyStylized: 'Frequency Stylized',
    'sound:silence': '[sound:_silence.wav]',
};
class HTMLMiningInputElement extends HTMLElement {
    get _availableFields() {
        return this._fields.filter((field) => !this._fieldSelects.some((select) => select.value === field) &&
            !this._templateTargets.some((target) => target.field === field));
    }
    get value() {
        return JSON.parse(this.getAttribute('value') ?? '{}');
    }
    set value(value) {
        this.setAttribute('value', JSON.stringify(value));
    }
    get name() {
        return this.getAttribute('name');
    }
    set name(value) {
        this.setAttribute('name', value);
    }
    set fetchUrl(value) {
        this.setAttribute('fetch-url', value);
    }
    set title(value) {
        this.setAttribute('title', value);
    }
    constructor() {
        super();
        this._decks = [];
        this._models = [];
        this._fields = [];
        this._templateContainer = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', { id: 'template-list' });
        this._selects = {
            deckInput: (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('select'),
            modelInput: (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('select'),
            wordInput: (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('select'),
            readingInput: (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('select'),
        };
        this._fieldSelects = [this._selects.wordInput, this._selects.readingInput];
        this._proxyInput = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('input', {
            attributes: {
                type: 'checkbox',
            },
        });
        this._templateTargets = [];
    }
    connectedCallback() {
        this._shadow = this.attachShadow({ mode: 'open' });
        this.installStyles();
        this.buildInputElements();
        this.registerSelectElementListeners();
        this.buildDOM();
    }
    attributeChangedCallback(name, oldValue, newValue) {
        const pascalCaseName = name.replace(/(^\w|-\w)/g, (a) => a.replace(/-/, '').toUpperCase());
        const functionName = `on${pascalCaseName}Changed`;
        const changeHandler = this[functionName];
        if (changeHandler) {
            changeHandler.apply(this, [oldValue, newValue]);
        }
    }
    installStyles() {
        this._shadow.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('link', {
            attributes: {
                rel: 'stylesheet',
                href: (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_5__.getStyleUrl)('html-mining-input'),
            },
        }));
    }
    registerSelectElementListeners() {
        Object.values(this._selects).forEach((select) => {
            select.addEventListener('change', () => {
                this.packDeck();
            });
        });
        this._selects.modelInput.addEventListener('change', () => {
            void this.updateFields(this.getAttribute('fetch-url'), this.value.model).then(() => this.validateTemplatesThenPackDeck());
        });
    }
    buildInputElements() {
        this._input = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('input', {
            attributes: {
                type: 'hidden',
                name: this.name,
            },
        });
        this._input.addEventListener('change', () => {
            this.value = JSON.parse(this._input.value);
            this.dispatchEvent(new Event('change'));
        });
        this._proxyInput.addEventListener('change', () => this.packDeck());
    }
    buildDOM() {
        this._shadow.appendChild(this._input);
        const container = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            class: ['mining-input'],
            children: [
                this.buildHeaderBlock(),
                {
                    tag: 'div',
                    class: ['form-box-parent'],
                    children: [
                        this.buildColumn([
                            this.buildSelectBlock('Deck', this._selects.deckInput),
                            this.buildSelectBlock('Word Field', this._selects.wordInput),
                        ]),
                        this.buildColumn([
                            this.buildSelectBlock('Model', this._selects.modelInput),
                            this.buildSelectBlock('Reading Field', this._selects.readingInput),
                        ]),
                    ],
                },
                this.buildTemplateBlock(),
            ],
        });
        this._shadow.appendChild(this.buildAccordionBlock(container));
    }
    buildAccordionBlock(contents) {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('details', {
            class: ['accordion'],
            children: [{ tag: 'summary', innerText: this.getAttribute('title') }, contents],
        });
    }
    buildHeaderBlock() {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            style: {
                display: 'flex',
                justifyContent: 'space-between',
                gap: '2em',
            },
            children: [
                { tag: 'p', style: { flex: '1', opacity: '0.8' }, children: [{ tag: 'slot' }] },
                this.buildProxyBlock(),
            ],
        });
    }
    buildColumn(inputs) {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            class: ['form-box'],
            children: inputs
                .map((input) => [input, (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', { style: { height: '1em' } })])
                .flat(),
        });
    }
    buildSelectBlock(label, input) {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            children: [
                {
                    tag: 'label',
                    attributes: { for: input.id },
                    innerText: label,
                },
                { tag: 'div', class: ['select'], children: [input] },
            ],
        });
    }
    buildProxyBlock() {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            style: { flex: '1' },
            children: [
                {
                    tag: 'div',
                    class: ['checkbox'],
                    children: [
                        this._proxyInput,
                        {
                            tag: 'label',
                            attributes: { for: this._proxyInput.id },
                            innerText: 'Use proxy for mining into this deck',
                        },
                    ],
                },
            ],
        });
    }
    buildTemplateBlock() {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            children: [
                { tag: 'p', innerText: 'Template Fields' },
                this._templateContainer,
                this.buildTemplateList(),
                this.buildTemplateControls(),
            ],
        });
    }
    buildTemplateList() {
        if (!this.value) {
            return this._templateContainer;
        }
        const childs = this._templateTargets.map((target, index) => {
            const fieldSelect = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('select', {
                attributes: { name: 'field' },
                children: [...new Set(['', ...this._availableFields, target.field])].map((field) => {
                    return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('option', {
                        innerText: field,
                        attributes: { value: field },
                    });
                }),
            });
            const templateSelect = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('select', {
                attributes: { name: 'template' },
                children: Object.keys(TemplateTargetTranslations).map((template) => {
                    return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('option', {
                        innerText: TemplateTargetTranslations[template],
                        attributes: { value: template },
                    });
                }),
            });
            [fieldSelect, templateSelect].forEach((select) => {
                select.value = target[select.name];
                select.addEventListener('change', () => {
                    target[select.name] = select.value;
                    this.validateTemplatesThenPackDeck();
                });
            });
            const removeButton = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('input', {
                class: ['outline', 'v1'],
                attributes: { type: 'button', value: '-' },
                handler: () => {
                    this._templateTargets.splice(index, 1);
                    this.validateTemplatesThenPackDeck();
                    this.buildTemplateList();
                },
            });
            return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
                children: [fieldSelect, templateSelect, removeButton],
            });
        });
        this._templateContainer.replaceChildren(...childs);
        return this._templateContainer;
    }
    buildTemplateControls() {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            class: ['controls-list'],
            children: [
                {
                    tag: 'input',
                    class: 'outline',
                    attributes: { type: 'button', value: 'Add' },
                    handler: () => this.addTemplate(),
                },
                {
                    tag: 'input',
                    class: ['outline', 'v1'],
                    attributes: { type: 'button', value: 'Clear' },
                    handler: () => this.clearTemplates(),
                },
                {
                    tag: 'input',
                    class: ['outline', 'v3'],
                    attributes: { type: 'button', value: 'Copy' },
                    handler: () => this.copyTemplate(),
                },
                {
                    tag: 'input',
                    class: ['outline', 'v4'],
                    attributes: { type: 'button', value: 'Paste' },
                    handler: () => this.pasteTemplate(),
                },
            ],
        });
    }
    addTemplate() {
        const newTemplate = { template: 'empty', field: '' };
        this._templateTargets.push(newTemplate);
        this.buildTemplateList();
    }
    clearTemplates() {
        this._templateTargets = [];
        this.buildTemplateList();
        this.packDeck();
    }
    copyTemplate() {
        HTMLMiningInputElement.copiedDeckConfiguration = {
            model: this._selects.modelInput.value,
            templateTargets: this._templateTargets,
        };
        (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('success', 'Template copied');
    }
    pasteTemplate() {
        if (!HTMLMiningInputElement.copiedDeckConfiguration?.model?.length) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('error', 'No template copied');
            return;
        }
        if (this._selects.modelInput.value !== HTMLMiningInputElement.copiedDeckConfiguration.model) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('error', 'Models do not match');
            return;
        }
        if (HTMLMiningInputElement.copiedDeckConfiguration) {
            this._templateTargets = HTMLMiningInputElement.copiedDeckConfiguration.templateTargets;
            this.buildTemplateList();
            this.packDeck();
        }
    }
    validateTemplatesThenPackDeck() {
        this._templateTargets = this._templateTargets.filter((target) => target.field && this._fields.includes(target.field) && target.template);
        this.buildTemplateList();
        this.packDeck();
    }
    onValueChanged(_, newValue) {
        if (this._input && this._input.value !== newValue) {
            this._input.value = newValue;
            this.dispatchEvent(new Event('change'));
        }
    }
    async onFetchUrlChanged(_, ankiConnectUrl) {
        if (!ankiConnectUrl) {
            return;
        }
        await this.updateDecks(ankiConnectUrl);
        await this.updateModels(ankiConnectUrl);
        await this.updateFields(ankiConnectUrl, this.value.model);
        this.unpackDeck();
        this.packDeck();
    }
    async updateDecks(ankiConnectUrl) {
        this._decks = await (0,_shared_anki_get_decks__WEBPACK_IMPORTED_MODULE_0__.getDecks)({ ankiConnectUrl });
        this._decks.unshift('');
        this._selects.deckInput.replaceChildren(...this._decks.map((deck) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('option', { innerText: deck })));
    }
    async updateModels(ankiConnectUrl) {
        this._models = await (0,_shared_anki_get_models__WEBPACK_IMPORTED_MODULE_2__.getModels)({ ankiConnectUrl });
        this._selects.modelInput.replaceChildren(...this._models.map((model) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('option', { innerText: model })));
    }
    async updateFields(ankiConnectUrl, model) {
        this._fields = model ? await (0,_shared_anki_get_fields__WEBPACK_IMPORTED_MODULE_1__.getFields)(model, { ankiConnectUrl }) : [];
        ['wordInput', 'readingInput'].forEach((key) => {
            const select = this._selects[key];
            const includeEmpty = key === 'readingInput';
            const fields = [includeEmpty ? [''] : [], this._fields].flat();
            select.replaceChildren(...fields.map((field) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('option', { attributes: { value: field }, innerText: field })));
        });
    }
    packDeck() {
        this.value = {
            deck: this._selects.deckInput.value,
            model: this._selects.modelInput.value,
            wordField: this._selects.wordInput.value,
            readingField: this._selects.readingInput.value,
            proxy: this._proxyInput.checked,
            templateTargets: this._templateTargets,
        };
    }
    unpackDeck() {
        const propagate = (key, haystack, needle) => {
            this._selects[key].value = haystack.includes(needle) ? needle : '';
        };
        propagate('deckInput', this._decks, this.value.deck);
        propagate('modelInput', this._models, this.value.model);
        propagate('wordInput', this._fields, this.value.wordField);
        propagate('readingInput', this._fields, this.value.readingField);
        this._proxyInput.checked = this.value.proxy;
        this._templateTargets = this.value.templateTargets;
        this.buildTemplateList();
    }
}
HTMLMiningInputElement.observedAttributes = observedAttributes;


/***/ }),
/* 153 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getDecks: () => (/* binding */ getDecks)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(154);

const getDecks = (options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('deckNames', {}, options);


/***/ }),
/* 154 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   request: () => (/* binding */ request)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _dom_display_toast__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(29);


const request = async (action, params, options) => {
    const ankiUrl = options?.ankiConnectUrl || (await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('ankiUrl'));
    if (!ankiUrl?.length) {
        (0,_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('error', 'Anki URL is not set');
        throw new Error('Anki URL is not set');
    }
    const usedUrl = new URL(ankiUrl.replace(/127\.0\.0\.1/, 'http://localhost'));
    const response = await fetch(usedUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            action,
            version: 6,
            params,
        }),
    });
    const responseObject = (await response.json());
    if ('error' in responseObject && responseObject.error !== null) {
        throw new Error(responseObject.error);
    }
    return responseObject.result;
};


/***/ }),
/* 155 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getFields: () => (/* binding */ getFields)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(154);

const getFields = (modelName, options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('modelFieldNames', { modelName }, options);


/***/ }),
/* 156 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getModels: () => (/* binding */ getModels)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(154);

const getModels = (options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('modelNames', {}, options);


/***/ }),
/* 157 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLNewStateInputElement: () => (/* binding */ HTMLNewStateInputElement)
/* harmony export */ });
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(4);
/* harmony import */ var _lib_checkbox_list_input__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(150);


const LABELED_CARD_STATES = [
    {
        id: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.NEW,
        name: 'New',
        description: 'Card has never been reviewed or is in the initial learning phase.',
    },
    {
        id: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.YOUNG,
        name: 'Young',
        description: 'Card has been reviewed but has not yet reached maturity.',
    },
    {
        id: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.MATURE,
        name: 'Mature',
        description: 'Card has been reviewed enough times to be considered well-known.',
    },
    {
        id: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.DUE,
        name: 'Due',
        description: "Card's review interval has lapsed and it's ready for another review.",
    },
];
class HTMLNewStateInputElement extends _lib_checkbox_list_input__WEBPACK_IMPORTED_MODULE_1__.CheckboxListInput {
    constructor() {
        super(...arguments);
        this.allowInspect = false;
        this.invertList = false;
    }
    getRows() {
        return LABELED_CARD_STATES;
    }
}


/***/ }),
/* 158 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLParsersInputElement: () => (/* binding */ HTMLParsersInputElement)
/* harmony export */ });
/* harmony import */ var _shared_host_meta_default_hosts__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(102);
/* harmony import */ var _lib_checkbox_list_input__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(150);


class HTMLParsersInputElement extends _lib_checkbox_list_input__WEBPACK_IMPORTED_MODULE_1__.CheckboxListInput {
    constructor() {
        super(...arguments);
        this.allowInspect = true;
        this.invertList = true;
    }
    getRows() {
        return _shared_host_meta_default_hosts__WEBPACK_IMPORTED_MODULE_0__.DEFAULT_HOSTS.filter((host) => host.optOut);
    }
}


/***/ }),
/* 159 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLProfileManagerElement: () => (/* binding */ HTMLProfileManagerElement)
/* harmony export */ });
/* harmony import */ var _shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(145);
/* harmony import */ var _shared_configuration_profile_types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(7);
/* harmony import */ var _shared_configuration_profiles_state__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(6);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(31);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(29);





class HTMLProfileManagerElement extends HTMLElement {
    constructor() {
        super(...arguments);
        this._profiles = [];
        this._activeProfileId = '';
    }
    async connectedCallback() {
        await this.loadProfiles();
        this.render();
    }
    async loadProfiles() {
        const state = await (0,_shared_configuration_profiles_state__WEBPACK_IMPORTED_MODULE_2__.getProfilesState)();
        this._profiles = state.profiles;
        this._activeProfileId = state.activeProfileId;
    }
    render() {
        this.innerHTML = '';
        this._limitWarning = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            class: 'limit-warning',
            style: { display: 'none', color: '#ff9800', marginBottom: '1em' },
            innerText: `Maximum of ${_shared_configuration_profile_types__WEBPACK_IMPORTED_MODULE_1__.MAX_PROFILES} profiles reached. Delete a profile to create a new one.`,
        });
        this.appendChild(this._limitWarning);
        this._tableHost = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', { class: 'table-box' });
        this.appendChild(this._tableHost);
        this.renderProfileRows();
        this._createButton = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('button', {
            class: ['outline', 'create-profile-btn'],
            innerText: '+ Create New Profile',
            handler: () => this.showCreateDialog(),
        });
        this.appendChild(this._createButton);
        this.updateLimitWarning();
    }
    renderProfileRows() {
        this._tableHost.innerHTML = '';
        const headerRow = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', { class: ['row', 'header'] });
        headerRow.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            class: 'col',
            innerText: 'Profile',
            style: { fontWeight: 'bold', flex: '1' },
        }));
        headerRow.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
            class: 'col',
            innerText: 'Actions',
            style: { fontWeight: 'bold', width: '200px' },
        }));
        this._tableHost.appendChild(headerRow);
        for (const profile of this._profiles) {
            const isActive = profile.id === this._activeProfileId;
            const canDelete = this._profiles.length > 1 && !isActive;
            const row = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', { class: ['row', isActive ? 'active-profile' : ''] });
            const nameCol = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
                class: 'col',
                style: { flex: '1', display: 'flex', alignItems: 'center', gap: '0.5em' },
            });
            nameCol.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('span', { innerText: profile.name }));
            if (isActive) {
                nameCol.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('span', {
                    class: 'active-badge',
                    innerText: '(active)',
                    style: { opacity: '0.6' },
                }));
            }
            row.appendChild(nameCol);
            const actionsCol = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('div', {
                class: 'col',
                style: { width: '200px', display: 'flex', gap: '0.5em' },
            });
            actionsCol.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('button', {
                class: 'outline',
                innerText: 'Rename',
                handler: () => this.showRenameDialog(profile),
            }));
            actionsCol.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('button', {
                class: 'outline',
                innerText: 'Duplicate',
                handler: () => this.handleDuplicate(profile),
            }));
            if (canDelete) {
                actionsCol.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('button', {
                    class: ['outline', 'v1'],
                    innerText: 'Delete',
                    handler: () => this.showDeleteDialog(profile),
                }));
            }
            row.appendChild(actionsCol);
            this._tableHost.appendChild(row);
        }
    }
    updateLimitWarning() {
        const atLimit = this._profiles.length >= _shared_configuration_profile_types__WEBPACK_IMPORTED_MODULE_1__.MAX_PROFILES;
        this._limitWarning.style.display = atLimit ? 'block' : 'none';
        this._createButton.disabled = atLimit;
    }
    showCreateDialog() {
        const name = prompt('Enter profile name:');
        if (name?.trim()) {
            void this.handleCreate(name.trim());
        }
    }
    async handleCreate(name) {
        const newProfile = await (0,_shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__.createProfile)(name);
        if (newProfile) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('success', `Profile "${name}" created`);
            await this.refresh();
        }
        else {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('error', 'Failed to create profile');
        }
    }
    showRenameDialog(profile) {
        const newName = prompt('Enter new profile name:', profile.name);
        if (newName?.trim() && newName.trim() !== profile.name) {
            void this.handleRename(profile.id, newName.trim());
        }
    }
    async handleRename(profileId, newName) {
        const success = await (0,_shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__.renameProfile)(profileId, newName);
        if (success) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('success', `Profile renamed to "${newName}"`);
            await this.refresh();
        }
        else {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('error', 'Failed to rename profile');
        }
    }
    async handleDuplicate(profile) {
        if (this._profiles.length >= _shared_configuration_profile_types__WEBPACK_IMPORTED_MODULE_1__.MAX_PROFILES) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('error', `Maximum of ${_shared_configuration_profile_types__WEBPACK_IMPORTED_MODULE_1__.MAX_PROFILES} profiles reached`);
            return;
        }
        const newProfile = await (0,_shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__.duplicateProfile)(profile.id);
        if (newProfile) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('success', `Profile "${newProfile.name}" created`);
            await this.refresh();
        }
        else {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('error', 'Failed to duplicate profile');
        }
    }
    showDeleteDialog(profile) {
        const confirmed = confirm(`Are you sure you want to delete profile "${profile.name}"?\n\nThis action cannot be undone.`);
        if (confirmed) {
            void this.handleDelete(profile);
        }
    }
    async handleDelete(profile) {
        const success = await (0,_shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__.deleteProfile)(profile.id);
        if (success) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('success', `Profile "${profile.name}" deleted`);
            await this.refresh();
        }
        else {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('error', 'Failed to delete profile');
        }
    }
    async refresh() {
        await this.loadProfiles();
        this.renderProfileRows();
        this.updateLimitWarning();
    }
    async switchToProfile(profileId) {
        const success = await (0,_shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__.switchProfile)(profileId);
        if (success) {
            this._activeProfileId = profileId;
            this.renderProfileRows();
        }
        return success;
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
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(9);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(31);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(29);
/* harmony import */ var _shared_dom_find_element__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(34);
/* harmony import */ var _shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(121);
/* harmony import */ var _shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(118);
/* harmony import */ var _shared_jiten_ping__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(148);
/* harmony import */ var _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(138);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(17);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(72);
/* harmony import */ var _elements_html_features_input_element__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(149);
/* harmony import */ var _elements_html_keybind_input_element__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(151);
/* harmony import */ var _elements_html_mining_input_element__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(152);
/* harmony import */ var _elements_html_new_state_input_element__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(157);
/* harmony import */ var _elements_html_parsers_input_element__WEBPACK_IMPORTED_MODULE_15__ = __webpack_require__(158);
/* harmony import */ var _elements_html_profile_manager_element__WEBPACK_IMPORTED_MODULE_16__ = __webpack_require__(159);
/* harmony import */ var _elements_html_profile_selector_element__WEBPACK_IMPORTED_MODULE_17__ = __webpack_require__(144);


















customElements.define('mining-input', _elements_html_mining_input_element__WEBPACK_IMPORTED_MODULE_13__.HTMLMiningInputElement);
customElements.define('profile-selector', _elements_html_profile_selector_element__WEBPACK_IMPORTED_MODULE_17__.HTMLProfileSelectorElement);
customElements.define('keybind-input', _elements_html_keybind_input_element__WEBPACK_IMPORTED_MODULE_12__.HTMLKeybindInputElement);
customElements.define('parsers-input', _elements_html_parsers_input_element__WEBPACK_IMPORTED_MODULE_15__.HTMLParsersInputElement);
customElements.define('features-input', _elements_html_features_input_element__WEBPACK_IMPORTED_MODULE_11__.HTMLFeaturesInputElement);
customElements.define('new-state-input', _elements_html_new_state_input_element__WEBPACK_IMPORTED_MODULE_14__.HTMLNewStateInputElement);
customElements.define('profile-manager', _elements_html_profile_manager_element__WEBPACK_IMPORTED_MODULE_16__.HTMLProfileManagerElement);
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)('#currentProfile', (selector) => {
    selector.addEventListener('profilechange', () => {
        window.location.reload();
    });
});
const localConfiguration = new Map();
const bindings = new Map();
const validators = {
    jitenApiKey: validateJitenApiKey,
};
const configurationUpdatedCommand = new _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_8__.ConfigurationUpdatedCommand();
const getThemeStyleEl = () => {
    let styleEl = document.getElementById('jiten-theme-vars');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'jiten-theme-vars';
        document.head.appendChild(styleEl);
    }
    return styleEl;
};
const applyThemeVars = async () => {
    getThemeStyleEl().textContent = await (0,_shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_10__.getThemeCssVars)();
};
const applyThemeVarsFromInputs = () => {
    const bg = document.getElementById('themeBgColour')?.value || '#181818';
    const accent = document.getElementById('themeAccentColour')?.value || '#D8B9FA';
    getThemeStyleEl().textContent = `:root, :host { --jiten-bg: ${bg}; --jiten-accent: ${accent}; }`;
};
void applyThemeVars();
(0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_9__.onBroadcastMessage)('configurationUpdated', () => void applyThemeVars());
const setupColourPicker = (colourId, textId) => {
    const colourInput = document.getElementById(colourId);
    const textInput = document.getElementById(textId);
    if (!colourInput || !textInput)
        return;
    let debounceTimer = null;
    const saveAndApply = (value) => {
        if (debounceTimer)
            clearTimeout(debounceTimer);
        applyThemeVarsFromInputs();
        debounceTimer = setTimeout(async () => {
            await (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.setConfiguration)(colourId, value);
            configurationUpdatedCommand.send();
        }, 150);
    };
    const syncTextFromColour = () => {
        textInput.value = colourInput.value.toUpperCase();
    };
    setTimeout(syncTextFromColour, 50);
    textInput.addEventListener('input', () => {
        const value = textInput.value.trim();
        if (/^#[0-9A-Fa-f]{6}$/i.test(value)) {
            colourInput.value = value;
            saveAndApply(value);
        }
    });
    colourInput.addEventListener('input', () => {
        textInput.value = colourInput.value.toUpperCase();
        saveAndApply(colourInput.value);
    });
};
setupColourPicker('themeBgColour', 'themeBgColourText');
setupColourPicker('themeAccentColour', 'themeAccentColourText');
(0,_shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_6__.withElements)('input, textarea, select, keybind-input, parsers-input, features-input, new-state-input', (field) => {
    const internal = field.hasAttribute('internal');
    const ignored = ['hidden', 'submit', 'button'];
    const checkbox = field.type === 'checkbox';
    if (internal || ignored.includes(field.type)) {
        return;
    }
    void (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)(field.name)
        .then((value) => {
        if (checkbox) {
            field.checked = value;
        }
        else {
            field.value = value;
        }
        return validateAndSet(field.name, value);
    })
        .then(() => {
        field.onchange = () => {
            const value = checkbox ? field.checked : field.value;
            void validateAndSet(field.name, value, async () => {
                await (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.setConfiguration)(field.name, value);
                configurationUpdatedCommand.send();
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast)('success', 'Settings saved successfully', undefined, true);
            });
        };
    });
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)('#apiTokenButton', (button) => {
    button.onclick = () => {
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)('#jitenApiKey', (i) => {
            void validateJitenApiKey(i.value);
        });
    };
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)('#export-settings', (button) => {
    button.onclick = (event) => {
        event.stopPropagation();
        event.preventDefault();
        const downloadTitleWithDate = `configuration-${new Date().toISOString().slice(0, 10)}.json`;
        void chrome.storage.local.get().then((configuration) => {
            const includeApiKey = document.getElementById('exportApiKey')?.checked;
            if (!includeApiKey) {
                Object.keys(configuration).forEach((key) => {
                    if (key.includes('jitenApiKey')) {
                        delete configuration[key];
                    }
                });
            }
            const blob = new Blob([JSON.stringify(configuration, null, 2)], {
                type: 'application/json',
            });
            const url = URL.createObjectURL(blob);
            const a = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
                attributes: { href: url, download: downloadTitleWithDate },
            });
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    };
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)('#import-settings', (button) => {
    button.onclick = (event) => {
        event.stopPropagation();
        event.preventDefault();
        const fileInput = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('input', {
            attributes: { type: 'file', accept: '.json' },
        });
        fileInput.onchange = async () => {
            if (!fileInput.files?.length) {
                return;
            }
            const file = fileInput.files[0];
            const text = await file.text();
            let data;
            try {
                data = JSON.parse(text);
            }
            catch {
                alert('Failed to import settings: invalid JSON file');
                return;
            }
            await chrome.storage.local.clear();
            await chrome.storage.local.set(data);
            configurationUpdatedCommand.send();
            window.location.reload();
        };
        fileInput.click();
    };
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)('#exportApiKey', (checkbox) => {
    checkbox.addEventListener('change', () => {
        const warning = document.getElementById('exportApiKeyWarning');
        if (warning) {
            warning.style.display = checkbox.checked ? 'block' : 'none';
        }
    });
});
function afterValueUpdated(key, value) {
    localConfiguration.set(key, value);
    updateBindings(key);
}
async function validateAndSet(key, value, afterValidate) {
    if (validators[key]) {
        const isValid = await validators[key](value);
        if (!isValid) {
            updateBindings(key);
            return;
        }
    }
    afterValueUpdated(key, value);
    await afterValidate?.();
}
(0,_shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_6__.withElements)('[data-show]', (element) => {
    const attributeValue = element.getAttribute('data-show');
    const fields = attributeValue
        ?.match(/(\w+)/g)
        ?.map((field) => field.trim())
        .filter(Boolean) ?? [];
    for (const f of fields) {
        if (!bindings.has(f)) {
            bindings.set(f, new Set());
        }
        bindings.get(f).add(element);
    }
});
function updateBindings(key) {
    const affected = bindings.get(key);
    if (!affected?.size) {
        return;
    }
    for (const current of affected) {
        const attributeValue = current.getAttribute('data-show');
        if (!attributeValue) {
            continue;
        }
        current.style.display = parseCondition(attributeValue) ? '' : 'none';
    }
}
function parseCondition(expr) {
    const tokens = expr
        .replace(/([()!])/g, ' $1 ')
        .replace(/&&/g, ' && ')
        .replace(/\|\|/g, ' || ')
        .split(/\s+/)
        .filter(Boolean);
    let pos = 0;
    function peek() {
        return tokens[pos];
    }
    function next() {
        return tokens[pos++];
    }
    function parsePrimary() {
        const token = peek();
        if (token === '(') {
            next();
            const value = parseOr();
            if (next() !== ')') {
                throw new Error('Expected )');
            }
            return value;
        }
        if (token === '!') {
            next();
            return !parsePrimary();
        }
        next();
        const value = localConfiguration.get(token);
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            return value?.length > 0;
        }
        return !!value;
    }
    function parseAnd() {
        let value = parsePrimary();
        while (peek() === '&&') {
            next();
            value = value && parsePrimary();
        }
        return value;
    }
    function parseOr() {
        let value = parseAnd();
        while (peek() === '||') {
            next();
            value = value || parseAnd();
        }
        return value;
    }
    if (!tokens.length) {
        return false;
    }
    try {
        const result = parseOr();
        if (pos !== tokens.length) {
            throw new Error('Unexpected token');
        }
        return result;
    }
    catch {
        return false;
    }
}
async function validateJitenApiKey(value) {
    let isValid = false;
    if (value?.length) {
        try {
            await (0,_shared_jiten_ping__WEBPACK_IMPORTED_MODULE_7__.ping)({ apiToken: value });
            isValid = true;
        }
        catch (_e) {
        }
    }
    const button = (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_4__.findElement)('#apiTokenButton');
    const input = (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_4__.findElement)('#jitenApiKey');
    button.classList.toggle('v1', !isValid);
    input.classList.toggle('v1', !isValid);
    return isValid;
}

})();

/******/ })()
;