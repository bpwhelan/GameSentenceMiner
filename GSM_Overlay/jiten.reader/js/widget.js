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
/* 15 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   openOptionsPage: () => (/* binding */ openOptionsPage)
/* harmony export */ });
const openOptionsPage = () => chrome.runtime.openOptionsPage();


/***/ }),
/* 16 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   openView: () => (/* binding */ openView)
/* harmony export */ });
/* harmony import */ var _get_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(17);

const openView = (view) => chrome.tabs.create({ url: (0,_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)(`views/${view}.html`) });


/***/ }),
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
/* 26 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   OpenReaderModeCommand: () => (/* binding */ OpenReaderModeCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);

class OpenReaderModeCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'openReaderMode';
    }
}


/***/ }),
/* 27 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ForegroundCommand: () => (/* binding */ ForegroundCommand)
/* harmony export */ });
/* harmony import */ var _extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(28);
/* harmony import */ var _extension_tabs__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(29);
/* harmony import */ var _command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(30);



class ForegroundCommand extends _command__WEBPACK_IMPORTED_MODULE_2__.Command {
    send(tabId, afterCall) {
        // Fire-and-forget: swallow rejections (e.g. "Receiving end does not exist" when the target tab
        // has no content script yet / was closed). Callers that need the result use call() and handle it.
        void this.call(tabId, afterCall).catch(() => undefined);
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
/* 31 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParsePageCommand: () => (/* binding */ ParsePageCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(27);

class ParsePageCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'parsePage';
    }
}


/***/ }),
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
/* 41 */,
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
/* 121 */,
/* 122 */,
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
/* 138 */,
/* 139 */,
/* 140 */,
/* 141 */,
/* 142 */,
/* 143 */,
/* 144 */,
/* 145 */,
/* 146 */,
/* 147 */
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
/* 164 */,
/* 165 */,
/* 166 */,
/* 167 */,
/* 168 */,
/* 169 */,
/* 170 */,
/* 171 */,
/* 172 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   isDisabled: () => (/* binding */ isDisabled)
/* harmony export */ });
/* harmony import */ var _get_host_meta__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(103);

const isDisabled = async (host) => {
    const enabledHosts = await (0,_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.resolveMatchingHosts)(host);
    const meta = (0,_get_host_meta__WEBPACK_IMPORTED_MODULE_0__.filterHostMeta)(enabledHosts, ({ host }) => host !== '<all_urls>');
    if (!meta) {
        return false;
    }
    if (meta.disabled) {
        return true;
    }
    return meta.auto;
};


/***/ }),
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
/* 177 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   setParsingPaused: () => (/* binding */ setParsingPaused)
/* harmony export */ });
const setParsingPaused = async (paused) => {
    await chrome.storage.local.set({ parsingPaused: paused });
};


/***/ }),
/* 178 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParsingPausedCommand: () => (/* binding */ ParsingPausedCommand)
/* harmony export */ });
/* harmony import */ var _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(45);

class ParsingPausedCommand extends _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__.BroadcastCommand {
    constructor(paused) {
        super();
        this.key = 'parsingPaused';
        this.arguments = [paused];
    }
}


/***/ }),
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
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(11);
/* harmony import */ var _shared_dom_append_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(23);
/* harmony import */ var _shared_dom_on_loaded__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(87);
/* harmony import */ var _shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(147);
/* harmony import */ var _shared_extension_get_tabs__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(46);
/* harmony import */ var _shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(15);
/* harmony import */ var _shared_extension_open_view__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(16);
/* harmony import */ var _shared_extension_set_parsing_paused__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(177);
/* harmony import */ var _shared_host_meta_is_disabled__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(172);
/* harmony import */ var _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(174);
/* harmony import */ var _shared_messages_broadcast_parsing_paused_command__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(178);
/* harmony import */ var _shared_messages_foreground_open_reader_mode_command__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(26);
/* harmony import */ var _shared_messages_foreground_parse_page_command__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(31);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(33);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_15__ = __webpack_require__(124);
/* harmony import */ var _shared_word_style_resolve_theme__WEBPACK_IMPORTED_MODULE_16__ = __webpack_require__(179);
/* harmony import */ var _shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_17__ = __webpack_require__(180);
/* harmony import */ var _shared_word_style_themes__WEBPACK_IMPORTED_MODULE_18__ = __webpack_require__(6);
/* harmony import */ var _elements_html_profile_selector_element__WEBPACK_IMPORTED_MODULE_19__ = __webpack_require__(181);




















customElements.define('profile-selector', _elements_html_profile_selector_element__WEBPACK_IMPORTED_MODULE_19__.HTMLProfileSelectorElement);
const applyThemeVars = async () => {
    const cssVars = await (0,_shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_15__.getThemeCssVars)();
    let styleEl = document.getElementById('jiten-theme-vars');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'jiten-theme-vars';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = cssVars;
};
void applyThemeVars();
(0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_14__.onBroadcastMessage)('configurationUpdated', () => void applyThemeVars());
const updatePauseToggle = (toggle, paused) => {
    toggle.innerText = paused ? 'Paused' : 'Enabled';
    toggle.classList.toggle('paused', paused);
};
(0,_shared_dom_on_loaded__WEBPACK_IMPORTED_MODULE_3__.onLoaded)(async () => {
    document.getElementById('settings')?.addEventListener('click', () => {
        void (0,_shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_6__.openOptionsPage)();
    });
    document.getElementById('changelog')?.addEventListener('click', () => {
        void (0,_shared_extension_open_view__WEBPACK_IMPORTED_MODULE_7__.openView)('changelog');
    });
    document.getElementById('reader-mode')?.addEventListener('click', () => {
        void (0,_shared_extension_get_tabs__WEBPACK_IMPORTED_MODULE_5__.getTabs)({ active: true, currentWindow: true }).then(([tab]) => {
            if (tab?.id) {
                new _shared_messages_foreground_open_reader_mode_command__WEBPACK_IMPORTED_MODULE_12__.OpenReaderModeCommand().send(tab.id, () => window.close());
            }
        });
    });
    document.getElementById('pdf-reader')?.addEventListener('click', () => {
        void (0,_shared_extension_open_view__WEBPACK_IMPORTED_MODULE_7__.openView)('pdf-reader').then(() => window.close());
    });
    const themeSelect = document.getElementById('theme-select');
    const currentConfig = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('wordStyleConfig');
    const savedThemes = await (0,_shared_word_style_saved_themes_state__WEBPACK_IMPORTED_MODULE_17__.getSavedThemes)();
    const populateWidgetThemeDropdown = () => {
        themeSelect.innerHTML = '';
        const presetsGroup = document.createElement('optgroup');
        presetsGroup.label = 'Presets';
        for (const [key, { label }] of _shared_word_style_themes__WEBPACK_IMPORTED_MODULE_18__.PRESET_THEMES) {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = label;
            presetsGroup.appendChild(option);
        }
        themeSelect.appendChild(presetsGroup);
        if (savedThemes.length > 0) {
            const savedGroup = document.createElement('optgroup');
            savedGroup.label = 'Saved';
            for (const saved of savedThemes) {
                const option = document.createElement('option');
                option.value = saved.id;
                option.textContent = saved.label;
                savedGroup.appendChild(option);
            }
            themeSelect.appendChild(savedGroup);
        }
        const resolved = (0,_shared_word_style_resolve_theme__WEBPACK_IMPORTED_MODULE_16__.resolveThemeSync)(currentConfig.theme, savedThemes);
        if (resolved.type === 'custom') {
            const customOption = document.createElement('option');
            customOption.value = 'custom';
            customOption.textContent = 'Custom';
            themeSelect.appendChild(customOption);
        }
        themeSelect.value = currentConfig.theme;
    };
    populateWidgetThemeDropdown();
    themeSelect.addEventListener('change', () => {
        if (currentConfig.theme === 'custom' && themeSelect.value !== 'custom') {
            if (!confirm('Your unsaved custom theme will be lost. Continue?')) {
                themeSelect.value = 'custom';
                return;
            }
        }
        const preset = _shared_word_style_themes__WEBPACK_IMPORTED_MODULE_18__.PRESET_THEMES.get(themeSelect.value);
        if (preset) {
            currentConfig.theme = preset.config.theme;
            void (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.setConfiguration)('wordStyleConfig', structuredClone(preset.config)).then(() => {
                new _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_10__.ConfigurationUpdatedCommand().send();
            });
            return;
        }
        const saved = savedThemes.find((t) => t.id === themeSelect.value);
        if (saved) {
            const config = structuredClone(saved.config);
            config.theme = saved.id;
            currentConfig.theme = saved.id;
            void (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.setConfiguration)('wordStyleConfig', config).then(() => {
                new _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_10__.ConfigurationUpdatedCommand().send();
            });
        }
    });
    const pauseToggle = document.getElementById('pause-toggle');
    let isPaused = await (0,_shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_4__.getParsingPaused)();
    updatePauseToggle(pauseToggle, isPaused);
    pauseToggle.addEventListener('click', () => {
        isPaused = !isPaused;
        void (0,_shared_extension_set_parsing_paused__WEBPACK_IMPORTED_MODULE_8__.setParsingPaused)(isPaused).then(() => {
            updatePauseToggle(pauseToggle, isPaused);
            new _shared_messages_broadcast_parsing_paused_command__WEBPACK_IMPORTED_MODULE_11__.ParsingPausedCommand(isPaused).send();
        });
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
    const allTabs = await (0,_shared_extension_get_tabs__WEBPACK_IMPORTED_MODULE_5__.getTabs)(tabsFilter);
    const parsePage = new _shared_messages_foreground_parse_page_command__WEBPACK_IMPORTED_MODULE_13__.ParsePageCommand();
    let renderedTabs = [];
    for (const tab of allTabs) {
        if (tab.id &&
            !tab.url?.startsWith('about://') &&
            !tab.url?.startsWith('chrome://') &&
            !(await (0,_shared_host_meta_is_disabled__WEBPACK_IMPORTED_MODULE_9__.isDisabled)(tab.url))) {
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
        (0,_shared_dom_append_element__WEBPACK_IMPORTED_MODULE_2__.appendElement)('.pages', {
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