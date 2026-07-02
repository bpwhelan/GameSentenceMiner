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
/* 19 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   clearRejectedApiToken: () => (/* binding */ clearRejectedApiToken),
/* harmony export */   isApiTokenRejected: () => (/* binding */ isApiTokenRejected),
/* harmony export */   requestByUrl: () => (/* binding */ requestByUrl)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _dom_display_toast__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(20);


const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const API_KEY_REJECTED_MESSAGE = 'Jiten API key was rejected by the server. Please update it in the extension settings.';
// Latches the token that was rejected with 401/403 so subsequent requests fail
// fast without hitting the API until the key is changed or revalidated.
let rejectedApiToken;
const clearRejectedApiToken = () => {
    rejectedApiToken = undefined;
};
const isApiTokenRejected = async () => {
    if (!rejectedApiToken) {
        return false;
    }
    return (await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiKey')) === rejectedApiToken;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryable = (error, response) => {
    if (!response) {
        return true;
    }
    const status = response.status;
    return status === 429 || status >= 500;
};
const requestByUrl = async (baseUrl = 'https://api.jiten.moe', action, params, options) => {
    const apiToken = options?.apiToken || (await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiKey'));
    if (!apiToken?.length) {
        (0,_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('error', 'API Token is not set');
        throw new Error('API Token is not set');
    }
    // Requests with an explicitly provided token (e.g. key validation in the
    // settings) bypass the latch so the server is actually consulted again.
    if (!options?.apiToken && apiToken === rejectedApiToken) {
        throw new Error(API_KEY_REJECTED_MESSAGE);
    }
    const usedUrl = new URL(`${baseUrl}/${action}`);
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
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
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        }
        catch (error) {
            lastError = error;
            if (attempt < MAX_RETRIES - 1) {
                const backoff = INITIAL_BACKOFF_MS * 2 ** attempt;
                await wait(backoff + Math.random() * backoff * 0.5);
                continue;
            }
            (0,_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('error', 'jiten.moe is unreachable', error.message);
            throw error;
        }
        if (response.status === 401 || response.status === 403) {
            rejectedApiToken = apiToken;
            throw new Error(API_KEY_REJECTED_MESSAGE);
        }
        if (!response.ok && isRetryable(null, response) && attempt < MAX_RETRIES - 1) {
            const backoff = INITIAL_BACKOFF_MS * 2 ** attempt;
            await wait(backoff + Math.random() * backoff * 0.5);
            continue;
        }
        const responseObject = (await response.json());
        if ('error_message' in responseObject) {
            throw new Error(responseObject.error_message);
        }
        if (apiToken === rejectedApiToken) {
            rejectedApiToken = undefined;
        }
        return responseObject;
    }
    throw lastError;
};


/***/ }),
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
/* 29 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   tabs: () => (/* binding */ tabs)
/* harmony export */ });
const tabs = chrome.tabs;


/***/ }),
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
/* 36 */,
/* 37 */,
/* 38 */,
/* 39 */,
/* 40 */,
/* 41 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   request: () => (/* binding */ request)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _request_by_url__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(19);


const request = async (action, params, options) => {
    const baseUrl = await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiEndpoint');
    return await (0,_request_by_url__WEBPACK_IMPORTED_MODULE_1__.requestByUrl)(baseUrl, action, params, options);
};


/***/ }),
/* 42 */,
/* 43 */,
/* 44 */,
/* 45 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BroadcastCommand: () => (/* binding */ BroadcastCommand)
/* harmony export */ });
/* harmony import */ var _extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(28);
/* harmony import */ var _extension_get_tabs__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(46);
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(18);
/* harmony import */ var _extension_tabs__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(29);
/* harmony import */ var _command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(30);





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
        // Fetch the last error to suppress it.
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
/* 46 */
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
/* 47 */,
/* 48 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   fetchStudyDecks: () => (/* binding */ fetchStudyDecks)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(41);

const fetchStudyDecks = (options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/reader-study-decks', undefined, options);


/***/ }),
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
/* 72 */,
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
/* 84 */,
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
/* 102 */,
/* 103 */,
/* 104 */,
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
/* 118 */,
/* 119 */,
/* 120 */,
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
/* 123 */,
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
/* 126 */,
/* 127 */,
/* 128 */,
/* 129 */,
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
/* 131 */,
/* 132 */,
/* 133 */,
/* 134 */,
/* 135 */,
/* 136 */,
/* 137 */,
/* 138 */,
/* 139 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CRUNCHYROLL: () => (/* binding */ CRUNCHYROLL),
/* harmony export */   FEATURES: () => (/* binding */ FEATURES),
/* harmony export */   READER_MODE: () => (/* binding */ READER_MODE)
/* harmony export */ });
const CRUNCHYROLL = {
    id: 'crunchyroll.com',
    name: 'Crunchyroll',
    description: 'Force removes Crunchyroll subtitles',
    host: '*://static.crunchyroll.com/*',
    allFrames: true,
};
const READER_MODE = {
    id: 'reader-mode',
    name: 'Reader mode',
    description: 'Adds a button and keybind to extract the main article of any page into a ' +
        'distraction-free reading view with parsing applied',
    host: '<all_urls>',
    allFrames: false,
};
const FEATURES = [CRUNCHYROLL, READER_MODE];


/***/ }),
/* 140 */,
/* 141 */,
/* 142 */,
/* 143 */,
/* 144 */,
/* 145 */,
/* 146 */,
/* 147 */,
/* 148 */,
/* 149 */,
/* 150 */,
/* 151 */,
/* 152 */,
/* 153 */,
/* 154 */,
/* 155 */,
/* 156 */,
/* 157 */,
/* 158 */,
/* 159 */,
/* 160 */,
/* 161 */,
/* 162 */,
/* 163 */,
/* 164 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   withElements: () => (/* binding */ withElements)
/* harmony export */ });
/* harmony import */ var _find_elements__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(121);

function withElements(p0, p1, p2) {
    const e = p2
        ? (0,_find_elements__WEBPACK_IMPORTED_MODULE_0__.findElements)(p0, p1)
        : (0,_find_elements__WEBPACK_IMPORTED_MODULE_0__.findElements)(p0);
    const fn = p2 ?? p1;
    return e.map((c) => fn(c));
}


/***/ }),
/* 165 */,
/* 166 */,
/* 167 */,
/* 168 */,
/* 169 */,
/* 170 */,
/* 171 */,
/* 172 */,
/* 173 */,
/* 174 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ConfigurationUpdatedCommand: () => (/* binding */ ConfigurationUpdatedCommand)
/* harmony export */ });
/* harmony import */ var _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(45);

class ConfigurationUpdatedCommand extends _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__.BroadcastCommand {
    constructor() {
        super(...arguments);
        this.key = 'configurationUpdated';
    }
}


/***/ }),
/* 175 */,
/* 176 */,
/* 177 */,
/* 178 */,
/* 179 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   resolveThemeSync: () => (/* binding */ resolveThemeSync)
/* harmony export */ });
/* harmony import */ var _themes__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(6);

const resolveThemeSync = (themeKey, savedThemes) => {
    const preset = _themes__WEBPACK_IMPORTED_MODULE_0__.PRESET_THEMES.get(themeKey);
    if (preset) {
        return { type: 'preset', key: themeKey, preset };
    }
    const saved = savedThemes.find((t) => t.id === themeKey);
    if (saved) {
        return { type: 'saved', saved };
    }
    return { type: 'custom' };
};


/***/ }),
/* 180 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   createSavedTheme: () => (/* binding */ createSavedTheme),
/* harmony export */   deleteSavedTheme: () => (/* binding */ deleteSavedTheme),
/* harmony export */   getSavedThemeById: () => (/* binding */ getSavedThemeById),
/* harmony export */   getSavedThemes: () => (/* binding */ getSavedThemes),
/* harmony export */   setSavedThemes: () => (/* binding */ setSavedThemes),
/* harmony export */   updateSavedTheme: () => (/* binding */ updateSavedTheme)
/* harmony export */ });
const SAVED_THEMES_KEY = '__savedWordStyleThemes__';
const getSavedThemes = async () => {
    const result = await chrome.storage.local.get(SAVED_THEMES_KEY);
    const stored = result[SAVED_THEMES_KEY];
    if (!stored) {
        return [];
    }
    try {
        return JSON.parse(stored);
    }
    catch {
        return [];
    }
};
const setSavedThemes = async (themes) => {
    await chrome.storage.local.set({
        [SAVED_THEMES_KEY]: JSON.stringify(themes),
    });
};
const getSavedThemeById = async (id) => {
    const themes = await getSavedThemes();
    return themes.find((t) => t.id === id);
};
const createSavedTheme = async (label, config) => {
    const themes = await getSavedThemes();
    const entry = { id: crypto.randomUUID(), label, config: structuredClone(config) };
    themes.push(entry);
    await setSavedThemes(themes);
    return entry;
};
const updateSavedTheme = async (id, updates) => {
    const themes = await getSavedThemes();
    const theme = themes.find((t) => t.id === id);
    if (!theme) {
        return;
    }
    if (updates.label !== undefined) {
        theme.label = updates.label;
    }
    if (updates.config !== undefined) {
        theme.config = structuredClone(updates.config);
    }
    await setSavedThemes(themes);
};
const deleteSavedTheme = async (id) => {
    const themes = await getSavedThemes();
    await setSavedThemes(themes.filter((t) => t.id !== id));
};


/***/ }),
/* 181 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLProfileSelectorElement: () => (/* binding */ HTMLProfileSelectorElement)
/* harmony export */ });
/* harmony import */ var _shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(182);
/* harmony import */ var _shared_configuration_profiles_state__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(8);


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
        this._select.addEventListener('change', () => void this.onSelectionChange());
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
}


/***/ }),
/* 182 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   createProfile: () => (/* binding */ createProfile),
/* harmony export */   deleteProfile: () => (/* binding */ deleteProfile),
/* harmony export */   duplicateProfile: () => (/* binding */ duplicateProfile),
/* harmony export */   renameProfile: () => (/* binding */ renameProfile),
/* harmony export */   switchProfile: () => (/* binding */ switchProfile)
/* harmony export */ });
/* harmony import */ var _messages_broadcast_profile_switched_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(183);
/* harmony import */ var _default_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(3);
/* harmony import */ var _get_configuration__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(1);
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(7);
/* harmony import */ var _profile_types__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(9);
/* harmony import */ var _profiles_state__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(8);
/* harmony import */ var _set_configuration__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(11);







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
/* 183 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ProfileSwitchedCommand: () => (/* binding */ ProfileSwitchedCommand)
/* harmony export */ });
/* harmony import */ var _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(45);

class ProfileSwitchedCommand extends _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__.BroadcastCommand {
    constructor(profileId) {
        super();
        this.key = 'profileSwitched';
        this.arguments = [profileId];
    }
}


/***/ }),
/* 184 */,
/* 185 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ping: () => (/* binding */ ping)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(41);

const ping = async (options) => {
    await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('reader/ping', undefined, options);
    return true;
};


/***/ }),
/* 186 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLFeaturesInputElement: () => (/* binding */ HTMLFeaturesInputElement)
/* harmony export */ });
/* harmony import */ var _shared_features_features__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(139);
/* harmony import */ var _lib_checkbox_list_input__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(187);


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
/* 187 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CheckboxListInput: () => (/* binding */ CheckboxListInput)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(25);


const observedAttributes = ['value', 'name'];
class CheckboxListInput extends HTMLElement {
    constructor() {
        super(...arguments);
        this._checkboxes = {};
    }
    //#region Attributes
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
    //#endregion
    //#region Lifecycle
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
    //#endregion
    //#region Events
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
/* 188 */
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
        //#endregion
    }
    //#region Attributes
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
    //#endregion
    //#region Lifecycle
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
    //#endregion
    //#region Events
    onValueChanged(_, newValue) {
        if (this._input && this._input.value !== newValue) {
            this._input.value = newValue;
            if (!HTMLKeybindInputElement.active) {
                this.updateButtonValues();
            }
            this.dispatchEvent(new Event('change'));
        }
    }
    //#endregion
    //#region DOM
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
            // We use mousedown instead of click to allow the left mouse button being used as keybind.
            // If we would use click, the event propagation cannot be stopped and the button would activate again immediately after the keybind was chosen.
            button.addEventListener('mousedown', (event) => this.initChooseKey(event, index));
            this._buttons.push(button);
            this.appendChild(button);
        };
        buildButton(0);
        buildButton(1);
    }
    //#endregion
    //#region Helpers
    keybindToString(keybind) {
        const { key = '', code = '', modifiers = '' } = keybind ?? {};
        return !key.length && !code.length ? 'None' : `${key} (${[...modifiers, code].join('+')})`;
    }
    updateButtonValues() {
        this._buttons.forEach((button, index) => {
            button.value = this.keybindToString(this.arrayValue[index]);
        });
    }
    //#endregion
    //#region Choose Keys
    initChooseKey(event, index) {
        event.preventDefault();
        event.stopPropagation();
        // To activate any keybind, we only accept the left mouse button.
        if (event.button !== 0) {
            return;
        }
        // If any keybind input is already active, we check if it's the same as the current one.
        // If it's not, we change the active keybind input to the current one.
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
        // We ignore the keydown event for modifiers, and only register them on keyup.
        // This allows pressing and holding modifiers before pressing the main hotkey.
        if (event instanceof KeyboardEvent &&
            event.type === 'keydown' &&
            HTMLKeybindInputElement.MODIFIERS.includes(event.key)) {
            return;
        }
        // .code: Layout-independent key identifier (usually equal to whatever that key means in qwerty)
        // .key: Key character in the current layout (respecting modifiers like shift or altgr)
        // .button: Mouse button number
        const code = event instanceof KeyboardEvent ? event.code : `Mouse${event.button}`;
        const key = event instanceof KeyboardEvent
            ? event.key
            : (HTMLKeybindInputElement.MOUSE_BUTTONS[event.button] ?? code);
        const modifiers = HTMLKeybindInputElement.MODIFIERS.filter((name) => name !== key && event.getModifierState(name));
        if (!modifiers.length && code === 'Mouse0') {
            // We don't want to allow the left mouse button as keybind, as it would be impossible to click on anything.
            return;
        }
        if (code === 'Mouse2') {
            // We don't want to allow the right mouse button as keybind, as it would interfere with the context menu, which is another event
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
/* 189 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLMiningInputElement: () => (/* binding */ HTMLMiningInputElement)
/* harmony export */ });
/* harmony import */ var _shared_anki_get_decks__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(190);
/* harmony import */ var _shared_anki_get_fields__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(192);
/* harmony import */ var _shared_anki_get_models__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(193);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(20);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(21);






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
/* 190 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getDecks: () => (/* binding */ getDecks)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(191);

const getDecks = (options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('deckNames', {}, options);


/***/ }),
/* 191 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   request: () => (/* binding */ request)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _dom_display_toast__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(20);


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
/* 192 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getFields: () => (/* binding */ getFields)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(191);

const getFields = (modelName, options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('modelFieldNames', { modelName }, options);


/***/ }),
/* 193 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getModels: () => (/* binding */ getModels)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(191);

const getModels = (options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('modelNames', {}, options);


/***/ }),
/* 194 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLNewStateInputElement: () => (/* binding */ HTMLNewStateInputElement)
/* harmony export */ });
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(4);
/* harmony import */ var _lib_checkbox_list_input__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(187);


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
/* 195 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLParsersInputElement: () => (/* binding */ HTMLParsersInputElement)
/* harmony export */ });
/* harmony import */ var _shared_host_meta_default_hosts__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(105);
/* harmony import */ var _lib_checkbox_list_input__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(187);


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
/* 196 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLProfileManagerElement: () => (/* binding */ HTMLProfileManagerElement)
/* harmony export */ });
/* harmony import */ var _shared_configuration_profile_operations__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(182);
/* harmony import */ var _shared_configuration_profile_types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(9);
/* harmony import */ var _shared_configuration_profiles_state__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(8);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(20);





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
                handler: () => void this.handleDuplicate(profile),
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
}


/***/ }),
/* 197 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLReaderThemeInputElement: () => (/* binding */ HTMLReaderThemeInputElement)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(22);
/* harmony import */ var _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(5);


const observedAttributes = ['value', 'name'];
class HTMLReaderThemeInputElement extends HTMLElement {
    constructor() {
        super(...arguments);
        this._swatches = {};
    }
    get value() {
        return this.getAttribute('value') ?? '';
    }
    set value(value) {
        this.setAttribute('value', value);
    }
    get name() {
        return this.getAttribute('name') ?? '';
    }
    set name(value) {
        this.setAttribute('name', value);
    }
    connectedCallback() {
        this.render();
    }
    attributeChangedCallback(name) {
        if (name === 'value') {
            this.updateActive();
        }
    }
    render() {
        if (Object.keys(this._swatches).length) {
            this.updateActive();
            return;
        }
        const container = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            class: ['reader-theme-swatches'],
            children: _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_1__.READER_THEMES.map((theme) => {
                const swatch = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('button', {
                    class: ['reader-theme-swatch'],
                    attributes: { type: 'button', title: theme.label, 'data-theme': theme.id },
                    style: { backgroundColor: theme.bg, borderColor: theme.fg },
                    handler: () => this.select(theme.id),
                });
                this._swatches[theme.id] = swatch;
                return swatch;
            }),
        });
        this.appendChild(container);
        this.updateActive();
    }
    select(theme) {
        if (this.value === theme) {
            return;
        }
        this.value = theme;
        this.dispatchEvent(new Event('change'));
    }
    updateActive() {
        for (const [id, swatch] of Object.entries(this._swatches)) {
            swatch.classList.toggle('active', id === this.value);
        }
    }
}
HTMLReaderThemeInputElement.observedAttributes = observedAttributes;


/***/ }),
/* 198 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   HTMLWordStyleEditorElement: () => (/* binding */ HTMLWordStyleEditorElement)
/* harmony export */ });
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(20);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(21);
/* harmony import */ var _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(199);
/* harmony import */ var _shared_word_style_generate_css__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(130);
/* harmony import */ var _shared_word_style_resolve_theme__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(179);
/* harmony import */ var _shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(180);
/* harmony import */ var _shared_word_style_theme_code__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(200);
/* harmony import */ var _shared_word_style_themes__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(6);








const PREVIEW_WORDS = [
    { text: '事典', state: 'new' },
    { text: 'を', state: 'unparsed' },
    { text: '読む', state: 'mature' },
    { text: '時', state: 'young' },
    { text: '、', state: 'unparsed' },
    { text: '新しい', state: 'i-plus-one' },
    { text: '言葉', state: 'due' },
    { text: 'が', state: 'mastered' },
    { text: '物', state: 'redundant' },
    { text: '出て', state: 'frequent' },
    { text: 'くる', state: 'blacklisted' },
    { text: '。', state: 'unparsed' },
];
function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'class') {
                e.className = v;
            }
            else if (k === 'textContent') {
                e.textContent = v;
            }
            else {
                e.setAttribute(k, v);
            }
        }
    }
    for (const child of children) {
        e.append(child);
    }
    return e;
}
function defaultEffectForType(type) {
    switch (type) {
        case 'text-colour':
            return { type: 'text-colour', colour: '#ffffff' };
        case 'background':
            return { type: 'background', colour: '#ffffff', opacity: 0.15 };
        case 'underline':
            return { type: 'underline', colour: '#ffffff', style: 'solid', thickness: 2 };
        case 'border':
            return { type: 'border', colour: '#ffffff', width: 1, style: 'solid', radius: 4 };
        case 'shadow':
            return { type: 'shadow', colour: '#ffffff', blur: 6, offsetX: 0, offsetY: 2 };
        case 'blur':
            return { type: 'blur', radius: 3, hoverOnly: true };
        case 'opacity':
            return { type: 'opacity', value: 0.5, hoverOnly: true };
        case 'font-weight':
            return { type: 'font-weight', value: 'bold' };
        case 'font-style':
            return { type: 'font-style', value: 'italic' };
    }
}
class HTMLWordStyleEditorElement extends HTMLElement {
    constructor() {
        super(...arguments);
        this._emitTimer = null;
        this._autoSaveTimer = null;
        this._previewDark = true;
        this._savedThemes = [];
    }
    get value() {
        return JSON.stringify(this._config);
    }
    set value(val) {
        try {
            this._config = typeof val === 'object' ? val : JSON.parse(val);
        }
        catch {
            return;
        }
        this._syncFromConfig();
    }
    get name() {
        return this.getAttribute('name') ?? '';
    }
    set name(val) {
        this.setAttribute('name', val);
    }
    connectedCallback() {
        this._shadow = this.attachShadow({ mode: 'open' });
        this._shadow.appendChild(el('link', { rel: 'stylesheet', href: (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_1__.getStyleUrl)('html-word-style-editor') }));
        this._input = el('input', { type: 'hidden', name: this.name });
        this.appendChild(this._input);
        this._config = structuredClone(_shared_word_style_themes__WEBPACK_IMPORTED_MODULE_7__.PRESET_THEMES.get('default').config);
        void (0,_shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_5__.getSavedThemes)().then((themes) => {
            this._savedThemes = themes;
            this._buildDOM();
            this._syncFromConfig();
        });
    }
    attributeChangedCallback(name, _old, val) {
        if (name === 'value' && this._config) {
            try {
                const parsed = JSON.parse(val);
                if (JSON.stringify(parsed) !== JSON.stringify(this._config)) {
                    this._config = parsed;
                    this._syncFromConfig();
                }
            }
            catch {
                /* nop */
            }
        }
        if (name === 'name' && this._input) {
            this._input.name = val;
        }
    }
    _buildDOM() {
        this._themeSelect = el('select', { class: 'theme-select' });
        this._populateThemeDropdown();
        this._themeSelect.addEventListener('change', () => {
            const theme = this._themeSelect.value;
            if (this._config.theme === 'custom' && theme !== 'custom') {
                if (!confirm('Your unsaved custom theme will be lost. Continue?')) {
                    this._themeSelect.value = 'custom';
                    return;
                }
            }
            const preset = _shared_word_style_themes__WEBPACK_IMPORTED_MODULE_7__.PRESET_THEMES.get(theme);
            if (preset) {
                this._config = structuredClone(preset.config);
                this._syncFromConfig();
                this._emitChange();
                return;
            }
            const saved = this._savedThemes.find((t) => t.id === theme);
            if (saved) {
                this._config = structuredClone(saved.config);
                this._config.theme = saved.id;
                this._syncFromConfig();
                this._emitChange();
            }
        });
        const copyBtn = el('button', {
            class: 'btn btn-sm',
            type: 'button',
            textContent: 'Copy Theme',
        });
        copyBtn.addEventListener('click', () => {
            const resolved = (0,_shared_word_style_resolve_theme__WEBPACK_IMPORTED_MODULE_4__.resolveThemeSync)(this._config.theme, this._savedThemes);
            let name;
            if (resolved.type === 'preset') {
                name = resolved.preset.label;
            }
            else if (resolved.type === 'saved') {
                name = resolved.saved.label;
            }
            const code = (0,_shared_word_style_theme_code__WEBPACK_IMPORTED_MODULE_6__.encodeThemeCode)(this._config, name);
            void navigator.clipboard.writeText(code).then(() => {
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('success', 'Theme code copied to clipboard');
            });
        });
        const importBtn = el('button', {
            class: 'btn btn-sm',
            type: 'button',
            textContent: 'Import Theme',
        });
        importBtn.addEventListener('click', () => {
            this._importRow.style.display = this._importRow.style.display === 'none' ? 'flex' : 'none';
        });
        this._saveAsBtn = el('button', {
            class: 'btn btn-sm btn-save-as',
            type: 'button',
            textContent: 'Save As',
        });
        this._saveAsBtn.addEventListener('click', () => {
            const name = prompt('Theme name:');
            if (!name?.trim()) {
                return;
            }
            void (0,_shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_5__.createSavedTheme)(name.trim(), this._config).then((entry) => {
                this._savedThemes.push(entry);
                this._config.theme = entry.id;
                this._populateThemeDropdown();
                this._themeSelect.value = entry.id;
                this._updateThemeActions();
                this._emitChange();
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('success', 'Theme saved');
            });
        });
        const duplicateBtn = el('button', {
            class: 'btn btn-sm',
            type: 'button',
            textContent: 'Duplicate',
        });
        duplicateBtn.addEventListener('click', () => {
            const resolved = (0,_shared_word_style_resolve_theme__WEBPACK_IMPORTED_MODULE_4__.resolveThemeSync)(this._config.theme, this._savedThemes);
            let baseName = 'Custom';
            if (resolved.type === 'preset') {
                baseName = resolved.preset.label;
            }
            else if (resolved.type === 'saved') {
                baseName = resolved.saved.label;
            }
            const label = `Copy of ${baseName}`;
            void (0,_shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_5__.createSavedTheme)(label, this._config).then((entry) => {
                this._savedThemes.push(entry);
                this._config = structuredClone(entry.config);
                this._config.theme = entry.id;
                this._syncFromConfig();
                this._emitChange();
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('success', `Theme duplicated as "${label}"`);
            });
        });
        const newBtn = el('button', {
            class: 'btn btn-sm',
            type: 'button',
            textContent: 'New',
        });
        newBtn.addEventListener('click', () => {
            const states = {};
            for (const key of _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.STYLEABLE_STATE_KEYS) {
                states[key] = { effects: [] };
            }
            this._config = { v: 1, theme: 'custom', states };
            this._syncFromConfig();
            this._emitChange();
        });
        this._renameBtn = el('button', {
            class: 'btn btn-sm btn-rename',
            type: 'button',
            textContent: 'Rename',
        });
        this._renameBtn.addEventListener('click', () => {
            const saved = this._savedThemes.find((t) => t.id === this._config.theme);
            if (!saved) {
                return;
            }
            const name = prompt('New name:', saved.label);
            if (!name?.trim() || name.trim() === saved.label) {
                return;
            }
            saved.label = name.trim();
            void (0,_shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_5__.updateSavedTheme)(saved.id, { label: saved.label }).then(() => {
                this._populateThemeDropdown();
                this._themeSelect.value = saved.id;
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('success', 'Theme renamed');
            });
        });
        this._deleteBtn = el('button', {
            class: 'btn btn-sm btn-delete',
            type: 'button',
            textContent: 'Delete',
        });
        this._deleteBtn.addEventListener('click', () => {
            const saved = this._savedThemes.find((t) => t.id === this._config.theme);
            if (!saved) {
                return;
            }
            if (!confirm(`Delete theme "${saved.label}"?`)) {
                return;
            }
            const id = saved.id;
            this._savedThemes = this._savedThemes.filter((t) => t.id !== id);
            void (0,_shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_5__.deleteSavedTheme)(id);
            this._config.theme = 'custom';
            this._populateThemeDropdown();
            this._themeSelect.value = 'custom';
            this._updateThemeActions();
            this._emitChange();
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('success', 'Theme deleted');
        });
        this._importRow = this._buildImportRow();
        this._themeBar = el('div', { class: 'theme-bar' }, this._themeSelect, newBtn, duplicateBtn, this._saveAsBtn, this._renameBtn, this._deleteBtn, copyBtn, importBtn);
        this._unsavedWarning = el('div', {
            class: 'unsaved-warning',
            textContent: 'This theme is unsaved. Use "Save As" to keep your changes.',
        });
        this._previewContainer = el('div', { class: 'preview-panel' });
        this._statesContainer = el('div', { class: 'state-sections' });
        this._previewStyle = document.createElement('style');
        this._shadow.append(this._previewStyle, this._themeBar, this._unsavedWarning, this._importRow, this._previewContainer, this._statesContainer);
    }
    _populateThemeDropdown() {
        this._themeSelect.innerHTML = '';
        const presetsGroup = document.createElement('optgroup');
        presetsGroup.label = 'Presets';
        for (const [key, { label }] of _shared_word_style_themes__WEBPACK_IMPORTED_MODULE_7__.PRESET_THEMES) {
            presetsGroup.appendChild(el('option', { value: key, textContent: label }));
        }
        this._themeSelect.appendChild(presetsGroup);
        if (this._savedThemes.length > 0) {
            const savedGroup = document.createElement('optgroup');
            savedGroup.label = 'Saved';
            for (const saved of this._savedThemes) {
                savedGroup.appendChild(el('option', { value: saved.id, textContent: saved.label }));
            }
            this._themeSelect.appendChild(savedGroup);
        }
        const resolved = (0,_shared_word_style_resolve_theme__WEBPACK_IMPORTED_MODULE_4__.resolveThemeSync)(this._config.theme, this._savedThemes);
        if (resolved.type === 'custom') {
            this._themeSelect.appendChild(el('option', { value: 'custom', textContent: 'Custom' }));
        }
    }
    _updateThemeActions() {
        const resolved = (0,_shared_word_style_resolve_theme__WEBPACK_IMPORTED_MODULE_4__.resolveThemeSync)(this._config.theme, this._savedThemes);
        const isSaved = resolved.type === 'saved';
        const isCustom = resolved.type === 'custom';
        this._renameBtn.style.display = isSaved ? '' : 'none';
        this._deleteBtn.style.display = isSaved ? '' : 'none';
        this._unsavedWarning.style.display = isCustom ? '' : 'none';
    }
    _buildImportRow() {
        const input = el('input', {
            type: 'text',
            class: 'import-input',
            placeholder: 'Paste theme code...',
        });
        const applyBtn = el('button', { class: 'btn btn-sm', type: 'button', textContent: 'Apply' });
        applyBtn.addEventListener('click', () => {
            const decoded = (0,_shared_word_style_theme_code__WEBPACK_IMPORTED_MODULE_6__.decodeThemeCode)(input.value.trim());
            if (!decoded) {
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('error', 'Invalid theme code');
                return;
            }
            this._importRow.style.display = 'none';
            input.value = '';
            if (decoded.name) {
                void (0,_shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_5__.createSavedTheme)(decoded.name, decoded.config).then((entry) => {
                    this._savedThemes.push(entry);
                    this._config = structuredClone(entry.config);
                    this._config.theme = entry.id;
                    this._syncFromConfig();
                    this._emitChange();
                    (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('success', `Theme "${entry.label}" imported and saved`);
                });
            }
            else {
                this._config = decoded.config;
                this._syncFromConfig();
                this._emitChange();
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__.displayToast)('success', 'Theme imported');
            }
        });
        const row = el('div', { class: 'import-row', style: 'display:none' }, input, applyBtn);
        return row;
    }
    _buildPreview() {
        this._previewContainer.innerHTML = '';
        this._previewStyle.textContent =
            '.jiten-word { margin-inline: 0.5px; }\n' + (0,_shared_word_style_generate_css__WEBPACK_IMPORTED_MODULE_3__.generateWordStyleCSS)(this._config);
        const previewH = el('div', { class: 'preview-horizontal' });
        for (const word of PREVIEW_WORDS) {
            const span = el('span', { class: `jiten-word preview-word ${word.state}` });
            span.textContent = word.text;
            previewH.appendChild(span);
        }
        const previewV = el('div', { class: 'preview-vertical' });
        for (const word of PREVIEW_WORDS) {
            const span = el('span', { class: `jiten-word preview-word ${word.state}` });
            span.textContent = word.text;
            previewV.appendChild(span);
        }
        const legend = el('div', { class: 'preview-legend' });
        const usedStates = [...new Set(PREVIEW_WORDS.map((w) => w.state))];
        for (const state of usedStates) {
            const swatch = el('span', { class: 'legend-swatch' });
            const inlineStyle = (0,_shared_word_style_generate_css__WEBPACK_IMPORTED_MODULE_3__.generateInlineStyles)(this._config.states[state]?.effects ?? []);
            swatch.setAttribute('style', inlineStyle);
            swatch.textContent = _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.STYLEABLE_STATES[state] ?? state;
            legend.appendChild(swatch);
        }
        const toggleBtn = el('button', {
            class: 'btn btn-sm preview-bg-toggle',
            type: 'button',
            textContent: this._previewDark ? '\u2600' : '\u263e',
        });
        toggleBtn.addEventListener('click', () => {
            this._previewDark = !this._previewDark;
            this._previewContainer.classList.toggle('light', !this._previewDark);
            toggleBtn.textContent = this._previewDark ? '\u2600' : '\u263e';
        });
        const header = el('div', { class: 'preview-header' }, toggleBtn);
        if (!this._previewDark) {
            this._previewContainer.classList.add('light');
        }
        this._previewContainer.append(header, previewH, previewV, legend);
    }
    _buildStateSections() {
        this._statesContainer.innerHTML = '';
        for (const stateKey of _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.STYLEABLE_STATE_KEYS) {
            const stateStyle = this._config.states[stateKey] ?? { effects: [] };
            const section = this._buildStateSection(stateKey, stateStyle.effects);
            this._statesContainer.appendChild(section);
        }
    }
    _buildStateSection(stateKey, effects) {
        const details = document.createElement('details');
        details.className = 'state-section';
        const summary = document.createElement('summary');
        const chevron = el('span', { class: 'state-chevron', textContent: '\u25b6' });
        const label = el('span', { class: 'state-label', textContent: _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.STYLEABLE_STATES[stateKey] });
        const previewWord = el('span', { class: 'state-preview-word' });
        const inlineStyle = (0,_shared_word_style_generate_css__WEBPACK_IMPORTED_MODULE_3__.generateInlineStyles)(effects);
        previewWord.setAttribute('style', inlineStyle);
        previewWord.textContent = '例';
        const spacer = el('span', { class: 'summary-spacer' });
        const addSelect = el('select', { class: 'add-effect-select' });
        addSelect.appendChild(el('option', { value: '', textContent: '+ Add Effect' }));
        for (const effectType of _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.EFFECT_TYPES) {
            addSelect.appendChild(el('option', { value: effectType, textContent: _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.EFFECT_LABELS[effectType] }));
        }
        addSelect.addEventListener('click', (e) => e.stopPropagation());
        addSelect.addEventListener('change', () => {
            if (!addSelect.value) {
                return;
            }
            const newEffect = defaultEffectForType(addSelect.value);
            (this._config.states[stateKey] ??= { effects: [] }).effects.push(newEffect);
            this._handleUserEdit();
            this._refreshStateSection(details, stateKey, true);
            this._updatePreviews();
            this._emitChange();
            addSelect.value = '';
        });
        summary.append(chevron, label, previewWord, spacer, addSelect);
        details.appendChild(summary);
        const effectList = el('div', { class: 'effect-list' });
        for (let i = 0; i < effects.length; i++) {
            effectList.appendChild(this._buildEffectRow(stateKey, i));
        }
        details.appendChild(effectList);
        return details;
    }
    _refreshStateSection(details, stateKey, forceOpen) {
        const effects = this._config.states[stateKey]?.effects ?? [];
        const newSection = this._buildStateSection(stateKey, effects);
        newSection.open = forceOpen ?? details.open;
        details.replaceWith(newSection);
    }
    _buildEffectRow(stateKey, index) {
        const effect = this._config.states[stateKey].effects[index];
        const row = el('div', { class: 'effect-row' });
        const labelEl = el('span', { class: 'effect-label', textContent: _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.EFFECT_LABELS[effect.type] });
        row.appendChild(labelEl);
        const controls = el('div', { class: 'effect-controls' });
        this._buildEffectControls(controls, stateKey, index, effect);
        row.appendChild(controls);
        const removeBtn = el('button', {
            class: 'btn btn-remove',
            type: 'button',
            textContent: '\u00d7',
        });
        removeBtn.addEventListener('click', () => {
            this._config.states[stateKey].effects.splice(index, 1);
            this._handleUserEdit();
            this._rebuildState(stateKey);
            this._updatePreviews();
            this._emitChange();
        });
        row.appendChild(removeBtn);
        return row;
    }
    _buildEffectControls(container, stateKey, index, effect) {
        const onUpdate = () => {
            this._handleUserEdit();
            this._updatePreviews();
            this._updateStatePreview(stateKey);
            this._emitChange();
        };
        switch (effect.type) {
            case 'text-colour':
                container.appendChild(this._colourInput(effect.colour, (v) => {
                    this._config.states[stateKey].effects[index].colour = v;
                    onUpdate();
                }));
                break;
            case 'background':
                container.appendChild(this._colourInput(effect.colour, (v) => {
                    this._config.states[stateKey].effects[index].colour = v;
                    onUpdate();
                }));
                container.appendChild(this._rangeInput('Opacity', effect.opacity, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BOUNDS.backgroundOpacity, (v) => {
                    this._config.states[stateKey].effects[index].opacity = v;
                    onUpdate();
                }));
                break;
            case 'underline':
                container.appendChild(this._colourInput(effect.colour, (v) => {
                    this._config.states[stateKey].effects[index].colour = v;
                    onUpdate();
                }));
                container.appendChild(this._selectInput('Style', effect.style, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.UNDERLINE_STYLES, (v) => {
                    this._config.states[stateKey].effects[index].style =
                        v;
                    onUpdate();
                }));
                container.appendChild(this._rangeInput('Thickness', effect.thickness, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BOUNDS.underlineThickness, (v) => {
                    this._config.states[stateKey].effects[index].thickness = v;
                    onUpdate();
                }));
                break;
            case 'border':
                container.appendChild(this._colourInput(effect.colour, (v) => {
                    this._config.states[stateKey].effects[index].colour = v;
                    onUpdate();
                }));
                container.appendChild(this._rangeInput('Width', effect.width, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BOUNDS.borderWidth, (v) => {
                    this._config.states[stateKey].effects[index].width = v;
                    onUpdate();
                }));
                container.appendChild(this._selectInput('Style', effect.style, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BORDER_STYLES, (v) => {
                    this._config.states[stateKey].effects[index].style =
                        v;
                    onUpdate();
                }));
                container.appendChild(this._rangeInput('Radius', effect.radius, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BOUNDS.borderRadius, (v) => {
                    this._config.states[stateKey].effects[index].radius = v;
                    onUpdate();
                }));
                break;
            case 'shadow':
                container.appendChild(this._colourInput(effect.colour, (v) => {
                    this._config.states[stateKey].effects[index].colour = v;
                    onUpdate();
                }));
                container.appendChild(this._rangeInput('Blur', effect.blur, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BOUNDS.shadowBlur, (v) => {
                    this._config.states[stateKey].effects[index].blur = v;
                    onUpdate();
                }));
                container.appendChild(this._rangeInput('X Offset', effect.offsetX, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BOUNDS.shadowOffset, (v) => {
                    this._config.states[stateKey].effects[index].offsetX = v;
                    onUpdate();
                }));
                container.appendChild(this._rangeInput('Y Offset', effect.offsetY, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BOUNDS.shadowOffset, (v) => {
                    this._config.states[stateKey].effects[index].offsetY = v;
                    onUpdate();
                }));
                break;
            case 'blur':
                container.appendChild(this._rangeInput('Radius', effect.radius, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BOUNDS.blurRadius, (v) => {
                    this._config.states[stateKey].effects[index].radius = v;
                    onUpdate();
                }));
                container.appendChild(this._checkboxInput('Reveal on hover', effect.hoverOnly, (v) => {
                    this._config.states[stateKey].effects[index].hoverOnly = v;
                    onUpdate();
                }));
                break;
            case 'opacity':
                container.appendChild(this._rangeInput('Value', effect.value, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.BOUNDS.opacity, (v) => {
                    this._config.states[stateKey].effects[index].value = v;
                    onUpdate();
                }));
                container.appendChild(this._checkboxInput('Restore on hover', effect.hoverOnly, (v) => {
                    this._config.states[stateKey].effects[index].hoverOnly = v;
                    onUpdate();
                }));
                break;
            case 'font-weight':
                container.appendChild(this._selectInput('Weight', effect.value, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.FONT_WEIGHTS, (v) => {
                    this._config.states[stateKey].effects[index].value =
                        v;
                    onUpdate();
                }));
                break;
            case 'font-style':
                container.appendChild(this._selectInput('Style', effect.value, _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.FONT_STYLES, (v) => {
                    this._config.states[stateKey].effects[index].value =
                        v;
                    onUpdate();
                }));
                break;
        }
    }
    _colourInput(value, onChange) {
        const wrapper = el('div', { class: 'control-group' });
        const colourPicker = el('input', { type: 'color', value: value.substring(0, 7) });
        const textInput = el('input', { type: 'text', class: 'colour-text', value });
        colourPicker.addEventListener('input', () => {
            textInput.value = colourPicker.value;
            onChange(colourPicker.value);
        });
        textInput.addEventListener('change', () => {
            const v = textInput.value.trim();
            if (/^#[0-9a-fA-F]{3,8}$/.test(v)) {
                colourPicker.value = v.substring(0, 7);
                onChange(v);
            }
        });
        wrapper.append(colourPicker, textInput);
        return wrapper;
    }
    _rangeInput(label, value, bounds, onChange) {
        const wrapper = el('div', { class: 'control-group' });
        const labelEl = el('span', { class: 'control-label', textContent: label });
        const step = bounds.step ?? 1;
        const range = el('input', {
            type: 'range',
            min: String(bounds.min),
            max: String(bounds.max),
            step: String(step),
            value: String(value),
        });
        const display = el('span', { class: 'range-value', textContent: String(value) });
        range.addEventListener('input', () => {
            const num = parseFloat(range.value);
            display.textContent = String(num);
            onChange(num);
        });
        wrapper.append(labelEl, range, display);
        return wrapper;
    }
    _selectInput(label, value, options, onChange) {
        const wrapper = el('div', { class: 'control-group' });
        const labelEl = el('span', { class: 'control-label', textContent: label });
        const select = el('select', { class: 'effect-select' });
        for (const opt of options) {
            const option = el('option', { value: opt, textContent: opt });
            if (opt === value) {
                option.selected = true;
            }
            select.appendChild(option);
        }
        select.addEventListener('change', () => onChange(select.value));
        wrapper.append(labelEl, select);
        return wrapper;
    }
    _checkboxInput(label, checked, onChange) {
        const wrapper = el('div', { class: 'control-group control-checkbox' });
        const cb = el('input', { type: 'checkbox' });
        cb.checked = checked;
        const labelEl = el('label', { textContent: label });
        cb.addEventListener('change', () => onChange(cb.checked));
        wrapper.append(cb, labelEl);
        return wrapper;
    }
    _syncFromConfig() {
        if (!this._themeSelect || !this._config) {
            return;
        }
        this._populateThemeDropdown();
        this._themeSelect.value = this._config.theme;
        this._updateThemeActions();
        this._buildPreview();
        this._buildStateSections();
        this._syncHiddenInput();
    }
    _updatePreviews() {
        this._buildPreview();
    }
    _updateStatePreview(stateKey) {
        const sections = this._statesContainer.querySelectorAll('.state-section');
        const index = _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.STYLEABLE_STATE_KEYS.indexOf(stateKey);
        if (index >= 0 && sections[index]) {
            const previewWord = sections[index].querySelector('.state-preview-word');
            if (previewWord) {
                const inlineStyle = (0,_shared_word_style_generate_css__WEBPACK_IMPORTED_MODULE_3__.generateInlineStyles)(this._config.states[stateKey]?.effects ?? []);
                previewWord.setAttribute('style', inlineStyle);
            }
        }
    }
    _rebuildState(stateKey) {
        const sections = this._statesContainer.querySelectorAll('.state-section');
        const index = _shared_word_style_constants__WEBPACK_IMPORTED_MODULE_2__.STYLEABLE_STATE_KEYS.indexOf(stateKey);
        if (index >= 0 && sections[index]) {
            const details = sections[index];
            this._refreshStateSection(details, stateKey);
        }
    }
    _handleUserEdit() {
        const resolved = (0,_shared_word_style_resolve_theme__WEBPACK_IMPORTED_MODULE_4__.resolveThemeSync)(this._config.theme, this._savedThemes);
        if (resolved.type === 'saved') {
            this._scheduleAutoSave(resolved.saved.id);
            return;
        }
        if (resolved.type === 'preset') {
            this._config.theme = 'custom';
            this._populateThemeDropdown();
            this._themeSelect.value = 'custom';
            this._updateThemeActions();
        }
    }
    _scheduleAutoSave(id) {
        if (this._autoSaveTimer) {
            clearTimeout(this._autoSaveTimer);
        }
        this._autoSaveTimer = setTimeout(() => {
            this._autoSaveTimer = null;
            const saved = this._savedThemes.find((t) => t.id === id);
            if (saved) {
                saved.config = structuredClone(this._config);
                saved.config.theme = id;
                void (0,_shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_5__.updateSavedTheme)(id, { config: saved.config });
            }
        }, 250);
    }
    _syncHiddenInput() {
        if (this._input) {
            this._input.value = JSON.stringify(this._config);
        }
    }
    _emitChange() {
        this._syncHiddenInput();
        if (this._emitTimer) {
            clearTimeout(this._emitTimer);
        }
        this._emitTimer = setTimeout(() => {
            this._emitTimer = null;
            this._input.dispatchEvent(new Event('change', { bubbles: true }));
        }, 250);
    }
}
HTMLWordStyleEditorElement.observedAttributes = ['value', 'name'];


/***/ }),
/* 199 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BORDER_STYLES: () => (/* binding */ BORDER_STYLES),
/* harmony export */   BOUNDS: () => (/* binding */ BOUNDS),
/* harmony export */   COLOUR_REGEX: () => (/* binding */ COLOUR_REGEX),
/* harmony export */   EFFECT_LABELS: () => (/* binding */ EFFECT_LABELS),
/* harmony export */   EFFECT_TYPES: () => (/* binding */ EFFECT_TYPES),
/* harmony export */   FONT_STYLES: () => (/* binding */ FONT_STYLES),
/* harmony export */   FONT_WEIGHTS: () => (/* binding */ FONT_WEIGHTS),
/* harmony export */   STYLEABLE_STATES: () => (/* binding */ STYLEABLE_STATES),
/* harmony export */   STYLEABLE_STATE_KEYS: () => (/* binding */ STYLEABLE_STATE_KEYS),
/* harmony export */   UNDERLINE_STYLES: () => (/* binding */ UNDERLINE_STYLES)
/* harmony export */ });
const STYLEABLE_STATES = {
    new: 'New',
    young: 'Young',
    mature: 'Mature',
    mastered: 'Mastered',
    due: 'Due',
    blacklisted: 'Blacklisted',
    suspended: 'Suspended',
    redundant: 'Redundant',
    frequent: 'Frequent',
    'i-plus-one': 'I+1',
    'in-any-deck': 'In any deck',
    'in-word-list': 'In word list',
    'in-media-deck': 'In media deck',
    'in-frequency-deck': 'In frequency deck',
    unparsed: 'Unparsed',
    heiban: 'Heiban',
    atamadaka: 'Atamadaka',
    nakadaka: 'Nakadaka',
    odaka: 'Odaka',
    kifuku: 'Kifuku',
};
const STYLEABLE_STATE_KEYS = Object.keys(STYLEABLE_STATES);
const EFFECT_LABELS = {
    'text-colour': 'Text Colour',
    background: 'Background',
    underline: 'Underline',
    border: 'Border',
    shadow: 'Text Shadow',
    blur: 'Blur',
    opacity: 'Opacity',
    'font-weight': 'Font Weight',
    'font-style': 'Font Style',
};
const EFFECT_TYPES = Object.keys(EFFECT_LABELS);
const COLOUR_REGEX = /^#[0-9a-fA-F]{3,8}$/;
const BOUNDS = {
    blurRadius: { min: 0, max: 20 },
    borderWidth: { min: 0, max: 10 },
    borderRadius: { min: 0, max: 20 },
    underlineThickness: { min: 1, max: 10 },
    shadowBlur: { min: 0, max: 20 },
    shadowOffset: { min: -20, max: 20 },
    opacity: { min: 0, max: 1, step: 0.05 },
    backgroundOpacity: { min: 0, max: 1, step: 0.05 },
};
const UNDERLINE_STYLES = ['solid', 'dashed', 'dotted', 'wavy'];
const BORDER_STYLES = ['solid', 'dashed'];
const FONT_WEIGHTS = ['normal', 'bold'];
const FONT_STYLES = ['normal', 'italic'];


/***/ }),
/* 200 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   decodeThemeCode: () => (/* binding */ decodeThemeCode),
/* harmony export */   encodeThemeCode: () => (/* binding */ encodeThemeCode)
/* harmony export */ });
/* harmony import */ var _validate__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(201);

function encodeThemeCode(config, name) {
    const payload = { v: 1, states: config.states };
    if (name) {
        payload.name = name;
    }
    const base64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    return `jtr:1${base64}`;
}
function decodeThemeCode(code) {
    if (!code.startsWith('jtr:')) {
        return null;
    }
    const version = code.charAt(4);
    if (parseInt(version, 10) > 1) {
        return null;
    }
    const base64 = code.substring(5);
    try {
        const json = decodeURIComponent(escape(atob(base64)));
        const parsed = JSON.parse(json);
        const config = (0,_validate__WEBPACK_IMPORTED_MODULE_0__.validateWordStyleConfig)(typeof parsed === 'object' && parsed !== null ? { ...parsed, theme: 'custom' } : null);
        if (!config) {
            return null;
        }
        const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
        return { config, name };
    }
    catch {
        return null;
    }
}


/***/ }),
/* 201 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   validateWordStyleConfig: () => (/* binding */ validateWordStyleConfig)
/* harmony export */ });
/* harmony import */ var _constants__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(199);
/* harmony import */ var _themes__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(6);


function isObject(val) {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
}
function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
}
function isValidColour(val) {
    return typeof val === 'string' && _constants__WEBPACK_IMPORTED_MODULE_0__.COLOUR_REGEX.test(val);
}
function validateEffect(raw) {
    if (!isObject(raw) || typeof raw.type !== 'string') {
        return null;
    }
    switch (raw.type) {
        case 'text-colour':
            if (!isValidColour(raw.colour)) {
                return null;
            }
            return { type: 'text-colour', colour: raw.colour };
        case 'background':
            if (!isValidColour(raw.colour) || typeof raw.opacity !== 'number') {
                return null;
            }
            return {
                type: 'background',
                colour: raw.colour,
                opacity: clamp(raw.opacity, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.backgroundOpacity.min, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.backgroundOpacity.max),
            };
        case 'underline':
            if (!isValidColour(raw.colour) ||
                typeof raw.thickness !== 'number' ||
                !_constants__WEBPACK_IMPORTED_MODULE_0__.UNDERLINE_STYLES.includes(raw.style)) {
                return null;
            }
            return {
                type: 'underline',
                colour: raw.colour,
                style: raw.style,
                thickness: clamp(raw.thickness, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.underlineThickness.min, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.underlineThickness.max),
            };
        case 'border':
            if (!isValidColour(raw.colour) ||
                typeof raw.width !== 'number' ||
                typeof raw.radius !== 'number' ||
                !_constants__WEBPACK_IMPORTED_MODULE_0__.BORDER_STYLES.includes(raw.style)) {
                return null;
            }
            return {
                type: 'border',
                colour: raw.colour,
                width: clamp(raw.width, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.borderWidth.min, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.borderWidth.max),
                style: raw.style,
                radius: clamp(raw.radius, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.borderRadius.min, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.borderRadius.max),
            };
        case 'shadow':
            if (!isValidColour(raw.colour) ||
                typeof raw.blur !== 'number' ||
                typeof raw.offsetX !== 'number' ||
                typeof raw.offsetY !== 'number') {
                return null;
            }
            return {
                type: 'shadow',
                colour: raw.colour,
                blur: clamp(raw.blur, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.shadowBlur.min, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.shadowBlur.max),
                offsetX: clamp(raw.offsetX, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.shadowOffset.min, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.shadowOffset.max),
                offsetY: clamp(raw.offsetY, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.shadowOffset.min, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.shadowOffset.max),
            };
        case 'blur':
            if (typeof raw.radius !== 'number') {
                return null;
            }
            return {
                type: 'blur',
                radius: clamp(raw.radius, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.blurRadius.min, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.blurRadius.max),
                hoverOnly: raw.hoverOnly === true,
            };
        case 'opacity':
            if (typeof raw.value !== 'number') {
                return null;
            }
            return {
                type: 'opacity',
                value: clamp(raw.value, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.opacity.min, _constants__WEBPACK_IMPORTED_MODULE_0__.BOUNDS.opacity.max),
                hoverOnly: raw.hoverOnly === true,
            };
        case 'font-weight':
            if (!_constants__WEBPACK_IMPORTED_MODULE_0__.FONT_WEIGHTS.includes(raw.value)) {
                return null;
            }
            return { type: 'font-weight', value: raw.value };
        case 'font-style':
            if (!_constants__WEBPACK_IMPORTED_MODULE_0__.FONT_STYLES.includes(raw.value)) {
                return null;
            }
            return { type: 'font-style', value: raw.value };
        default:
            return null;
    }
}
function validateWordStyleConfig(input) {
    if (!isObject(input)) {
        return null;
    }
    if (typeof input.v !== 'number' || input.v > 1) {
        return null;
    }
    if (!isObject(input.states)) {
        return null;
    }
    const theme = typeof input.theme === 'string' ? input.theme : 'custom';
    const states = {};
    for (const stateKey of _constants__WEBPACK_IMPORTED_MODULE_0__.STYLEABLE_STATE_KEYS) {
        const rawState = input.states[stateKey];
        if (!isObject(rawState) || !Array.isArray(rawState.effects)) {
            states[stateKey] = _themes__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_WORD_STYLE_CONFIG.states[stateKey]
                ? structuredClone(_themes__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_WORD_STYLE_CONFIG.states[stateKey])
                : { effects: [] };
            continue;
        }
        const validEffects = [];
        for (const rawEffect of rawState.effects) {
            const validated = validateEffect(rawEffect);
            if (validated) {
                validEffects.push(validated);
            }
        }
        states[stateKey] = { effects: validEffects };
    }
    return { v: 1, theme, states };
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
/* harmony import */ var _shared_configuration_profiles_state__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(8);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(11);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(20);
/* harmony import */ var _shared_dom_find_element__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(25);
/* harmony import */ var _shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(122);
/* harmony import */ var _shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(164);
/* harmony import */ var _shared_jiten_fetch_study_decks__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(48);
/* harmony import */ var _shared_jiten_ping__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(185);
/* harmony import */ var _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(174);
/* harmony import */ var _shared_messages_broadcast_profile_switched_command__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(183);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(33);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(124);
/* harmony import */ var _shared_tts_play_tts__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(125);
/* harmony import */ var _elements_html_features_input_element__WEBPACK_IMPORTED_MODULE_15__ = __webpack_require__(186);
/* harmony import */ var _elements_html_keybind_input_element__WEBPACK_IMPORTED_MODULE_16__ = __webpack_require__(188);
/* harmony import */ var _elements_html_mining_input_element__WEBPACK_IMPORTED_MODULE_17__ = __webpack_require__(189);
/* harmony import */ var _elements_html_new_state_input_element__WEBPACK_IMPORTED_MODULE_18__ = __webpack_require__(194);
/* harmony import */ var _elements_html_parsers_input_element__WEBPACK_IMPORTED_MODULE_19__ = __webpack_require__(195);
/* harmony import */ var _elements_html_profile_manager_element__WEBPACK_IMPORTED_MODULE_20__ = __webpack_require__(196);
/* harmony import */ var _elements_html_profile_selector_element__WEBPACK_IMPORTED_MODULE_21__ = __webpack_require__(181);
/* harmony import */ var _elements_html_reader_theme_input_element__WEBPACK_IMPORTED_MODULE_22__ = __webpack_require__(197);
/* harmony import */ var _elements_html_word_style_editor_element__WEBPACK_IMPORTED_MODULE_23__ = __webpack_require__(198);
























customElements.define('mining-input', _elements_html_mining_input_element__WEBPACK_IMPORTED_MODULE_17__.HTMLMiningInputElement);
customElements.define('reader-theme-input', _elements_html_reader_theme_input_element__WEBPACK_IMPORTED_MODULE_22__.HTMLReaderThemeInputElement);
customElements.define('profile-selector', _elements_html_profile_selector_element__WEBPACK_IMPORTED_MODULE_21__.HTMLProfileSelectorElement);
customElements.define('keybind-input', _elements_html_keybind_input_element__WEBPACK_IMPORTED_MODULE_16__.HTMLKeybindInputElement);
customElements.define('parsers-input', _elements_html_parsers_input_element__WEBPACK_IMPORTED_MODULE_19__.HTMLParsersInputElement);
customElements.define('features-input', _elements_html_features_input_element__WEBPACK_IMPORTED_MODULE_15__.HTMLFeaturesInputElement);
customElements.define('new-state-input', _elements_html_new_state_input_element__WEBPACK_IMPORTED_MODULE_18__.HTMLNewStateInputElement);
customElements.define('profile-manager', _elements_html_profile_manager_element__WEBPACK_IMPORTED_MODULE_20__.HTMLProfileManagerElement);
customElements.define('word-style-editor', _elements_html_word_style_editor_element__WEBPACK_IMPORTED_MODULE_23__.HTMLWordStyleEditorElement);
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#currentProfile', (selector) => {
    selector.addEventListener('profilechange', () => {
        window.location.reload();
    });
});
const localConfiguration = new Map();
const bindings = new Map();
const validators = {
    jitenApiKey: validateJitenApiKey,
};
const configurationUpdatedCommand = new _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_10__.ConfigurationUpdatedCommand();
//#region Theme Variables
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
    getThemeStyleEl().textContent = await (0,_shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_13__.getThemeCssVars)();
};
const applyThemeVarsFromInputs = () => {
    const bg = document.getElementById('themeBgColour')?.value || '#181818';
    const accent = document.getElementById('themeAccentColour')?.value || '#D8B9FA';
    getThemeStyleEl().textContent = `:root, :host { --jiten-bg: ${bg}; --jiten-accent: ${accent}; }`;
};
void applyThemeVars();
(0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_12__.onBroadcastMessage)('configurationUpdated', () => void applyThemeVars());
const setupColourPicker = (colourId, textId) => {
    const colourInput = document.getElementById(colourId);
    const textInput = document.getElementById(textId);
    if (!colourInput || !textInput) {
        return;
    }
    let debounceTimer = null;
    const saveAndApply = (value) => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        // Apply theme vars immediately from current input values for instant visual feedback
        applyThemeVarsFromInputs();
        // Debounce the save to avoid spamming storage
        debounceTimer = setTimeout(() => {
            void (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__.setConfiguration)(colourId, value).then(() => {
                configurationUpdatedCommand.send();
            });
        }, 150);
    };
    // Initial load: sync text input from colour input (which is loaded by withElements)
    const syncTextFromColour = () => {
        textInput.value = colourInput.value.toUpperCase();
    };
    // Wait for colour input to be loaded by withElements, then sync text
    setTimeout(syncTextFromColour, 50);
    // When user types in text input, update colour picker and save
    textInput.addEventListener('input', () => {
        const value = textInput.value.trim();
        if (/^#[0-9A-Fa-f]{6}$/i.test(value)) {
            colourInput.value = value;
            saveAndApply(value);
        }
    });
    // When user picks colour, update text input and save
    colourInput.addEventListener('input', () => {
        textInput.value = colourInput.value.toUpperCase();
        saveAndApply(colourInput.value);
    });
};
setupColourPicker('themeBgColour', 'themeBgColourText');
setupColourPicker('themeAccentColour', 'themeAccentColourText');
//#endregion
//#region Init Interactions
(0,_shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_7__.withElements)('input, textarea, select, keybind-input, parsers-input, features-input, new-state-input, word-style-editor, reader-theme-input', (field) => {
    const internal = field.hasAttribute('internal');
    const ignored = ['hidden', 'submit', 'button'];
    const checkbox = field.type === 'checkbox';
    if (internal || ignored.includes(field.type)) {
        return;
    }
    void (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)(field.name)
        // Load current or default configuration
        .then((value) => {
        if (checkbox) {
            field.checked = value;
        }
        else {
            field.value = value;
        }
        return validateAndSet(field.name, value);
    })
        // Apply change listeners
        .then(() => {
        field.onchange = () => {
            const value = checkbox ? field.checked : field.value;
            void validateAndSet(field.name, value, async () => {
                await (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__.setConfiguration)(field.name, value);
                configurationUpdatedCommand.send();
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_4__.displayToast)('success', 'Settings saved successfully', undefined, true);
            });
        };
    });
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#jitenStudyDeckId', (select) => {
    void (async () => {
        const apiKey = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiKey');
        if (!apiKey?.length) {
            return;
        }
        try {
            const decks = await (0,_shared_jiten_fetch_study_decks__WEBPACK_IMPORTED_MODULE_8__.fetchStudyDecks)({ apiToken: apiKey });
            for (const deck of decks) {
                const option = document.createElement('option');
                option.value = String(deck.userStudyDeckId);
                option.textContent = deck.name;
                select.appendChild(option);
            }
            const currentValue = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenStudyDeckId');
            select.value = String(currentValue);
        }
        catch {
            // API unreachable
        }
    })();
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#apiKeyRevealButton', (button) => {
    button.onclick = () => {
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#jitenApiKey', (input) => {
            const revealed = input.type === 'text';
            input.type = revealed ? 'password' : 'text';
            button.style.textDecoration = revealed ? '' : 'line-through';
        });
    };
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#apiTokenButton', (button) => {
    button.onclick = () => {
        (0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#jitenApiKey', (i) => {
            void validateJitenApiKey(i.value);
        });
    };
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#export-settings', (button) => {
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
            const a = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('a', {
                attributes: { href: url, download: downloadTitleWithDate },
            });
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    };
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#import-settings', (button) => {
    button.onclick = (event) => {
        event.stopPropagation();
        event.preventDefault();
        const fileInput = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_3__.createElement)('input', {
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
            const activeProfileId = await (0,_shared_configuration_profiles_state__WEBPACK_IMPORTED_MODULE_1__.getActiveProfileId)();
            new _shared_messages_broadcast_profile_switched_command__WEBPACK_IMPORTED_MODULE_11__.ProfileSwitchedCommand(activeProfileId).send();
            configurationUpdatedCommand.send();
            window.location.reload();
        };
        fileInput.click();
    };
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#ttsTestButton', (button) => {
    button.onclick = () => {
        const voiceSelect = document.getElementById('ttsVoice');
        button.disabled = true;
        void (0,_shared_tts_play_tts__WEBPACK_IMPORTED_MODULE_14__.playTts)(1002340, 3, voiceSelect.value).finally(() => {
            button.disabled = false;
        });
    };
});
(0,_shared_dom_with_element__WEBPACK_IMPORTED_MODULE_6__.withElement)('#exportApiKey', (checkbox) => {
    checkbox.addEventListener('change', () => {
        const warning = document.getElementById('exportApiKeyWarning');
        if (warning) {
            warning.style.display = checkbox.checked ? 'block' : 'none';
        }
    });
});
//#endregion
//#region Field Updates
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
//#endregion
//#region Field Bindings
(0,_shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_7__.withElements)('[data-show]', (element) => {
    const attributeValue = element.getAttribute('data-show');
    /**
     * The property resembles a javascript condition - the following are valid
     *
     * - myProperty
     * - !myProperty
     * - myProperty && !myOtherProperty
     * - myProperty || myOtherProperty
     * - (myProperty && myOtherProperty) || !myThirdProperty
     */
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
const afterBindingsCallbacks = [];
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
    for (const cb of afterBindingsCallbacks) {
        cb();
    }
}
function parseCondition(expr) {
    // Tokenize
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
            next(); // consume '('
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
        // Property name
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
//#endregion
//#region TOC Navigation
const toc = document.getElementById('settings-toc');
if (toc) {
    const tocLinks = Array.from(toc.querySelectorAll('a[href^="#"]'));
    const sectionEls = [];
    for (const link of tocLinks) {
        const id = link.getAttribute('href').slice(1);
        const section = document.getElementById(id);
        if (section) {
            sectionEls.push(section);
        }
    }
    const scrollTocToLink = (link) => {
        const tocRect = toc.getBoundingClientRect();
        const linkRect = link.getBoundingClientRect();
        const offset = linkRect.left - tocRect.left + linkRect.width / 2 - tocRect.width / 2;
        toc.scrollBy({ left: offset, behavior: 'smooth' });
    };
    toc.addEventListener('click', (e) => {
        const link = e.target.closest('a[href^="#"]');
        if (!link) {
            return;
        }
        e.preventDefault();
        const id = link.getAttribute('href').slice(1);
        const target = document.getElementById(id);
        if (target) {
            if (target instanceof HTMLDetailsElement && !target.open) {
                target.open = true;
            }
            target.scrollIntoView({ behavior: 'smooth' });
            scrollTocToLink(link);
        }
    });
    let activeLink = null;
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                const link = toc.querySelector(`a[href="#${entry.target.id}"]`);
                if (link && link.style.display !== 'none') {
                    activeLink?.classList.remove('active');
                    link.classList.add('active');
                    activeLink = link;
                    scrollTocToLink(link);
                }
            }
        }
    }, { rootMargin: '-10% 0px -80% 0px' });
    for (const section of sectionEls) {
        observer.observe(section);
    }
    afterBindingsCallbacks.push(() => {
        if (activeLink?.style.display === 'none') {
            activeLink.classList.remove('active');
            activeLink = null;
        }
    });
}
//#endregion
//#region Settings Search
const searchInput = document.getElementById('settings-search');
if (searchInput) {
    const searchSections = [];
    const searchOpenedDetails = new Set();
    const sectionSelector = 'form > .section[id], form > details.section-collapsible[id]';
    for (const sectionEl of document.querySelectorAll(sectionSelector)) {
        const heading = sectionEl.querySelector(':scope > h6, :scope > summary');
        const tocLink = toc?.querySelector(`a[href="#${sectionEl.id}"]`) ?? null;
        const items = [];
        const containers = new Set();
        for (const fbp of sectionEl.querySelectorAll('.form-box-parent')) {
            containers.add(fbp);
            for (const fb of fbp.querySelectorAll(':scope > .form-box')) {
                for (const child of Array.from(fb.children)) {
                    if (child.tagName !== 'DIV') {
                        continue;
                    }
                    items.push({ el: child, text: gatherText(child), container: fbp });
                }
            }
        }
        for (const acc of sectionEl.querySelectorAll('details.accordion')) {
            if (acc.closest('.form-box-parent')) {
                continue;
            }
            items.push({ el: acc, text: gatherText(acc), container: null });
        }
        searchSections.push({
            el: sectionEl,
            heading: heading?.textContent?.toLowerCase().trim() ?? '',
            tocLink,
            items,
            containers,
        });
    }
    function gatherText(el) {
        const parts = [];
        for (const node of el.querySelectorAll('label, p, summary')) {
            if (node.textContent) {
                parts.push(node.textContent);
            }
        }
        return parts.join(' ').toLowerCase();
    }
    function isHiddenByShow(el, root) {
        if (root.style.display === 'none') {
            return true;
        }
        let cur = el;
        while (cur && cur !== root) {
            if (cur.style.display === 'none') {
                return true;
            }
            cur = cur.parentElement;
        }
        return false;
    }
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
        if (searchTimer) {
            clearTimeout(searchTimer);
        }
        searchTimer = setTimeout(runSearch, 150);
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            clearSearch();
        }
    });
    searchInput.addEventListener('search', () => {
        if (!searchInput.value) {
            clearSearch();
        }
    });
    function runSearch() {
        const query = searchInput.value.trim().toLowerCase();
        if (!query) {
            clearSearch();
            return;
        }
        for (const section of searchSections) {
            let sectionHasMatch = false;
            const headingMatches = section.heading.includes(query);
            const containerHits = new Map();
            for (const c of section.containers) {
                containerHits.set(c, 0);
            }
            for (const item of section.items) {
                if (isHiddenByShow(item.el, section.el)) {
                    continue;
                }
                const matches = headingMatches || item.text.includes(query);
                item.el.classList.toggle('search-hidden', !matches);
                item.el.classList.toggle('search-match', matches);
                if (matches) {
                    sectionHasMatch = true;
                    if (item.container) {
                        containerHits.set(item.container, (containerHits.get(item.container) ?? 0) + 1);
                    }
                    if (item.el instanceof HTMLDetailsElement && !item.el.open) {
                        item.el.open = true;
                        searchOpenedDetails.add(item.el);
                    }
                }
            }
            for (const [c, hits] of containerHits) {
                c.classList.toggle('search-hidden', hits === 0);
            }
            section.el.classList.toggle('search-hidden', !sectionHasMatch);
            section.tocLink?.classList.toggle('search-hidden', !sectionHasMatch);
            if (sectionHasMatch && section.el instanceof HTMLDetailsElement && !section.el.open) {
                section.el.open = true;
                searchOpenedDetails.add(section.el);
            }
        }
    }
    function clearSearch() {
        searchInput.value = '';
        for (const section of searchSections) {
            section.el.classList.remove('search-hidden');
            section.tocLink?.classList.remove('search-hidden');
            for (const c of section.containers) {
                c.classList.remove('search-hidden');
            }
            for (const item of section.items) {
                item.el.classList.remove('search-hidden', 'search-match');
            }
        }
        for (const d of searchOpenedDetails) {
            d.open = false;
        }
        searchOpenedDetails.clear();
    }
    afterBindingsCallbacks.push(() => {
        if (searchInput.value.trim()) {
            runSearch();
        }
    });
}
//#endregion
//#region Validators
async function validateJitenApiKey(value) {
    let isValid = false;
    if (value?.length) {
        try {
            await (0,_shared_jiten_ping__WEBPACK_IMPORTED_MODULE_9__.ping)({ apiToken: value });
            isValid = true;
        }
        catch (_e) {
            /* NOP */
        }
    }
    const button = (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_5__.findElement)('#apiTokenButton');
    const input = (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_5__.findElement)('#jitenApiKey');
    button.classList.toggle('v1', !isValid);
    input.classList.toggle('v1', !isValid);
    return isValid;
}
//#endregion

})();

/******/ })()
;