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
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(7);
/* harmony import */ var _profiles_state__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(8);




// Fetch all configs which should be a number, boolean or object
// Use those to properly parse stored values
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
            // Catch broken persisted values and return the default value
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
/* harmony import */ var _reader_mode_themes__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(5);
/* harmony import */ var _word_style_themes__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(6);



const DEFAULT_CONFIGURATION = Object.freeze({
    schemaVersion: 1,
    //#region Theme
    themeBgColour: '#181818',
    themeAccentColour: '#D8B9FA',
    //#endregion
    //#region JPDB Integration
    jitenApiKey: '',
    jitenApiEndpoint: 'https://api.jiten.moe/api',
    //#endregion
    //#region Mining configuration
    jitenAddToForq: false,
    setSentences: true,
    jitenDisableReviews: false,
    jitenUseTwoGrades: false,
    // Review on-screen words / auto-fail on dwell
    massReviewNew: true,
    massReviewDue: true,
    massReviewYoung: false,
    massReviewMature: false,
    massReviewCooldownHours: 20,
    massReviewRequireConfirm: true,
    autoFailOnDwell: false,
    autoFailDwellDuration: 500,
    jitenMineToStudyDeck: false,
    jitenStudyDeckId: '',
    jitenAutoMineOnReview: false,
    // JPDB Flag settings
    jitenRotateFlags: false,
    jitenRotateCycle: false,
    jitenCycleNeverForget: true,
    jitenCycleBlacklist: true,
    jitenCycleSuspended: false,
    //#endregion
    //#region Parsing
    hideInactiveTabs: true,
    showCurrentOnTop: true,
    showParseButton: false,
    enabledFeatures: ['reader-mode'],
    disabledParsers: [],
    additionalHosts: '',
    additionalMeta: '[]',
    readerModeTheme: _reader_mode_themes__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_READER_THEME,
    readerModeFont: _reader_mode_themes__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_READER_FONT,
    readerModeFontSize: _reader_mode_themes__WEBPACK_IMPORTED_MODULE_1__.READER_FONT_SIZE.default,
    readerModeBold: _reader_mode_themes__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_READER_BOLD,
    readerModeWidth: _reader_mode_themes__WEBPACK_IMPORTED_MODULE_1__.READER_WIDTH.default,
    readerModeLineHeight: _reader_mode_themes__WEBPACK_IMPORTED_MODULE_1__.READER_LINE_HEIGHT.default,
    pdfReaderMode: 'faithful',
    //#endregion
    //#region Texthighlighting
    newStates: [_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState.NEW],
    markTopX: false,
    markAllTypes: false,
    markTopXCount: 10_000,
    markIPlus1: false,
    minSentenceLength: 3,
    iPlusOneMaxFrequency: false,
    iPlusOneMaxFrequencyCount: 15_000,
    skipFurigana: false,
    generatePitch: true,
    markWordsInDeck: false,
    wordStyleConfig: structuredClone(_word_style_themes__WEBPACK_IMPORTED_MODULE_2__.DEFAULT_WORD_STYLE_CONFIG),
    customWordCSS: '',
    //#endregion
    //#region Popup
    showPopupOnHover: false,
    renderCloseButton: true,
    closeButtonBottomLeft: false,
    touchscreenSupport: false,
    touchscreenDoubleTap: false,
    touchscreenLongPress: false,
    touchscreenLongPressDuration: 250,
    disableFadeAnimation: false,
    leftAlignPopupToWord: false,
    // Popup settings
    hideAfterAction: true,
    hidePopupAutomatically: true,
    hidePopupDelay: 500,
    showMiningActions: true,
    moveMiningActions: false,
    showDeckButton: true,
    showGradingActions: true,
    moveGradingActions: false,
    showRotateActions: false,
    moveRotateActions: false,
    showConjugations: true,
    showPitchDiagrams: true,
    showDeckMembership: true,
    disableHeadWordLink: false,
    ttsVoice: 'female',
    ttsAutoPlay: false,
    popupWidth: 350,
    popupHeight: 250,
    customPopupCSS: '',
    //#endregion
    //#region Keybinds
    // General keybinds
    parseKey: [{ key: 'P', code: 'KeyP', modifiers: ['Alt'] }],
    showPopupKey: [{ key: 'Shift', code: 'ShiftLeft', modifiers: [] }],
    showAdvancedDialogKey: [],
    lookupSelectionKey: [{ key: 'L', code: 'KeyL', modifiers: ['Alt'] }],
    readerModeKey: [{ key: 'H', code: 'KeyH', modifiers: ['Alt'] }],
    // Mining keybinds
    addToStudyDeckKey: [],
    addToMiningKey: [],
    addToBlacklistKey: [],
    addToNeverForgetKey: [],
    addToSuspendedKey: [],
    cycleMasterBlacklistKey: [],
    // Review keybinds
    jitenReviewNothing: [],
    jitenReviewSomething: [],
    jitenReviewHard: [],
    jitenReviewOkay: [],
    jitenReviewEasy: [],
    jitenReviewFail: [],
    jitenReviewPass: [],
    massReviewKey: [],
    // Rotation keybinds
    jitenRotateForward: [],
    jitenRotateBackward: [],
    //#endregion
    //#region Anki Integration (not implemented!)
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
    //#endregion
    //#region Status Bar
    statusBarEnabled: true,
    statusBarAutoHide: true,
    statusBarHideIcon: false,
    statusBarShowBadge: true,
    statusBarShowReviewButton: true,
    statusBarPosition: 'bottom',
    toggleStatusBarKey: [{ key: 'S', code: 'KeyS', modifiers: ['Alt'] }],
    //#endregion
    skipReleaseNotes: true,
    enableDebugMode: false,
});


/***/ }),
/* 4 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DECK_MEMBERSHIP_CLASSES: () => (/* binding */ DECK_MEMBERSHIP_CLASSES),
/* harmony export */   IN_ANY_DECK_CLASS: () => (/* binding */ IN_ANY_DECK_CLASS),
/* harmony export */   JitenCardState: () => (/* binding */ JitenCardState),
/* harmony export */   JitenRatingMap: () => (/* binding */ JitenRatingMap),
/* harmony export */   STUDY_DECK_CLASS: () => (/* binding */ STUDY_DECK_CLASS),
/* harmony export */   StudyDeckType: () => (/* binding */ StudyDeckType)
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
    // A form covered by a sibling form the user already has a card for (kanji parent or
    // script variant). Always accompanies exactly one tier state — NEW/YOUNG/MATURE/
    // MASTERED/BLACKLISTED, never DUE — and is not reviewable itself.
    JitenCardState["REDUNDANT"] = "redundant";
    // A parked card (manual suspend or leech auto-suspend). Keeps its tier — YOUNG/MATURE —
    // for stats, but is never DUE: a suspended card is not scheduled for review.
    JitenCardState["SUSPENDED"] = "suspended";
})(JitenCardState || (JitenCardState = {}));
// Mirrors the backend StudyDeckType enum.
var StudyDeckType;
(function (StudyDeckType) {
    StudyDeckType[StudyDeckType["MEDIA_DECK"] = 0] = "MEDIA_DECK";
    StudyDeckType[StudyDeckType["GLOBAL_DYNAMIC"] = 1] = "GLOBAL_DYNAMIC";
    StudyDeckType[StudyDeckType["STATIC_WORD_LIST"] = 2] = "STATIC_WORD_LIST";
})(StudyDeckType || (StudyDeckType = {}));
// CSS class applied to a word for each type of study deck it belongs to.
const STUDY_DECK_CLASS = {
    [StudyDeckType.MEDIA_DECK]: 'in-media-deck',
    [StudyDeckType.GLOBAL_DYNAMIC]: 'in-frequency-deck',
    [StudyDeckType.STATIC_WORD_LIST]: 'in-word-list',
};
// Generic class applied to any word in at least one study deck, regardless of type.
const IN_ANY_DECK_CLASS = 'in-any-deck';
const DECK_MEMBERSHIP_CLASSES = [...Object.values(STUDY_DECK_CLASS), IN_ANY_DECK_CLASS];


/***/ }),
/* 5 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DEFAULT_READER_BOLD: () => (/* binding */ DEFAULT_READER_BOLD),
/* harmony export */   DEFAULT_READER_FONT: () => (/* binding */ DEFAULT_READER_FONT),
/* harmony export */   DEFAULT_READER_THEME: () => (/* binding */ DEFAULT_READER_THEME),
/* harmony export */   READER_FONTS: () => (/* binding */ READER_FONTS),
/* harmony export */   READER_FONT_SIZE: () => (/* binding */ READER_FONT_SIZE),
/* harmony export */   READER_FONT_STACKS: () => (/* binding */ READER_FONT_STACKS),
/* harmony export */   READER_LINE_HEIGHT: () => (/* binding */ READER_LINE_HEIGHT),
/* harmony export */   READER_THEMES: () => (/* binding */ READER_THEMES),
/* harmony export */   READER_WIDTH: () => (/* binding */ READER_WIDTH),
/* harmony export */   resolveReaderFont: () => (/* binding */ resolveReaderFont)
/* harmony export */ });
const READER_THEMES = [
    { id: 'light', label: 'Light', bg: '#ffffff', fg: '#1a1a1a' },
    { id: 'sepia', label: 'Sepia', bg: '#f4ecd8', fg: '#5b4636' },
    { id: 'gray', label: 'Gray', bg: '#5c5c5c', fg: '#e8e8e8' },
    { id: 'dark', label: 'Dark', bg: '#1a1a1a', fg: '#dcdcdc' },
    { id: 'black', label: 'Black', bg: '#000000', fg: '#c8c8c8' },
    { id: 'solarized', label: 'Solarized', bg: '#002b36', fg: '#93a1a1' },
];
const DEFAULT_READER_THEME = 'dark';
const READER_FONTS = [
    { id: 'sans', label: 'Gothic' },
    { id: 'serif', label: 'Mincho' },
    { id: 'rounded', label: 'Rounded' },
];
const READER_FONT_STACKS = {
    sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, sans-serif",
    serif: "'Hiragino Mincho ProN', 'Yu Mincho', YuMincho, 'MS PMincho', serif",
    rounded: "'Hiragino Maru Gothic ProN', 'Hiragino Maru Gothic Pro', 'Yu Gothic UI', 'Segoe UI Rounded', 'Quicksand', sans-serif",
};
const DEFAULT_READER_FONT = 'sans';
// Resolves a stored font value to a CSS font-family. Built-in ids map to a curated stack; any
// other value is treated as an installed font family name (from the Local Font Access API).
const resolveReaderFont = (value) => {
    if (value in READER_FONT_STACKS) {
        return READER_FONT_STACKS[value];
    }
    return `"${value.replace(/["\\]/g, '')}", sans-serif`;
};
const READER_FONT_SIZE = { min: 14, max: 32, step: 1, default: 18 };
const READER_WIDTH = { min: 28, max: 64, step: 1, default: 42 };
const READER_LINE_HEIGHT = { min: 1.4, max: 2.4, step: 0.1, default: 1.9 };
const DEFAULT_READER_BOLD = false;


/***/ }),
/* 6 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DEFAULT_WORD_STYLE_CONFIG: () => (/* binding */ DEFAULT_WORD_STYLE_CONFIG),
/* harmony export */   PRESET_THEMES: () => (/* binding */ PRESET_THEMES)
/* harmony export */ });
const PRESETS = [
    [
        'default',
        {
            label: 'Default',
            config: {
                v: 1,
                theme: 'default',
                states: {
                    new: { effects: [{ type: 'text-colour', colour: '#a566ef' }] },
                    young: {
                        effects: [{ type: 'underline', colour: '#d08700', style: 'solid', thickness: 2 }],
                    },
                    mature: { effects: [] },
                    mastered: { effects: [] },
                    due: { effects: [{ type: 'text-colour', colour: '#ff4500' }] },
                    blacklisted: { effects: [{ type: 'opacity', value: 0.5, hoverOnly: false }] },
                    suspended: { effects: [{ type: 'opacity', value: 0.5, hoverOnly: false }] },
                    redundant: { effects: [{ type: 'background', colour: '#4b9fff', opacity: 0.14 }] },
                    frequent: {
                        effects: [{ type: 'underline', colour: '#4b8d7f', style: 'dotted', thickness: 2 }],
                    },
                    'i-plus-one': {
                        effects: [
                            { type: 'shadow', colour: '#359eff', blur: 6, offsetX: 0, offsetY: 2 },
                            { type: 'shadow', colour: '#359eff', blur: 12, offsetX: 0, offsetY: 4 },
                        ],
                    },
                    unparsed: { effects: [] },
                    heiban: { effects: [] },
                    atamadaka: { effects: [] },
                    nakadaka: { effects: [] },
                    odaka: { effects: [] },
                    kifuku: { effects: [] },
                },
            },
        },
    ],
    [
        'toyBox',
        {
            label: 'Toy Box',
            config: {
                v: 1,
                theme: 'toyBox',
                states: {
                    new: { effects: [{ type: 'text-colour', colour: '#4b8dff' }] },
                    young: { effects: [{ type: 'text-colour', colour: '#4ac34a' }] },
                    mature: { effects: [] },
                    mastered: { effects: [] },
                    due: { effects: [{ type: 'text-colour', colour: '#e8a735' }] },
                    blacklisted: { effects: [{ type: 'text-colour', colour: '#777777' }] },
                    suspended: { effects: [{ type: 'text-colour', colour: '#777777' }] },
                    redundant: { effects: [{ type: 'background', colour: '#4b8dff', opacity: 0.16 }] },
                    frequent: {
                        effects: [{ type: 'underline', colour: '#4b8dff', style: 'solid', thickness: 2 }],
                    },
                    'i-plus-one': {
                        effects: [{ type: 'shadow', colour: '#4b8dff', blur: 6, offsetX: 0, offsetY: 2 }],
                    },
                    unparsed: { effects: [] },
                    heiban: { effects: [] },
                    atamadaka: { effects: [] },
                    nakadaka: { effects: [] },
                    odaka: { effects: [] },
                    kifuku: { effects: [] },
                },
            },
        },
    ],
    [
        'monochrome',
        {
            label: 'Monochrome',
            config: {
                v: 1,
                theme: 'monochrome',
                states: {
                    new: { effects: [{ type: 'text-colour', colour: '#cccccc' }] },
                    young: { effects: [{ type: 'text-colour', colour: '#999999' }] },
                    mature: { effects: [{ type: 'text-colour', colour: '#666666' }] },
                    mastered: { effects: [] },
                    due: {
                        effects: [
                            { type: 'text-colour', colour: '#ffffff' },
                            { type: 'underline', colour: '#ffffff', style: 'solid', thickness: 1 },
                        ],
                    },
                    blacklisted: { effects: [{ type: 'opacity', value: 0.4, hoverOnly: false }] },
                    suspended: { effects: [{ type: 'opacity', value: 0.4, hoverOnly: false }] },
                    redundant: { effects: [{ type: 'background', colour: '#aaaaaa', opacity: 0.18 }] },
                    frequent: {
                        effects: [{ type: 'underline', colour: '#999999', style: 'dotted', thickness: 1 }],
                    },
                    'i-plus-one': { effects: [{ type: 'background', colour: '#cccccc', opacity: 0.1 }] },
                    unparsed: { effects: [] },
                    heiban: { effects: [] },
                    atamadaka: { effects: [] },
                    nakadaka: { effects: [] },
                    odaka: { effects: [] },
                    kifuku: { effects: [] },
                },
            },
        },
    ],
    [
        'high-contrast',
        {
            label: 'High Contrast',
            config: {
                v: 1,
                theme: 'high-contrast',
                states: {
                    new: {
                        effects: [
                            { type: 'text-colour', colour: '#ff00ff' },
                            { type: 'background', colour: '#ff00ff', opacity: 0.1 },
                        ],
                    },
                    young: {
                        effects: [
                            { type: 'text-colour', colour: '#ffaa00' },
                            { type: 'background', colour: '#ffaa00', opacity: 0.1 },
                        ],
                    },
                    mature: { effects: [{ type: 'text-colour', colour: '#00ff00' }] },
                    mastered: { effects: [] },
                    due: {
                        effects: [
                            { type: 'text-colour', colour: '#ff0000' },
                            { type: 'underline', colour: '#ff0000', style: 'wavy', thickness: 2 },
                        ],
                    },
                    blacklisted: { effects: [{ type: 'text-colour', colour: '#555555' }] },
                    suspended: { effects: [] },
                    redundant: { effects: [{ type: 'background', colour: '#00aaff', opacity: 0.45 }] },
                    frequent: {
                        effects: [{ type: 'underline', colour: '#00ffff', style: 'solid', thickness: 2 }],
                    },
                    'i-plus-one': { effects: [{ type: 'background', colour: '#4444ff', opacity: 0.5 }] },
                    unparsed: { effects: [] },
                    heiban: { effects: [] },
                    atamadaka: { effects: [] },
                    nakadaka: { effects: [] },
                    odaka: { effects: [] },
                    kifuku: { effects: [] },
                },
            },
        },
    ],
    [
        'subtle',
        {
            label: 'Subtle',
            config: {
                v: 1,
                theme: 'subtle',
                states: {
                    new: { effects: [{ type: 'background', colour: '#a566ef', opacity: 0.15 }] },
                    young: { effects: [{ type: 'background', colour: '#d08700', opacity: 0.12 }] },
                    mature: { effects: [] },
                    mastered: { effects: [] },
                    due: { effects: [{ type: 'background', colour: '#ff4500', opacity: 0.15 }] },
                    blacklisted: { effects: [{ type: 'opacity', value: 0.5, hoverOnly: false }] },
                    suspended: { effects: [] },
                    redundant: { effects: [{ type: 'background', colour: '#4b9fff', opacity: 0.12 }] },
                    frequent: { effects: [{ type: 'background', colour: '#4b8d7f', opacity: 0.1 }] },
                    'i-plus-one': { effects: [{ type: 'background', colour: '#359eff', opacity: 0.1 }] },
                    unparsed: { effects: [] },
                    heiban: { effects: [] },
                    atamadaka: { effects: [] },
                    nakadaka: { effects: [] },
                    odaka: { effects: [] },
                    kifuku: { effects: [] },
                },
            },
        },
    ],
    [
        'underline',
        {
            label: 'Underline',
            config: {
                v: 1,
                theme: 'underline',
                states: {
                    new: {
                        effects: [{ type: 'underline', colour: '#a566ef', style: 'solid', thickness: 3 }],
                    },
                    young: {
                        effects: [{ type: 'underline', colour: '#e8a020', style: 'solid', thickness: 3 }],
                    },
                    mature: { effects: [] },
                    mastered: { effects: [] },
                    due: {
                        effects: [{ type: 'underline', colour: '#e03030', style: 'solid', thickness: 3 }],
                    },
                    blacklisted: { effects: [] },
                    suspended: { effects: [] },
                    redundant: {
                        effects: [{ type: 'underline', colour: '#4b9fff', style: 'dotted', thickness: 3 }],
                    },
                    frequent: {
                        effects: [{ type: 'underline', colour: '#40a840', style: 'dashed', thickness: 3 }],
                    },
                    'i-plus-one': {
                        effects: [{ type: 'underline', colour: '#40a840', style: 'solid', thickness: 3 }],
                    },
                    unparsed: { effects: [] },
                    heiban: { effects: [] },
                    atamadaka: { effects: [] },
                    nakadaka: { effects: [] },
                    odaka: { effects: [] },
                    kifuku: { effects: [] },
                },
            },
        },
    ],
];
const PRESET_THEMES = new Map(PRESETS);
const DEFAULT_WORD_STYLE_CONFIG = structuredClone(PRESETS[0][1].config);


/***/ }),
/* 7 */
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
/* 8 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getActiveProfileId: () => (/* binding */ getActiveProfileId),
/* harmony export */   getProfilesState: () => (/* binding */ getProfilesState),
/* harmony export */   setProfilesState: () => (/* binding */ setProfilesState)
/* harmony export */ });
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(7);
/* harmony import */ var _profile_types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(9);


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
/* 9 */
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
/* 10 */,
/* 11 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   invalidateSetConfigurationCache: () => (/* binding */ invalidateSetConfigurationCache),
/* harmony export */   setConfiguration: () => (/* binding */ setConfiguration)
/* harmony export */ });
/* harmony import */ var _extension_write_storage__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(12);
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(7);
/* harmony import */ var _profiles_state__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(8);



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
/* 12 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   writeStorage: () => (/* binding */ writeStorage)
/* harmony export */ });
const writeStorage = (key, value) => chrome.storage.local.set({ [key]: value });


/***/ }),
/* 13 */,
/* 14 */,
/* 15 */,
/* 16 */,
/* 17 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getURL: () => (/* binding */ getURL)
/* harmony export */ });
const getURL = (url) => chrome.runtime.getURL(url);


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
/* 20 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   displayToast: () => (/* binding */ displayToast)
/* harmony export */ });
/* harmony import */ var _extension_get_style_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(21);
/* harmony import */ var _create_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(22);
/* harmony import */ var _find_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(25);



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
        // This is a background-side environment, so we can't display a toast
        // or manipulate the DOM.
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
        class: ['toast', type],
        handler: () => toast.classList.add('hide'),
        children: [
            {
                tag: 'span',
                class: ['icon'],
            },
            {
                tag: 'div',
                class: ['content'],
                children: [
                    {
                        tag: 'span',
                        class: ['message'],
                        innerText: message,
                    },
                ],
            },
            type === 'error'
                ? {
                    tag: 'button',
                    class: ['action'],
                    attributes: { 'aria-label': 'Copy error details' },
                    innerText: '⎘',
                    handler(ev) {
                        ev?.stopPropagation();
                        void navigator.clipboard.writeText(error ?? message);
                    },
                }
                : false,
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
/* 21 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getStyleUrl: () => (/* binding */ getStyleUrl)
/* harmony export */ });
/* harmony import */ var _get_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(17);

const getStyleUrl = (url) => (0,_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)(`css/${url}.css`);


/***/ }),
/* 22 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   createElement: () => (/* binding */ createElement)
/* harmony export */ });
/* harmony import */ var _append_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(23);

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
/* 23 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   appendElement: () => (/* binding */ appendElement)
/* harmony export */ });
/* harmony import */ var _create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(22);
/* harmony import */ var _resolve_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(24);


function appendElement(parent, child) {
    const e = child instanceof HTMLElement ? child : (0,_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)(child);
    (0,_resolve_element__WEBPACK_IMPORTED_MODULE_1__.resolveElement)(parent)?.append(e);
    return e;
}


/***/ }),
/* 24 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   resolveElement: () => (/* binding */ resolveElement)
/* harmony export */ });
function resolveElement(element) {
    return typeof element === 'string' ? document.querySelector(element) : element;
}


/***/ }),
/* 25 */
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
/* 26 */,
/* 27 */,
/* 28 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getLastError: () => (/* binding */ getLastError)
/* harmony export */ });
const getLastError = () => chrome.runtime.lastError;


/***/ }),
/* 29 */,
/* 30 */
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
/* 31 */,
/* 32 */,
/* 33 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   onBroadcastMessage: () => (/* binding */ onBroadcastMessage)
/* harmony export */ });
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);

/**
 * Message handler to receive broadcasted messages.
 */
const onBroadcastMessage = (event, handler, runNow = false) => {
    const listener = (message) => {
        if (message.event !== event) {
            return;
        }
        void handler(...message.args);
    };
    _extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.onMessage.addListener(listener);
    if (runNow) {
        handler();
    }
    return () => _extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.onMessage.removeListener(listener);
};


/***/ }),
/* 34 */,
/* 35 */,
/* 36 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AddToStudyDeckCommand: () => (/* binding */ AddToStudyDeckCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class AddToStudyDeckCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'addToStudyDeck';
    }
}


/***/ }),
/* 37 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BackgroundCommand: () => (/* binding */ BackgroundCommand)
/* harmony export */ });
/* harmony import */ var _extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(28);
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(18);
/* harmony import */ var _lib_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(30);



class BackgroundCommand extends _lib_command__WEBPACK_IMPORTED_MODULE_2__.Command {
    send(afterCall) {
        this.call(afterCall).catch((error) => {
            // eslint-disable-next-line no-console
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
                if (!response?.success) {
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
/* 49 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   FetchStudyDecksCommand: () => (/* binding */ FetchStudyDecksCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class FetchStudyDecksCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'fetchStudyDecks';
    }
}


/***/ }),
/* 50 */,
/* 51 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ForgetCardCommand: () => (/* binding */ ForgetCardCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class ForgetCardCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor(wordId, readingIndex) {
        super(wordId, readingIndex);
        this.key = 'forgetCard';
    }
}


/***/ }),
/* 52 */,
/* 53 */,
/* 54 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   GradeCardCommand: () => (/* binding */ GradeCardCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class GradeCardCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'gradeCard';
    }
}


/***/ }),
/* 55 */,
/* 56 */,
/* 57 */,
/* 58 */,
/* 59 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RunDeckActionCommand: () => (/* binding */ RunDeckActionCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class RunDeckActionCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'runDeckAction';
    }
}


/***/ }),
/* 60 */,
/* 61 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   UpdateCardStateCommand: () => (/* binding */ UpdateCardStateCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class UpdateCardStateCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'updateCardState';
    }
}


/***/ }),
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
/* harmony export */   AbortRequestCommand: () => (/* binding */ AbortRequestCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class AbortRequestCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'abortRequest';
    }
}


/***/ }),
/* 73 */,
/* 74 */,
/* 75 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParseCommand: () => (/* binding */ ParseCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class ParseCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'parse';
    }
}


/***/ }),
/* 76 */,
/* 77 */,
/* 78 */,
/* 79 */,
/* 80 */,
/* 81 */,
/* 82 */,
/* 83 */,
/* 84 */,
/* 85 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   FetchPdfCommand: () => (/* binding */ FetchPdfCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

// Fetches a PDF in the service worker (which has real host-permission cross-origin access, unlike an
// extension page subject to CORS) and returns it base64-encoded so the bytes survive runtime
// messaging serialisation. Errors are returned in the result (not thrown) so the page can show the
// real reason rather than the generic "command failed".
class FetchPdfCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'fetchPdf';
    }
}


/***/ }),
/* 86 */,
/* 87 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   onLoaded: () => (/* binding */ onLoaded)
/* harmony export */ });
/* harmony import */ var _on__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(88);

const onLoaded = (listener) => {
    (0,_on__WEBPACK_IMPORTED_MODULE_0__.on)('DOMContentLoaded', listener);
};


/***/ }),
/* 88 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   on: () => (/* binding */ on)
/* harmony export */ });
const on = (event, listener) => {
    document.addEventListener(event, listener);
};


/***/ }),
/* 89 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   bootstrapPipeline: () => (/* binding */ bootstrapPipeline)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(33);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(90);
/* harmony import */ var _popup_popup_manager__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(108);
/* harmony import */ var _text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(129);
/* harmony import */ var _faithful_highlight__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(131);






const FAITHFUL_STYLE_ID = 'pdf-faithful-highlight';
const applyFaithfulHighlight = async () => {
    const config = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('wordStyleConfig');
    let style = document.getElementById(FAITHFUL_STYLE_ID);
    if (!style) {
        style = document.createElement('style');
        style.id = FAITHFUL_STYLE_ID;
        document.head.appendChild(style);
    }
    style.textContent = (0,_faithful_highlight__WEBPACK_IMPORTED_MODULE_5__.generateFaithfulHighlightCss)(config);
};
// The shared parsing pipeline (BatchController → ParseCommand → SequenceManager → TextHighlighter)
// is normally wired up by `new AJB()` in the content script. This standalone page never runs AJB, so
// it replicates the minimal subset needed to parse text and get interactive, themed highlights:
// the word-event delegation + popup, the highlight options derived from configuration, and the
// word-style stylesheets. Parse results route back here because the page lives in a real tab, so the
// service worker's `tabs.sendMessage(sender.tab.id, …)` reaches our SequenceManager listeners.
const applyHighlightOptions = async () => {
    const options = _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.textHighlighterOptions;
    options.skipFurigana = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('skipFurigana');
    options.generatePitch = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('generatePitch');
    options.markIPlus1 = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markIPlus1');
    options.markAll = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markAllTypes');
    options.markFrequency = (await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markTopX'))
        ? await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markTopXCount')
        : false;
    options.minSentenceLength = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('minSentenceLength');
    options.iPlusOneMaxFrequency = (await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('iPlusOneMaxFrequency'))
        ? await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('iPlusOneMaxFrequencyCount')
        : false;
    options.newStates = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('newStates');
    options.markWordsInDeck = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markWordsInDeck');
    await (0,_text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_4__.applyWordStyles)();
    await applyFaithfulHighlight();
};
const bootstrapPipeline = async () => {
    _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.wordEventDelegator.initialise();
    _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.popupManager = new _popup_popup_manager__WEBPACK_IMPORTED_MODULE_3__.PopupManager();
    (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('cardStateUpdated', (wordId, readingIndex, state) => {
        _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.updateCard(wordId, readingIndex, state);
    });
    (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', () => void applyHighlightOptions(), true);
    await applyHighlightOptions();
    await (0,_text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_4__.ensureWordStyles)();
};


/***/ }),
/* 90 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Registry: () => (/* binding */ Registry)
/* harmony export */ });
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(4);
/* harmony import */ var _batches_batch_controller__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(91);
/* harmony import */ var _sequence_sequence_manager__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(99);
/* harmony import */ var _event_collection__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(101);
/* harmony import */ var _host_evaluator__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(102);
/* harmony import */ var _sentence_manager__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(106);
/* harmony import */ var _word_event_delegator__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(107);







class Registry {
    static markSessionTouched(wordId, readingIndex) {
        this.sessionTouchedCards.add(`${wordId}/${readingIndex}`);
    }
    static isSessionTouched(wordId, readingIndex) {
        return this.sessionTouchedCards.has(`${wordId}/${readingIndex}`);
    }
    static setStudyDecks(decks) {
        this.studyDecks.clear();
        for (const deck of decks) {
            this.studyDecks.set(deck.userStudyDeckId, deck);
        }
    }
    static getStudyDecks() {
        return Array.from(this.studyDecks.values());
    }
    static getStudyDeck(deckId) {
        return this.studyDecks.get(deckId);
    }
    // Resolves the membership CSS classes for the decks a word belongs to: one per deck type
    // present, plus a generic `in-any-deck` whenever the word is in at least one deck.
    static getDeckMembershipClasses(deckIds) {
        const classes = new Set();
        for (const id of deckIds) {
            const deck = this.studyDecks.get(id);
            if (deck) {
                classes.add(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.STUDY_DECK_CLASS[deck.deckType]);
            }
        }
        if (classes.size > 0) {
            classes.add(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.IN_ANY_DECK_CLASS);
        }
        return Array.from(classes);
    }
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
    static updateCard(wordId, readingIndex, state, deckIds) {
        const card = this.getCard(wordId, readingIndex);
        const managedStates = Object.values(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.JitenCardState);
        const { markFrequency, markAll, newStates, markWordsInDeck } = this.textHighlighterOptions;
        if (!card) {
            return;
        }
        card.cardState = state;
        if (deckIds) {
            card.deckIds = deckIds;
        }
        const deckClasses = markWordsInDeck ? this.getDeckMembershipClasses(card.deckIds) : [];
        const isNew = state.some((s) => newStates.includes(s));
        const isFrequent = markFrequency !== false && card.frequencyRank <= markFrequency && (markAll || isNew);
        document
            .querySelectorAll(`[wordId="${wordId}"][readingIndex="${readingIndex}"]`)
            .forEach((element) => {
            const classes = Array.from(element.classList).filter((x) => x !== 'frequent' &&
                !managedStates.includes(x) &&
                !_shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__.DECK_MEMBERSHIP_CLASSES.includes(x));
            classes.push(...state, ...deckClasses);
            if (isFrequent) {
                classes.push('frequent');
            }
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
    static clearCards() {
        this.cards.clear();
        this.sessionTouchedCards.clear();
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
    iPlusOneMaxFrequency: false,
    newStates: [],
    markWordsInDeck: false,
};
Registry.skipTouchEvents = false;
Registry.cards = new Map();
Registry.conjugations = new WeakMap();
Registry.studyDecks = new Map();
// Words the user manually graded or auto-failed this session — excluded from mass review.
Registry.sessionTouchedCards = new Set();


/***/ }),
/* 91 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BatchController: () => (/* binding */ BatchController)
/* harmony export */ });
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(20);
/* harmony import */ var _shared_messages_background_parse_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(75);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(90);
/* harmony import */ var _sequence_canceled__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(92);
/* harmony import */ var _apply_tokens__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(93);
/* harmony import */ var _get_paragraphs__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(96);






class BatchController {
    constructor() {
        this._pendingBatches = new Map();
    }
    registerNodes(nodes, options = {}) {
        nodes.forEach((node) => this.registerNode(node, options));
    }
    registerNode(node, options = {}) {
        const { filter, onEmpty, getParagraphsFn = _get_paragraphs__WEBPACK_IMPORTED_MODULE_5__.getParagraphs, applyFn = _apply_tokens__WEBPACK_IMPORTED_MODULE_4__.applyTokens, collapseWhitespace, onComplete, } = options;
        if (this._pendingBatches.has(node)) {
            return;
        }
        const paragraphs = getParagraphsFn(node, filter, collapseWhitespace);
        if (!paragraphs.length) {
            return onEmpty?.(node);
        }
        this.prepareNode(node, paragraphs, applyFn, onComplete);
    }
    dismissNode(node) {
        this._pendingBatches.get(node)?.forEach((batch) => batch.abort());
        this._pendingBatches.delete(node);
    }
    abortAll() {
        this._pendingBatches.forEach((batches) => batches.forEach((batch) => batch.abort()));
        this._pendingBatches.clear();
    }
    parseBatches(afterSend) {
        const batches = Array.from(this._pendingBatches.values());
        const sequences = batches.flatMap((b) => b);
        const sequenceData = sequences.map((s) => [s.sequenceId, s.data.map((f) => f.node.data).join('')]);
        new _shared_messages_background_parse_command__WEBPACK_IMPORTED_MODULE_1__.ParseCommand(sequenceData).send(afterSend);
        this._pendingBatches.clear();
    }
    prepareNode(node, paragraphs, applyFn, onComplete) {
        const batches = paragraphs.map((paragraph) => _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.sequenceManager.getAbortableSequence(paragraph));
        this._pendingBatches.set(node, batches);
        this.prepareBatches(node, applyFn, onComplete);
    }
    prepareBatches(node, applyFn, onComplete) {
        const batches = this._pendingBatches.get(node);
        // Process paragraphs sequentially to prevent parallel DOM flooding
        void batches
            .reduce((previousPromise, batch) => previousPromise.then(async () => {
            try {
                const value = await batch.promise;
                applyFn(batch.data, value);
            }
            catch (error) {
                if (error instanceof _sequence_canceled__WEBPACK_IMPORTED_MODULE_3__.Canceled) {
                    return;
                }
                if (error.message === 'Failed to fetch') {
                    (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('error', 'api.jiten.moe is unreachable', error.message);
                    return;
                }
                // eslint-disable-next-line no-console
                console.error(error);
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('error', 'An error occurred while parsing the text', error.message);
            }
        }), Promise.resolve())
            .then(() => onComplete?.());
    }
}


/***/ }),
/* 92 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Canceled: () => (/* binding */ Canceled)
/* harmony export */ });
class Canceled extends Error {
}


/***/ }),
/* 93 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   applyTokens: () => (/* binding */ applyTokens)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(90);
/* harmony import */ var _text_highlighter_text_highlighter__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(94);


let statsUpdateTimeout;
const applyTokens = (fragments, tokens) => {
    new _text_highlighter_text_highlighter__WEBPACK_IMPORTED_MODULE_1__.TextHighlighter(fragments, tokens).apply();
    // Debounce stats recalculation to avoid calling it too often when there's a lot of paragraphs
    if (statsUpdateTimeout) {
        clearTimeout(statsUpdateTimeout);
    }
    statsUpdateTimeout = window.setTimeout(() => {
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.statusBar?.recalculateStats();
        statsUpdateTimeout = undefined;
    }, 100);
};


/***/ }),
/* 94 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TextHighlighter: () => (/* binding */ TextHighlighter)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(22);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(90);
/* harmony import */ var _base_text_highlighter__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(95);



class TextHighlighter extends _base_text_highlighter__WEBPACK_IMPORTED_MODULE_2__.BaseTextHighlighter {
    constructor() {
        super(...arguments);
        this._fragments = new Set(this.fragments);
        this._tokens = new Set(this.tokens);
        this._tokenToFragmentsMap = new Map();
        this._fragmentToTokensMap = new Map();
    }
    apply() {
        void this.applyAsync();
    }
    /**
     * Preprocess the data - this maps tokens and fragment relations as well as applies error correction
     */
    async preprocess() {
        // Match tokens and fragments together
        this.buildMaps();
        // Split fragments that contain multiple tokens into multiple fragments (e.g. sentences)
        await this.splitMultiTokenFragmentsChunked();
        // Apply error correction to fragments that do not match the tokens exactly
        await this.adjustUnmatchedFragmentsChunked();
        // Rebuild the maps after error correction. This also sorts fragments and tokens beforehand
        this.rebuildMaps();
        // Error correction may have resulted in new fragments that need to be split (e.g. sentences behind a malformed node)
        await this.splitMultiTokenFragmentsChunked();
    }
    //#region Building Maps
    /**
     * Rebuild the maps between tokens and fragments
     *
     * The maps are sorted by the start position of the tokens and fragments
     * This is necessary after error correction to ensure the maps are up to date, otherwise splitted fragments may not be matched correctly
     */
    rebuildMaps() {
        this._fragments = new Set([...this._fragments].sort((a, b) => a.start - b.start));
        this._tokens = new Set([...this._tokens].sort((a, b) => a.start - b.start));
        this._fragmentToTokensMap.clear();
        this._tokenToFragmentsMap.clear();
        this.buildMaps();
    }
    /**
     * Build bidirectional maps between tokens and fragments using O(n+m) sweep-line algorithm
     * Both tokens and fragments are sorted by start position, allowing efficient matching
     */
    buildMaps() {
        const sortedTokens = [...this._tokens].sort((a, b) => a.start - b.start);
        const sortedFragments = [...this._fragments].sort((a, b) => a.start - b.start);
        // Initialise fragment map with empty arrays
        for (const fragment of sortedFragments) {
            this._fragmentToTokensMap.set(fragment, []);
        }
        let fragIndex = 0;
        for (const token of sortedTokens) {
            const matchingFragments = [];
            // Advance past fragments that end before this token starts
            while (fragIndex < sortedFragments.length && sortedFragments[fragIndex].end <= token.start) {
                fragIndex++;
            }
            // Scan through potentially overlapping fragments
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
    //#endregion Building Maps
    //#region Splitting Fragments
    /**
     * Split fragments that contain multiple tokens into multiple fragments and add them to the fragment set
     */
    splitMultiTokenFragments() {
        this.filterMap(this._fragmentToTokensMap, (tokens, _fragment) => tokens.length > 1).forEach((tokens, fragment) => {
            let token;
            while ((token = tokens.pop())) {
                this.cutoffTokenEnd(token, fragment);
                if (token.start < fragment.start) {
                    // Fragment is part of this token but starts after token.start
                    // This happens when a token spans multiple fragments (e.g., ruby + text node)
                    // Associate the fragment with this token without splitting further
                    this._fragmentToTokensMap.get(fragment)?.push(token);
                    this._tokenToFragmentsMap.get(token)?.push(fragment);
                    break;
                }
                // We cut off the token length from the fragment and save it as a new fragment
                // this shortens the original fragment and may fix its length
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
        // If the fragment is longer than the token (e.g. a sentence ending with a period)
        // we cut off the end and mark it as unparsed
        if (token.end < fragment.end) {
            // The fragment is longer than the token (e.g. a sentence ending with a period)
            this.patchOrWrap(this.splitFragmentsNode(fragment, token.end));
            this.fixFragmentParameters(fragment);
        }
    }
    //#endregion Splitting Fragments
    //#region Error Correction
    adjustUnmatchedFragments() {
        this.filterMap(this._tokenToFragmentsMap, (fragments, tokens) => !this.areBoundariesExactMatch(tokens, fragments)).forEach((fragments, token) => {
            // An mismatch in boundaries has two common reasons:
            // 1. It is related to a misparsed kanji where the boundaries shift - we ignore those for now
            // 2. Special caracters like 。, 、 or parentheses are not included in the token
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
    //#endregion Error Correction
    //#region Patch unparsed Fragments
    /**
     * Fragments with zero tokens could not be parsed - we mark them as unparsed
     */
    patchUnparsedFragments() {
        this.filterMap(this._fragmentToTokensMap, (tokens) => !tokens.length).forEach((_, fragment) => this.patchOrWrap(fragment));
    }
    //#endregion Patch unparsed Fragments
    //#region Patch non ruby tokens
    /**
     * Apply tokens without rubies with fragments matching the boundaries of the token
     */
    patchNonRubyTokens() {
        this.filterMap(this._tokenToFragmentsMap, (fragments, token) => !token.rubies.length && this.areBoundariesExactMatch(token, fragments)).forEach((fragments, token) => fragments.forEach((fragment) => this.patchOrWrap(fragment, token)));
    }
    //#endregion Patch non ruby tokens
    //#region Patch contained ruby elements
    /**
     * Apply ruby tokens which have fragments sharing the same ruby parent and boundaries match exactly
     */
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
    //#endregion Patch contained ruby elements
    //#region Patch fragmented ruby tokens
    /**
     * Apply ruby tokens which span multiple fragments and the boundaries match exactly
     */
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
    //#endregion
    //#region Patch remaining misparses
    patchRemainingMisparses() {
        this._tokenToFragmentsMap.forEach((fragments, token) => {
            if (this.checkUnmatchedFragmentMisparse(token, fragments)) {
                fragments.forEach((fragment) => this.dismissElements(fragment, token));
            }
        });
    }
    checkUnmatchedFragmentMisparse(token, fragments) {
        let isMisparse = false;
        // If we have a definitive ruby, we can attempt a direct match
        // If it was a misparsed ruby, we can already mark and it do not need to check those anymore
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
    //#endregion Patch remaining misparses
    //#region Shared Helpers
    /**
     * Check if a fragment is within a token or overlaps with it
     *
     * @param {Fragment} fragment The fragment to check
     * @param {JitenToken} token The token to check
     * @returns {boolean} True if the fragment is within the token or overlaps, false otherwise
     */
    isFragmentWithinToken(fragment, token) {
        return fragment.end > token.start && fragment.start < token.end;
    }
    /**
     * Split the text of a fragment at a given offset
     * The offset is relative to the fragment and will respect the fragment boundaries
     *
     * The node of the fragment is modified and the new node is returned
     *
     * @param {Fragment} fragment The fragment to cut the end off
     * @param {number} start The start position in relation to the fragment
     * @returns {Text} The new node that was created
     */
    splitFragmentsNode(fragment, start) {
        const node = fragment.node;
        const offset = start - fragment.start;
        if (offset >= node.data.length) {
            const empty = document.createTextNode('');
            node.after(empty);
            return empty;
        }
        return node.splitText(offset);
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
        const { skipFurigana, markFrequency, markAll, generatePitch, markIPlus1, newStates, markWordsInDeck, } = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.textHighlighterOptions;
        const { card, pitchClass, sentence, conjugations } = token ?? {};
        // do not apply the same card twice
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
            if (markWordsInDeck && card.deckIds.length > 0) {
                const deckClasses = _integration_registry__WEBPACK_IMPORTED_MODULE_1__.Registry.getDeckMembershipClasses(card.deckIds);
                if (deckClasses.length > 0) {
                    element.classList.add(...deckClasses);
                }
            }
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
        if (fragments.length === 0) {
            return false;
        }
        const rubyElements = fragments
            .map((f) => f.rubyElement ?? this.findParent(f.node, 'RUBY'))
            .filter((el) => el !== null);
        if (rubyElements.length !== fragments.length) {
            return false;
        }
        const firstRuby = rubyElements[0];
        return rubyElements.every((ruby) => ruby === firstRuby);
    }
    getSharedRubyElement(fragments) {
        if (fragments.length === 0) {
            return null;
        }
        const first = fragments[0];
        return first.rubyElement ?? this.findParent(first.node, 'RUBY');
    }
    isMisparsedRuby(_rubyElement, _token) {
        return false;
        // const cardsRubyText =
        //   token.card.wordWithReading?.replace(/[^[]*\[([^\]]*)\][^[]*/g, '$1') ?? '';
        //
        // return originalRubyText !== cardsRubyText;
    }
    /**
     * Split ruby elements that contain fragments belonging to multiple tokens.
     * Without this, only the first token's attributes get applied to the shared ruby element
     * and subsequent tokens are silently dropped.
     */
    splitSharedRubyElements() {
        const rubyToTokens = new Map();
        for (const [token, fragments] of this._tokenToFragmentsMap) {
            for (const fragment of fragments) {
                if (!fragment.hasRuby) {
                    continue;
                }
                const rubyEl = (fragment.rubyElement ?? this.findParent(fragment.node, 'RUBY'));
                if (!rubyEl) {
                    continue;
                }
                let tokenSet = rubyToTokens.get(rubyEl);
                if (!tokenSet) {
                    tokenSet = new Set();
                    rubyToTokens.set(rubyEl, tokenSet);
                }
                tokenSet.add(token);
            }
        }
        for (const [rubyEl, tokens] of rubyToTokens) {
            if (tokens.size <= 1) {
                continue;
            }
            this.splitRubyForTokens(rubyEl, tokens);
        }
    }
    markElementAsMisparsed(element) {
        if (element.hasAttribute('ajb')) {
            return;
        }
        element.classList.add('jiten-word', 'misparsed');
        element.setAttribute('ajb', 'true');
    }
    //#endregion Shared Helpers
    async applyAsync() {
        await this.preprocess();
        this.splitSharedRubyElements();
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
    splitRubyForTokens(rubyEl, tokens) {
        const parent = rubyEl.parentNode;
        if (!parent) {
            return;
        }
        const nodeToToken = new Map();
        for (const token of tokens) {
            const fragments = this._tokenToFragmentsMap.get(token) ?? [];
            for (const fragment of fragments) {
                const fragRuby = fragment.rubyElement ?? this.findParent(fragment.node, 'RUBY');
                if (fragRuby === rubyEl) {
                    nodeToToken.set(fragment.node, token);
                }
            }
        }
        const groups = [];
        let current = null;
        for (const child of Array.from(rubyEl.childNodes)) {
            if (child instanceof Text || child instanceof CDATASection) {
                const token = nodeToToken.get(child) ?? null;
                if (current?.token !== token) {
                    current = { token, nodes: [] };
                    groups.push(current);
                }
                current.nodes.push(child);
            }
            else if (child instanceof Element && (child.tagName === 'RT' || child.tagName === 'RP')) {
                current?.nodes.push(child);
            }
            else {
                current?.nodes.push(child);
            }
        }
        if (groups.length <= 1) {
            return;
        }
        for (const group of groups) {
            const newRuby = document.createElement('ruby');
            for (const node of group.nodes) {
                newRuby.appendChild(node);
            }
            parent.insertBefore(newRuby, rubyEl);
        }
        rubyEl.remove();
        for (const fragment of this._fragments) {
            if (fragment.rubyElement !== rubyEl) {
                continue;
            }
            fragment.rubyElement = this.findParent(fragment.node, 'RUBY') ?? undefined;
        }
    }
}
TextHighlighter.CHUNK_SIZE = 40;


/***/ }),
/* 95 */
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
/* 96 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getParagraphs: () => (/* binding */ getParagraphs)
/* harmony export */ });
/* harmony import */ var _paragraph_reader_paragraph_reader__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(97);

const getParagraphs = (node, filter, collapseWhitespace) => {
    return new _paragraph_reader_paragraph_reader__WEBPACK_IMPORTED_MODULE_0__.ParagraphReader(node, filter, collapseWhitespace).read();
};


/***/ }),
/* 97 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParagraphReader: () => (/* binding */ ParagraphReader)
/* harmony export */ });
/* harmony import */ var _base_paragraph_reader__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(98);

class ParagraphReader extends _base_paragraph_reader__WEBPACK_IMPORTED_MODULE_0__.BaseParagraphReader {
    constructor() {
        super(...arguments);
        this._styleCache = new Map();
    }
    read() {
        this._styleCache = new Map();
        if (this.collapseWhitespace) {
            this.splitTextNodesAtWhitespace(this.node);
        }
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
        // Remove fragments from the end that are just whitespace
        // (the ones from the start have already been ignored)
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
            const { tagName } = node;
            if (tagName === 'RUBY') {
                return 'ruby';
            }
            if (tagName === 'RP') {
                return 'none';
            }
            if (tagName === 'RT') {
                return 'ruby-text';
            }
            if (tagName === 'RB') {
                return 'inline';
            }
            if (ParagraphReader._skipTags.has(tagName)) {
                return 'none';
            }
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
            } // Old name of flex? Still used on Google Search for some reason.
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
    splitTextNodesAtWhitespace(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) {
            textNodes.push(walker.currentNode);
        }
        for (const text of textNodes) {
            if (!/[\n\r\t]/.test(text.data)) {
                continue;
            }
            const parent = text.parentNode;
            if (!parent) {
                continue;
            }
            const normalised = text.data.replace(/\r\n/g, '\n').replace(/[\r\t]/g, '');
            const parts = normalised.split('\n');
            const fragment = document.createDocumentFragment();
            parts.forEach((part, i) => {
                if (i > 0) {
                    fragment.appendChild(document.createElement('br'));
                }
                if (part.length > 0) {
                    fragment.appendChild(document.createTextNode(part));
                }
            });
            parent.replaceChild(fragment, text);
        }
    }
}
ParagraphReader._skipTags = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'IMG',
    'IFRAME',
    'OBJECT',
    'EMBED',
    'BR',
    'HR',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'BUTTON',
]);


/***/ }),
/* 98 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BaseParagraphReader: () => (/* binding */ BaseParagraphReader)
/* harmony export */ });
class BaseParagraphReader {
    constructor(node, filter, collapseWhitespace) {
        this.node = node;
        this.filter = filter;
        this.collapseWhitespace = collapseWhitespace;
    }
}


/***/ }),
/* 99 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SequenceManager: () => (/* binding */ SequenceManager)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_abort_request_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(72);
/* harmony import */ var _shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(100);
/* harmony import */ var _canceled__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(92);



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
            abortController.signal.addEventListener('abort', () => new _shared_messages_background_abort_request_command__WEBPACK_IMPORTED_MODULE_0__.AbortRequestCommand(sequenceId).send(), { once: true });
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
/* 100 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   receiveBackgroundMessage: () => (/* binding */ receiveBackgroundMessage)
/* harmony export */ });
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);

/**
 * Message handler to receive messages from the background script.
 *
 * @param {keyof TabEvents} event The message type to handle
 * @param {TabEventFunction} handler The handler for the message
 */
const receiveBackgroundMessage = (event, handler) => {
    const listener = (request, _, sendResponse) => {
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
    };
    _extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.onMessage.addListener(listener);
    return () => _extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.onMessage.removeListener(listener);
};


/***/ }),
/* 101 */
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
    off(event, listener) {
        this._map.get(event)?.delete(listener);
    }
    emit(event, ...args) {
        const listeners = this._map.get(event);
        if (!listeners?.size) {
            return;
        }
        for (const listener of listeners) {
            // @ts-expect-error: 2554
            void listener(...args);
        }
    }
}


/***/ }),
/* 102 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HostEvaluator: () => (/* binding */ HostEvaluator)
/* harmony export */ });
/* harmony import */ var _shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(103);

class HostEvaluator {
    get metaKey() {
        return this.relevantMeta
            .map((meta) => ('id' in meta && meta.id) || JSON.stringify(meta))
            .sort()
            .join(',');
    }
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
        if (this._host === 'about:srcdoc' || this._host === 'about:blank') {
            try {
                this._host = window.parent.location.href;
            }
            catch {
                // Cross-origin parent; keep the about: URL
            }
        }
    }
    updateUrl(url) {
        this._host = url;
    }
    async load() {
        const enabledHosts = await (0,_shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.resolveMatchingHosts)(this._host);
        this._targetedTriggerMeta = (0,_shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.filterHostMeta)(enabledHosts, ({ auto, host, allFrames }) => !auto && host !== '<all_urls>' && (allFrames || this._isMainFrame));
        this._targetedAutomaticMeta = (0,_shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.filterHostMeta)(enabledHosts, ({ auto, host, allFrames }) => auto && host !== '<all_urls>' && (allFrames || this._isMainFrame), true);
        this._defaultTriggerMeta = (0,_shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.filterHostMeta)(enabledHosts, ({ auto, host, allFrames }) => auto === false && host === '<all_urls>' && (allFrames || this._isMainFrame));
        this._defaultAutomaticMeta = (0,_shared_host_meta_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.filterHostMeta)(enabledHosts, ({ auto, host, allFrames }) => auto && host === '<all_urls>' && (allFrames || this._isMainFrame), true);
        return this;
    }
}


/***/ }),
/* 103 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   filterHostMeta: () => (/* binding */ filterHostMeta),
/* harmony export */   resolveMatchingHosts: () => (/* binding */ resolveMatchingHosts)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _dom_display_toast__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(20);
/* harmony import */ var _match_url__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(104);
/* harmony import */ var _default_hosts__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(105);




const isPredefined = (meta) => 'id' in meta;
const normaliseHostPattern = (entry) => {
    if (entry === '<all_urls>' || entry.includes('://')) {
        return entry;
    }
    const pattern = `*://${entry}`;
    const afterScheme = pattern.split('://', 2)[1] ?? '';
    return afterScheme.includes('/') ? pattern : `${pattern}/*`;
};
async function resolveMatchingHosts(host) {
    if (!host?.length) {
        return [];
    }
    const [disabledHosts, additionalHosts, additionalMeta] = await Promise.all([
        (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('disabledParsers'),
        (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('additionalHosts'),
        (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('additionalMeta'),
    ]);
    const hostsMeta = [..._default_hosts__WEBPACK_IMPORTED_MODULE_3__.DEFAULT_HOSTS];
    try {
        const meta = JSON.parse(additionalMeta?.length ? additionalMeta : '[]');
        hostsMeta.push(...meta.map(({ host, auto = true, allFrames = false, disabled, parse, filter, css, parseVisibleObserver, addedObserver, parserClass, collapseWhitespace, }) => ({
            host: Array.isArray(host) ? host.map(normaliseHostPattern) : normaliseHostPattern(host),
            auto,
            allFrames,
            disabled,
            parse,
            filter,
            css,
            parseVisibleObserver,
            addedObserver,
            parserClass,
            collapseWhitespace,
        })));
    }
    catch (e) {
        // eslint-disable-next-line no-console
        console.error('Failed to parse additional meta:', e);
        (0,_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('error', 'Failed to parse additional meta. Please check your configuration.', e.message);
    }
    additionalHosts
        .trim()
        .replace(/\r\n?/g, ' ')
        .split(/[\s;,]/)
        .filter(Boolean)
        .forEach((h) => {
        hostsMeta.push({
            host: normaliseHostPattern(h),
            auto: true,
            allFrames: true,
            parse: 'body',
            parserClass: 'custom-parser',
        });
    });
    const hostFilter = (meta) => {
        const isMatch = (matchPattern) => {
            if (isPredefined(meta) && meta.optOut && disabledHosts.includes(meta.id)) {
                return false;
            }
            return (0,_match_url__WEBPACK_IMPORTED_MODULE_2__.matchUrl)(matchPattern, host);
        };
        return Array.isArray(meta.host) ? meta.host.some(isMatch) : isMatch(meta.host);
    };
    return hostsMeta.filter(hostFilter);
}
function filterHostMeta(enabledHosts, filter, multiple) {
    return multiple ? enabledHosts.filter(filter) : enabledHosts.find(filter);
}


/***/ }),
/* 104 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   matchUrl: () => (/* binding */ matchUrl)
/* harmony export */ });
const matchUrl = (matchPattern, host) => {
    if (matchPattern === '<all_urls>') {
        return true;
    }
    const parts = matchPattern.split('://', 2);
    if (parts.length < 2) {
        return false;
    }
    let patternSchema = parts[0];
    const patternUrl = parts[1];
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
/* 105 */
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
        id: 'ttsu-parser',
        name: 'Ttsu Parser',
        description: 'Parses the ebook reader Ttsu',
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
            notifyFor: '.asbplayer-offscreen > div',
            lazy: true,
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
        id: 'kizuna-parser',
        name: 'Kizuna',
        description: 'Parses the text hooking page Kizuna.',
        host: ['*://kizuna-texthooker-ui.app/rooms/*'],
        auto: true,
        optOut: true,
        allFrames: false,
        parseVisibleObserver: true,
        addedObserver: {
            notifyFor: '.text-line',
            observeFrom: ['#text-container', 'body'],
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
    {
        id: 'manatan-manga',
        name: 'Manatan parser (manga)',
        description: 'Parses locally hosted Manatan mangas.',
        host: ['*://localhost:4568/manga/*'],
        auto: true,
        optOut: true,
        allFrames: true,
        parseVisibleObserver: true,
        collapseWhitespace: true,
        custom: 'ManatanMangaParser',
        css: [
            '.gemini-ocr-text-box[data-jiten-parsed] {',
            '  color: transparent !important;',
            '  -webkit-text-fill-color: transparent !important;',
            '  text-shadow: none !important;',
            '  opacity: 0 !important;',
            '}',
            '.gemini-ocr-text-box[data-jiten-parsed]:hover {',
            '  opacity: 1 !important;',
            '}',
            '.jiten-manatan-overlay {',
            '  position: absolute;',
            '  inset: 0;',
            '  pointer-events: none;',
            '  overflow: visible;',
            '  color: var(--ocr-text-color, #333);',
            '  -webkit-text-fill-color: initial;',
            '}',
            '.jiten-manatan-overlay .jiten-word { margin-inline: 0; }',
            '.jiten-manatan-overlay .jiten-word[wordId] { pointer-events: auto; }',
            '.jiten-manatan-pass-through .jiten-manatan-overlay .jiten-word[wordId] { pointer-events: none; }',
            '.jiten-manatan-overlay .jiten-word::before {',
            '  content: attr(data-text);',
            '  text-shadow: inherit;',
            '}',
        ].join('\n'),
        addedObserver: {
            notifyFor: '.gemini-ocr-text-box',
        },
    },
    {
        id: 'manatan-ln',
        name: 'Manatan parser (LNs)',
        description: 'Parses locally hosted Manatan light novels.',
        host: ['*://localhost:4568/ln/*'],
        auto: true,
        optOut: true,
        allFrames: true,
        parseVisibleObserver: true,
        addedObserver: {
            notifyFor: 'p',
            checkNested: 'div',
        },
    },
    {
        id: 'manatan-anime',
        name: 'Manatan parser (anime)',
        description: 'Parses locally hosted Manatan anime.',
        host: ['*://localhost:4568/anime/*'],
        auto: true,
        optOut: true,
        allFrames: true,
        parseVisibleObserver: true,
        addedObserver: {
            notifyFor: 'p',
            checkNested: 'div',
        },
    },
    {
        id: 'yatsu-parser',
        name: 'Yatsu Parser',
        description: 'Parses the ebook reader Yatsu',
        host: '*://app.yatsu.moe/b*',
        auto: true,
        optOut: true,
        allFrames: false,
        custom: 'YatsuParser',
        parserClass: 'ttsu-parser',
        parseVisibleObserver: true,
        filter: '.book-content-page-measure, [aria-hidden="true"], [data-yatsu-current-position-marker], [data-yatsu-bookmark-marker]',
        addedObserver: {
            notifyFor: 'div.book-content:not(.book-content-page-measure)',
            checkNested: 'div',
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
    // {
    //   id: 'youtube-comments-parser',
    //   name: 'YouTube Comments Parser',
    //   description: 'Parses YouTube comments',
    //   host: ['*://*.youtube.com/*', '*://*.youtu.be/*'],
    //   auto: true,
    //   optOut: true,
    //   allFrames: false,
    //   parseVisibleObserver: true,
    //   parserClass: 'youtube-parser',
    //   addedObserver: {
    //     notifyFor: 'ytd-comment-view-model',
    //   },
    // },
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
        id: 'readest-parser',
        name: 'Readest Parser',
        description: 'Parses Readest web',
        host: ['*://web.readest.com/reader/*'],
        auto: true,
        optOut: true,
        allFrames: true,
        parseVisibleObserver: true,
        addedObserver: {
            notifyFor: 'p',
            observeFrom: ['main', 'div'],
        },
    },
    {
        id: 'nihongotracker-parser',
        name: 'Nihongo Tracker',
        description: 'Parses the text hooking page Nihongo Tracker.',
        host: ['*://nihongotracker.app/texthooker/*', '*://www.nihongotracker.app/texthooker/*'],
        auto: true,
        optOut: true,
        allFrames: false,
        parseVisibleObserver: true,
        addedObserver: {
            notifyFor: "p, span[lang='ja']",
            checkNested: '.group',
            observeFrom: 'body',
            config: {
                childList: true,
                subtree: true,
            },
        },
        filter: "button, .btn, svg, [aria-label='Delete line']",
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
];


/***/ }),
/* 106 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SentenceManager: () => (/* binding */ SentenceManager)
/* harmony export */ });
/* harmony import */ var _registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(90);

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
        if (!this._sentenceToCards.get(sentence)?.includes(cardKey)) {
            this.addToMap(this._sentenceToCards, sentence, cardKey);
        }
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
        // Remove element from sentence-to-elements map
        this.filterMap(this._sentenceToElements, sentence, element);
        // Remove card mapping for this element
        const card = this._elementToCard.get(element);
        if (card) {
            this.filterMap(this._cardToElements, card, element);
            this._elementToCard.delete(element);
        }
        this._elementsToSentence.delete(element);
        // Remove i-plus-one class if present
        element.classList.remove('i-plus-one');
        // If no more elements for this sentence, clean up sentence references
        if (!this._sentenceToElements.get(sentence)?.length) {
            this._sentenceToElements.delete(sentence);
            this._sentenceToCards.delete(sentence);
            this._processedSentences.delete(sentence);
        }
        // If no more elements for this card, clean up card references
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
        const { iPlusOneMaxFrequency, minSentenceLength, newStates } = _registry__WEBPACK_IMPORTED_MODULE_0__.Registry.textHighlighterOptions;
        this._processedSentences.add(sentence);
        const cards = this._sentenceToCards.get(sentence) ?? [];
        const unknownCards = cards.filter((card) => {
            const states = this._cardToState.get(card);
            return states.some((s) => newStates.includes(s));
        });
        let notIPlusOne = unknownCards.length === 0 || unknownCards.length > 1 || cards.length < minSentenceLength;
        if (iPlusOneMaxFrequency && !notIPlusOne) {
            const relevantFrequency = this._cardToFrequency.get(unknownCards[0]);
            if (relevantFrequency > iPlusOneMaxFrequency) {
                notIPlusOne = true;
            }
        }
        if (notIPlusOne) {
            // Force remove i+1 class if it was previously set
            this._sentenceToElements.get(sentence)?.forEach((element) => {
                element.classList.remove('i-plus-one');
            });
            return; // No i+1 sentence or too many unknown cards
        }
        const [wordId, readingIndex] = unknownCards[0].split('/');
        // If we have exactly one unknown card, mark the element as i+1
        this._sentenceToElements.get(sentence)?.forEach((element) => {
            const e = element;
            // if element attributes match the wordId and readingIndex, add the i-plus-one class
            if (e.getAttribute('wordId') === wordId && e.getAttribute('readingIndex') === readingIndex) {
                e.classList.add('i-plus-one');
            }
        });
    }
}


/***/ }),
/* 107 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   WordEventDelegator: () => (/* binding */ WordEventDelegator)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(33);
/* harmony import */ var _registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(90);



/** Window after a touch during which emulated ("ghost") mouse events are ignored */
const GHOST_MOUSE_WINDOW = 700;
class WordEventDelegator {
    constructor() {
        this._initialised = false;
        this._sentenceMap = new WeakMap();
        this._lastTouchTime = 0;
        this._touchscreenLongPress = false;
        this._touchscreenLongPressDuration = 250;
        this._longPressTimer = null;
        this._longPressTarget = null;
        this._touchStartX = 0;
        this._touchStartY = 0;
        this.handleMouseEnter = (event) => {
            if (this.isGhostMouseEvent()) {
                return;
            }
            const target = this.findWordElement(event);
            if (target) {
                const sentence = this._sentenceMap.get(target);
                _registry__WEBPACK_IMPORTED_MODULE_2__.Registry.popupManager?.enter(target, sentence);
                this.findAdjacentWordElements(target).forEach((el) => el.classList.add('hovered'));
            }
        };
        this.handleMouseLeave = (event) => {
            if (this.isGhostMouseEvent()) {
                return;
            }
            const target = this.findWordElement(event);
            if (target) {
                _registry__WEBPACK_IMPORTED_MODULE_2__.Registry.popupManager?.leave();
                this.findAdjacentWordElements(target).forEach((el) => el.classList.remove('hovered'));
            }
        };
        this.handleClick = (event) => {
            const target = this.findWordElement(event);
            if (target) {
                const sentence = this._sentenceMap.get(target);
                _registry__WEBPACK_IMPORTED_MODULE_2__.Registry.popupManager?.touch(target, event, sentence);
            }
        };
        this.handleTouchStart = (event) => {
            this._lastTouchTime = Date.now();
            if (!this._touchscreenLongPress) {
                return;
            }
            const target = this.findWordElement(event);
            if (!target) {
                this.clearLongPress();
                return;
            }
            const touch = event.touches[0];
            this._touchStartX = touch.clientX;
            this._touchStartY = touch.clientY;
            this._longPressTarget = target;
            this._longPressTimer = setTimeout(() => {
                if (!this._longPressTarget) {
                    return;
                }
                const sentence = this._sentenceMap.get(this._longPressTarget);
                _registry__WEBPACK_IMPORTED_MODULE_2__.Registry.popupManager?.longPress(this._longPressTarget, sentence);
                this.clearLongPress();
            }, this._touchscreenLongPressDuration);
        };
        this.handleTouchEnd = () => {
            this._lastTouchTime = Date.now();
            this.clearLongPress();
        };
        this.handleTouchMove = (event) => {
            this._lastTouchTime = Date.now();
            if (!this._longPressTimer) {
                return;
            }
            const touch = event.touches[0];
            const dx = touch.clientX - this._touchStartX;
            const dy = touch.clientY - this._touchStartY;
            if (dx * dx + dy * dy > 100) {
                this.clearLongPress();
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
        if (this._initialised) {
            return;
        }
        this._initialised = true;
        this._broadcastDisposer = (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', async () => {
            this._touchscreenLongPress = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenLongPress');
            this._touchscreenLongPressDuration = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenLongPressDuration');
        }, true);
        document.addEventListener('mouseenter', this.handleMouseEnter, true);
        document.addEventListener('mouseleave', this.handleMouseLeave, true);
        document.addEventListener('click', this.handleClick, true);
        document.addEventListener('touchstart', this.handleTouchStart, true);
        document.addEventListener('touchend', this.handleTouchEnd, true);
        document.addEventListener('touchcancel', this.handleTouchEnd, true);
        document.addEventListener('touchmove', this.handleTouchMove, true);
    }
    destroy() {
        if (!this._initialised) {
            return;
        }
        this._broadcastDisposer?.();
        this._broadcastDisposer = undefined;
        document.removeEventListener('mouseenter', this.handleMouseEnter, true);
        document.removeEventListener('mouseleave', this.handleMouseLeave, true);
        document.removeEventListener('click', this.handleClick, true);
        document.removeEventListener('touchstart', this.handleTouchStart, true);
        document.removeEventListener('touchend', this.handleTouchEnd, true);
        document.removeEventListener('touchcancel', this.handleTouchEnd, true);
        document.removeEventListener('touchmove', this.handleTouchMove, true);
        this._initialised = false;
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
        if (!wordId) {
            return [element];
        }
        const elements = [element];
        let prev = element.previousElementSibling;
        while (prev) {
            if (prev.getAttribute('wordId') === wordId &&
                prev.getAttribute('readingIndex') === readingIndex) {
                elements.unshift(prev);
                prev = prev.previousElementSibling;
            }
            else if (!prev.hasAttribute('wordId')) {
                prev = prev.previousElementSibling;
            }
            else {
                break;
            }
        }
        let next = element.nextElementSibling;
        while (next) {
            if (next.getAttribute('wordId') === wordId &&
                next.getAttribute('readingIndex') === readingIndex) {
                elements.push(next);
                next = next.nextElementSibling;
            }
            else if (!next.hasAttribute('wordId')) {
                next = next.nextElementSibling;
            }
            else {
                break;
            }
        }
        return elements;
    }
    isGhostMouseEvent() {
        return Date.now() - this._lastTouchTime < GHOST_MOUSE_WINDOW;
    }
    clearLongPress() {
        if (this._longPressTimer) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
        this._longPressTarget = null;
    }
}
WordEventDelegator._instance = null;


/***/ }),
/* 108 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   PopupManager: () => (/* binding */ PopupManager)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(33);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(109);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(90);
/* harmony import */ var _actions_grading_actions__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(111);
/* harmony import */ var _actions_grading_controller__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(113);
/* harmony import */ var _actions_mining_actions__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(116);
/* harmony import */ var _actions_mining_controller__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(117);
/* harmony import */ var _actions_rotation_actions__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(118);
/* harmony import */ var _actions_rotation_controller__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(119);
/* harmony import */ var _popup__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(120);











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
        this._lastTapTime = 0;
        this._lastTapTarget = null;
        this._observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.removedNodes) {
                    if (node === this._currentHover || node.contains(this._currentHover)) {
                        this._observer.disconnect();
                        this._popup.hide();
                        return;
                    }
                }
            }
        });
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', async () => {
            this._showPopupOnHover = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showPopupOnHover');
            this._touchscreenSupport = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenSupport');
            this._touchscreenDoubleTap = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenDoubleTap');
        }, true);
        _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry.events.on('showPopupKey', () => this.handlePopup(true));
        _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry.events.on('showAdvancedDialogKey', () => this.handleAdvancedDialog());
    }
    /**
     * Register a node for keybinds and the popup itself. Shows the popup if configured to do so.
     *
     * @param {HTMLElement} element The jiten-word element being hovered
     * @param {string} [sentence] The sentence containing this word
     * @returns {void}
     */
    enter(element, sentence) {
        this._currentHover = element;
        this._currentSentence = sentence;
        this._keyManager.activate();
        this._miningActions.activate(this._currentHover, sentence);
        this._rotationActions.activate(this._currentHover);
        this._gradingActions.activate(this._currentHover, sentence);
        if (this._showPopupOnHover) {
            this.handlePopup(false);
        }
    }
    touch(element, event, sentence) {
        if (!this._touchscreenSupport || !element || _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry.skipTouchEvents) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (this._touchscreenDoubleTap) {
            const now = Date.now();
            const isDoubleTap = this._lastTapTarget === element && now - this._lastTapTime < 300;
            this._lastTapTime = now;
            this._lastTapTarget = element;
            if (!isDoubleTap) {
                return;
            }
        }
        this.activateAndShow(element, sentence);
    }
    longPress(element, sentence) {
        if (!this._touchscreenSupport || !element || _integration_registry__WEBPACK_IMPORTED_MODULE_3__.Registry.skipTouchEvents) {
            return;
        }
        this.activateAndShow(element, sentence);
    }
    /**
     * Leave the current context. Deactivates keybinds. If the popup currently open, it will be hidden after a short delay
     *
     * @returns {void}
     */
    leave() {
        this._currentHover = undefined;
        this._currentSentence = undefined;
        this._observer.disconnect();
        this._keyManager.deactivate();
        this._miningActions.deactivate();
        this._rotationActions.deactivate();
        this._gradingActions.deactivate();
        this._popup.initHide();
    }
    activateAndShow(element, sentence) {
        this._currentHover = element;
        this._currentSentence = sentence;
        this._keyManager.activate();
        this._miningActions.activate(this._currentHover, sentence);
        this._rotationActions.activate(this._currentHover);
        this._gradingActions.activate(this._currentHover, sentence);
        this.handlePopup(true);
    }
    /**
     * Event handler is reached if an element is hovered and the keybind for popup is pressed.
     * Also called if the popup is configured to show on hover and the mouse is moved over an element.
     *
     * @param {boolean} explicit Whether the popup was opened deliberately (keybind/click/long-press)
     *   rather than automatically on hover. Only explicit opens arm the auto-fail-on-dwell timer.
     * @returns
     */
    handlePopup(explicit) {
        if (!this._currentHover) {
            return;
        }
        this._popup.show(this._currentHover, this._currentSentence, explicit);
        this._observer.disconnect();
        if (this._currentHover.parentElement) {
            this._observer.observe(this._currentHover.parentElement, { childList: true });
        }
    }
    handleAdvancedDialog() {
        // TODO: Show the advanced dialog
    }
}


/***/ }),
/* 109 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   KeybindManager: () => (/* binding */ KeybindManager)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(33);
/* harmony import */ var _no_focus_trigger__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(110);
/* harmony import */ var _registry__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(90);




class KeybindManager {
    constructor(_events, extraListeners, _gate) {
        this._events = _events;
        this._gate = _gate;
        /** Map of configured keybinds */
        this._keyMap = {};
        this._sortedKeylist = [];
        /** Reference which can be added or removed as event listener */
        this._downListener = this.handleKeydown.bind(this);
        this._upListener = this.handleKeyUp.bind(this);
        this._broadcastDisposer = (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', () => this.buildKeyMap(), true);
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
    destroy() {
        this.deactivate();
        this._broadcastDisposer();
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
        // Sort the keybinds by the number of modifiers they have, then by the key code
        // This way we can prioritize keybinds with more modifiers, as they may extend other keybinds (e.g. ALT + KEY should have a lower priority than ALT + SHIFT + KEY)
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
            // Ignore events on input elements! Otherwise we may interfere with typing.
            return;
        }
        events.emit('keydown', e);
        this._keydown?.(e);
        const keybind = this.getActiveKeybind(e);
        if (keybind && (!this._gate || this._gate())) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            events.emit(keybind, e);
        }
    }
    handleKeyUp(e) {
        const { events } = _registry__WEBPACK_IMPORTED_MODULE_3__.Registry;
        if (this.shouldCancel()) {
            // Ignore events on input elements! Otherwise we may interfere with typing.
            return;
        }
        events.emit('keyup', e);
        this._keyup?.(e);
        const keybind = this.getActiveKeybind(e);
        if (keybind && (!this._gate || this._gate())) {
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
        // Map left/right-specific modifiers to their generic names
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
/* 110 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   NoFocusTrigger: () => (/* binding */ NoFocusTrigger)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(33);


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
        // When leaving focus, we install the mouse event listener, except if touchscreen support is enabled
        window.addEventListener('blur', () => {
            if (this._touchscreenSupport) {
                return;
            }
            document.addEventListener('mousemove', handler);
            hasEvent = true;
        });
        // When entering focus, we remove the mouse event listener, no matter what
        window.addEventListener('focus', () => {
            document.removeEventListener('mousemove', handler);
            hasEvent = false;
        });
        // We monitor touchscreen support. When it changes, we check and may install the mouse event listener
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
            // although this should not happen, we wanna play it safe
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
/* 111 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   GradingActions: () => (/* binding */ GradingActions)
/* harmony export */ });
/* harmony import */ var _shared_format_sentence__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(112);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(109);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(90);



/**
 * Handles keybinds for grading cards.
 */
class GradingActions {
    constructor(_controller) {
        this._controller = _controller;
        this._keyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_1__.KeybindManager([
            'jitenReviewNothing',
            'jitenReviewSomething',
            'jitenReviewHard',
            'jitenReviewOkay',
            'jitenReviewEasy',
            'jitenReviewFail',
            'jitenReviewPass',
        ]);
        const { events } = _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry;
        events.on('jitenReviewNothing', () => this.reviewCard('again'));
        events.on('jitenReviewSomething', () => this.reviewCard('again'));
        events.on('jitenReviewHard', () => this.reviewCard('hard'));
        events.on('jitenReviewOkay', () => this.reviewCard('good'));
        events.on('jitenReviewEasy', () => this.reviewCard('easy'));
        events.on('jitenReviewFail', () => this.reviewCard('again'));
        events.on('jitenReviewPass', () => this.reviewCard('good'));
    }
    activate(context, sentence) {
        this._card = _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.getCardFromElement(context);
        this._sentence = sentence;
        this._surfaceForm = GradingActions.getTextWithoutFurigana(context) || undefined;
        this._keyManager.activate();
    }
    deactivate() {
        this._card = undefined;
        this._sentence = undefined;
        this._surfaceForm = undefined;
        this._keyManager.deactivate();
    }
    reviewCard(rating) {
        if (!this._card) {
            return;
        }
        const sentence = this._sentence && this._surfaceForm
            ? (0,_shared_format_sentence__WEBPACK_IMPORTED_MODULE_0__.formatSentenceWithMarkers)(this._sentence, this._surfaceForm)
            : undefined;
        this._controller.gradeCard(this._card, rating, sentence, document.title);
    }
    static getTextWithoutFurigana(element) {
        let text = '';
        for (const node of element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            }
            else if (node instanceof HTMLElement && node.tagName !== 'RT') {
                text += GradingActions.getTextWithoutFurigana(node);
            }
        }
        return text;
    }
}


/***/ }),
/* 112 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   formatSentenceWithMarkers: () => (/* binding */ formatSentenceWithMarkers)
/* harmony export */ });
const MAX_SENTENCE_LENGTH = 150;
const MARKER_OVERHEAD = 4; // length of "**" + "**"
const formatSentenceWithMarkers = (sentence, surfaceForm) => {
    if (!sentence || !surfaceForm) {
        return undefined;
    }
    const index = sentence.indexOf(surfaceForm);
    if (index === -1) {
        return undefined;
    }
    const marked = sentence.slice(0, index) + `**${surfaceForm}**` + sentence.slice(index + surfaceForm.length);
    if (marked.length <= MAX_SENTENCE_LENGTH) {
        return marked;
    }
    const budget = MAX_SENTENCE_LENGTH - surfaceForm.length - MARKER_OVERHEAD;
    if (budget <= 0) {
        return undefined;
    }
    const before = sentence.slice(0, index);
    const after = sentence.slice(index + surfaceForm.length);
    const halfBudget = Math.floor(budget / 2);
    const trimmedBefore = before.length > halfBudget ? before.slice(-halfBudget) : before;
    const remainingBudget = budget - trimmedBefore.length;
    const trimmedAfter = after.length > remainingBudget ? after.slice(0, remainingBudget) : after;
    return trimmedBefore + `**${surfaceForm}**` + trimmedAfter;
};


/***/ }),
/* 113 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   GradingController: () => (/* binding */ GradingController)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(4);
/* harmony import */ var _shared_messages_background_add_to_study_deck_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(36);
/* harmony import */ var _shared_messages_background_grade_card_command__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(54);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(90);
/* harmony import */ var _integration_review_cooldown__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(114);
/* harmony import */ var _base_controller__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(115);







class GradingController extends _base_controller__WEBPACK_IMPORTED_MODULE_6__.BaseController {
    constructor() {
        super(...arguments);
        this._massReviewCooldownHours = 20;
    }
    get gradingEnabled() {
        return !this._disableReviews;
    }
    get showActions() {
        return this._showActions && this.gradingEnabled;
    }
    getGradingActions() {
        return this._useTwoPointGrading ? ['again', 'good'] : ['again', 'hard', 'good', 'easy'];
    }
    gradeCard(card, rating, sentence, source) {
        if (!this.gradingEnabled ||
            card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.REDUNDANT) ||
            !this.getGradingActions().includes(rating)) {
            return;
        }
        const { wordId, readingIndex } = card;
        // Any card the user grades directly (or that is auto-failed, which routes through here)
        // is excluded from mass review — for the rest of the session and, across navigations,
        // for the cooldown window — so a later mass review can't override the grade just given.
        _integration_registry__WEBPACK_IMPORTED_MODULE_4__.Registry.markSessionTouched(wordId, readingIndex);
        void _integration_review_cooldown__WEBPACK_IMPORTED_MODULE_5__.ReviewCooldown.mark([{ wordId, readingIndex }], this._massReviewCooldownHours);
        new _shared_messages_background_grade_card_command__WEBPACK_IMPORTED_MODULE_3__.GradeCardCommand(wordId, readingIndex, rating).send(() => {
            const deckId = this.getAutoMineDeckId(card);
            if (deckId) {
                new _shared_messages_background_add_to_study_deck_command__WEBPACK_IMPORTED_MODULE_2__.AddToStudyDeckCommand(deckId, wordId, readingIndex, sentence, source).send(() => this.updateCardState(card));
                return;
            }
            this.updateCardState(card);
        });
    }
    async applyConfiguration() {
        this._useTwoPointGrading = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenUseTwoGrades');
        this._disableReviews = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenDisableReviews');
        this._showActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showGradingActions');
        this._autoMineOnReview = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenAutoMineOnReview');
        this._studyDeckId = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenStudyDeckId');
        this._massReviewCooldownHours = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('massReviewCooldownHours');
    }
    /**
     * Returns the target word list id to mine the reviewed card into, or 0 when auto-mining is off,
     * no target word list is selected, or the card is already in that list.
     */
    getAutoMineDeckId(card) {
        if (!this._autoMineOnReview) {
            return 0;
        }
        const deckId = Number(this._studyDeckId);
        if (!deckId || card.deckIds.includes(deckId)) {
            return 0;
        }
        return deckId;
    }
}


/***/ }),
/* 114 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ReviewCooldown: () => (/* binding */ ReviewCooldown)
/* harmony export */ });
/* harmony import */ var _shared_extension_read_storage__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(2);
/* harmony import */ var _shared_extension_write_storage__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(12);


const STORAGE_KEY = 'ajb-mass-review-cooldown';
const HOUR_MS = 3_600_000;
const key = (wordId, readingIndex) => `${wordId}/${readingIndex}`;
/**
 * Persisted per-word cooldown so the same word isn't pushed through the SRS as "good"
 * repeatedly over a short period (e.g. re-reviewing the same words across pages).
 */
class ReviewCooldown {
    static async isCoolingDown(wordId, readingIndex, cooldownHours) {
        if (cooldownHours <= 0) {
            return false;
        }
        const map = await this.load();
        const timestamp = map[key(wordId, readingIndex)];
        return timestamp !== undefined && Date.now() - timestamp < cooldownHours * HOUR_MS;
    }
    static async mark(entries, cooldownHours) {
        const map = await this.load();
        const now = Date.now();
        for (const entry of entries) {
            map[key(entry.wordId, entry.readingIndex)] = now;
        }
        if (cooldownHours > 0) {
            const cutoff = now - cooldownHours * HOUR_MS;
            for (const storedKey of Object.keys(map)) {
                if (map[storedKey] < cutoff) {
                    delete map[storedKey];
                }
            }
        }
        this.cache = map;
        await (0,_shared_extension_write_storage__WEBPACK_IMPORTED_MODULE_1__.writeStorage)(STORAGE_KEY, JSON.stringify(map));
    }
    static async load() {
        if (this.cache) {
            return this.cache;
        }
        try {
            this.cache = JSON.parse(await (0,_shared_extension_read_storage__WEBPACK_IMPORTED_MODULE_0__.readStorage)(STORAGE_KEY, '{}'));
        }
        catch {
            this.cache = {};
        }
        return this.cache;
    }
}


/***/ }),
/* 115 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BaseController: () => (/* binding */ BaseController)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(61);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(33);


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
/* 116 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MiningActions: () => (/* binding */ MiningActions)
/* harmony export */ });
/* harmony import */ var _shared_format_sentence__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(112);
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(4);
/* harmony import */ var _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(59);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(109);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(90);





class MiningActions {
    constructor(_controller) {
        this._controller = _controller;
        this._keyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_3__.KeybindManager([
            'addToStudyDeckKey',
            'addToMiningKey',
            'addToBlacklistKey',
            'addToNeverForgetKey',
            'addToSuspendedKey',
            'cycleMasterBlacklistKey',
        ]);
        const { events } = _integration_registry__WEBPACK_IMPORTED_MODULE_4__.Registry;
        events.on('addToStudyDeckKey', () => this.mineToStudyDeck());
        events.on('addToMiningKey', () => this.addToDeck('mining'));
        events.on('addToBlacklistKey', () => this.addToDeck('blacklist'));
        events.on('addToNeverForgetKey', () => this.addToDeck('neverForget'));
        events.on('addToSuspendedKey', () => this.addToDeck('suspend'));
        events.on('cycleMasterBlacklistKey', () => this.cycleMasterBlacklist());
    }
    activate(context, sentence) {
        this._card = _integration_registry__WEBPACK_IMPORTED_MODULE_4__.Registry.getCardFromElement(context);
        this._sentence = sentence;
        this._surfaceForm = MiningActions.getTextWithoutFurigana(context) || undefined;
        this._keyManager.activate();
    }
    deactivate() {
        this._card = undefined;
        this._sentence = undefined;
        this._surfaceForm = undefined;
        this._keyManager.deactivate();
    }
    mineToStudyDeck() {
        if (!this._card) {
            return;
        }
        const deckId = Number(this._controller.studyDeckId);
        if (!deckId || !this._controller.autoMineToStudyDeck) {
            return;
        }
        const sentence = this._sentence && this._surfaceForm
            ? (0,_shared_format_sentence__WEBPACK_IMPORTED_MODULE_0__.formatSentenceWithMarkers)(this._sentence, this._surfaceForm)
            : undefined;
        this._controller.addToStudyDeck(deckId, this._card, sentence, document.title);
    }
    addToDeck(key) {
        if (!this._card) {
            return;
        }
        const state = MiningActions.STATE_MAP[key];
        const action = state && this._card.cardState.includes(state) ? 'remove' : 'add';
        this._controller.addOrRemove(action, key, this._card, this._sentence);
    }
    cycleMasterBlacklist() {
        if (!this._card) {
            return;
        }
        const card = this._card;
        const { wordId, readingIndex } = card;
        if (this._pendingCard?.wordId !== wordId || this._pendingCard?.readingIndex !== readingIndex) {
            this._originalCardState = [...card.cardState];
            this._pendingCard = card;
        }
        const nextState = this.getNextCycleState(card.cardState);
        _integration_registry__WEBPACK_IMPORTED_MODULE_4__.Registry.updateCard(wordId, readingIndex, nextState);
        if (this._cycleTimer) {
            clearTimeout(this._cycleTimer);
        }
        this._cycleTimer = setTimeout(() => this.flushCycle(), 400);
    }
    getNextCycleState(cardState) {
        const next = cardState.filter((s) => s !== _shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MASTERED && s !== _shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.BLACKLISTED);
        if (cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MASTERED)) {
            next.push(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.BLACKLISTED);
        }
        else if (!cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.BLACKLISTED)) {
            next.push(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MASTERED);
        }
        return next;
    }
    flushCycle() {
        this._cycleTimer = undefined;
        const card = this._pendingCard;
        const original = this._originalCardState;
        if (!card || !original) {
            return;
        }
        this._pendingCard = undefined;
        this._originalCardState = undefined;
        const hadMastered = original.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MASTERED);
        const hadBlacklisted = original.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.BLACKLISTED);
        const hasMastered = card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MASTERED);
        const hasBlacklisted = card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.BLACKLISTED);
        const instructions = [];
        if (hadMastered !== hasMastered) {
            instructions.push(new _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_2__.RunDeckActionCommand(card.wordId, card.readingIndex, 'neverForget', hasMastered ? 'add' : 'remove'));
        }
        if (hadBlacklisted !== hasBlacklisted) {
            instructions.push(new _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_2__.RunDeckActionCommand(card.wordId, card.readingIndex, 'blacklist', hasBlacklisted ? 'add' : 'remove'));
        }
        if (instructions.length === 0) {
            return;
        }
        this._controller.suspendUpdateWordStates();
        const executeInstructions = (index) => {
            if (index < instructions.length) {
                instructions[index].send(() => executeInstructions(index + 1));
            }
            else {
                this._controller.resumeUpdateWordStates(card);
            }
        };
        executeInstructions(0);
    }
    static getTextWithoutFurigana(element) {
        let text = '';
        for (const node of element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            }
            else if (node instanceof HTMLElement && node.tagName !== 'RT') {
                text += MiningActions.getTextWithoutFurigana(node);
            }
        }
        return text;
    }
}
MiningActions.STATE_MAP = {
    neverForget: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MASTERED,
    blacklist: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.BLACKLISTED,
    suspend: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.SUSPENDED,
};


/***/ }),
/* 117 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MiningController: () => (/* binding */ MiningController)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(4);
/* harmony import */ var _shared_messages_background_add_to_study_deck_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(36);
/* harmony import */ var _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(59);
/* harmony import */ var _base_controller__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(115);





class MiningController extends _base_controller__WEBPACK_IMPORTED_MODULE_4__.BaseController {
    get showActions() {
        return this._showActions;
    }
    get autoMineToStudyDeck() {
        return this._autoMineToStudyDeck;
    }
    get studyDeckId() {
        return this._studyDeckId;
    }
    addOrRemove(action, key, card, sentence) {
        if (card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.REDUNDANT)) {
            return;
        }
        const { wordId, readingIndex } = card;
        new _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_3__.RunDeckActionCommand(wordId, readingIndex, key, action, sentence).send(() => this.updateCardState(card));
    }
    addToStudyDeck(deckId, card, sentence, source) {
        if (card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.REDUNDANT)) {
            return;
        }
        new _shared_messages_background_add_to_study_deck_command__WEBPACK_IMPORTED_MODULE_2__.AddToStudyDeckCommand(deckId, card.wordId, card.readingIndex, sentence, source).send(() => this.updateCardState(card));
    }
    async applyConfiguration() {
        this._showActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showDeckButton');
        this._autoMineToStudyDeck = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenMineToStudyDeck');
        this._studyDeckId = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenStudyDeckId');
    }
}


/***/ }),
/* 118 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RotationActions: () => (/* binding */ RotationActions)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(33);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(109);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(90);




/**
 * Handles keybinds for rotating flags on cards.
 */
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
/* 119 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RotationController: () => (/* binding */ RotationController)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(4);
/* harmony import */ var _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(59);
/* harmony import */ var _base_controller__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(115);




class RotationController extends _base_controller__WEBPACK_IMPORTED_MODULE_3__.BaseController {
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
        if (!this.rotateFlags || card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.REDUNDANT)) {
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
            instructions.push(new _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_2__.RunDeckActionCommand(card.wordId, card.readingIndex, state, state === nextState ? 'add' : 'remove'));
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
/* 120 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Popup: () => (/* binding */ Popup)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(11);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(20);
/* harmony import */ var _shared_dom_find_elements__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(121);
/* harmony import */ var _shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(122);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(21);
/* harmony import */ var _shared_format_sentence__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(112);
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(4);
/* harmony import */ var _shared_messages_background_fetch_study_decks_command__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(49);
/* harmony import */ var _shared_messages_background_forget_card_command__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(51);
/* harmony import */ var _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(61);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(33);
/* harmony import */ var _shared_pitch_accent_utils__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(123);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(124);
/* harmony import */ var _shared_tts_play_tts__WEBPACK_IMPORTED_MODULE_15__ = __webpack_require__(125);
/* harmony import */ var _integration_flash_words__WEBPACK_IMPORTED_MODULE_16__ = __webpack_require__(126);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_17__ = __webpack_require__(109);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_18__ = __webpack_require__(90);
/* harmony import */ var _integration_review_cooldown__WEBPACK_IMPORTED_MODULE_19__ = __webpack_require__(114);
/* harmony import */ var _confirm_dialog__WEBPACK_IMPORTED_MODULE_20__ = __webpack_require__(127);
/* harmony import */ var _part_of_speech__WEBPACK_IMPORTED_MODULE_21__ = __webpack_require__(128);






















class Popup {
    constructor(_mining, _rotation, _grading) {
        this._mining = _mining;
        this._rotation = _rotation;
        this._grading = _grading;
        this._keyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_17__.KeybindManager([], {
            keydown: (e) => this.handleKeydown(e),
        });
        /** Closes the popup when a pointer (mouse or touch) is pressed outside of it */
        this._outsidePointerListener = this.handleOutsidePointer.bind(this);
        /**
         * This is the root element of the popup, which is attached to the host page or iframe.
         * It manages the shadow root isolating the actual popup content.
         */
        this._root = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
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
        //#region Utility Accessors
        /** Theme CSS variables - syncronised with extension storage */
        this._themeStyles = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('style');
        /** The user declared styles - syncronised with extension storage */
        this._customStyles = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('style');
        this._closeButton = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('section', {
            id: 'close',
            class: ['controls'],
            style: {
                display: 'none', // Hidden by default
            },
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
                    id: 'close-btn',
                    class: ['outline', 'close'],
                    handler: () => this.hide(),
                }),
            ],
        });
        /** Contains the card action and mining buttons */
        this._mineButtons = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('section', { id: 'mining', class: ['controls'] });
        /** Contains the buttons to manage the card rotation */
        this._rotateButtons = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('section', { id: 'rotation', class: ['controls'] });
        /** Contains the buttons to manage card states */
        this._gradeButtons = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('section', { id: 'grading', class: ['controls'] });
        /** Contains the header data - all information about a word except its meaning */
        this._context = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('section', { id: 'context' });
        /** Contains the various meanings of a word */
        this._details = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('section', { id: 'details' });
        this._resizeHandle = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', { class: ['resize-handle'] });
        //#endregion
        /**
         * The rendered popup content itself
         */
        this._popup = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['popup'],
            events: {
                onmouseenter: () => this.startHover(),
                onmouseleave: () => this.stopHover(),
            },
            children: [],
        });
        this._popupWidth = 350;
        this._popupHeight = 250;
        this._autoFailOnDwell = false;
        this._autoFailDwellDuration = 500;
        this._massReviewCooldownHours = 20;
        this._isResizing = false;
        this._popupLeft = 0;
        this._popupTop = 0;
        this.renderNodes();
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_12__.onBroadcastMessage)('cardStateUpdated', (wordId, readingIndex) => {
            setTimeout(() => {
                this._card = _integration_registry__WEBPACK_IMPORTED_MODULE_18__.Registry.getCard(wordId, readingIndex);
                // Auto-fail grades the card while the user is still reading it, so its own state
                // update must not close the popup.
                if (this._skipHideForCard === `${wordId}/${readingIndex}`) {
                    this._skipHideForCard = undefined;
                    return this.rerender();
                }
                if (this._hideAfterAction) {
                    return this.hide();
                }
                this.rerender();
            }, 1);
        });
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_12__.onBroadcastMessage)('configurationUpdated', () => this.applyConfiguration(), true);
    }
    show(context, sentence, explicit = false) {
        this._cardContext = context;
        this._card = _integration_registry__WEBPACK_IMPORTED_MODULE_18__.Registry.getCardFromElement(context);
        this._sentence = sentence;
        this._conjugations = _integration_registry__WEBPACK_IMPORTED_MODULE_18__.Registry.getConjugations(context);
        this.clearTimer();
        this.clearDwellTimer();
        this.updateParentElement();
        this.rerender();
        this.setPosition();
        Object.assign(this._root.style, {
            transition: this._disableFadeAnimation ? 'none' : 'opacity 60ms ease-in, visibility 60ms',
            opacity: '1',
            visibility: 'visible',
        });
        this._keyManager.activate();
        window.addEventListener('pointerdown', this._outsidePointerListener, true);
        if (this._ttsAutoPlay && this._card) {
            const key = `${this._card.wordId}/${this._card.readingIndex}`;
            if (this._lastAutoPlayKey !== key) {
                this._lastAutoPlayKey = key;
                void this.playCardTts(this._card);
            }
        }
        this.armDwellTimer(explicit);
    }
    hide() {
        (0,_shared_tts_play_tts__WEBPACK_IMPORTED_MODULE_15__.stopTts)();
        this.clearDwellTimer();
        Object.assign(this._root.style, {
            transition: this._disableFadeAnimation ? 'none' : 'opacity 200ms ease-in, visibility 20ms',
            opacity: '0',
            visibility: 'hidden',
        });
        this._keyManager.deactivate();
        window.removeEventListener('pointerdown', this._outsidePointerListener, true);
    }
    initHide() {
        // Leaving the word cancels any pending auto-fail so a quick look-and-leave isn't penalised.
        this.clearDwellTimer();
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
    //#region Configuration
    async applyConfiguration() {
        this._hidePopupAutomatically = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('hidePopupAutomatically');
        this._hidePopupDelay = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('hidePopupDelay');
        this._hideAfterAction = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('hideAfterAction');
        this._autoFailOnDwell = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('autoFailOnDwell');
        this._autoFailDwellDuration = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('autoFailDwellDuration');
        this._massReviewCooldownHours = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('massReviewCooldownHours');
        this._disableFadeAnimation = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('disableFadeAnimation');
        this._leftAlignPopupToWord = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('leftAlignPopupToWord');
        this._renderCloseButton = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('renderCloseButton');
        this._closeButtonBottomLeft = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('closeButtonBottomLeft');
        this._touchscreenSupport = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenSupport');
        this._showMiningActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showMiningActions');
        this._moveMiningActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('moveMiningActions');
        this._moveRotationActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('moveRotateActions');
        this._moveGradingActions = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('moveGradingActions');
        this._showConjugations = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showConjugations');
        this._showPitchDiagrams = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showPitchDiagrams');
        this._showDeckMembership = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showDeckMembership');
        this._disableHeadWordLink = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('disableHeadWordLink');
        this._ttsVoice = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('ttsVoice');
        this._ttsAutoPlay = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('ttsAutoPlay');
        this._popupWidth = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('popupWidth');
        this._popupHeight = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('popupHeight');
        this.applyDimensions();
        this._themeStyles.textContent = await (0,_shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_14__.getThemeCssVars)();
        this._customStyles.textContent = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('customPopupCSS');
        this._closeButton.style.display =
            this._touchscreenSupport && this._renderCloseButton ? 'flex' : 'none';
        this._closeButton.classList.toggle('bottom-left', this._closeButtonBottomLeft);
        this.updateMiningButtons();
        this.updateRotationButtons();
        this.updateGradingButtons();
        this.applyPositions();
    }
    //#endregion
    //#region Install the popup
    /**
     * Installs all components and initializes the shadow root
     */
    renderNodes() {
        this._shadowRoot = this._root.attachShadow({ mode: 'closed' });
        this._shadowRoot.append((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('link', { attributes: { rel: 'stylesheet', href: (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_6__.getStyleUrl)('popup') } }), this._themeStyles, this._customStyles, this._popup);
        this._popup.appendChild(this._resizeHandle);
        this.initResize();
        this._confirmDialog = new _confirm_dialog__WEBPACK_IMPORTED_MODULE_20__.ConfirmDialog(this._shadowRoot, () => ({
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
        return (0,_shared_dom_find_elements__WEBPACK_IMPORTED_MODULE_4__.findElements)('video').find((videoElement) => document.fullscreenElement.contains(videoElement));
    }
    findElementForFullscreenVideoDisplay(videoElement) {
        let currentNode = videoElement.parentElement;
        let chosenNode;
        const testNode = document.createElement('div');
        testNode.style.position = 'absolute';
        testNode.style.zIndex = '2147483647';
        testNode.innerText = '&nbsp;'; // The node needs to take up some space to perform test clicks
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
    //#endregion
    //#region Position the popup
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
            // Align the popup to the left of the word
            // Ensure the popup does not overflow the right edge of the screen, also add a bit of padding
            popupLeft = Math.min(wordLeft, innerWidth - popupWidth - 8);
        }
        if (innerWidth < 450) {
            popupLeft = 8;
            this._root.style.width = `${innerWidth - 32}px`;
            this._popup.style.width = `${innerWidth - 32}px`;
        }
        else {
            this._root.style.width = '';
            this._popup.style.width = '';
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
        // Merge client rects that are adjacent
        // This works around a Chrome issue, where sometimes, non-deterministically,
        // inline child elements will get separate client rects, even if they are on the same line.
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
    //#endregion
    //#region Button Renderer
    updateMiningButtons() {
        const performDeckAction = (action, key) => this._mining.addOrRemove(action, key, this._card, this._sentence);
        const performFlaggedDeckAction = (key) => {
            const action = this.cardHasState(key, this._card) ? 'remove' : 'add';
            performDeckAction(action, key);
        };
        this._mineButtons.replaceChildren();
        this.addMiningButton('neverForget', 'never-forget', undefined, () => performFlaggedDeckAction('neverForget'));
        this.addMiningButton('blacklist', 'blacklist', undefined, () => performFlaggedDeckAction('blacklist'));
        this._mineButtons.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
            id: 'forget-deck',
            class: ['outline', 'forget'],
            innerText: 'Forget',
            handler: () => void this.handleForgetClick(),
        }));
        this.renderDeckButton(this._card);
        this._mineButtons.style.display = this._showMiningActions ? '' : 'none';
    }
    /**
     * Builds (or rebuilds) the Deck+ button for the given card. Idempotent: removes any previous
     * instance first, so it can run on first build and on each per-card rerender.
     */
    renderDeckButton(card) {
        this._mineButtons.querySelector('#add-to-deck')?.remove();
        const deckId = Number(this._mining.studyDeckId);
        if (!((deckId || !this._mining.autoMineToStudyDeck) && this._mining.showActions)) {
            return;
        }
        // When a single target deck is configured, disable the button once the word is already in it.
        const alreadyInTargetDeck = this._mining.autoMineToStudyDeck && deckId > 0 && !!card?.deckIds.includes(deckId);
        const inWordList = !alreadyInTargetDeck &&
            !!card &&
            (this.groupDecksByType(card).get(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.StudyDeckType.STATIC_WORD_LIST)?.length ?? 0) > 0;
        const classes = ['outline', 'mining'];
        let label = 'Deck +';
        let handler = () => void this.handleAddToDeck();
        if (alreadyInTargetDeck) {
            classes.push('disabled');
            label = 'In deck';
            handler = undefined;
        }
        else if (inWordList) {
            // Already in a word list, but still clickable to add to others.
            classes.push('in-list');
            label = '✓ In list';
        }
        this._mineButtons.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', { id: 'add-to-deck', class: classes, innerText: label, handler }));
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
        new _shared_messages_background_forget_card_command__WEBPACK_IMPORTED_MODULE_10__.ForgetCardCommand(wordId, readingIndex).send(() => {
            new _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_11__.UpdateCardStateCommand(wordId, readingIndex).send();
        });
    }
    getFormattedSentence() {
        if (!this._cardContext || !this._sentence) {
            return undefined;
        }
        const surfaceForm = this.getTextWithoutFurigana(this._cardContext);
        if (!surfaceForm) {
            return undefined;
        }
        return (0,_shared_format_sentence__WEBPACK_IMPORTED_MODULE_7__.formatSentenceWithMarkers)(this._sentence, surfaceForm);
    }
    getTextWithoutFurigana(element) {
        let text = '';
        for (const node of element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            }
            else if (node instanceof HTMLElement) {
                if (node.tagName !== 'RT') {
                    text += this.getTextWithoutFurigana(node);
                }
            }
        }
        return text;
    }
    async handleAddToDeck() {
        if (!this._card) {
            return;
        }
        const deckId = Number(this._mining.studyDeckId);
        if (this._mining.autoMineToStudyDeck && deckId) {
            this._mining.addToStudyDeck(deckId, this._card, this.getFormattedSentence(), document.title);
            this.toastDeckAction(undefined);
            if (this._hideAfterAction) {
                this.hide();
            }
            return;
        }
        try {
            const decks = await new _shared_messages_background_fetch_study_decks_command__WEBPACK_IMPORTED_MODULE_9__.FetchStudyDecksCommand().call();
            if (decks) {
                _integration_registry__WEBPACK_IMPORTED_MODULE_18__.Registry.setStudyDecks(decks);
            }
            // Only static word-list decks can be added to manually.
            const staticDecks = (decks ?? []).filter((deck) => deck.deckType === _shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.StudyDeckType.STATIC_WORD_LIST);
            if (!staticDecks.length) {
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast)('error', 'No word lists available. Create one in Jiten first.');
                return;
            }
            this.showDeckPicker(staticDecks);
        }
        catch {
            // API unreachable
        }
    }
    showDeckPicker(decks) {
        if (!this._shadowRoot) {
            return;
        }
        const existing = this._shadowRoot.getElementById('deck-picker-overlay');
        if (existing) {
            existing.remove();
            return;
        }
        const formattedSentence = this.getFormattedSentence();
        const source = document.title;
        const openedAt = Date.now();
        const close = () => overlay.remove();
        const dismissIfReady = () => {
            if (Date.now() - openedAt > 300) {
                close();
            }
        };
        const overlay = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            id: 'deck-picker-overlay',
            events: {
                onclick: dismissIfReady,
                ontouchstart: (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    dismissIfReady();
                },
            },
        });
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        const tx = scrollX - this._popupLeft;
        const ty = scrollY - this._popupTop;
        overlay.style.transform = `translate(${tx}px, ${ty}px)`;
        const buttons = decks.map((deck) => {
            const alreadyIn = !!this._card?.deckIds.includes(deck.userStudyDeckId);
            return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
                class: alreadyIn ? ['outline', 'mining', 'already-in'] : ['outline', 'mining'],
                innerText: alreadyIn ? `✓ ${deck.name}` : deck.name,
                handler: alreadyIn
                    ? () => close()
                    : () => {
                        if (this._card) {
                            this._mining.addToStudyDeck(deck.userStudyDeckId, this._card, formattedSentence, source);
                            this.toastDeckAction(deck.name);
                            if (this._hideAfterAction) {
                                this.hide();
                            }
                        }
                        close();
                    },
            });
        });
        const dialog = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            id: 'deck-picker-dialog',
            events: {
                onclick: (e) => e.stopPropagation(),
                ontouchstart: (e) => e.stopPropagation(),
            },
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('p', { id: 'deck-picker-title', innerText: 'Add to deck' }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', { id: 'deck-picker-list', children: buttons }),
            ],
        });
        overlay.appendChild(dialog);
        this._shadowRoot.appendChild(overlay);
    }
    addMiningButton(deck, id, text, handler) {
        if (!deck?.length) {
            return;
        }
        this._mineButtons.appendChild((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
            id: `${id}-deck`,
            class: ['outline', id],
            innerText: text,
            handler,
        }));
    }
    updateRotationButtons() {
        const previous = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
            id: 'previous',
            class: ['outline', 'previous'],
            innerText: 'Previous',
            handler: () => this._rotation.rotate(this._card, -1),
        });
        const next = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
            id: 'next',
            class: ['outline', 'next'],
            innerText: 'Next',
            handler: () => this._rotation.rotate(this._card, 1),
        });
        this._rotateButtons.replaceChildren(previous, next);
        this._rotateButtons.style.display = this._rotation.showActions ? '' : 'none';
    }
    updateGradingButtons() {
        const gradeButtons = this._grading.getGradingActions().map((grade) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
            id: grade,
            class: ['outline', grade],
            innerText: grade,
            handler: () => this._grading.gradeCard(this._card, grade, this.getFormattedSentence(), document.title),
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
        this._popup.replaceChildren(...sections, this._resizeHandle);
    }
    //#endregion
    //#region Resize
    applyDimensions() {
        this._popup.style.setProperty('--popup-width', `${this._popupWidth}px`);
        this._popup.style.setProperty('--popup-height', `${this._popupHeight}px`);
    }
    initResize() {
        let startX;
        let startY;
        let startWidth;
        let startHeight;
        const onMouseMove = (e) => {
            const newWidth = Math.max(Popup.MIN_WIDTH, startWidth + (e.clientX - startX));
            const newHeight = Math.max(Popup.MIN_HEIGHT, startHeight + (e.clientY - startY));
            this._popupWidth = newWidth;
            this._popupHeight = newHeight;
            this.applyDimensions();
        };
        const onMouseUp = () => {
            this._isResizing = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            void (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.setConfiguration)('popupWidth', this._popupWidth);
            void (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.setConfiguration)('popupHeight', this._popupHeight);
        };
        this._resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startWidth = this._popupWidth;
            startHeight = this._popupHeight;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
    //#endregion
    //#region Card Utils
    cardHasState(state, card) {
        const stateMap = {
            neverForget: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.JitenCardState.MASTERED,
            blacklist: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.JitenCardState.BLACKLISTED,
            suspend: _shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.JitenCardState.SUSPENDED,
        };
        return card.cardState.includes(stateMap[state]);
    }
    //#endregion
    //#region On showing a popup
    rerender() {
        if (!this._card) {
            return;
        }
        this.adjustMiningButtons(this._card);
        this.adjustRotateButtons(this._card);
        this.adjustContext(this._card);
        this.adjustDetails(this._card);
        this.applyActionVisibility(this._card);
        this._popup.setAttribute('class', `popup ${this._card.cardState.join(' ')}`);
    }
    /**
     * Redundant words (known via their kanji sibling) have no card of their own, so the popup is
     * view-only for them: every actionable section is hidden regardless of configuration.
     */
    applyActionVisibility(card) {
        const reviewable = !card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.JitenCardState.REDUNDANT);
        this._mineButtons.style.display = reviewable && this._showMiningActions ? '' : 'none';
        this._rotateButtons.style.display = reviewable && this._rotation.showActions ? '' : 'none';
        this._gradeButtons.style.display = reviewable && this._grading.showActions ? '' : 'none';
    }
    adjustMiningButtons(card) {
        const isNF = this.cardHasState('neverForget', card);
        const isBL = this.cardHasState('blacklist', card);
        const isSP = this.cardHasState('suspend', card);
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)(this._mineButtons, '#never-forget-deck', (el) => {
            el.innerText = isNF ? 'Remove Never Forget' : 'Never forget';
        });
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)(this._mineButtons, '#blacklist-deck', (el) => {
            el.innerText = isBL ? 'Remove Blacklist' : 'Blacklist';
        });
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)(this._mineButtons, '#suspend-deck', (el) => {
            el.innerText = isSP ? 'Unsuspend' : 'Suspend';
        });
        this.renderDeckButton(card);
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
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)(this._rotateButtons, '#previous', (el) => {
            el.style.display = same ? 'none' : '';
            el.innerText = getText(previous, 'left');
            el.setAttribute('class', `outline previous ${getCls(previous)}`);
        });
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_5__.withElement)(this._rotateButtons, '#next', (el) => {
            el.innerText = getText(next, same ? undefined : 'right');
            el.setAttribute('class', `outline next ${getCls(next)}`);
        });
    }
    adjustContext(card) {
        this._context.replaceChildren((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            id: 'header',
            class: 'subsection',
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
                    id: 'headword',
                    children: [this.getReadingBlock(card), this.getTtsButton(card)],
                }),
                this.getCardStateBlock(card),
            ],
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            id: 'meta',
            class: 'subsection',
            children: [this.getPitchAccentBlock(card), this.getFrequencyBlock(card)],
        }), ...this.getDeckMembershipBlock(card));
    }
    groupDecksByType(card) {
        const groups = new Map();
        for (const id of card.deckIds) {
            const deck = _integration_registry__WEBPACK_IMPORTED_MODULE_18__.Registry.getStudyDeck(id);
            if (!deck) {
                continue;
            }
            const decks = groups.get(deck.deckType) ?? [];
            decks.push(deck);
            groups.set(deck.deckType, decks);
        }
        return groups;
    }
    getDeckMembershipBlock(card) {
        if (!this._showDeckMembership || !card.deckIds.length) {
            return [];
        }
        const labels = {
            [_shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.StudyDeckType.STATIC_WORD_LIST]: 'Word list',
            [_shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.StudyDeckType.MEDIA_DECK]: 'Media deck',
            [_shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.StudyDeckType.GLOBAL_DYNAMIC]: 'Freq deck',
        };
        const order = [
            _shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.StudyDeckType.STATIC_WORD_LIST,
            _shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.StudyDeckType.MEDIA_DECK,
            _shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.StudyDeckType.GLOBAL_DYNAMIC,
        ];
        const groups = this.groupDecksByType(card);
        if (groups.size === 0) {
            return [];
        }
        const rows = order
            .filter((type) => groups.has(type))
            .map((type) => {
            const decks = groups.get(type);
            const names = decks.map((deck) => deck.name).filter((name) => name?.trim().length);
            const label = decks.length > 1 ? `${labels[type]} ×${decks.length}` : labels[type];
            return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
                class: ['deck-membership-row'],
                children: [
                    (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['deck-dot', _shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.STUDY_DECK_CLASS[type]] }),
                    (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['deck-membership-label'], innerText: label }),
                    names.length
                        ? (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', {
                            class: ['deck-membership-names'],
                            innerText: names.join(', '),
                        })
                        : undefined,
                ],
            });
        });
        return [
            (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
                id: 'deck-membership',
                children: rows,
            }),
        ];
    }
    getReadingBlock(card) {
        const { wordId, spelling, readingIndex, wordWithReading } = card;
        const nodes = this.convertToRubyNodes(wordWithReading ?? spelling);
        if (this._disableHeadWordLink) {
            const span = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', {
                id: 'link',
                attributes: { lang: 'ja' },
            });
            span.append(...nodes);
            return span;
        }
        const url = `https://jiten.moe/vocabulary/${wordId}/${readingIndex}`;
        const a = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
            id: 'link',
            attributes: { href: url, target: '_blank', lang: 'ja' },
        });
        a.append(...nodes);
        return a;
    }
    getTtsButton(card) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8.5v7a4.47 4.47 0 002.5-3.5zM14 3.23v2.06a7.007 7.007 0 010 13.42v2.06A9.005 9.005 0 0014 3.23z');
        svg.appendChild(path);
        const btn = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('a', {
            id: 'tts-btn',
            handler: () => void this.playCardTts(card, btn),
        });
        btn.appendChild(svg);
        return btn;
    }
    async playCardTts(card, btn) {
        btn?.classList.add('playing');
        try {
            await (0,_shared_tts_play_tts__WEBPACK_IMPORTED_MODULE_15__.playTts)(card.wordId, card.readingIndex, this._ttsVoice);
        }
        catch {
            /* TTS errors are non-critical */
        }
        finally {
            btn?.classList.remove('playing');
        }
    }
    convertToRubyNodes(wordWithReading) {
        // If no brackets, return as a single text node
        if (!wordWithReading.includes('[')) {
            return [document.createTextNode(wordWithReading)];
        }
        // Regex to match kanji[reading] patterns
        const regex = /([^\u3040-\u309F\u30A0-\u30FF]+)\[(.+?)\]/g;
        const nodes = [];
        let lastIndex = 0;
        let match;
        while ((match = regex.exec(wordWithReading)) !== null) {
            // Add text before the match
            if (match.index > lastIndex) {
                nodes.push(document.createTextNode(wordWithReading.slice(lastIndex, match.index)));
            }
            // Create ruby element
            const ruby = document.createElement('ruby');
            const rt = document.createElement('rt');
            rt.textContent = match[2];
            ruby.append(document.createTextNode(match[1]));
            ruby.append(rt);
            nodes.push(ruby);
            lastIndex = regex.lastIndex;
        }
        // Add any remaining text after the last match
        if (lastIndex < wordWithReading.length) {
            nodes.push(document.createTextNode(wordWithReading.slice(lastIndex)));
        }
        return nodes;
    }
    getCardStateBlock(card) {
        const { cardState } = card;
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            id: 'state',
            children: cardState.map((s) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: [s], innerText: s })),
        });
    }
    getPitchAccentBlock(card) {
        const container = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', { id: 'pitch-accent' });
        if (!this._showPitchDiagrams) {
            return container;
        }
        const kana = (0,_shared_pitch_accent_utils__WEBPACK_IMPORTED_MODULE_13__.cleanReading)(card.reading);
        for (const pitch of card.pitchAccents) {
            const svg = this.renderPitchDiagram(kana, pitch);
            if (svg) {
                container.appendChild(svg);
            }
        }
        return container;
    }
    renderPitchDiagram(reading, pitchNum) {
        const data = (0,_shared_pitch_accent_utils__WEBPACK_IMPORTED_MODULE_13__.getPitchDiagramData)(reading, pitchNum);
        if (!data) {
            return null;
        }
        const { morae, pattern, color } = data;
        const ns = 'http://www.w3.org/2000/svg';
        const pointCount = pattern.length;
        const stepX = 18;
        const padX = 9;
        const width = pointCount * stepX;
        const height = 38;
        const highY = 5;
        const lowY = 17;
        const radius = 3;
        const textOffset = 8;
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const points = pattern.map((v, i) => ({
            x: padX + i * stepX,
            y: v === 1 ? highY : lowY,
        }));
        const polyline = document.createElementNS(ns, 'polyline');
        polyline.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', color);
        polyline.setAttribute('stroke-width', '1.5');
        svg.appendChild(polyline);
        for (let i = 0; i < pointCount; i++) {
            const isParticle = i === pointCount - 1;
            const circle = document.createElementNS(ns, 'circle');
            circle.setAttribute('cx', String(points[i].x));
            circle.setAttribute('cy', String(points[i].y));
            circle.setAttribute('r', String(radius));
            circle.setAttribute('fill', isParticle ? '#fff' : color);
            circle.setAttribute('stroke', color);
            circle.setAttribute('stroke-width', '1.5');
            svg.appendChild(circle);
            if (!isParticle && morae[i]) {
                const text = document.createElementNS(ns, 'text');
                text.setAttribute('x', String(points[i].x));
                text.setAttribute('y', String(points[i].y + textOffset));
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('dominant-baseline', 'hanging');
                text.setAttribute('fill', color);
                text.setAttribute('font-size', '9');
                text.setAttribute('font-weight', 'bold');
                text.setAttribute('font-family', "'Noto Sans JP', sans-serif");
                text.textContent = morae[i];
                svg.appendChild(text);
            }
        }
        return svg;
    }
    getFrequencyBlock(card) {
        const { frequencyRank } = card;
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            id: 'frequency',
            innerText: `#${frequencyRank}`,
        });
    }
    getConjugationsBlock(conjugations) {
        if (!conjugations || conjugations.length === 0) {
            return null;
        }
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            id: 'conjugations',
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', {
                    class: 'label',
                    innerText: 'Conjugations: ',
                }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', {
                    innerText: conjugations.join(' ; '),
                }),
            ],
        });
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
            (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
                class: 'pos',
                children: partsOfSpeech
                    .map((pos) => _part_of_speech__WEBPACK_IMPORTED_MODULE_21__.PARTS_OF_SPEECH[pos] ?? 'Unknown')
                    .filter(Boolean)
                    .map((pos) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { innerText: pos })),
            }),
            (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('ol', {
                attributes: {
                    start: (startIndex + 1).toString(),
                },
                children: glosses.map((g) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('li', {
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
    //#endregion
    //#region Others
    isVisibile() {
        return this._root.style.visibility === 'visible';
    }
    isDeckPickerOpen() {
        return this._shadowRoot?.getElementById('deck-picker-overlay') !== null;
    }
    toastDeckAction(deckName) {
        const word = this._cardContext ? this.getTextWithoutFurigana(this._cardContext) : '';
        const target = deckName ?? 'deck';
        (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast)('success', `${word} added to ${target}`);
    }
    startHover() {
        if (!this.isVisibile()) {
            return;
        }
        this.clearTimer();
    }
    stopHover() {
        if (!this.isVisibile()) {
            return;
        }
        if (this._isResizing || this._confirmDialog?.isOpen || this.isDeckPickerOpen()) {
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
    }
    /**
     * Dismisses the popup when a pointer is pressed outside of it. Uses the composed event path so it
     * behaves identically for mouse and touch, instead of relying on emulated hover state which is
     * unreliable on touchscreens.
     */
    handleOutsidePointer(e) {
        if (!this.isVisibile() || this._isResizing) {
            return;
        }
        // Never close from underneath an open modal (confirm dialog / deck picker).
        if (this._confirmDialog?.isOpen || this.isDeckPickerOpen()) {
            return;
        }
        // composedPath() includes the popup host element for any press inside the popup or its
        // overlays, even across the closed shadow boundary.
        if (e.composedPath().includes(this._root)) {
            return;
        }
        this.hide();
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
    clearDwellTimer() {
        if (this._dwellTimer) {
            clearTimeout(this._dwellTimer);
            this._dwellTimer = undefined;
        }
    }
    /**
     * Arms the auto-fail timer for explicitly opened popups. If the popup stays open on the
     * same card past the threshold, the word is reviewed "again" (the user clearly didn't know it).
     */
    armDwellTimer(explicit) {
        if (!explicit ||
            !this._autoFailOnDwell ||
            !this._card ||
            this._card.cardState.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_8__.JitenCardState.REDUNDANT)) {
            return;
        }
        const card = this._card;
        this._dwellTimer = setTimeout(() => {
            this._dwellTimer = undefined;
            void this.autoFail(card);
        }, this._autoFailDwellDuration);
    }
    async autoFail(card) {
        // Don't fail a word that was already reviewed (manually, by mass review, or by a previous
        // auto-fail) this session or within the cooldown window.
        if (_integration_registry__WEBPACK_IMPORTED_MODULE_18__.Registry.isSessionTouched(card.wordId, card.readingIndex) ||
            (await _integration_review_cooldown__WEBPACK_IMPORTED_MODULE_19__.ReviewCooldown.isCoolingDown(card.wordId, card.readingIndex, this._massReviewCooldownHours))) {
            return;
        }
        // Keep the popup open: this grade's own state update must not auto-hide it.
        this._skipHideForCard = `${card.wordId}/${card.readingIndex}`;
        this._grading.gradeCard(card, 'again', undefined, document.title);
        (0,_integration_flash_words__WEBPACK_IMPORTED_MODULE_16__.flashWords)(card.wordId, card.readingIndex, 'fail');
    }
}
Popup.MIN_WIDTH = 250;
Popup.MIN_HEIGHT = 200;


/***/ }),
/* 121 */
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
/* 122 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   withElement: () => (/* binding */ withElement)
/* harmony export */ });
/* harmony import */ var _find_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(25);

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
/* 123 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   cleanReading: () => (/* binding */ cleanReading),
/* harmony export */   getPitchDiagramData: () => (/* binding */ getPitchDiagramData)
/* harmony export */ });
const smallNonMora = new Set(['ゃ', 'ゅ', 'ょ', 'ャ', 'ュ', 'ョ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ']);
const splitMorae = (reading) => {
    const morae = [];
    for (const ch of reading) {
        if (morae.length > 0 && smallNonMora.has(ch)) {
            morae[morae.length - 1] += ch;
        }
        else {
            morae.push(ch);
        }
    }
    return morae;
};
const cleanReading = (reading) => reading.replace(/[\u4E00-\u9FFF\u3400-\u4DBF\uFF10-\uFF5A\[\]A-Za-z0-9]/g, '');
const PITCH_COLORS = {
    heiban: '#d20ca3',
    atamadaka: '#ea9316',
    nakadaka: '#27a2ff',
    odaka: '#0cd24d',
    unknown: '#cccccc',
};
const getPitchDiagramData = (reading, pitchNum) => {
    const morae = splitMorae(reading);
    const moraCount = morae.length;
    if (moraCount === 0) {
        return null;
    }
    const pattern = [];
    if (pitchNum === 0) {
        pattern.push(0);
        for (let i = 1; i < moraCount; i++) {
            pattern.push(1);
        }
        pattern.push(1);
    }
    else {
        pattern.push(pitchNum === 1 ? 1 : 0);
        for (let i = 1; i < moraCount; i++) {
            pattern.push(i < pitchNum ? 1 : 0);
        }
        pattern.push(0);
    }
    let patternName;
    if (pitchNum === 0) {
        patternName = 'heiban';
    }
    else if (pitchNum === 1) {
        patternName = 'atamadaka';
    }
    else if (pitchNum === moraCount) {
        patternName = 'odaka';
    }
    else if (pitchNum > 1 && pitchNum < moraCount) {
        patternName = 'nakadaka';
    }
    else {
        patternName = 'unknown';
    }
    return {
        morae,
        pattern,
        patternName,
        color: PITCH_COLORS[patternName] || PITCH_COLORS.unknown,
    };
};


/***/ }),
/* 124 */
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
/* 125 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   playTts: () => (/* binding */ playTts),
/* harmony export */   stopTts: () => (/* binding */ stopTts)
/* harmony export */ });
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);

function stopTts() {
    _extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.sendMessage({ type: 'stopTts' }, () => {
        void _extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.lastError;
    });
}
async function playTts(wordId, readingIndex, voice) {
    const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('TTS timeout')), 20_000);
        _extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.sendMessage({ type: 'playTts', wordId, readingIndex, voice }, (res) => {
            clearTimeout(timeout);
            if (_extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.lastError) {
                return reject(new Error(_extension_runtime__WEBPACK_IMPORTED_MODULE_0__.runtime.lastError.message));
            }
            resolve(res);
        });
    });
    if (!response?.ok) {
        throw new Error(response?.error ?? 'TTS playback failed');
    }
}


/***/ }),
/* 126 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   clearPendingHighlight: () => (/* binding */ clearPendingHighlight),
/* harmony export */   flashElements: () => (/* binding */ flashElements),
/* harmony export */   flashWords: () => (/* binding */ flashWords),
/* harmony export */   setPendingHighlight: () => (/* binding */ setPendingHighlight)
/* harmony export */ });
const CLASS_BY_KIND = {
    good: 'jiten-flash-good',
    fail: 'jiten-flash-fail',
};
/**
 * Briefly flashes a set of word elements to give visual feedback that they were
 * reviewed (green) or auto-failed (red). The class is removed once the animation
 * ends so it can be re-triggered later.
 */
function flashElements(elements, kind) {
    const cls = CLASS_BY_KIND[kind];
    const list = [...elements];
    for (const element of list) {
        element.classList.remove(cls);
    }
    // Force a single reflow so re-adding the class restarts the animation, rather than
    // one forced layout per element.
    void document.body.offsetWidth;
    for (const element of list) {
        element.classList.add(cls);
        const onEnd = () => {
            element.classList.remove(cls);
            element.removeEventListener('animationend', onEnd);
        };
        element.addEventListener('animationend', onEnd);
    }
}
function flashWords(wordId, readingIndex, kind) {
    flashElements(document.querySelectorAll(`[wordId="${wordId}"][readingIndex="${readingIndex}"]`), kind);
}
const PENDING_CLASS = 'jiten-review-pending';
/**
 * Marks the words a pending mass review would affect with a static highlight, so the user
 * can see exactly what will be marked before confirming.
 */
function setPendingHighlight(elements) {
    clearPendingHighlight();
    for (const element of elements) {
        element.classList.add(PENDING_CLASS);
    }
}
function clearPendingHighlight() {
    document.querySelectorAll(`.${PENDING_CLASS}`).forEach((element) => {
        element.classList.remove(PENDING_CLASS);
    });
}


/***/ }),
/* 127 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ConfirmDialog: () => (/* binding */ ConfirmDialog)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(22);

class ConfirmDialog {
    constructor(_shadowRoot, _getPopupPosition) {
        this._shadowRoot = _shadowRoot;
        this._getPopupPosition = _getPopupPosition;
        this._overlay = null;
        this._openedAt = 0;
    }
    get isOpen() {
        return this._overlay !== null;
    }
    show(options) {
        // A single touch fires both the touchstart and the synthesised click handler on the trigger
        // button; ignore the second call so we don't open (and leak) a duplicate dialog.
        if (this._overlay) {
            return Promise.resolve(false);
        }
        const { message, confirmText = 'Confirm', cancelText = 'Cancel', confirmClass = 'forget', } = options;
        this._openedAt = Date.now();
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
        const dismissIfReady = () => {
            if (Date.now() - this._openedAt > 300) {
                this.close(false);
            }
        };
        const overlay = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            id: 'confirm-overlay',
            events: {
                onclick: dismissIfReady,
                ontouchstart: (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    dismissIfReady();
                },
            },
        });
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        overlay.style.transform = `translate(${scrollX - x}px, ${scrollY - y}px)`;
        return overlay;
    }
    createDialog(message, confirmText, cancelText, confirmClass) {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            id: 'confirm-dialog',
            events: {
                onclick: (e) => e.stopPropagation(),
                ontouchstart: (e) => e.stopPropagation(),
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
/* 128 */
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
    // Name types from JMNedict
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
/* 129 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   applyWordStyles: () => (/* binding */ applyWordStyles),
/* harmony export */   ensureWordStyles: () => (/* binding */ ensureWordStyles),
/* harmony export */   hasWordStyles: () => (/* binding */ hasWordStyles)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(21);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(124);
/* harmony import */ var _shared_word_style_generate_css__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(130);




const STYLE_SELECTOR = 'style[data-jiten-style="word-dynamic"]';
// Word styling is owned by a single content-script <style> element whose textContent is fully
// replaced on every change. This must not go through chrome.scripting.insertCSS: that injection
// is bookkept in the service worker's memory, which MV3 recycles at will, leaving stale
// stylesheets stuck on the page (a previous theme's colours then leak through an empty theme).
const applyWordStyles = async () => {
    const themeVars = await (0,_shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_2__.getThemeCssVars)();
    const wordStyleConfig = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('wordStyleConfig');
    const generatedCSS = (0,_shared_word_style_generate_css__WEBPACK_IMPORTED_MODULE_3__.generateWordStyleCSS)(wordStyleConfig);
    const customWordCSS = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('customWordCSS');
    let style = document.head.querySelector(STYLE_SELECTOR);
    if (!style) {
        style = document.createElement('style');
        style.setAttribute('data-jiten-style', 'word-dynamic');
        document.head.appendChild(style);
    }
    style.textContent = `${themeVars}\n${generatedCSS}\n${customWordCSS}`;
};
const hasWordStyles = () => !!document.head.querySelector(STYLE_SELECTOR);
// Ensures the static word.css link and the dynamic word styling are present, regardless of whether
// a parser ran. Used by contexts that drive the highlight pipeline directly (e.g. reader mode).
const ensureWordStyles = async () => {
    if (!document.querySelector('link[data-jiten-style="word"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_1__.getStyleUrl)('word');
        link.setAttribute('data-jiten-style', 'word');
        document.head.appendChild(link);
    }
    if (!hasWordStyles()) {
        await applyWordStyles();
    }
};


/***/ }),
/* 130 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   generateInlineStyles: () => (/* binding */ generateInlineStyles),
/* harmony export */   generateWordStyleCSS: () => (/* binding */ generateWordStyleCSS)
/* harmony export */ });
function hexToRgb(hex) {
    const cleaned = hex.replace('#', '');
    let r, g, b;
    if (cleaned.length === 3) {
        r = parseInt(cleaned[0] + cleaned[0], 16);
        g = parseInt(cleaned[1] + cleaned[1], 16);
        b = parseInt(cleaned[2] + cleaned[2], 16);
    }
    else if (cleaned.length >= 6) {
        r = parseInt(cleaned.substring(0, 2), 16);
        g = parseInt(cleaned.substring(2, 4), 16);
        b = parseInt(cleaned.substring(4, 6), 16);
    }
    else {
        return null;
    }
    return { r, g, b };
}
function generateEffectCSS(effects) {
    const normal = [];
    const hover = [];
    const shadows = [];
    let hasHoverTransitions = false;
    for (const effect of effects) {
        switch (effect.type) {
            case 'text-colour':
                normal.push(`color: ${effect.colour} !important;`);
                normal.push(`-webkit-text-fill-color: ${effect.colour} !important;`);
                break;
            case 'background': {
                const rgb = hexToRgb(effect.colour);
                if (rgb) {
                    normal.push(`background-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${effect.opacity}) !important;`);
                }
                break;
            }
            case 'underline':
                normal.push(`text-decoration: underline ${effect.style} ${effect.colour} !important;`);
                normal.push(`text-decoration-thickness: ${effect.thickness}px !important;`);
                normal.push('text-underline-position: under left !important;');
                break;
            case 'border':
                normal.push(`border: ${effect.width}px ${effect.style} ${effect.colour} !important;`);
                normal.push(`border-radius: ${effect.radius}px !important;`);
                break;
            case 'shadow':
                shadows.push(`${effect.offsetX}px ${effect.offsetY}px ${effect.blur}px ${effect.colour}`);
                break;
            case 'blur':
                normal.push(`filter: blur(${effect.radius}px) !important;`);
                if (effect.hoverOnly) {
                    hover.push('filter: none !important;');
                    hasHoverTransitions = true;
                }
                break;
            case 'opacity':
                normal.push(`opacity: ${effect.value} !important;`);
                if (effect.hoverOnly) {
                    hover.push('opacity: 1 !important;');
                    hasHoverTransitions = true;
                }
                break;
            case 'font-weight':
                normal.push(`font-weight: ${effect.value} !important;`);
                break;
            case 'font-style':
                normal.push(`font-style: ${effect.value} !important;`);
                break;
        }
    }
    if (shadows.length) {
        normal.push(`text-shadow: ${shadows.join(', ')} !important;`);
    }
    if (hasHoverTransitions) {
        const transitions = [];
        if (effects.some((e) => e.type === 'blur' && e.hoverOnly)) {
            transitions.push('filter 0.3s ease-in-out');
        }
        if (effects.some((e) => e.type === 'opacity' && e.hoverOnly)) {
            transitions.push('opacity 0.3s ease-in-out');
        }
        normal.push(`transition: ${transitions.join(', ')} !important;`);
    }
    return { normal, hover };
}
function generateWordStyleCSS(config) {
    const lines = [];
    let iPlusOneStyle;
    for (const [state, stateStyle] of Object.entries(config.states)) {
        if (!stateStyle?.effects?.length) {
            continue;
        }
        if (state === 'i-plus-one') {
            iPlusOneStyle = stateStyle;
            continue;
        }
        const { normal, hover } = generateEffectCSS(stateStyle.effects);
        if (normal.length) {
            lines.push(`.jiten-word.${state} {`);
            for (const decl of normal) {
                lines.push(`  ${decl}`);
            }
            lines.push('}');
        }
        if (hover.length) {
            lines.push(`.jiten-word.${state}:hover {`);
            for (const decl of hover) {
                lines.push(`  ${decl}`);
            }
            lines.push('}');
        }
    }
    if (iPlusOneStyle?.effects?.length) {
        const { normal, hover } = generateEffectCSS(iPlusOneStyle.effects);
        if (normal.length) {
            lines.push('.jiten-word.i-plus-one {');
            for (const decl of normal) {
                lines.push(`  ${decl}`);
            }
            lines.push('}');
        }
        if (hover.length) {
            lines.push('.jiten-word.i-plus-one:hover {');
            for (const decl of hover) {
                lines.push(`  ${decl}`);
            }
            lines.push('}');
        }
    }
    return lines.join('\n');
}
function generateInlineStyles(effects) {
    if (!effects?.length) {
        return '';
    }
    const { normal } = generateEffectCSS(effects);
    return normal.map((decl) => decl.replace(/ !important/g, '')).join(' ');
}


/***/ }),
/* 131 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   generateFaithfulHighlightCss: () => (/* binding */ generateFaithfulHighlightCss)
/* harmony export */ });
// In faithful mode the PDF canvas is the visible text and PDF.js' text layer sits transparently over
// it. Highlight each parsed word with a translucent box in its state colour, pulled from whatever the
// user's word-style config uses for that state (text colour, background, underline, border…). We emit
// our own translucent box (with !important) rather than relying on the config's raw effect so the
// opacity is consistent and every coloured state gets a box — even ones configured as text colour.
const stateColour = (effects) => {
    for (const effect of effects) {
        if ('colour' in effect && effect.colour) {
            return effect.colour;
        }
    }
    return undefined;
};
const generateFaithfulHighlightCss = (config) => {
    const blocks = [];
    for (const [state, style] of Object.entries(config.states)) {
        const colour = style?.effects?.length ? stateColour(style.effects) : undefined;
        if (!colour) {
            continue;
        }
        blocks.push([
            `#jiten-pdf .textLayer .jiten-word.${state} {`,
            `  background: color-mix(in srgb, ${colour} 30%, transparent) !important;`,
            '}',
            `#jiten-pdf .textLayer .jiten-word.${state}:hover,`,
            `#jiten-pdf .textLayer .jiten-word.${state}.hovered {`,
            `  background: color-mix(in srgb, ${colour} 50%, transparent) !important;`,
            '}',
        ].join('\n'));
    }
    return blocks.join('\n');
};


/***/ }),
/* 132 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   PdfReader: () => (/* binding */ PdfReader)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(11);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(20);
/* harmony import */ var _shared_messages_background_fetch_pdf_command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(85);
/* harmony import */ var _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(5);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(90);
/* harmony import */ var _reader_mode_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(133);
/* harmony import */ var _pdfjs__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(135);
/* harmony import */ var _reconstruct__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(136);










const LOAD_FONTS_VALUE = '__jiten_load_fonts__';
class PdfReader {
    constructor(root) {
        this._pages = [];
        this._mode = 'reflow';
        this._theme = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.DEFAULT_READER_THEME;
        this._font = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.DEFAULT_READER_FONT;
        this._fontSize = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_FONT_SIZE.default;
        this._bold = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.DEFAULT_READER_BOLD;
        this._width = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_WIDTH.default;
        this._lineHeight = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_LINE_HEIGHT.default;
        this._root = root;
    }
    async init() {
        this._mode = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('pdfReaderMode');
        this._theme = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('readerModeTheme');
        this._font = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('readerModeFont');
        this._fontSize = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('readerModeFontSize');
        this._bold = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('readerModeBold');
        this._width = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('readerModeWidth');
        this._lineHeight = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('readerModeLineHeight');
        await (0,_reader_mode_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_7__.loadPersistedFonts)();
        this.render();
        this.applyTypography();
        // Allow deep-linking a PDF: views/pdf-reader.html?src=<url> opens it straight away.
        const src = new URLSearchParams(location.search).get('src');
        if (src) {
            void this.openUrl(src);
        }
    }
    async openFile(file) {
        try {
            await this.loadDocument(await file.arrayBuffer());
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error(error);
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast)('error', 'PDF reader', 'Could not open this PDF');
        }
    }
    async openUrl(url) {
        try {
            // A normal page fetch is subject to CORS and most PDF hosts send no Access-Control headers, so
            // the bytes get blocked. The service worker has real host-permission cross-origin access, so it
            // does the fetch (and the 202-retry / %PDF validation) and returns the bytes base64-encoded.
            const result = await new _shared_messages_background_fetch_pdf_command__WEBPACK_IMPORTED_MODULE_4__.FetchPdfCommand(url).call();
            if (!result.ok) {
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast)('error', 'PDF reader', result.error);
                return;
            }
            await this.loadDocument(this.decodeBase64(result.base64));
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error(error);
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast)('error', 'PDF reader', 'Could not open a PDF from that URL');
        }
    }
    decodeBase64(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
    async loadDocument(data) {
        const pdfjs = await this.ensurePdfjs();
        this.reset();
        this._doc = await pdfjs.getDocument({
            data,
            cMapUrl: (0,_pdfjs__WEBPACK_IMPORTED_MODULE_8__.CMAP_URL)(),
            cMapPacked: true,
            isEvalSupported: false,
        }).promise;
        this.buildPages();
    }
    // #region Shell
    render() {
        this._root.classList.add(`reader-theme-${this._theme}`);
        this._root.classList.toggle('reader-bold', this._bold);
        this._emptyEl = this.buildEmptyState();
        this._pagesEl = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', { class: ['pdf-pages'] });
        const controls = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['reader-controls-anchor'],
            children: [this.buildToolbar(), this.buildPanel()],
        });
        this._root.append(controls, this._emptyEl, this._pagesEl);
        this.updateModeUi();
        this.installDragAndDrop();
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._panel?.classList.contains('open')) {
                this.closePanel();
            }
        });
    }
    buildEmptyState() {
        const input = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('input', {
            class: ['pdf-file-input'],
            attributes: { type: 'file', accept: 'application/pdf' },
        });
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (file) {
                void this.openFile(file);
            }
        });
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['pdf-empty'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('p', { class: ['pdf-empty-title'], innerText: 'Open a Japanese PDF' }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('p', {
                    class: ['pdf-empty-hint'],
                    innerText: 'Choose a file, drop one anywhere on this page, or paste a URL.',
                }),
                input,
                this.buildUrlRow(),
            ],
        });
    }
    buildUrlRow() {
        const urlInput = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('input', {
            class: ['pdf-url-input'],
            attributes: { type: 'url', placeholder: 'https://…/document.pdf' },
        });
        const open = () => {
            const url = urlInput.value.trim();
            if (url) {
                void this.openUrl(url);
            }
        };
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                open();
            }
        });
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['pdf-url-row'],
            children: [
                urlInput,
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', { class: ['reader-btn'], innerText: 'Open URL', handler: open }),
            ],
        });
    }
    buildToolbar() {
        this._pageLabel = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['pdf-page-label'], innerText: '' });
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['reader-toolbar'],
            children: [
                this._pageLabel,
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
                    class: ['reader-btn'],
                    innerText: 'Open',
                    attributes: { title: 'Open another PDF' },
                    handler: () => this._emptyEl?.querySelector('.pdf-file-input')?.click(),
                }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
                    class: ['reader-btn', 'reader-options-btn'],
                    innerText: 'Aa',
                    attributes: { title: 'Reading options' },
                    handler: () => this.togglePanel(),
                }),
            ],
        });
    }
    buildPanel() {
        this._panel = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['reader-panel'],
            children: [
                this.buildModeToggle(),
                this.buildThemeSection(),
                this.panelRow('Text size', this.buildSizeStepper(), 'pdf-typography'),
                this.panelRow('Font', this.buildFontSelect(), 'pdf-typography'),
                this.panelRow('Font weight', this.buildWeightSelect(), 'pdf-typography'),
                this.panelRow('Content width', this.buildRange(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_WIDTH, this._width, (v) => void this.setWidth(v)), 'pdf-typography'),
                this.panelRow('Line spacing', this.buildRange(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_LINE_HEIGHT, this._lineHeight, (v) => void this.setLineHeight(v)), 'pdf-typography'),
            ],
        });
        return this._panel;
    }
    buildModeToggle() {
        const button = (mode, label) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
            class: ['reader-btn', 'pdf-mode-btn', ...(this._mode === mode ? ['active'] : [])],
            innerText: label,
            attributes: { 'data-mode': mode },
            handler: () => void this.setMode(mode),
        });
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['pdf-mode-toggle'],
            children: [button('reflow', 'Reflow'), button('faithful', 'Faithful')],
        });
    }
    buildThemeSection() {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['reader-theme-grid'],
            children: _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_THEMES.map((theme) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
                class: ['reader-theme-option', ...(theme.id === this._theme ? ['active'] : [])],
                attributes: { title: theme.label, 'data-theme': theme.id },
                handler: () => void this.setTheme(theme.id),
                children: [
                    (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', {
                        class: ['reader-swatch'],
                        style: { backgroundColor: theme.bg, borderColor: theme.fg },
                    }),
                    (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['reader-theme-label'], innerText: theme.label }),
                ],
            })),
        });
    }
    buildSizeStepper() {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['reader-stepper'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
                    class: ['reader-btn'],
                    innerText: '−',
                    handler: () => void this.changeFontSize(-_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_FONT_SIZE.step),
                }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['reader-stepper-label'], innerText: 'A' }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('button', {
                    class: ['reader-btn'],
                    innerText: '+',
                    handler: () => void this.changeFontSize(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_FONT_SIZE.step),
                }),
            ],
        });
    }
    buildFontSelect() {
        this._fontSelect = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('select', { class: ['reader-select'] });
        this.populateFontOptions();
        this._fontSelect.onchange = () => {
            const value = this._fontSelect.value;
            if (value === LOAD_FONTS_VALUE) {
                void this.loadFonts();
                return;
            }
            void this.setFont(value);
        };
        return this._fontSelect;
    }
    buildWeightSelect() {
        const select = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('select', { class: ['reader-select'] });
        for (const option of [
            { value: 'regular', label: 'Regular' },
            { value: 'bold', label: 'Bold' },
        ]) {
            const el = document.createElement('option');
            el.value = option.value;
            el.textContent = option.label;
            select.appendChild(el);
        }
        select.value = this._bold ? 'bold' : 'regular';
        select.onchange = () => void this.setBold(select.value === 'bold');
        return select;
    }
    buildRange(range, value, onInput) {
        const input = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('input', {
            class: ['reader-range'],
            attributes: {
                type: 'range',
                min: String(range.min),
                max: String(range.max),
                step: String(range.step),
                value: String(value),
            },
        });
        input.addEventListener('input', () => onInput(parseFloat(input.value)));
        return input;
    }
    panelRow(label, control, extraClass) {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', {
            class: ['reader-panel-row', ...(extraClass ? [extraClass] : [])],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('span', { class: ['reader-panel-label'], innerText: label }),
                control,
            ],
        });
    }
    // #endregion
    // #region Pages
    buildPages() {
        if (!this._doc || !this._pagesEl) {
            return;
        }
        this._emptyEl?.classList.add('hidden');
        this._pagesEl.replaceChildren();
        this._pages = [];
        this._observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
            rootMargin: '600px 0px',
        });
        for (let number = 1; number <= this._doc.numPages; number++) {
            const section = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('section', {
                class: ['pdf-page'],
                attributes: { 'data-page': String(number) },
            });
            this._pages.push({ number, section, rendered: false });
            this._pagesEl.appendChild(section);
            this._observer.observe(section);
        }
        this.updatePageLabel(1);
    }
    onIntersect(entries) {
        for (const entry of entries) {
            const number = Number(entry.target.dataset.page);
            const entryData = this._pages[number - 1];
            if (entry.isIntersecting) {
                this.updatePageLabel(number);
                if (entryData && !entryData.rendered) {
                    entryData.rendered = true;
                    void this.renderPage(entryData);
                }
            }
        }
    }
    async renderPage(entry) {
        if (!this._doc) {
            return;
        }
        try {
            const page = await this._doc.getPage(entry.number);
            if (this._mode === 'faithful') {
                await this.renderFaithful(page, entry.section);
            }
            else {
                await this.renderReflow(page, entry.section);
            }
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error('Failed to render page', entry.number, error);
            entry.rendered = false;
        }
    }
    async renderReflow(page, section) {
        const content = await page.getTextContent();
        const paragraphs = (0,_reconstruct__WEBPACK_IMPORTED_MODULE_9__.reconstructParagraphs)(content);
        section.classList.add('pdf-page-reflow');
        section.replaceChildren();
        for (const text of paragraphs) {
            const para = document.createElement('p');
            para.textContent = text;
            section.appendChild(para);
        }
        this.parse(section);
    }
    async renderFaithful(page, section) {
        const pdfjs = await this.ensurePdfjs();
        const targetWidth = section.clientWidth || 800;
        const baseWidth = page.getViewport({ scale: 1 }).width;
        const scale = targetWidth / baseWidth;
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.scale(dpr, dpr);
        section.classList.add('pdf-page-faithful');
        section.replaceChildren();
        section.style.width = `${viewport.width}px`;
        section.style.height = `${viewport.height}px`;
        await page.render({ canvasContext: context, viewport }).promise;
        // The crisp canvas stays the only visible text (so its baked-in furigana survives and there's no
        // misaligned double-text). PDF.js' TextLayer lays a transparent, positioned span over each run
        // purely for selection/parsing; parsed words then get a translucent state-coloured highlight box.
        const textLayer = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__.createElement)('div', { class: ['pdf-text-layer', 'textLayer'] });
        textLayer.style.width = `${viewport.width}px`;
        textLayer.style.height = `${viewport.height}px`;
        section.append(canvas, textLayer);
        const content = await page.getTextContent();
        await new pdfjs.TextLayer({
            textContentSource: content,
            container: textLayer,
            viewport,
        }).render();
        this.parse(textLayer);
    }
    parse(node) {
        _integration_registry__WEBPACK_IMPORTED_MODULE_6__.Registry.batchController.registerNode(node);
        _integration_registry__WEBPACK_IMPORTED_MODULE_6__.Registry.batchController.parseBatches();
    }
    updatePageLabel(current) {
        if (this._pageLabel && this._doc) {
            this._pageLabel.innerText = `${current} / ${this._doc.numPages}`;
        }
    }
    reset() {
        this._observer?.disconnect();
        this._observer = undefined;
        for (const entry of this._pages) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_6__.Registry.batchController.dismissNode(entry.section);
        }
        this._pages = [];
        if (this._pagesEl) {
            this._pagesEl.replaceChildren();
        }
        void this._doc?.destroy();
        this._doc = undefined;
    }
    // #endregion
    // #region Options
    togglePanel() {
        if (this._panel?.classList.contains('open')) {
            this.closePanel();
        }
        else {
            this._panel?.classList.add('open');
        }
    }
    closePanel() {
        this._panel?.classList.remove('open');
    }
    async setMode(mode) {
        if (mode === this._mode) {
            return;
        }
        this._mode = mode;
        this.updateModeUi();
        await this.persist('pdfReaderMode', mode);
        this.rerenderPages();
    }
    updateModeUi() {
        const faithful = this._mode === 'faithful';
        this._root.classList.toggle('pdf-mode-faithful', faithful);
        this._root.classList.toggle('pdf-mode-reflow', !faithful);
        this._panel?.querySelectorAll('.pdf-mode-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.mode === this._mode);
        });
    }
    rerenderPages() {
        for (const entry of this._pages) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_6__.Registry.batchController.dismissNode(entry.section);
            entry.rendered = false;
            entry.section.replaceChildren();
            entry.section.removeAttribute('style');
            entry.section.classList.remove('pdf-page-reflow', 'pdf-page-faithful');
        }
        // Re-trigger rendering for whatever is currently on screen.
        for (const entry of this._pages) {
            const rect = entry.section.getBoundingClientRect();
            if (rect.bottom > -600 && rect.top < window.innerHeight + 600 && !entry.rendered) {
                entry.rendered = true;
                void this.renderPage(entry);
            }
        }
    }
    applyTypography() {
        this._root.style.setProperty('--reader-font-family', (0,_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.resolveReaderFont)(this._font));
        this._root.style.setProperty('--reader-font-size', `${this._fontSize}px`);
        this._root.style.setProperty('--reader-width', `${this._width}em`);
        this._root.style.setProperty('--reader-line-height', `${this._lineHeight}`);
        this._root.classList.toggle('reader-bold', this._bold);
    }
    async loadFonts() {
        await (0,_reader_mode_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_7__.enumerateAllFonts)();
        this.populateFontOptions();
    }
    populateFontOptions() {
        const select = this._fontSelect;
        if (!select) {
            return;
        }
        select.replaceChildren();
        const addGroup = (label, entries, preview = true) => {
            if (!entries.length) {
                return;
            }
            const group = document.createElement('optgroup');
            group.label = label;
            for (const entry of entries) {
                const option = document.createElement('option');
                option.value = entry.value;
                option.textContent = entry.label;
                if (preview) {
                    option.style.fontFamily = (0,_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.resolveReaderFont)(entry.value);
                }
                group.appendChild(option);
            }
            select.appendChild(group);
        };
        const toEntries = (names) => names.map((name) => ({ value: name, label: name }));
        addGroup('Standard', _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_FONTS.map((font) => ({ value: font.id, label: font.label })));
        const all = (0,_reader_mode_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_7__.getInstalledFonts)();
        if (all?.length) {
            addGroup('Japanese fonts', toEntries(all.filter(_reader_mode_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_7__.isJapaneseFont)));
            addGroup('Other fonts', toEntries(all.filter((f) => !(0,_reader_mode_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_7__.isJapaneseFont)(f))), false);
        }
        else {
            addGroup('Japanese fonts', toEntries((0,_reader_mode_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_7__.getCommonJapaneseFonts)()));
        }
        if ((0,_reader_mode_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_7__.supportsFontEnumeration)()) {
            addGroup('More', [
                {
                    value: LOAD_FONTS_VALUE,
                    label: all?.length ? 'Reload installed fonts…' : 'Load all installed fonts…',
                },
            ]);
        }
        select.value = this._font;
    }
    async setTheme(theme) {
        if (theme === this._theme) {
            return;
        }
        this._root.classList.remove(`reader-theme-${this._theme}`);
        this._theme = theme;
        this._root.classList.add(`reader-theme-${theme}`);
        this._panel?.querySelectorAll('.reader-theme-option').forEach((option) => {
            option.classList.toggle('active', option.getAttribute('data-theme') === theme);
        });
        await this.persist('readerModeTheme', theme);
    }
    async setFont(value) {
        this._font = value;
        this._root.style.setProperty('--reader-font-family', (0,_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.resolveReaderFont)(value));
        await this.persist('readerModeFont', value);
    }
    async changeFontSize(delta) {
        const next = Math.min(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_FONT_SIZE.max, Math.max(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_5__.READER_FONT_SIZE.min, this._fontSize + delta));
        if (next === this._fontSize) {
            return;
        }
        this._fontSize = next;
        this._root.style.setProperty('--reader-font-size', `${next}px`);
        await this.persist('readerModeFontSize', next);
    }
    async setBold(bold) {
        this._bold = bold;
        this._root.classList.toggle('reader-bold', bold);
        await this.persist('readerModeBold', bold);
    }
    async setWidth(width) {
        this._width = width;
        this._root.style.setProperty('--reader-width', `${width}em`);
        await this.persist('readerModeWidth', width);
    }
    async setLineHeight(lineHeight) {
        this._lineHeight = lineHeight;
        this._root.style.setProperty('--reader-line-height', `${lineHeight}`);
        await this.persist('readerModeLineHeight', lineHeight);
    }
    async persist(key, value) {
        await (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.setConfiguration)(key, value);
    }
    // #endregion
    installDragAndDrop() {
        const prevent = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        this._root.addEventListener('dragover', (e) => {
            prevent(e);
            this._root.classList.add('pdf-drag-over');
        });
        this._root.addEventListener('dragleave', (e) => {
            prevent(e);
            this._root.classList.remove('pdf-drag-over');
        });
        this._root.addEventListener('drop', (e) => {
            prevent(e);
            this._root.classList.remove('pdf-drag-over');
            const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
            if (file) {
                void this.openFile(file);
            }
        });
    }
    async ensurePdfjs() {
        if (!this._pdfjs) {
            this._pdfjs = await (0,_pdfjs__WEBPACK_IMPORTED_MODULE_8__.loadPdfjs)();
        }
        return this._pdfjs;
    }
}


/***/ }),
/* 133 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   enumerateAllFonts: () => (/* binding */ enumerateAllFonts),
/* harmony export */   getCommonJapaneseFonts: () => (/* binding */ getCommonJapaneseFonts),
/* harmony export */   getInstalledFonts: () => (/* binding */ getInstalledFonts),
/* harmony export */   isJapaneseFont: () => (/* binding */ isJapaneseFont),
/* harmony export */   loadPersistedFonts: () => (/* binding */ loadPersistedFonts),
/* harmony export */   supportsFontEnumeration: () => (/* binding */ supportsFontEnumeration)
/* harmony export */ });
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(134);
/* harmony import */ var _shared_extension_read_storage__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(2);
/* harmony import */ var _shared_extension_write_storage__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(12);



// Common Japanese font families across Windows / macOS / Linux / web installs. Used as a
// permission-free fallback so the picker shows real installed fonts even when the Local Font
// Access API has not been used yet.
const COMMON_JP_FONTS = [
    'Yu Gothic',
    'Yu Gothic UI',
    'YuGothic',
    'Yu Mincho',
    'YuMincho',
    'Meiryo',
    'Meiryo UI',
    'MS Gothic',
    'MS PGothic',
    'MS UI Gothic',
    'MS Mincho',
    'MS PMincho',
    'BIZ UDGothic',
    'BIZ UDPGothic',
    'BIZ UDMincho',
    'UD Digi Kyokasho N-R',
    'Hiragino Sans',
    'Hiragino Kaku Gothic ProN',
    'Hiragino Kaku Gothic Pro',
    'Hiragino Maru Gothic ProN',
    'Hiragino Mincho ProN',
    'Osaka',
    'Noto Sans JP',
    'Noto Serif JP',
    'Noto Sans CJK JP',
    'Noto Serif CJK JP',
    'Source Han Sans',
    'Source Han Sans JP',
    'Source Han Serif',
    'IPAGothic',
    'IPAMincho',
    'IPAexGothic',
    'IPAexMincho',
    'TakaoGothic',
    'Kosugi',
    'Kosugi Maru',
    'M PLUS 1p',
    'M PLUS Rounded 1c',
    'Sawarabi Gothic',
    'Sawarabi Mincho',
];
// A short Japanese sample spanning hiragana + kanji. A font lacking these glyphs falls back to the
// system default, producing the same advance width as a deliberately-missing font; one that has
// them renders its own glyphs at a different width.
const SAMPLE = '日本語のあ亜';
// Hiragana, katakana (incl. half-width), CJK ideographs + extensions. A font whose family name
// contains any of these almost certainly ships Japanese glyphs (catches device/printer fonts such
// as the EPSON families that the width test can miss).
const CJK_NAME = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;
const STORAGE_KEY = 'readerInstalledFonts';
let installed = null;
let commonCache = null;
let detector;
const getDetector = () => {
    if (detector !== undefined) {
        return detector;
    }
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) {
        detector = null;
        return null;
    }
    const measure = (family) => {
        ctx.font = `40px ${family}`;
        return ctx.measureText(SAMPLE).width;
    };
    const fallbackWidth = measure('"__jiten_missing_font__"');
    detector = (family) => Math.abs(measure(`"${family.replace(/["\\]/g, '')}"`) - fallbackWidth) > 0.5;
    return detector;
};
const sortUnique = (families) => Array.from(new Set(families)).sort((a, b) => a.localeCompare(b));
const isJapaneseFont = (family) => {
    if (CJK_NAME.test(family)) {
        return true;
    }
    const detect = getDetector();
    return detect ? detect(family) : false;
};
// Synchronous, permission-free: which of the well-known Japanese fonts are actually installed.
const getCommonJapaneseFonts = () => {
    if (commonCache) {
        return commonCache;
    }
    const detect = getDetector();
    commonCache = detect ? sortUnique(COMMON_JP_FONTS.filter(detect)) : [];
    return commonCache;
};
// All installed font families currently known (from a prior enumeration or restored from storage).
const getInstalledFonts = () => installed;
const supportsFontEnumeration = () => typeof window.queryLocalFonts === 'function';
// Restores the persisted installed-font list so it survives content-script reloads without
// re-running the (permission-prompting) enumeration.
const loadPersistedFonts = async () => {
    if (installed) {
        return;
    }
    try {
        const raw = await (0,_shared_extension_read_storage__WEBPACK_IMPORTED_MODULE_1__.readStorage)(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length) {
                installed = parsed;
            }
        }
    }
    catch (error) {
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('loadPersistedFonts failed', error);
    }
};
// Enumerates every installed font family via the Local Font Access API (prompts on first use) and
// persists the result.
const enumerateAllFonts = async () => {
    const query = window.queryLocalFonts;
    if (typeof query !== 'function') {
        return installed ?? [];
    }
    try {
        const fonts = await query();
        installed = sortUnique(fonts.map((font) => font.family));
        void (0,_shared_extension_write_storage__WEBPACK_IMPORTED_MODULE_2__.writeStorage)(STORAGE_KEY, JSON.stringify(installed));
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('enumerateAllFonts', { total: installed.length });
    }
    catch (error) {
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('enumerateAllFonts failed', error);
    }
    return installed ?? [];
};


/***/ }),
/* 134 */
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
        // Buffer messages until we know the debug state
        bufferedDebugMessages.push([message, ...optionalParams]);
        return;
    }
    if (!debugEnabled) {
        return;
    }
    // eslint-disable-next-line no-console
    console.log(`[DEBUG] ${message}`, ...optionalParams);
};
const drainBufferedDebugMessages = () => {
    if (debugEnabled === undefined || debugEnabled === false) {
        return;
    }
    for (const [message, ...optionalParams] of bufferedDebugMessages) {
        // eslint-disable-next-line no-console
        console.log(`[DEBUG] ${message}`, ...optionalParams);
    }
    bufferedDebugMessages.length = 0; // Clear the buffer
};


/***/ }),
/* 135 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CMAP_URL: () => (/* binding */ CMAP_URL),
/* harmony export */   isTextItem: () => (/* binding */ isTextItem),
/* harmony export */   loadPdfjs: () => (/* binding */ loadPdfjs)
/* harmony export */ });
/* harmony import */ var _shared_extension_get_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(17);

let modulePromise = null;
const loadPdfjs = () => {
    if (!modulePromise) {
        modulePromise = (async () => {
            const pdfjs = (await import(/* webpackIgnore: true */ (0,_shared_extension_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)('vendor/pdf.min.mjs')));
            pdfjs.GlobalWorkerOptions.workerSrc = (0,_shared_extension_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)('vendor/pdf.worker.min.mjs');
            return pdfjs;
        })();
    }
    return modulePromise;
};
// Adobe CMaps are mandatory for CID-keyed Japanese fonts: without them getTextContent() returns
// empty or mojibake for a large share of real Japanese PDFs.
const CMAP_URL = () => (0,_shared_extension_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)('vendor/cmaps/');
const isTextItem = (item) => 'str' in item;


/***/ }),
/* 136 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   reconstructParagraphs: () => (/* binding */ reconstructParagraphs)
/* harmony export */ });
/* harmony import */ var _pdfjs__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(135);

// Reconstruct readable paragraphs from a page's text-content items. pdfjs returns text in small runs
// carrying a transform matrix (e=transform[4], f=transform[5]) but no notion of sentences. Japanese
// has no inter-word spaces, so soft line wraps must join with no separator; only a noticeably larger
// vertical gap between baselines is treated as a paragraph break. Latin runs keep pdfjs' synthetic
// space items, so spacing there survives.
const reconstructParagraphs = (content) => {
    const paragraphs = [];
    let current = '';
    let lastY = null;
    let lastHeight = 0;
    const flush = () => {
        if (current.trim()) {
            paragraphs.push(current);
        }
        current = '';
    };
    for (const item of content.items) {
        if (!(0,_pdfjs__WEBPACK_IMPORTED_MODULE_0__.isTextItem)(item)) {
            continue;
        }
        const y = Number(item.transform[5]);
        const height = item.height || lastHeight || 12;
        if (lastY !== null && lastY - y > height * 1.6) {
            flush();
        }
        current += item.str;
        lastY = y;
        lastHeight = height;
    }
    flush();
    return paragraphs;
};


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
/* harmony import */ var _shared_dom_on_loaded__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(87);
/* harmony import */ var _pdf_reader_bootstrap_pipeline__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(89);
/* harmony import */ var _pdf_reader_pdf_reader__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(132);



// Entry point for the standalone PDF reader page (views/pdf-reader.html). It lives under apps/ rather
// than views/ so it can import the foreground parsing pipeline without tripping the cross-scope
// import rule, and is auto-discovered by the webpack apps glob as js/pdf-reader.js.
(0,_shared_dom_on_loaded__WEBPACK_IMPORTED_MODULE_0__.onLoaded)(async () => {
    const root = document.getElementById('jiten-pdf');
    if (!root) {
        return;
    }
    await (0,_pdf_reader_bootstrap_pipeline__WEBPACK_IMPORTED_MODULE_1__.bootstrapPipeline)();
    await new _pdf_reader_pdf_reader__WEBPACK_IMPORTED_MODULE_2__.PdfReader(root).init();
});

})();

/******/ })()
;