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
    clipboardReaderAutoPaste: false,
    clipboardReaderReplaceLine: false,
    clipboardReaderTimestamps: false,
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
    furiganaOnlyOnNew: false,
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
    clipboardReaderKey: [],
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
    exposePageEvents: true,
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
/* 10 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   migrateToProfiles: () => (/* binding */ migrateToProfiles)
/* harmony export */ });
/* harmony import */ var _default_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(3);
/* harmony import */ var _profile_constants__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(7);
/* harmony import */ var _profile_types__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(9);



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
    catch { }
};


/***/ }),
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
/* 13 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   addContextMenu: () => (/* binding */ addContextMenu)
/* harmony export */ });
/* harmony import */ var _add_install_listener__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(14);

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
/* 14 */
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
/* 15 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CLIPBOARD_READER_COMMAND: () => (/* binding */ CLIPBOARD_READER_COMMAND),
/* harmony export */   CLIPBOARD_READER_STORAGE_KEY: () => (/* binding */ CLIPBOARD_READER_STORAGE_KEY),
/* harmony export */   FIND_CLIPBOARD_READER: () => (/* binding */ FIND_CLIPBOARD_READER)
/* harmony export */ });
/** Answered by an open clipboard reader page, so opening it again focuses that tab instead. */
const FIND_CLIPBOARD_READER = 'findClipboardReader';
/** Holds pasted text, so it stays out of settings exports. */
const CLIPBOARD_READER_STORAGE_KEY = 'clipboardReaderEntries';
/** Manifest command with no suggested key, so it claims no shortcut until the user binds one. */
const CLIPBOARD_READER_COMMAND = 'open-clipboard-reader';


/***/ }),
/* 16 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   openOptionsPage: () => (/* binding */ openOptionsPage)
/* harmony export */ });
const openOptionsPage = () => chrome.runtime.openOptionsPage();


/***/ }),
/* 17 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   openView: () => (/* binding */ openView)
/* harmony export */ });
/* harmony import */ var _get_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);

const openView = (view) => chrome.tabs.create({ url: (0,_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)(`views/${view}.html`) });


/***/ }),
/* 18 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getURL: () => (/* binding */ getURL)
/* harmony export */ });
const getURL = (url) => chrome.runtime.getURL(url);


/***/ }),
/* 19 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   runtime: () => (/* binding */ runtime)
/* harmony export */ });
const runtime = chrome.runtime;


/***/ }),
/* 20 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   clearRejectedApiToken: () => (/* binding */ clearRejectedApiToken),
/* harmony export */   isApiTokenRejected: () => (/* binding */ isApiTokenRejected),
/* harmony export */   requestByUrl: () => (/* binding */ requestByUrl)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _dom_display_toast__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(21);
/* harmony import */ var _connection_errors__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(27);
/* harmony import */ var _rate_limited_error__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(28);




const CONNECT_TIMEOUT_MS = 10_000;
const DOWNLOAD_STALL_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const DEFAULT_RETRY_AFTER_MS = 5_000;
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
const DOWNLOAD_STALLED = Symbol('download stalled');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitBeforeRetry = (attempt) => {
    const backoff = INITIAL_BACKOFF_MS * 2 ** attempt;
    return wait(backoff + Math.random() * backoff * 0.5);
};
const abortOnTimeout = (controller) => controller.abort(new DOMException('Request timed out', 'TimeoutError'));
// Large parse responses can take minutes on slow connections, so only a download that stops progressing fails.
const readBody = async (response, controller) => {
    if (!response.body) {
        return response.text();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let stalled = false;
    const onStall = () => {
        stalled = true;
        abortOnTimeout(controller);
    };
    const deadline = setTimeout(() => abortOnTimeout(controller), DOWNLOAD_TIMEOUT_MS);
    let stall = setTimeout(onStall, DOWNLOAD_STALL_TIMEOUT_MS);
    try {
        let chunk = await reader.read();
        while (!chunk.done) {
            chunks.push(chunk.value);
            clearTimeout(stall);
            stall = setTimeout(onStall, DOWNLOAD_STALL_TIMEOUT_MS);
            chunk = await reader.read();
        }
    }
    catch (error) {
        if (stalled) {
            return DOWNLOAD_STALLED;
        }
        throw error;
    }
    finally {
        clearTimeout(deadline);
        clearTimeout(stall);
    }
    return new Blob(chunks).text();
};
const parseRetryAfter = (header) => {
    const seconds = Number(header);
    return header?.trim() && Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000
        : DEFAULT_RETRY_AFTER_MS;
};
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
    // GSM consumes this ID locally; all retries of one operation share it.
    const requestId = crypto.randomUUID();
    let lastError;
    let downloadRetried = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let response;
        const controller = new AbortController();
        const connectTimeout = setTimeout(() => abortOnTimeout(controller), CONNECT_TIMEOUT_MS);
        try {
            response = await fetch(usedUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `ApiKey ${apiToken}`,
                    Accept: 'application/json',
                    'X-GSM-Request-Id': requestId,
                },
                body: params ? JSON.stringify(params) : undefined,
                signal: controller.signal,
            });
        }
        catch (error) {
            lastError = error;
            if (attempt < MAX_RETRIES - 1) {
                await waitBeforeRetry(attempt);
                continue;
            }
            throw (0,_connection_errors__WEBPACK_IMPORTED_MODULE_2__.toConnectionError)(error);
        }
        finally {
            clearTimeout(connectTimeout);
        }
        if (response.status === 401 || response.status === 403) {
            rejectedApiToken = apiToken;
            throw new Error(API_KEY_REJECTED_MESSAGE);
        }
        if (response.status === 429 && (options?.failFastOnRateLimit || attempt === MAX_RETRIES - 1)) {
            throw new _rate_limited_error__WEBPACK_IMPORTED_MODULE_3__.RateLimitedError(parseRetryAfter(response.headers.get('Retry-After')));
        }
        if (!response.ok && isRetryable(null, response) && attempt < MAX_RETRIES - 1) {
            await waitBeforeRetry(attempt);
            continue;
        }
        let body;
        try {
            body = await readBody(response, controller);
        }
        catch (error) {
            throw (0,_connection_errors__WEBPACK_IMPORTED_MODULE_2__.toConnectionError)(error);
        }
        if (body === DOWNLOAD_STALLED) {
            lastError = new Error(_connection_errors__WEBPACK_IMPORTED_MODULE_2__.JITEN_TIMEOUT_MESSAGE);
            // Retried once: a stall usually means a dropped connection, whereas hitting the overall cap means a slow one.
            if (!downloadRetried && attempt < MAX_RETRIES - 1) {
                downloadRetried = true;
                await waitBeforeRetry(attempt);
                continue;
            }
            throw lastError;
        }
        const responseObject = JSON.parse(body);
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
/* 21 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   displayToast: () => (/* binding */ displayToast)
/* harmony export */ });
/* harmony import */ var _extension_get_style_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(22);
/* harmony import */ var _create_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(23);
/* harmony import */ var _find_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(26);



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
/* 22 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getStyleUrl: () => (/* binding */ getStyleUrl)
/* harmony export */ });
/* harmony import */ var _get_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);

const getStyleUrl = (url) => (0,_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)(`css/${url}.css`);


/***/ }),
/* 23 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   createElement: () => (/* binding */ createElement)
/* harmony export */ });
/* harmony import */ var _append_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(24);

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
        e.style.touchAction = 'manipulation';
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
/* 24 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   appendElement: () => (/* binding */ appendElement)
/* harmony export */ });
/* harmony import */ var _create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(23);
/* harmony import */ var _resolve_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(25);


function appendElement(parent, child) {
    const e = child instanceof HTMLElement ? child : (0,_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)(child);
    (0,_resolve_element__WEBPACK_IMPORTED_MODULE_1__.resolveElement)(parent)?.append(e);
    return e;
}


/***/ }),
/* 25 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   resolveElement: () => (/* binding */ resolveElement)
/* harmony export */ });
function resolveElement(element) {
    return typeof element === 'string' ? document.querySelector(element) : element;
}


/***/ }),
/* 26 */
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
/* 27 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CONNECTION_ERROR_MESSAGES: () => (/* binding */ CONNECTION_ERROR_MESSAGES),
/* harmony export */   JITEN_TIMEOUT_MESSAGE: () => (/* binding */ JITEN_TIMEOUT_MESSAGE),
/* harmony export */   JITEN_UNREACHABLE_MESSAGE: () => (/* binding */ JITEN_UNREACHABLE_MESSAGE),
/* harmony export */   toConnectionError: () => (/* binding */ toConnectionError)
/* harmony export */ });
const JITEN_TIMEOUT_MESSAGE = 'jiten.moe did not respond in time';
const JITEN_UNREACHABLE_MESSAGE = 'jiten.moe is unreachable';
const CONNECTION_ERROR_MESSAGES = [
    JITEN_TIMEOUT_MESSAGE,
    JITEN_UNREACHABLE_MESSAGE,
];
// Errors reach content scripts as a bare message, so fetch failures are reworded before the DOMException is lost.
const toConnectionError = (error) => error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
    ? new Error(JITEN_TIMEOUT_MESSAGE)
    : new Error(JITEN_UNREACHABLE_MESSAGE);


/***/ }),
/* 28 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RateLimitedError: () => (/* binding */ RateLimitedError)
/* harmony export */ });
class RateLimitedError extends Error {
    constructor(retryAfterMs) {
        super('jiten.moe rate limit reached');
        this.retryAfterMs = retryAfterMs;
    }
}


/***/ }),
/* 29 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   OpenReaderModeCommand: () => (/* binding */ OpenReaderModeCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(30);

class OpenReaderModeCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'openReaderMode';
    }
}


/***/ }),
/* 30 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ForegroundCommand: () => (/* binding */ ForegroundCommand)
/* harmony export */ });
/* harmony import */ var _extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(31);
/* harmony import */ var _extension_tabs__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(32);
/* harmony import */ var _command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(33);



class ForegroundCommand extends _command__WEBPACK_IMPORTED_MODULE_2__.Command {
    send(tabId, afterCall) {
        // Fire-and-forget: swallow rejections (e.g. "Receiving end does not exist" when the target tab
        // has no content script yet / was closed). Callers that need the result use call() and handle it.
        void this.call(tabId, afterCall).catch(() => undefined);
    }
    /** Delivers to one frame only; a tab-wide send reaches every frame's content script. */
    sendToFrame(tabId, frameId) {
        void this.sendMessage(tabId, { frameId }).catch(() => undefined);
    }
    call(tabId, afterCall) {
        const promise = this.sendMessage(tabId, {});
        return afterCall
            ? promise.then(async (r) => {
                await afterCall(r);
                return r;
            })
            : promise;
    }
    sendMessage(tabId, options) {
        return new Promise((resolve, reject) => {
            _extension_tabs__WEBPACK_IMPORTED_MODULE_1__.tabs.sendMessage(tabId, {
                event: this.key,
                command: this.constructor.name,
                isBroadcast: false,
                args: this.arguments,
            }, options, (response) => {
                const lastError = (0,_extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__.getLastError)();
                if (lastError) {
                    reject(lastError);
                }
                resolve(response);
            });
        });
    }
}


/***/ }),
/* 31 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getLastError: () => (/* binding */ getLastError)
/* harmony export */ });
const getLastError = () => chrome.runtime.lastError;


/***/ }),
/* 32 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   tabs: () => (/* binding */ tabs)
/* harmony export */ });
const tabs = chrome.tabs;


/***/ }),
/* 33 */
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
/* 34 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParsePageCommand: () => (/* binding */ ParsePageCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(30);

class ParsePageCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'parsePage';
    }
}


/***/ }),
/* 35 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParseSelectionCommand: () => (/* binding */ ParseSelectionCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(30);

class ParseSelectionCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'parseSelection';
    }
}


/***/ }),
/* 36 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   onBroadcastMessage: () => (/* binding */ onBroadcastMessage)
/* harmony export */ });
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(19);

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
/* 37 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AddToStudyDeckCommandHandler: () => (/* binding */ AddToStudyDeckCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_jiten_add_to_study_deck__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(38);
/* harmony import */ var _shared_messages_background_add_to_study_deck_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(39);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(41);




class AddToStudyDeckCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_3__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_add_to_study_deck_command__WEBPACK_IMPORTED_MODULE_2__.AddToStudyDeckCommand;
    }
    async handle(_sender, deckId, wordId, readingIndex, sentence, source) {
        const setSentences = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('setSentences');
        await (0,_shared_jiten_add_to_study_deck__WEBPACK_IMPORTED_MODULE_1__.addToStudyDeck)(deckId, wordId, readingIndex, setSentences ? sentence : undefined, setSentences ? source : undefined);
    }
}


/***/ }),
/* 38 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   addToStudyDeck: () => (/* binding */ addToStudyDeck)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _request_by_url__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(20);


const addToStudyDeck = async (deckId, wordId, readingIndex, sentence, source) => {
    const baseUrl = await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiEndpoint');
    await (0,_request_by_url__WEBPACK_IMPORTED_MODULE_1__.requestByUrl)(baseUrl, `srs/study-decks/${deckId}/words`, {
        wordId,
        readingIndex,
        occurrences: 1,
        sentence,
        source,
    });
};


/***/ }),
/* 39 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AddToStudyDeckCommand: () => (/* binding */ AddToStudyDeckCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class AddToStudyDeckCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'addToStudyDeck';
    }
}


/***/ }),
/* 40 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BackgroundCommand: () => (/* binding */ BackgroundCommand)
/* harmony export */ });
/* harmony import */ var _extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(31);
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(19);
/* harmony import */ var _lib_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(33);



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
/* harmony export */   BatchReviewCommandHandler: () => (/* binding */ BatchReviewCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_jiten_batch_review__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(43);
/* harmony import */ var _shared_jiten_get_card_state__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(45);
/* harmony import */ var _shared_messages_background_batch_review_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(46);
/* harmony import */ var _shared_messages_broadcast_card_state_updated_command__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(47);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(41);





class BatchReviewCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_4__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_batch_review_command__WEBPACK_IMPORTED_MODULE_2__.BatchReviewCommand;
    }
    async handle(sender, items) {
        const result = await (0,_shared_jiten_batch_review__WEBPACK_IMPORTED_MODULE_0__.batchReview)(items);
        const words = items.map((item) => [item.wordId, item.readingIndex]);
        const states = await (0,_shared_jiten_get_card_state__WEBPACK_IMPORTED_MODULE_1__.getCardStates)(words);
        words.forEach(([wordId, readingIndex], index) => {
            const state = states[index];
            if (state) {
                new _shared_messages_broadcast_card_state_updated_command__WEBPACK_IMPORTED_MODULE_3__.CardStateUpdatedCommand(wordId, readingIndex, state.states, state.deckIds).send();
            }
        });
        return result;
    }
}


/***/ }),
/* 43 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   batchReview: () => (/* binding */ batchReview)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(44);
/* harmony import */ var _types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(4);


const batchReview = (items, options) => {
    const reviews = items.map((item) => ({
        wordId: item.wordId,
        readingIndex: item.readingIndex,
        rating: _types__WEBPACK_IMPORTED_MODULE_1__.JitenRatingMap[item.rating],
    }));
    return (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/batch-review', { reviews }, options);
};


/***/ }),
/* 44 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   request: () => (/* binding */ request)
/* harmony export */ });
/* harmony import */ var _configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _request_by_url__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(20);


const request = async (action, params, options) => {
    const baseUrl = await (0,_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiEndpoint');
    return await (0,_request_by_url__WEBPACK_IMPORTED_MODULE_1__.requestByUrl)(baseUrl, action, params, options);
};


/***/ }),
/* 45 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getCardState: () => (/* binding */ getCardState),
/* harmony export */   getCardStates: () => (/* binding */ getCardStates)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(44);
/* harmony import */ var _types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(4);


const CARD_STATE_MAP = {
    0: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.NEW,
    1: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.YOUNG,
    2: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MATURE,
    3: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.BLACKLISTED,
    4: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.DUE,
    5: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.MASTERED,
    6: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.REDUNDANT,
    7: _types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.SUSPENDED,
};
const toCardStateResult = (states, deckIds) => {
    if (!Array.isArray(states) || states.length === 0) {
        return { states: [_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.NEW], deckIds };
    }
    const mapped = states
        .map((state) => CARD_STATE_MAP[state])
        .filter((s) => s !== undefined);
    return { states: mapped.length > 0 ? mapped : [_types__WEBPACK_IMPORTED_MODULE_1__.JitenCardState.NEW], deckIds };
};
const getCardState = async (wordId, readingIndex, options) => {
    const [state] = await getCardStates([[wordId, readingIndex]], options);
    return state;
};
const getCardStates = async (words, options) => {
    if (words.length === 0) {
        return [];
    }
    const result = await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('reader/lookup-vocabulary', { words }, options);
    return words.map((_, index) => toCardStateResult(result.result?.[index], result.decks?.[index] ?? []));
};


/***/ }),
/* 46 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BatchReviewCommand: () => (/* binding */ BatchReviewCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class BatchReviewCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'batchReview';
    }
}


/***/ }),
/* 47 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CardStateUpdatedCommand: () => (/* binding */ CardStateUpdatedCommand)
/* harmony export */ });
/* harmony import */ var _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(48);

class CardStateUpdatedCommand extends _lib_broadcast_command__WEBPACK_IMPORTED_MODULE_0__.BroadcastCommand {
    constructor() {
        super(...arguments);
        this.key = 'cardStateUpdated';
    }
}


/***/ }),
/* 48 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BroadcastCommand: () => (/* binding */ BroadcastCommand)
/* harmony export */ });
/* harmony import */ var _extension_get_last_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(31);
/* harmony import */ var _extension_get_tabs__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(49);
/* harmony import */ var _extension_runtime__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(19);
/* harmony import */ var _extension_tabs__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(32);
/* harmony import */ var _command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(33);





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
/* 49 */
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
/* 50 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   FetchStudyDecksCommandHandler: () => (/* binding */ FetchStudyDecksCommandHandler),
/* harmony export */   invalidateStudyDecksCache: () => (/* binding */ invalidateStudyDecksCache)
/* harmony export */ });
/* harmony import */ var _shared_jiten_fetch_study_decks__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(51);
/* harmony import */ var _shared_messages_background_fetch_study_decks_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(52);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(41);



const CACHE_TTL_MS = 60_000;
let cached;
function invalidateStudyDecksCache() {
    cached = undefined;
}
class FetchStudyDecksCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_fetch_study_decks_command__WEBPACK_IMPORTED_MODULE_1__.FetchStudyDecksCommand;
    }
    handle() {
        const now = Date.now();
        if (cached && cached.expiresAt > now) {
            return cached.value;
        }
        // Cache the in-flight promise so concurrent calls (e.g. a burst of frame
        // inits) share a single request rather than each hitting the API.
        const value = (0,_shared_jiten_fetch_study_decks__WEBPACK_IMPORTED_MODULE_0__.fetchStudyDecks)().catch((error) => {
            invalidateStudyDecksCache();
            throw error;
        });
        cached = { value, expiresAt: now + CACHE_TTL_MS };
        return value;
    }
}


/***/ }),
/* 51 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   fetchStudyDecks: () => (/* binding */ fetchStudyDecks)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(44);

const fetchStudyDecks = (options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/reader-study-decks', undefined, options);


/***/ }),
/* 52 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   FetchStudyDecksCommand: () => (/* binding */ FetchStudyDecksCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class FetchStudyDecksCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'fetchStudyDecks';
    }
}


/***/ }),
/* 53 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ForgetCardCommandHandler: () => (/* binding */ ForgetCardCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_jiten_request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(44);
/* harmony import */ var _shared_messages_background_forget_card_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(54);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(41);



class ForgetCardCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_forget_card_command__WEBPACK_IMPORTED_MODULE_1__.ForgetCardCommand;
    }
    async handle(_sender, wordId, readingIndex) {
        await (0,_shared_jiten_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/set-vocabulary-state', {
            wordId,
            readingIndex,
            state: 'forget-add',
        });
    }
}


/***/ }),
/* 54 */
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
/* 55 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   GradeCardCommandHandler: () => (/* binding */ GradeCardCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_jiten_review__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(56);
/* harmony import */ var _shared_messages_background_grade_card_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(57);
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
/* 56 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   review: () => (/* binding */ review)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(44);
/* harmony import */ var _types__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(4);


const review = (rating, wordId, readingIndex, options) => {
    const ratingValue = _types__WEBPACK_IMPORTED_MODULE_1__.JitenRatingMap[rating];
    // Lets the server recognise a retried request after a lost response instead of grading twice.
    const clientRequestId = crypto.randomUUID();
    return (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/review', { wordId, readingIndex, rating: ratingValue, clientRequestId }, options);
};


/***/ }),
/* 57 */
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
/* 58 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RunDeckActionCommandHandler: () => (/* binding */ RunDeckActionCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_jiten_add_vocabulary__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(59);
/* harmony import */ var _shared_jiten_remove_vocabulary__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(60);
/* harmony import */ var _shared_jiten_set_card_sentence__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(61);
/* harmony import */ var _shared_messages_background_run_deck_action_command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(62);
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
/* 59 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   addVocabulary: () => (/* binding */ addVocabulary)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(44);

const addVocabulary = async (deckName, wordId, readingIndex, options) => {
    await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/set-vocabulary-state', {
        wordId,
        readingIndex,
        state: `${deckName}-add`,
    }, options);
};


/***/ }),
/* 60 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   removeVocabulary: () => (/* binding */ removeVocabulary)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(44);

const removeVocabulary = async (deckName, wordId, readingIndex, options) => {
    await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('srs/set-vocabulary-state', {
        wordId,
        readingIndex,
        state: `${deckName}-remove`,
    }, options);
};


/***/ }),
/* 61 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   setCardSentence: () => (/* binding */ setCardSentence)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(44);

const setCardSentence = (wordId, readingIndex, sentence, options) => (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('set-card-sentence', {
    wordId,
    readingIndex,
    sentence,
}, options);


/***/ }),
/* 62 */
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
/* 63 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   UpdateCardStateCommandHandler: () => (/* binding */ UpdateCardStateCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_jiten_get_card_state__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(45);
/* harmony import */ var _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(64);
/* harmony import */ var _shared_messages_broadcast_card_state_updated_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(47);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(41);




class UpdateCardStateCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_3__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_update_card_state_command__WEBPACK_IMPORTED_MODULE_1__.UpdateCardStateCommand;
    }
    async handle(sender, wordId, readingIndex) {
        const { states, deckIds } = await (0,_shared_jiten_get_card_state__WEBPACK_IMPORTED_MODULE_0__.getCardState)(wordId, readingIndex);
        new _shared_messages_broadcast_card_state_updated_command__WEBPACK_IMPORTED_MODULE_2__.CardStateUpdatedCommand(wordId, readingIndex, states, deckIds).send();
    }
}


/***/ }),
/* 64 */
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
/* 65 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BackgroundCommandHandlerCollection: () => (/* binding */ BackgroundCommandHandlerCollection)
/* harmony export */ });
/* harmony import */ var _shared_extension_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(19);

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
/* 66 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   openClipboardReader: () => (/* binding */ openClipboardReader)
/* harmony export */ });
/* harmony import */ var _shared_extension_clipboard_reader_tab__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(15);
/* harmony import */ var _shared_extension_open_view__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(17);


const findOpenReader = async () => {
    try {
        return await chrome.runtime.sendMessage({
            type: _shared_extension_clipboard_reader_tab__WEBPACK_IMPORTED_MODULE_0__.FIND_CLIPBOARD_READER,
        });
    }
    catch {
        return undefined;
    }
};
const openClipboardReader = async () => {
    const existing = await findOpenReader();
    const tab = existing
        ? await chrome.tabs.update(existing.tabId, { active: true })
        : await (0,_shared_extension_open_view__WEBPACK_IMPORTED_MODULE_1__.openView)('clipboard-reader');
    if (tab?.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
    }
};


/***/ }),
/* 67 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   OpenClipboardReaderCommandHandler: () => (/* binding */ OpenClipboardReaderCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_open_clipboard_reader_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(68);
/* harmony import */ var _background_command_handler__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(41);
/* harmony import */ var _open_clipboard_reader__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(66);



class OpenClipboardReaderCommandHandler extends _background_command_handler__WEBPACK_IMPORTED_MODULE_1__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_open_clipboard_reader_command__WEBPACK_IMPORTED_MODULE_0__.OpenClipboardReaderCommand;
    }
    handle() {
        void (0,_open_clipboard_reader__WEBPACK_IMPORTED_MODULE_2__.openClipboardReader)();
    }
}


/***/ }),
/* 68 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   OpenClipboardReaderCommand: () => (/* binding */ OpenClipboardReaderCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

class OpenClipboardReaderCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'openClipboardReader';
    }
}


/***/ }),
/* 69 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   OpenSettingsCommandHandler: () => (/* binding */ OpenSettingsCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(16);
/* harmony import */ var _shared_messages_background_open_settings_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(70);
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
/* 70 */
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
/* 71 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   initParsingPausedIcon: () => (/* binding */ initParsingPausedIcon)
/* harmony export */ });
/* harmony import */ var _shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(72);
/* harmony import */ var _shared_extension_on_parsing_paused_changed__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(73);


const ICON_SIZES = [16, 24, 32, 48, 64, 96, 128];
const iconPaths = (prefix) => Object.fromEntries(ICON_SIZES.map((size) => [size, `/assets/${prefix}${size}.png`]));
const applyParsingPausedIcon = async (paused) => {
    await chrome.action.setIcon({ path: iconPaths(paused ? 'paused-' : '') });
    await chrome.action.setTitle({
        title: paused ? 'Jiten Reader (parsing paused)' : 'Jiten Reader',
    });
};
const initParsingPausedIcon = () => {
    (0,_shared_extension_on_parsing_paused_changed__WEBPACK_IMPORTED_MODULE_1__.onParsingPausedChanged)((paused) => void applyParsingPausedIcon(paused));
    // The global icon is reset on browser restart and extension reload, so reapply on every worker start.
    void (0,_shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_0__.getParsingPaused)().then(applyParsingPausedIcon);
};


/***/ }),
/* 72 */
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
/* 73 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   onParsingPausedChanged: () => (/* binding */ onParsingPausedChanged)
/* harmony export */ });
/** Fires in every extension context, including the one that wrote the flag, unlike the broadcast. */
const onParsingPausedChanged = (listener) => {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !('parsingPaused' in changes)) {
            return;
        }
        listener(changes.parsingPaused.newValue ?? false);
    });
};


/***/ }),
/* 74 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   UpdateBadgeCommandHandler: () => (/* binding */ UpdateBadgeCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_update_badge_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(75);
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
/* 75 */
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
/* 76 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   LookupController: () => (/* binding */ LookupController)
/* harmony export */ });
/* harmony import */ var _shared_extension_add_context_menu__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(13);
/* harmony import */ var _shared_extension_open_new_tab__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(77);


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
/* 77 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   openNewTab: () => (/* binding */ openNewTab)
/* harmony export */ });
const openNewTab = (url) => chrome.tabs.create({ url });


/***/ }),
/* 78 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   LookupTextCommandHandler: () => (/* binding */ LookupTextCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_lookup_text_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(79);
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
/* 79 */
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
/* 80 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AbortRequestCommandHandler: () => (/* binding */ AbortRequestCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_abort_request_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(81);
/* harmony import */ var _shared_messages_foreground_sequence_aborted_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(82);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(41);



class AbortRequestCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_2__.BackgroundCommandHandler {
    constructor(_parseController) {
        super();
        this._parseController = _parseController;
        this.command = _shared_messages_background_abort_request_command__WEBPACK_IMPORTED_MODULE_0__.AbortRequestCommand;
    }
    handle(sender, sequence) {
        this._parseController.abortSequence(sender, sequence);
        new _shared_messages_foreground_sequence_aborted_command__WEBPACK_IMPORTED_MODULE_1__.SequenceAbortedCommand(sequence).sendToFrame(sender.tab.id, sender.frameId ?? 0);
    }
}


/***/ }),
/* 81 */
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
/* 82 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SequenceAbortedCommand: () => (/* binding */ SequenceAbortedCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(30);

class SequenceAbortedCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'sequenceAborted';
    }
}


/***/ }),
/* 83 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParseCommandHandler: () => (/* binding */ ParseCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(16);
/* harmony import */ var _shared_jiten_request_by_url__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(20);
/* harmony import */ var _shared_messages_background_parse_command__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(84);
/* harmony import */ var _shared_messages_foreground_toast_command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(85);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(41);






class ParseCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_5__.BackgroundCommandHandler {
    constructor(_parseController) {
        super();
        this._parseController = _parseController;
        this.command = _shared_messages_background_parse_command__WEBPACK_IMPORTED_MODULE_3__.ParseCommand;
        this._failToast = new _shared_messages_foreground_toast_command__WEBPACK_IMPORTED_MODULE_4__.ToastCommand('error', 'Jiten API key is not set. Please set it in the extension settings.');
        this._rejectedToast = new _shared_messages_foreground_toast_command__WEBPACK_IMPORTED_MODULE_4__.ToastCommand('error', 'Jiten API key was rejected by the server. Please update it in the extension settings.');
    }
    async handle(sender, data) {
        const jitenApiKey = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiKey');
        if (!jitenApiKey?.length) {
            await this._failToast.call(sender.tab.id);
            await (0,_shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_1__.openOptionsPage)();
            return;
        }
        if (await (0,_shared_jiten_request_by_url__WEBPACK_IMPORTED_MODULE_2__.isApiTokenRejected)()) {
            await this._rejectedToast.call(sender.tab.id);
            return;
        }
        this._parseController.parseSequences(sender, data);
    }
}


/***/ }),
/* 84 */
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
/* 85 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ToastCommand: () => (/* binding */ ToastCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(30);

class ToastCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'toast';
    }
}


/***/ }),
/* 86 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParseController: () => (/* binding */ ParseController)
/* harmony export */ });
/* harmony import */ var _shared_jiten_rate_limited_error__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(28);
/* harmony import */ var _shared_messages_foreground_sequence_aborted_command__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(82);
/* harmony import */ var _shared_messages_foreground_sequence_error_command__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(87);
/* harmony import */ var _shared_messages_foreground_sequence_success_command__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(88);
/* harmony import */ var _shared_messages_foreground_toast_command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(85);
/* harmony import */ var _parser__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(89);






// UTF-8 bytes: a deliberate ~3x overestimate for Japanese against the server's 81,000 character cap.
const BATCH_SIZE = 80000;
// Measured from request start, so batches slower than this to parse are not delayed further.
const MIN_DISPATCH_INTERVAL_MS = 1000;
// A longer pause risks the service worker being suspended while paragraphs are still queued.
const MAX_PAUSE_MS = 25_000;
class ParseController {
    constructor() {
        this._pending = new Map();
        this._inFlight = false;
        this._nextDispatchAt = 0;
        this._notifiedFrames = new Set();
    }
    abortSequence(sender, sequenceId) {
        this._pending.delete(this.getKey(sender, sequenceId));
    }
    parseSequences(sender, data) {
        const handles = data.map(([sequenceId, text]) => this.createHandle(sender, sequenceId, text));
        if (this.getPauseRemaining() > MAX_PAUSE_MS) {
            this.cancel(handles);
            return;
        }
        handles.forEach((handle) => this._pending.set(this.getKey(sender, handle.sequenceId), handle));
        this.scheduleDispatch();
    }
    createHandle(sender, sequenceId, text) {
        return {
            sequenceId,
            sender,
            text,
            length: new TextEncoder().encode(text).length + 7,
            resolve: (tokens) => this.reply(sender, new _shared_messages_foreground_sequence_success_command__WEBPACK_IMPORTED_MODULE_3__.SequenceSuccessCommand(sequenceId, tokens)),
            reject: (error) => this.reply(sender, new _shared_messages_foreground_sequence_error_command__WEBPACK_IMPORTED_MODULE_2__.SequenceErrorCommand(sequenceId, error.message)),
        };
    }
    scheduleDispatch() {
        if (this._inFlight || this._timer || !this._pending.size) {
            return;
        }
        const delay = this._nextDispatchAt - Date.now();
        if (delay > 0) {
            this._timer = setTimeout(() => {
                this._timer = undefined;
                this.scheduleDispatch();
            }, delay);
            return;
        }
        void this.dispatch();
    }
    async dispatch() {
        const batch = this.takeBatch();
        this._inFlight = true;
        this._nextDispatchAt = Date.now() + MIN_DISPATCH_INTERVAL_MS;
        try {
            await new _parser__WEBPACK_IMPORTED_MODULE_5__.Parser(batch).parse();
        }
        catch (error) {
            if (error instanceof _shared_jiten_rate_limited_error__WEBPACK_IMPORTED_MODULE_0__.RateLimitedError) {
                this.pause(batch, error.retryAfterMs);
            }
            else {
                batch.handles.forEach((handle) => handle.reject(error));
            }
        }
        finally {
            this._inFlight = false;
            this.scheduleDispatch();
        }
    }
    takeBatch() {
        const batch = { strings: [], handles: [] };
        let length = 0;
        for (const [key, handle] of this._pending) {
            if (batch.handles.length && length + handle.length > BATCH_SIZE) {
                break;
            }
            length += handle.length;
            batch.strings.push(handle.text);
            batch.handles.push(handle);
            this._pending.delete(key);
        }
        return batch;
    }
    pause(batch, retryAfterMs) {
        this._nextDispatchAt = Date.now() + retryAfterMs;
        this._notifiedFrames.clear();
        if (retryAfterMs > MAX_PAUSE_MS) {
            const handles = [...batch.handles, ...this._pending.values()];
            this._pending.clear();
            this.cancel(handles);
            return;
        }
        const requeued = batch.handles.map((h) => [this.getKey(h.sender, h.sequenceId), h]);
        this._pending = new Map([...requeued, ...this._pending]);
        this.notify(batch.handles, `jiten.moe rate limit reached, parsing resumes in ${Math.ceil(retryAfterMs / 1000)}s`);
    }
    cancel(handles) {
        handles.forEach((h) => this.reply(h.sender, new _shared_messages_foreground_sequence_aborted_command__WEBPACK_IMPORTED_MODULE_1__.SequenceAbortedCommand(h.sequenceId)));
        this.notify(handles, `jiten.moe rate limit reached, try again in ${Math.ceil(this.getPauseRemaining() / 1000)}s`);
    }
    notify(handles, message) {
        for (const { sender } of handles) {
            const frameKey = this.getFrameKey(sender);
            if (this._notifiedFrames.has(frameKey)) {
                continue;
            }
            this._notifiedFrames.add(frameKey);
            this.reply(sender, new _shared_messages_foreground_toast_command__WEBPACK_IMPORTED_MODULE_4__.ToastCommand('error', message));
        }
    }
    getPauseRemaining() {
        return this._nextDispatchAt - Date.now();
    }
    reply(sender, command) {
        command.sendToFrame(sender.tab.id, sender.frameId ?? 0);
    }
    // Sequence ids restart at 1 in every content script, so they only identify a paragraph per frame.
    getKey(sender, sequenceId) {
        return `${this.getFrameKey(sender)}:${sequenceId}`;
    }
    getFrameKey(sender) {
        return `${sender.tab?.id}:${sender.frameId ?? 0}`;
    }
}


/***/ }),
/* 87 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SequenceErrorCommand: () => (/* binding */ SequenceErrorCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(30);

class SequenceErrorCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'sequenceError';
    }
}


/***/ }),
/* 88 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SequenceSuccessCommand: () => (/* binding */ SequenceSuccessCommand)
/* harmony export */ });
/* harmony import */ var _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(30);

class SequenceSuccessCommand extends _lib_foreground_command__WEBPACK_IMPORTED_MODULE_0__.ForegroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'sequenceSuccess';
    }
}


/***/ }),
/* 89 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Parser: () => (/* binding */ Parser)
/* harmony export */ });
/* harmony import */ var _shared_jiten_parse__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(90);
/* harmony import */ var _pitch_accent_utils__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(91);


// First prefix match wins, so longer prefixes come first.
const KURU_READINGS = [
    ['ない', 'こ'],
    ['なか', 'こ'],
    ['なく', 'こ'],
    ['なけ', 'こ'],
    ['なきゃ', 'こ'],
    ['れば', 'く'],
    ['りゃ', 'く'],
    ['る', 'く'],
    ['な', 'き'],
    ['た', 'き'],
    ['て', 'き'],
    ['ま', 'き'],
    ['ち', 'き'],
    ['そう', 'き'],
    ['と', 'き'],
    ['や', 'き'],
    ['つ', 'き'],
    ['っ', 'き'],
    ['れ', 'こ'],
    ['ら', 'こ'],
    ['さ', 'こ'],
    ['よ', 'こ'],
    ['い', 'こ'],
    ['ず', 'こ'],
    ['ぬ', 'こ'],
    ['ね', 'こ'],
    ['ん', 'こ'],
];
// うる survives only in the plain and べき forms; every other conjugation of 得る reads え (あり得ない, あり得ます).
const URU_READINGS = [
    ['る', 'う'],
    ['べ', 'う'],
];
class Parser {
    constructor(batch) {
        this.batch = batch;
    }
    async parse() {
        const paragraphs = this.batch.strings;
        const { tokens, vocabulary } = await (0,_shared_jiten_parse__WEBPACK_IMPORTED_MODULE_0__.parse)(paragraphs, { failFastOnRateLimit: true });
        const cards = this.vocabToCard(vocabulary);
        const parsedTokens = this.parseTokens(tokens, cards, vocabulary, paragraphs);
        this.addSentenceInfo(paragraphs, parsedTokens);
        for (const [i, handle] of this.batch.handles.entries()) {
            handle.resolve(parsedTokens[i]);
        }
    }
    extractRubiesFromAnnotated(input) {
        const rubies = [];
        // Group 1: Prefix (any text before the target, including newlines)
        // Group 2: The Base (any non-kana run, so digits like １ in １[いっ]本[ぽん] carry their own reading)
        // Group 3: The Ruby (inside brackets)
        const regex = /((?:.|\n)*?)([^\u3040-\u309f\u30a0-\u30ff[\]]+)\[([^\]]+)\]/g;
        let match;
        let currentOffset = 0; // This tracks the position in the CLEAN (displayed) string
        while ((match = regex.exec(input)) !== null) {
            const prefix = match[1]; // e.g., "もう" in "もう一度"
            const base = match[2]; // e.g., "一度"
            const ruby = match[3]; // e.g., "いちど"
            // 1. Advance offset past the prefix (plain text that has no ruby); stray [reading] groups are not displayed
            currentOffset += prefix.replace(/\[[^\]]*\]/g, '').length;
            // 2. Mark the ruby position
            const start = currentOffset;
            const length = base.length;
            const end = start + length;
            rubies.push({
                text: ruby,
                start,
                end,
                length,
            });
            // 3. Advance offset past the base (the text covered by ruby)
            currentOffset += length;
        }
        return rubies;
    }
    /** Moves dictionary-form rubies onto the token's surface text, dropping any whose base the surface does not share. */
    alignRubiesToSurface(rubies, vocab, paragraph, token) {
        const dictionaryText = vocab.reading.replace(/\[[^\]]*\]/g, '');
        const surface = paragraph.slice(token.start, token.end);
        return rubies.flatMap((ruby) => {
            const base = dictionaryText.slice(ruby.start, ruby.end);
            if (surface.slice(ruby.start, ruby.end) !== base) {
                return [];
            }
            const text = dictionaryText.slice(ruby.end) === 'る'
                ? this.getVerbFinalReading(base, ruby.text, paragraph.slice(token.start + ruby.end))
                : ruby.text;
            if (!text) {
                return [];
            }
            return [{ ...ruby, text, start: token.start + ruby.start, end: token.start + ruby.end }];
        });
    }
    /** The kanji's reading in a verb ending in ruby + る (やって来[く]る, あり得[う]る), where 来 and 得 change reading with the conjugation. */
    getVerbFinalReading(base, reading, following) {
        if ((base === '来' || base === '來') && reading === 'く') {
            return this.matchFollowing(KURU_READINGS, following);
        }
        if (base === '得' && reading === 'う') {
            return this.matchFollowing(URU_READINGS, following) ?? 'え';
        }
        return reading;
    }
    matchFollowing(table, following) {
        const next = following
            .slice(0, 3)
            .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
        return table.find(([prefix]) => next.startsWith(prefix))?.[1];
    }
    vocabToCard(vocabulary) {
        const CARD_STATE_MAP = {
            0: 'new',
            1: 'young',
            2: 'mature',
            3: 'blacklisted',
            4: 'due',
            5: 'mastered',
            6: 'redundant',
            7: 'suspended',
        };
        return vocabulary.map((vocab) => {
            const { wordId, readingIndex, spelling, reading, frequencyRank, partsOfSpeech, meaningsChunks, meaningsPartOfSpeech, knownState, pitchAccents, studyDeckIds, } = vocab;
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
                pitchAccents: pitchAccents ?? [],
                wordWithReading: null,
                deckIds: studyDeckIds ?? [],
            };
        });
    }
    buildLookupKey(wordId, readingIndex) {
        return `${wordId}:${readingIndex}`;
    }
    parseTokens(tokens, cards, vocabulary, paragraphs) {
        const vocabMap = new Map();
        const cardMap = new Map();
        for (const v of vocabulary) {
            vocabMap.set(this.buildLookupKey(v.wordId, v.readingIndex), v);
        }
        for (const c of cards) {
            cardMap.set(this.buildLookupKey(c.wordId, c.readingIndex), c);
        }
        return tokens.map((group, i) => {
            let lastPitchClass = '';
            return group.map((token) => {
                const key = this.buildLookupKey(token.wordId, token.readingIndex);
                const vocabEntry = vocabMap.get(key);
                const card = cardMap.get(key);
                const isParticle = card.partsOfSpeech.includes('prt');
                const pitchClass = isParticle ? '' : (0,_pitch_accent_utils__WEBPACK_IMPORTED_MODULE_1__.getPitchClass)(card.pitchAccents, card.reading);
                lastPitchClass = pitchClass || lastPitchClass;
                const dictionaryRubies = vocabEntry?.reading
                    ? this.extractRubiesFromAnnotated(vocabEntry.reading)
                    : [];
                const rubies = vocabEntry
                    ? this.alignRubiesToSurface(dictionaryRubies, vocabEntry, paragraphs[i], token)
                    : [];
                const updated = {
                    ...token,
                    card,
                    pitchClass: lastPitchClass,
                    rubies,
                };
                if (card) {
                    this.assignWordWithReadingJiten(card, dictionaryRubies);
                }
                return updated;
            });
        });
    }
    assignWordWithReadingJiten(card, rubies) {
        if (!rubies.length) {
            return;
        }
        const word = card.spelling.split('');
        // Misaligned rubies would garble the headword; leaving it null falls back to the plain spelling
        if (rubies.some(({ start, length }) => start + length > word.length)) {
            return;
        }
        for (let i = rubies.length - 1; i >= 0; i--) {
            const { text, start, length } = rubies[i];
            word.splice(start + length, 0, `[${text}]`);
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
            for (let s = 0; s < sentences.length; s++) {
                const sentence = sentences[s];
                const compareSentence = sentence.replace(/(^[「『])|([。！？」』]$)/g, '');
                const positionInParagraphs = paragraph.substring(offset).indexOf(compareSentence);
                if (positionInParagraphs === -1) {
                    continue;
                }
                const sentenceStart = offset + positionInParagraphs;
                const nextCompareSentence = sentences[s + 1]?.replace(/(^[「『])|([。！？」』]$)/g, '');
                const nextPosition = nextCompareSentence
                    ? paragraph.indexOf(nextCompareSentence, sentenceStart + compareSentence.length)
                    : -1;
                const sentenceEnd = nextPosition !== -1 ? nextPosition : paragraph.length;
                for (const token of tokenData) {
                    if (token.start >= sentenceStart && token.end <= sentenceEnd) {
                        token.sentence = sentence;
                    }
                }
                offset = sentenceStart + compareSentence.length;
            }
        });
    }
    splitJapaneseTextIntoSentences(text) {
        // Regular expression to match sentence-ending punctuation marks and quotation marks
        const sentenceEndRegex = /.*?[。！？」』](?=\s?|$)|「.*?」|『.*?』/g;
        const sentences = text.match(sentenceEndRegex) || [];
        return sentences.length
            ? sentences
                .map((sentence) => sentence.trim())
                .filter(Boolean)
                .filter((sentence) => !/^[」』]$/.exec(sentence))
                .map((sentence) => {
                // If the sentence is a quotation, return it as is
                if (/「.*?」|『.*?』/.exec(sentence)) {
                    return sentence;
                }
                // If a quotation contained multiple sentences, remove the quotation marks
                const trimmed = sentence.replace(/(^「|『)|(」|』$)/, '');
                // Add a period at the end of the sentence if it doesn't already have a sentence-ending punctuation mark
                return /[。！？]$/.exec(trimmed) ? trimmed : `${trimmed}。`;
            })
            : [text];
    }
}


/***/ }),
/* 90 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   parse: () => (/* binding */ parse)
/* harmony export */ });
/* harmony import */ var _request__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(44);

const parse = async (paragraphs, options) => {
    const result = await (0,_request__WEBPACK_IMPORTED_MODULE_0__.request)('reader/parse', {
        text: paragraphs,
    }, options);
    return result;
};


/***/ }),
/* 91 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getPitchClass: () => (/* binding */ getPitchClass)
/* harmony export */ });
// Small yoon vowels that do NOT form a separate mora (small tsu DOES count as a mora)
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
    const [accent] = pitchAccent; // hatsuon accent number: 0, 1, 2, ...
    const morae = countMorae(reading);
    // Map accent number to pattern name
    if (accent === 0) {
        return 'heiban';
    }
    // Maintain prior special-case behavior for 1-mora words
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
    // If none matched, it's an unknown or unsupported pattern
    return 'unknown-pattern';
};


/***/ }),
/* 92 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   FetchPdfCommandHandler: () => (/* binding */ FetchPdfCommandHandler)
/* harmony export */ });
/* harmony import */ var _shared_messages_background_fetch_pdf_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(93);
/* harmony import */ var _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(41);


const delay = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
const looksLikePdf = (bytes) => bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46; // F
const toBase64 = (bytes) => {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
};
class FetchPdfCommandHandler extends _lib_background_command_handler__WEBPACK_IMPORTED_MODULE_1__.BackgroundCommandHandler {
    constructor() {
        super(...arguments);
        this.command = _shared_messages_background_fetch_pdf_command__WEBPACK_IMPORTED_MODULE_0__.FetchPdfCommand;
    }
    // Some repositories (bepress/Digital Commons CGI endpoints) answer the first request with a 202
    // "still generating" placeholder, then serve the real PDF 200 on a retry. 202 passes response.ok,
    // so retry until the body actually begins with the %PDF magic.
    async handle(_sender, url) {
        try {
            for (let attempt = 0; attempt < 8; attempt++) {
                const response = await fetch(url, { redirect: 'follow', credentials: 'include' });
                if (response.status === 202) {
                    await delay(1500);
                    continue;
                }
                if (!response.ok) {
                    return { ok: false, error: `Server responded ${response.status} ${response.statusText}` };
                }
                const bytes = new Uint8Array(await response.arrayBuffer());
                if (looksLikePdf(bytes)) {
                    return { ok: true, base64: toBase64(bytes) };
                }
                await delay(1500);
            }
            return { ok: false, error: 'The server kept returning a non-PDF / 202 response' };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}


/***/ }),
/* 93 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   FetchPdfCommand: () => (/* binding */ FetchPdfCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(40);

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
/* harmony import */ var _shared_configuration_migrate_to_profiles__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(10);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(11);
/* harmony import */ var _shared_extension_add_context_menu__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(13);
/* harmony import */ var _shared_extension_add_install_listener__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(14);
/* harmony import */ var _shared_extension_clipboard_reader_tab__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(15);
/* harmony import */ var _shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(16);
/* harmony import */ var _shared_extension_open_view__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(17);
/* harmony import */ var _shared_extension_runtime__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(19);
/* harmony import */ var _shared_jiten_request_by_url__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(20);
/* harmony import */ var _shared_messages_foreground_open_reader_mode_command__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(29);
/* harmony import */ var _shared_messages_foreground_parse_page_command__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(34);
/* harmony import */ var _shared_messages_foreground_parse_selection_command__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(35);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(36);
/* harmony import */ var _shared_word_style_themes__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(6);
/* harmony import */ var _jiten_card_actions_add_to_study_deck_command_handler__WEBPACK_IMPORTED_MODULE_15__ = __webpack_require__(37);
/* harmony import */ var _jiten_card_actions_batch_review_command_handler__WEBPACK_IMPORTED_MODULE_16__ = __webpack_require__(42);
/* harmony import */ var _jiten_card_actions_fetch_study_decks_command_handler__WEBPACK_IMPORTED_MODULE_17__ = __webpack_require__(50);
/* harmony import */ var _jiten_card_actions_forget_card_command_handler__WEBPACK_IMPORTED_MODULE_18__ = __webpack_require__(53);
/* harmony import */ var _jiten_card_actions_grade_card_command_handler__WEBPACK_IMPORTED_MODULE_19__ = __webpack_require__(55);
/* harmony import */ var _jiten_card_actions_run_deck_action_command_handler__WEBPACK_IMPORTED_MODULE_20__ = __webpack_require__(58);
/* harmony import */ var _jiten_card_actions_update_card_state_command_handler__WEBPACK_IMPORTED_MODULE_21__ = __webpack_require__(63);
/* harmony import */ var _lib_background_command_handler_collection__WEBPACK_IMPORTED_MODULE_22__ = __webpack_require__(65);
/* harmony import */ var _lib_open_clipboard_reader__WEBPACK_IMPORTED_MODULE_23__ = __webpack_require__(66);
/* harmony import */ var _lib_open_clipboard_reader_command_handler__WEBPACK_IMPORTED_MODULE_24__ = __webpack_require__(67);
/* harmony import */ var _lib_open_settings_command_handler__WEBPACK_IMPORTED_MODULE_25__ = __webpack_require__(69);
/* harmony import */ var _lib_parsing_paused_icon__WEBPACK_IMPORTED_MODULE_26__ = __webpack_require__(71);
/* harmony import */ var _lib_update_badge_command_handler__WEBPACK_IMPORTED_MODULE_27__ = __webpack_require__(74);
/* harmony import */ var _lookup_lookup_controller__WEBPACK_IMPORTED_MODULE_28__ = __webpack_require__(76);
/* harmony import */ var _lookup_lookup_text_command_handler__WEBPACK_IMPORTED_MODULE_29__ = __webpack_require__(78);
/* harmony import */ var _parser_abort_request_command_handler__WEBPACK_IMPORTED_MODULE_30__ = __webpack_require__(80);
/* harmony import */ var _parser_parse_command_handler__WEBPACK_IMPORTED_MODULE_31__ = __webpack_require__(83);
/* harmony import */ var _parser_parse_controller__WEBPACK_IMPORTED_MODULE_32__ = __webpack_require__(86);
/* harmony import */ var _pdf_fetch_pdf_command_handler__WEBPACK_IMPORTED_MODULE_33__ = __webpack_require__(92);


































const isMobile = navigator.userAgent.toLowerCase().includes('android') ??
    navigator.userAgentData?.mobile ??
    false;
const parsePageCommand = new _shared_messages_foreground_parse_page_command__WEBPACK_IMPORTED_MODULE_11__.ParsePageCommand();
const parseSelectionCommand = new _shared_messages_foreground_parse_selection_command__WEBPACK_IMPORTED_MODULE_12__.ParseSelectionCommand();
const lookupController = new _lookup_lookup_controller__WEBPACK_IMPORTED_MODULE_28__.LookupController();
const lookupTextCommandHandler = new _lookup_lookup_text_command_handler__WEBPACK_IMPORTED_MODULE_29__.LookupTextCommandHandler(lookupController);
const parseController = new _parser_parse_controller__WEBPACK_IMPORTED_MODULE_32__.ParseController();
const parseCommandHandler = new _parser_parse_command_handler__WEBPACK_IMPORTED_MODULE_31__.ParseCommandHandler(parseController);
const abortRequestCommandHandler = new _parser_abort_request_command_handler__WEBPACK_IMPORTED_MODULE_30__.AbortRequestCommandHandler(parseController);
const updateCardStateCommandHandler = new _jiten_card_actions_update_card_state_command_handler__WEBPACK_IMPORTED_MODULE_21__.UpdateCardStateCommandHandler();
const gradeCardCommandHandler = new _jiten_card_actions_grade_card_command_handler__WEBPACK_IMPORTED_MODULE_19__.GradeCardCommandHandler();
const batchReviewCommandHandler = new _jiten_card_actions_batch_review_command_handler__WEBPACK_IMPORTED_MODULE_16__.BatchReviewCommandHandler();
const runDeckActionCommandHandler = new _jiten_card_actions_run_deck_action_command_handler__WEBPACK_IMPORTED_MODULE_20__.RunDeckActionCommandHandler();
const fetchStudyDecksCommandHandler = new _jiten_card_actions_fetch_study_decks_command_handler__WEBPACK_IMPORTED_MODULE_17__.FetchStudyDecksCommandHandler();
const addToStudyDeckCommandHandler = new _jiten_card_actions_add_to_study_deck_command_handler__WEBPACK_IMPORTED_MODULE_15__.AddToStudyDeckCommandHandler();
const forgetCardCommandHandler = new _jiten_card_actions_forget_card_command_handler__WEBPACK_IMPORTED_MODULE_18__.ForgetCardCommandHandler();
const openSettingsCommandHandler = new _lib_open_settings_command_handler__WEBPACK_IMPORTED_MODULE_25__.OpenSettingsCommandHandler();
const openClipboardReaderCommandHandler = new _lib_open_clipboard_reader_command_handler__WEBPACK_IMPORTED_MODULE_24__.OpenClipboardReaderCommandHandler();
const updateBadgeCommandHandler = new _lib_update_badge_command_handler__WEBPACK_IMPORTED_MODULE_27__.UpdateBadgeCommandHandler();
const fetchPdfCommandHandler = new _pdf_fetch_pdf_command_handler__WEBPACK_IMPORTED_MODULE_33__.FetchPdfCommandHandler();
const handlerCollection = new _lib_background_command_handler_collection__WEBPACK_IMPORTED_MODULE_22__.BackgroundCommandHandlerCollection(lookupTextCommandHandler, parseCommandHandler, abortRequestCommandHandler, updateCardStateCommandHandler, gradeCardCommandHandler, batchReviewCommandHandler, runDeckActionCommandHandler, fetchStudyDecksCommandHandler, addToStudyDeckCommandHandler, forgetCardCommandHandler, openSettingsCommandHandler, openClipboardReaderCommandHandler, updateBadgeCommandHandler, fetchPdfCommandHandler);
handlerCollection.listen();
chrome.commands?.onCommand.addListener((command) => {
    if (command === _shared_extension_clipboard_reader_tab__WEBPACK_IMPORTED_MODULE_5__.CLIPBOARD_READER_COMMAND) {
        void (0,_lib_open_clipboard_reader__WEBPACK_IMPORTED_MODULE_23__.openClipboardReader)();
    }
});
(0,_lib_parsing_paused_icon__WEBPACK_IMPORTED_MODULE_26__.initParsingPausedIcon)();
async function ensureOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length > 0) {
        return;
    }
    await chrome.offscreen.createDocument({
        url: 'views/offscreen.html',
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'TTS audio playback',
    });
}
_shared_extension_runtime__WEBPACK_IMPORTED_MODULE_8__.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'stopTts') {
        void _shared_extension_runtime__WEBPACK_IMPORTED_MODULE_8__.runtime.sendMessage({ type: 'stopTtsAudio' });
        return false;
    }
    if (message.type !== 'playTts') {
        return false;
    }
    (async () => {
        const apiEndpoint = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenApiEndpoint');
        const baseUrl = apiEndpoint.replace(/\/api\/?$/, '');
        const url = `${baseUrl}/api/tts/word/${message.wordId}/${message.readingIndex}` +
            `?voice=${encodeURIComponent(message.voice ?? 'female')}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
            throw new Error(`TTS request failed: ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const data = Array.from(new Uint8Array(buffer));
        await ensureOffscreenDocument();
        return _shared_extension_runtime__WEBPACK_IMPORTED_MODULE_8__.runtime.sendMessage({ type: 'playTtsAudio', data });
    })()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
});
(0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_13__.onBroadcastMessage)('profileSwitched', () => {
    (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.invalidateProfileCache)();
    (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__.invalidateSetConfigurationCache)();
    (0,_shared_jiten_request_by_url__WEBPACK_IMPORTED_MODULE_9__.clearRejectedApiToken)();
    (0,_jiten_card_actions_fetch_study_decks_command_handler__WEBPACK_IMPORTED_MODULE_17__.invalidateStudyDecksCache)();
});
(0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_13__.onBroadcastMessage)('configurationUpdated', () => (0,_shared_jiten_request_by_url__WEBPACK_IMPORTED_MODULE_9__.clearRejectedApiToken)());
async function migrateWordStyleConfig() {
    const existing = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('wordStyleConfig');
    if (existing?.v) {
        return;
    }
    await (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__.setConfiguration)('wordStyleConfig', structuredClone(_shared_word_style_themes__WEBPACK_IMPORTED_MODULE_14__.DEFAULT_WORD_STYLE_CONFIG));
}
(0,_shared_extension_add_install_listener__WEBPACK_IMPORTED_MODULE_4__.addInstallListener)(async ({ reason }) => {
    if (reason === 'install') {
        await (0,_shared_configuration_migrate_to_profiles__WEBPACK_IMPORTED_MODULE_1__.migrateToProfiles)();
        await (0,_shared_extension_open_options_page__WEBPACK_IMPORTED_MODULE_6__.openOptionsPage)();
    }
    if (reason === 'update') {
        await (0,_shared_configuration_migrate_to_profiles__WEBPACK_IMPORTED_MODULE_1__.migrateToProfiles)();
        await migrateWordStyleConfig();
        const skipReleaseNotes = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('skipReleaseNotes');
        if (skipReleaseNotes) {
            return;
        }
        await (0,_shared_extension_open_view__WEBPACK_IMPORTED_MODULE_7__.openView)('changelog');
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
    (0,_shared_extension_add_context_menu__WEBPACK_IMPORTED_MODULE_3__.addContextMenu)({
        id: 'open-reader-mode',
        title: 'Open in Reader Mode',
        contexts: ['page'],
    }, (_, { id }) => new _shared_messages_foreground_open_reader_mode_command__WEBPACK_IMPORTED_MODULE_10__.OpenReaderModeCommand().send(id));
    (0,_shared_extension_add_context_menu__WEBPACK_IMPORTED_MODULE_3__.addContextMenu)({
        id: 'open-selection-reader-mode',
        title: 'Open Selection in Reader Mode',
        contexts: ['selection'],
    }, (info, { id }) => new _shared_messages_foreground_open_reader_mode_command__WEBPACK_IMPORTED_MODULE_10__.OpenReaderModeCommand(info.selectionText).send(id));
}

})();

/******/ })()
;