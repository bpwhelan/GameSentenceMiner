/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ([
/* 0 */,
/* 1 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getURL: () => (/* binding */ getURL)
/* harmony export */ });
const getURL = (url) => chrome.runtime.getURL(url);


/***/ }),
/* 18 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   runtime: () => (/* binding */ runtime)
/* harmony export */ });
const runtime = chrome.runtime;


/***/ }),
/* 19 */,
/* 20 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getStyleUrl: () => (/* binding */ getStyleUrl)
/* harmony export */ });
/* harmony import */ var _get_url__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(17);

const getStyleUrl = (url) => (0,_get_url__WEBPACK_IMPORTED_MODULE_0__.getURL)(`css/${url}.css`);


/***/ }),
/* 22 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getLastError: () => (/* binding */ getLastError)
/* harmony export */ });
const getLastError = () => chrome.runtime.lastError;


/***/ }),
/* 29 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   tabs: () => (/* binding */ tabs)
/* harmony export */ });
const tabs = chrome.tabs;


/***/ }),
/* 30 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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
/* 43 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BatchReviewCommand: () => (/* binding */ BatchReviewCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class BatchReviewCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'batchReview';
    }
}


/***/ }),
/* 44 */,
/* 45 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
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
/* 49 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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
/* 64 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   OpenSettingsCommand: () => (/* binding */ OpenSettingsCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class OpenSettingsCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'openSettings';
    }
}


/***/ }),
/* 65 */,
/* 66 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   UpdateBadgeCommand: () => (/* binding */ UpdateBadgeCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class UpdateBadgeCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'updateBadge';
    }
}


/***/ }),
/* 67 */,
/* 68 */,
/* 69 */,
/* 70 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   LookupTextCommand: () => (/* binding */ LookupTextCommand)
/* harmony export */ });
/* harmony import */ var _lib_background_command__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(37);

class LookupTextCommand extends _lib_background_command__WEBPACK_IMPORTED_MODULE_0__.BackgroundCommand {
    constructor() {
        super(...arguments);
        this.key = 'lookupText';
    }
}


/***/ }),
/* 71 */,
/* 72 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
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
/* 85 */,
/* 86 */,
/* 87 */,
/* 88 */,
/* 89 */,
/* 90 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
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

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Canceled: () => (/* binding */ Canceled)
/* harmony export */ });
class Canceled extends Error {
}


/***/ }),
/* 93 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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

"use strict";
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
/* 133 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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

"use strict";
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
/* 135 */,
/* 136 */,
/* 137 */,
/* 138 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getFeatures: () => (/* binding */ getFeatures)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_features_features__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(139);
/* harmony import */ var _shared_match_url__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(104);
/* harmony import */ var _crunchyroll_com_feature__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(140);
/* harmony import */ var _reader_mode_feature__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(141);





async function getFeatures() {
    const isMainFrame = window === window.top;
    const enabledFeatures = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('enabledFeatures');
    const features = {
        [_shared_features_features__WEBPACK_IMPORTED_MODULE_1__.CRUNCHYROLL.id]: [_shared_features_features__WEBPACK_IMPORTED_MODULE_1__.CRUNCHYROLL, _crunchyroll_com_feature__WEBPACK_IMPORTED_MODULE_3__.CrunchyrollFeature],
        [_shared_features_features__WEBPACK_IMPORTED_MODULE_1__.READER_MODE.id]: [_shared_features_features__WEBPACK_IMPORTED_MODULE_1__.READER_MODE, _reader_mode_feature__WEBPACK_IMPORTED_MODULE_4__.ReaderModeFeature],
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
/* 139 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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
/* 140 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CrunchyrollFeature: () => (/* binding */ CrunchyrollFeature)
/* harmony export */ });
class CrunchyrollFeature {
    apply() {
        // Inject CSS to hide the #velocity-canvas (the subtitles) and [data-testid="vilos-settings_texttrack_submenu"] (the subtitles menu) element
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
/* 141 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ReaderModeFeature: () => (/* binding */ ReaderModeFeature)
/* harmony export */ });
/* harmony import */ var _shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(100);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(109);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(90);
/* harmony import */ var _reader_mode_reader_view__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(142);




class ReaderModeFeature {
    constructor() {
        this._view = new _reader_mode_reader_view__WEBPACK_IMPORTED_MODULE_3__.ReaderView();
        this._keyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_1__.KeybindManager(['readerModeKey']);
    }
    apply() {
        this._keyManager.activate();
        _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.events.on('readerModeKey', (e) => {
            // Ignore auto-repeat so holding the key doesn't toggle the reader open/closed repeatedly.
            if (e instanceof KeyboardEvent && e.repeat) {
                return;
            }
            this._view.toggle();
        });
        (0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_0__.receiveBackgroundMessage)('openReaderMode', (text) => {
            if (text?.trim()) {
                void this._view.openText(text);
            }
            else {
                void this._view.open();
            }
        });
        _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.statusBar?.addButton({
            id: 'ajb-reader-btn',
            icon: '📖',
            tooltip: 'Toggle reader mode',
            handler: () => this._view.toggle(),
        });
    }
}


/***/ }),
/* 142 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ReaderView: () => (/* binding */ ReaderView)
/* harmony export */ });
/* harmony import */ var _mozilla_readability__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(143);
/* harmony import */ var _mozilla_readability__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(_mozilla_readability__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(1);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(11);
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(134);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(20);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(21);
/* harmony import */ var _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(5);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(90);
/* harmony import */ var _text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(129);
/* harmony import */ var _get_japanese_fonts__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(133);











// Attributes worth keeping on extracted article content; everything else (class, id, style, width,
// height, align, and crucially source-specific hooks like `typeof`/`role`/`data-*`) is removed so
// no host-page CSS — including attribute-selector rules such as Wikipedia's
// `figure[typeof~="mw:File/Thumb"]` framing — can match the light-DOM content.
const KEEP_ATTRS = new Set([
    'href',
    'src',
    'srcset',
    'alt',
    'title',
    'colspan',
    'rowspan',
    'datetime',
]);
// Sentinel option value that triggers the (permission-prompting) full font enumeration on demand.
const LOAD_FONTS_VALUE = '__jiten_load_fonts__';
class ReaderView {
    constructor() {
        this._theme = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.DEFAULT_READER_THEME;
        this._font = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.DEFAULT_READER_FONT;
        this._fontSize = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_FONT_SIZE.default;
        this._bold = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.DEFAULT_READER_BOLD;
        this._width = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_WIDTH.default;
        this._lineHeight = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_LINE_HEIGHT.default;
    }
    get active() {
        return !!this._root;
    }
    toggle() {
        if (this.active) {
            this.close();
        }
        else {
            void this.open();
        }
    }
    async open() {
        if (this.active) {
            return;
        }
        const article = this.extractArticle();
        if (!article) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_5__.displayToast)('error', 'Reader mode', 'Could not extract article content from this page');
            return;
        }
        await this.show(article);
    }
    async openText(text) {
        const trimmed = text.trim();
        if (!trimmed) {
            return this.open();
        }
        if (this.active) {
            this.close();
        }
        const content = trimmed
            .split(/\n{2,}/)
            .map((block) => `<p>${this.escape(block.trim()).replace(/\n/g, '<br>')}</p>`)
            .join('');
        await this.show({ title: document.title || 'Selection', content });
    }
    close() {
        if (!this._root) {
            return;
        }
        if (this._content) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_8__.Registry.batchController.dismissNode(this._content);
        }
        if (this._keyListener) {
            window.removeEventListener('keydown', this._keyListener, true);
            this._keyListener = undefined;
        }
        if (this._outsideListener) {
            window.removeEventListener('mousedown', this._outsideListener, true);
            this._outsideListener = undefined;
        }
        this._root.remove();
        this._root = undefined;
        this._content = undefined;
        this._panel = undefined;
        this._fontSelect = undefined;
        document.documentElement.classList.remove('ajb-reader-open');
    }
    async show(article) {
        this._theme = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_1__.getConfiguration)('readerModeTheme');
        this._font = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_1__.getConfiguration)('readerModeFont');
        this._fontSize = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_1__.getConfiguration)('readerModeFontSize');
        this._bold = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_1__.getConfiguration)('readerModeBold');
        this._width = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_1__.getConfiguration)('readerModeWidth');
        this._lineHeight = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_1__.getConfiguration)('readerModeLineHeight');
        await (0,_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_10__.loadPersistedFonts)();
        await (0,_text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_9__.ensureWordStyles)();
        this.render(article);
        this.parse();
        // The chosen font may load after the initial layout, re-breaking lines that ruby had grown;
        // relayout once it settles.
        if (document.fonts) {
            void document.fonts.ready.then(() => this.reflow());
        }
    }
    extractArticle() {
        // Readability mutates the document it receives, so always hand it a clone.
        const clone = document.cloneNode(true);
        this.stripJitenAnnotations(clone);
        const result = new _mozilla_readability__WEBPACK_IMPORTED_MODULE_0__.Readability(clone).parse();
        if (!result?.content) {
            return null;
        }
        return {
            title: result.title || document.title,
            byline: result.byline ?? undefined,
            content: result.content,
        };
    }
    // If the live page was already parsed, its DOM is full of jiten spans carrying an `ajb` marker.
    // Readability strips the class attributes but keeps `ajb`, and the paragraph reader skips any
    // `ajb` node — so the cloned article would never re-parse. Unwrap our markup back to plain base
    // text (furigana is re-derived when the reader re-parses) before handing the clone to Readability.
    stripJitenAnnotations(root) {
        root.querySelectorAll('rt, rp').forEach((el) => el.remove());
        root.querySelectorAll('ruby').forEach((ruby) => ruby.replaceWith(...ruby.childNodes));
        root.querySelectorAll('.jiten-word').forEach((el) => el.replaceWith(...el.childNodes));
        root.querySelectorAll('[ajb]').forEach((el) => el.removeAttribute('ajb'));
    }
    render(article) {
        this._content = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('article', { class: ['reader-content'] });
        this._content.innerHTML = article.content;
        // The reader content lives in the light DOM (so the word-highlight styles apply), which means
        // the host page's CSS and the source's own inline sizing/floats can leak in — that is what
        // frames images and squashes captions. Strip every non-essential attribute so the reader's own
        // stylesheet fully controls layout.
        this._content.querySelectorAll('*').forEach((el) => {
            for (const attr of Array.from(el.attributes)) {
                if (!KEEP_ATTRS.has(attr.name.toLowerCase())) {
                    el.removeAttribute(attr.name);
                }
            }
        });
        // The controls anchor lives inside the centred column so the toolbar/panel sit beside the text
        // rather than in the far viewport corner. It is sticky so they follow the scroll.
        const controls = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('div', {
            class: ['reader-controls-anchor'],
            children: [this.buildToolbar(), this.buildPanel()],
        });
        const surface = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('div', {
            class: ['reader-surface'],
            children: [controls, this.buildHeader(article), this._content],
        });
        const stylesheet = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('link', {
            attributes: { rel: 'stylesheet', href: (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_6__.getStyleUrl)('reader') },
        });
        this._root = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('div', {
            id: 'ajb-reader',
            class: [`reader-theme-${this._theme}`],
            children: [stylesheet, surface],
        });
        this.applyTypography();
        this.installListeners();
        document.documentElement.classList.add('ajb-reader-open');
        document.body.appendChild(this._root);
    }
    buildHeader(article) {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('header', {
            class: ['reader-header'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('h1', { class: ['reader-title'], innerText: article.title }),
                article.byline
                    ? (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('p', { class: ['reader-byline'], innerText: article.byline })
                    : undefined,
            ],
        });
    }
    buildToolbar() {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('div', {
            class: ['reader-toolbar'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('button', {
                    class: ['reader-btn', 'reader-options-btn'],
                    innerText: 'Aa',
                    attributes: { title: 'Reading options' },
                    handler: () => this.togglePanel(),
                }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('button', {
                    class: ['reader-btn', 'reader-close-btn'],
                    innerText: '✕',
                    attributes: { title: 'Close reader mode (Esc)' },
                    handler: () => this.close(),
                }),
            ],
        });
    }
    buildPanel() {
        this._panel = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('div', {
            class: ['reader-panel'],
            children: [
                this.buildThemeSection(),
                this.panelRow('Text size', this.buildSizeStepper()),
                this.panelRow('Font', this.buildFontSelect()),
                this.panelRow('Font weight', this.buildWeightSelect()),
                this.panelRow('Content width', this.buildRange(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_WIDTH, this._width, (v) => void this.setWidth(v))),
                this.panelRow('Line spacing', this.buildRange(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_LINE_HEIGHT, this._lineHeight, (v) => void this.setLineHeight(v))),
            ],
        });
        return this._panel;
    }
    buildThemeSection() {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('div', {
            class: ['reader-theme-grid'],
            children: _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_THEMES.map((theme) => (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('button', {
                class: ['reader-theme-option', ...(theme.id === this._theme ? ['active'] : [])],
                attributes: { title: theme.label, 'data-theme': theme.id },
                handler: () => void this.setTheme(theme.id),
                children: [
                    (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('span', {
                        class: ['reader-swatch'],
                        style: { backgroundColor: theme.bg, borderColor: theme.fg },
                    }),
                    (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('span', { class: ['reader-theme-label'], innerText: theme.label }),
                ],
            })),
        });
    }
    buildSizeStepper() {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('div', {
            class: ['reader-stepper'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('button', {
                    class: ['reader-btn'],
                    innerText: '−',
                    attributes: { title: 'Decrease font size' },
                    handler: () => void this.changeFontSize(-_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_FONT_SIZE.step),
                }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('span', { class: ['reader-stepper-label'], innerText: 'A' }),
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('button', {
                    class: ['reader-btn'],
                    innerText: '+',
                    attributes: { title: 'Increase font size' },
                    handler: () => void this.changeFontSize(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_FONT_SIZE.step),
                }),
            ],
        });
    }
    buildFontSelect() {
        this._fontSelect = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('select', { class: ['reader-select'] });
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
        const select = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('select', { class: ['reader-select'] });
        [
            { value: 'regular', label: 'Regular' },
            { value: 'bold', label: 'Bold' },
        ].forEach((option) => {
            const el = document.createElement('option');
            el.value = option.value;
            el.textContent = option.label;
            select.appendChild(el);
        });
        select.value = this._bold ? 'bold' : 'regular';
        select.onchange = () => {
            void this.setBold(select.value === 'bold');
        };
        return select;
    }
    buildRange(range, value, onInput) {
        const input = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('input', {
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
    panelRow(label, control) {
        return (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('div', {
            class: ['reader-panel-row'],
            children: [
                (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_4__.createElement)('span', { class: ['reader-panel-label'], innerText: label }),
                control,
            ],
        });
    }
    installListeners() {
        this._keyListener = (e) => {
            if (e.key !== 'Escape') {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            if (this._panel?.classList.contains('open')) {
                this.closePanel();
            }
            else {
                this.close();
            }
        };
        this._outsideListener = (e) => {
            if (!this._panel?.classList.contains('open')) {
                return;
            }
            const target = e.target;
            if (!this._root?.querySelector('.reader-controls-anchor')?.contains(target)) {
                this.closePanel();
            }
        };
        window.addEventListener('keydown', this._keyListener, true);
        window.addEventListener('mousedown', this._outsideListener, true);
    }
    togglePanel() {
        if (!this._panel) {
            return;
        }
        if (this._panel.classList.contains('open')) {
            this.closePanel();
        }
        else {
            this.openPanel();
        }
    }
    openPanel() {
        if (!this._panel || !this._root) {
            return;
        }
        // Pin the panel to fixed viewport coordinates derived from the toolbar, so adjusting the
        // content-width slider (which resizes the column) doesn't drag the panel out from under the
        // cursor.
        const toolbar = this._root.querySelector('.reader-toolbar');
        if (toolbar) {
            const rect = toolbar.getBoundingClientRect();
            this._panel.style.top = `${rect.bottom + 8}px`;
            this._panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
        }
        this._panel.classList.add('open');
    }
    closePanel() {
        this._panel?.classList.remove('open');
    }
    applyTypography() {
        const root = this._root;
        if (!root) {
            return;
        }
        root.style.setProperty('--reader-font-family', (0,_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.resolveReaderFont)(this._font));
        root.style.setProperty('--reader-font-size', `${this._fontSize}px`);
        root.style.setProperty('--reader-width', `${this._width}em`);
        root.style.setProperty('--reader-line-height', `${this._lineHeight}`);
        root.classList.toggle('reader-bold', this._bold);
    }
    async loadFonts() {
        await (0,_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_10__.enumerateAllFonts)();
        this.populateFontOptions();
    }
    populateFontOptions() {
        const select = this._fontSelect;
        if (!select) {
            return;
        }
        select.innerHTML = '';
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
                    option.style.fontFamily = (0,_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.resolveReaderFont)(entry.value);
                }
                group.appendChild(option);
            }
            select.appendChild(group);
        };
        const toEntries = (names) => names.map((name) => ({ value: name, label: name }));
        addGroup('Standard', _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_FONTS.map((font) => ({ value: font.id, label: font.label })));
        const all = (0,_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_10__.getInstalledFonts)();
        if (all?.length) {
            // Full enumeration available: split into Japanese fonts (detected or CJK-named) and the rest,
            // so nothing is hidden but the relevant ones come first.
            addGroup('Japanese fonts', toEntries(all.filter(_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_10__.isJapaneseFont)));
            addGroup('Other fonts', toEntries(all.filter((f) => !(0,_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_10__.isJapaneseFont)(f))), false);
        }
        else {
            addGroup('Japanese fonts', toEntries((0,_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_10__.getCommonJapaneseFonts)()));
        }
        const known = _shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_FONTS.some((f) => f.id === this._font) ||
            (all?.includes(this._font) ?? false) ||
            (0,_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_10__.getCommonJapaneseFonts)().includes(this._font);
        if (!known) {
            addGroup('Current', [{ value: this._font, label: this._font }]);
        }
        if ((0,_get_japanese_fonts__WEBPACK_IMPORTED_MODULE_10__.supportsFontEnumeration)()) {
            addGroup('More', [
                {
                    value: LOAD_FONTS_VALUE,
                    label: all?.length ? 'Reload installed fonts…' : 'Load all installed fonts…',
                },
            ]);
        }
        select.value = this._font;
    }
    parse() {
        if (!this._content) {
            return;
        }
        const { batchController } = _integration_registry__WEBPACK_IMPORTED_MODULE_8__.Registry;
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_3__.debug)('ReaderView: parsing content', { chars: this._content.textContent?.length ?? 0 });
        batchController.registerNode(this._content, { onComplete: () => this.reflow() });
        batchController.parseBatches();
    }
    // Furigana is injected into already-laid-out lines, which can leave stale line-box heights and
    // overlapping rows until a relayout — the user noticed nudging line spacing fixes it. Replicate
    // exactly that: briefly perturb the --reader-line-height the slider drives, then restore it. The
    // glitch can also reappear once the chosen font finishes loading (it re-lays out), so callers
    // also run this on document.fonts.ready.
    reflow() {
        const root = this._root;
        if (!root) {
            return;
        }
        root.style.setProperty('--reader-line-height', `${this._lineHeight + 0.01}`);
        requestAnimationFrame(() => {
            if (this._root === root) {
                root.style.setProperty('--reader-line-height', `${this._lineHeight}`);
            }
        });
    }
    async setTheme(theme) {
        if (!this._root || theme === this._theme) {
            return;
        }
        this._root.classList.remove(`reader-theme-${this._theme}`);
        this._theme = theme;
        this._root.classList.add(`reader-theme-${theme}`);
        this._root.querySelectorAll('.reader-theme-option').forEach((option) => {
            option.classList.toggle('active', option.getAttribute('data-theme') === theme);
        });
        await this.persist('readerModeTheme', theme);
    }
    async setFont(value) {
        this._font = value;
        this._root?.style.setProperty('--reader-font-family', (0,_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.resolveReaderFont)(value));
        await this.persist('readerModeFont', value);
    }
    async changeFontSize(delta) {
        const next = Math.min(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_FONT_SIZE.max, Math.max(_shared_reader_mode_themes__WEBPACK_IMPORTED_MODULE_7__.READER_FONT_SIZE.min, this._fontSize + delta));
        if (next === this._fontSize) {
            return;
        }
        this._fontSize = next;
        this._root?.style.setProperty('--reader-font-size', `${next}px`);
        await this.persist('readerModeFontSize', next);
    }
    async setBold(bold) {
        this._bold = bold;
        this._root?.classList.toggle('reader-bold', bold);
        await this.persist('readerModeBold', bold);
    }
    async setWidth(width) {
        this._width = width;
        this._root?.style.setProperty('--reader-width', `${width}em`);
        await this.persist('readerModeWidth', width);
    }
    async setLineHeight(lineHeight) {
        this._lineHeight = lineHeight;
        this._root?.style.setProperty('--reader-line-height', `${lineHeight}`);
        await this.persist('readerModeLineHeight', lineHeight);
    }
    async persist(key, value) {
        // Reader preferences only need to be written; a ConfigurationUpdatedCommand broadcast cannot be
        // sent from a content script (it queries chrome.tabs, which is unavailable here) and no other
        // context needs live notification of these.
        await (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_2__.setConfiguration)(key, value);
    }
    escape(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}


/***/ }),
/* 143 */
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

/* eslint-env node */
var Readability = __webpack_require__(144);
var isProbablyReaderable = __webpack_require__(145);

module.exports = {
  Readability,
  isProbablyReaderable,
};


/***/ }),
/* 144 */
/***/ ((module) => {

/*
 * Copyright (c) 2010 Arc90 Inc
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * This code is heavily based on Arc90's readability.js (1.7.1) script
 * available at: http://code.google.com/p/arc90labs-readability
 */

/**
 * Public constructor.
 * @param {HTMLDocument} doc     The document to parse.
 * @param {Object}       options The options object.
 */
function Readability(doc, options) {
  // In some older versions, people passed a URI as the first argument. Cope:
  if (options && options.documentElement) {
    doc = options;
    options = arguments[2];
  } else if (!doc || !doc.documentElement) {
    throw new Error(
      "First argument to Readability constructor should be a document object."
    );
  }
  options = options || {};

  this._doc = doc;
  this._docJSDOMParser = this._doc.firstChild.__JSDOMParser__;
  this._articleTitle = null;
  this._articleByline = null;
  this._articleDir = null;
  this._articleSiteName = null;
  this._attempts = [];
  this._metadata = {};

  // Configurable options
  this._debug = !!options.debug;
  this._maxElemsToParse =
    options.maxElemsToParse || this.DEFAULT_MAX_ELEMS_TO_PARSE;
  this._nbTopCandidates =
    options.nbTopCandidates || this.DEFAULT_N_TOP_CANDIDATES;
  this._charThreshold = options.charThreshold || this.DEFAULT_CHAR_THRESHOLD;
  this._classesToPreserve = this.CLASSES_TO_PRESERVE.concat(
    options.classesToPreserve || []
  );
  this._keepClasses = !!options.keepClasses;
  this._serializer =
    options.serializer ||
    function (el) {
      return el.innerHTML;
    };
  this._disableJSONLD = !!options.disableJSONLD;
  this._allowedVideoRegex = options.allowedVideoRegex || this.REGEXPS.videos;
  this._linkDensityModifier = options.linkDensityModifier || 0;

  // Start with all flags set
  this._flags =
    this.FLAG_STRIP_UNLIKELYS |
    this.FLAG_WEIGHT_CLASSES |
    this.FLAG_CLEAN_CONDITIONALLY;

  // Control whether log messages are sent to the console
  if (this._debug) {
    let logNode = function (node) {
      if (node.nodeType == node.TEXT_NODE) {
        return `${node.nodeName} ("${node.textContent}")`;
      }
      let attrPairs = Array.from(node.attributes || [], function (attr) {
        return `${attr.name}="${attr.value}"`;
      }).join(" ");
      return `<${node.localName} ${attrPairs}>`;
    };
    this.log = function () {
      if (typeof console !== "undefined") {
        let args = Array.from(arguments, arg => {
          if (arg && arg.nodeType == this.ELEMENT_NODE) {
            return logNode(arg);
          }
          return arg;
        });
        args.unshift("Reader: (Readability)");
        // eslint-disable-next-line no-console
        console.log(...args);
      } else if (typeof dump !== "undefined") {
        /* global dump */
        var msg = Array.prototype.map
          .call(arguments, function (x) {
            return x && x.nodeName ? logNode(x) : x;
          })
          .join(" ");
        dump("Reader: (Readability) " + msg + "\n");
      }
    };
  } else {
    this.log = function () {};
  }
}

Readability.prototype = {
  FLAG_STRIP_UNLIKELYS: 0x1,
  FLAG_WEIGHT_CLASSES: 0x2,
  FLAG_CLEAN_CONDITIONALLY: 0x4,

  // https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,

  // Max number of nodes supported by this parser. Default: 0 (no limit)
  DEFAULT_MAX_ELEMS_TO_PARSE: 0,

  // The number of top candidates to consider when analysing how
  // tight the competition is among candidates.
  DEFAULT_N_TOP_CANDIDATES: 5,

  // Element tags to score by default.
  DEFAULT_TAGS_TO_SCORE: "section,h2,h3,h4,h5,h6,p,td,pre"
    .toUpperCase()
    .split(","),

  // The default number of chars an article must have in order to return a result
  DEFAULT_CHAR_THRESHOLD: 500,

  // All of the regular expressions in use within readability.
  // Defined up here so we don't instantiate them repeatedly in loops.
  REGEXPS: {
    // NOTE: These two regular expressions are duplicated in
    // Readability-readerable.js. Please keep both copies in sync.
    unlikelyCandidates:
      /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
    okMaybeItsACandidate: /and|article|body|column|content|main|shadow/i,

    positive:
      /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
    negative:
      /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i,
    extraneous:
      /print|archive|comment|discuss|e[\-]?mail|share|reply|all|login|sign|single|utility/i,
    byline: /byline|author|dateline|writtenby|p-author/i,
    replaceFonts: /<(\/?)font[^>]*>/gi,
    normalize: /\s{2,}/g,
    videos:
      /\/\/(www\.)?((dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq)\.com|(archive|upload\.wikimedia)\.org|player\.twitch\.tv)/i,
    shareElements: /(\b|_)(share|sharedaddy)(\b|_)/i,
    nextLink: /(next|weiter|continue|>([^\|]|$)|»([^\|]|$))/i,
    prevLink: /(prev|earl|old|new|<|«)/i,
    tokenize: /\W+/g,
    whitespace: /^\s*$/,
    hasContent: /\S$/,
    hashUrl: /^#.+/,
    srcsetUrl: /(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g,
    b64DataUrl: /^data:\s*([^\s;,]+)\s*;\s*base64\s*,/i,
    // Commas as used in Latin, Sindhi, Chinese and various other scripts.
    // see: https://en.wikipedia.org/wiki/Comma#Comma_variants
    commas: /\u002C|\u060C|\uFE50|\uFE10|\uFE11|\u2E41|\u2E34|\u2E32|\uFF0C/g,
    // See: https://schema.org/Article
    jsonLdArticleTypes:
      /^Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|AskPublicNewsArticle|BackgroundNewsArticle|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|SatiricalArticle|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|BlogPosting|LiveBlogPosting|DiscussionForumPosting|TechArticle|APIReference$/,
    // used to see if a node's content matches words commonly used for ad blocks or loading indicators
    adWords:
      /^(ad(vertising|vertisement)?|pub(licité)?|werb(ung)?|广告|Реклама|Anuncio)$/iu,
    loadingWords:
      /^((loading|正在加载|Загрузка|chargement|cargando)(…|\.\.\.)?)$/iu,
  },

  UNLIKELY_ROLES: [
    "menu",
    "menubar",
    "complementary",
    "navigation",
    "alert",
    "alertdialog",
    "dialog",
  ],

  DIV_TO_P_ELEMS: new Set([
    "BLOCKQUOTE",
    "DL",
    "DIV",
    "IMG",
    "OL",
    "P",
    "PRE",
    "TABLE",
    "UL",
  ]),

  ALTER_TO_DIV_EXCEPTIONS: ["DIV", "ARTICLE", "SECTION", "P", "OL", "UL"],

  PRESENTATIONAL_ATTRIBUTES: [
    "align",
    "background",
    "bgcolor",
    "border",
    "cellpadding",
    "cellspacing",
    "frame",
    "hspace",
    "rules",
    "style",
    "valign",
    "vspace",
  ],

  DEPRECATED_SIZE_ATTRIBUTE_ELEMS: ["TABLE", "TH", "TD", "HR", "PRE"],

  // The commented out elements qualify as phrasing content but tend to be
  // removed by readability when put into paragraphs, so we ignore them here.
  PHRASING_ELEMS: [
    // "CANVAS", "IFRAME", "SVG", "VIDEO",
    "ABBR",
    "AUDIO",
    "B",
    "BDO",
    "BR",
    "BUTTON",
    "CITE",
    "CODE",
    "DATA",
    "DATALIST",
    "DFN",
    "EM",
    "EMBED",
    "I",
    "IMG",
    "INPUT",
    "KBD",
    "LABEL",
    "MARK",
    "MATH",
    "METER",
    "NOSCRIPT",
    "OBJECT",
    "OUTPUT",
    "PROGRESS",
    "Q",
    "RUBY",
    "SAMP",
    "SCRIPT",
    "SELECT",
    "SMALL",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TEXTAREA",
    "TIME",
    "VAR",
    "WBR",
  ],

  // These are the classes that readability sets itself.
  CLASSES_TO_PRESERVE: ["page"],

  // These are the list of HTML entities that need to be escaped.
  HTML_ESCAPE_MAP: {
    lt: "<",
    gt: ">",
    amp: "&",
    quot: '"',
    apos: "'",
  },

  /**
   * Run any post-process modifications to article content as necessary.
   *
   * @param Element
   * @return void
   **/
  _postProcessContent(articleContent) {
    // Readability cannot open relative uris so we convert them to absolute uris.
    this._fixRelativeUris(articleContent);

    this._simplifyNestedElements(articleContent);

    if (!this._keepClasses) {
      // Remove classes.
      this._cleanClasses(articleContent);
    }
  },

  /**
   * Iterates over a NodeList, calls `filterFn` for each node and removes node
   * if function returned `true`.
   *
   * If function is not passed, removes all the nodes in node list.
   *
   * @param NodeList nodeList The nodes to operate on
   * @param Function filterFn the function to use as a filter
   * @return void
   */
  _removeNodes(nodeList, filterFn) {
    // Avoid ever operating on live node lists.
    if (this._docJSDOMParser && nodeList._isLiveNodeList) {
      throw new Error("Do not pass live node lists to _removeNodes");
    }
    for (var i = nodeList.length - 1; i >= 0; i--) {
      var node = nodeList[i];
      var parentNode = node.parentNode;
      if (parentNode) {
        if (!filterFn || filterFn.call(this, node, i, nodeList)) {
          parentNode.removeChild(node);
        }
      }
    }
  },

  /**
   * Iterates over a NodeList, and calls _setNodeTag for each node.
   *
   * @param NodeList nodeList The nodes to operate on
   * @param String newTagName the new tag name to use
   * @return void
   */
  _replaceNodeTags(nodeList, newTagName) {
    // Avoid ever operating on live node lists.
    if (this._docJSDOMParser && nodeList._isLiveNodeList) {
      throw new Error("Do not pass live node lists to _replaceNodeTags");
    }
    for (const node of nodeList) {
      this._setNodeTag(node, newTagName);
    }
  },

  /**
   * Iterate over a NodeList, which doesn't natively fully implement the Array
   * interface.
   *
   * For convenience, the current object context is applied to the provided
   * iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return void
   */
  _forEachNode(nodeList, fn) {
    Array.prototype.forEach.call(nodeList, fn, this);
  },

  /**
   * Iterate over a NodeList, and return the first node that passes
   * the supplied test function
   *
   * For convenience, the current object context is applied to the provided
   * test function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The test function.
   * @return void
   */
  _findNode(nodeList, fn) {
    return Array.prototype.find.call(nodeList, fn, this);
  },

  /**
   * Iterate over a NodeList, return true if any of the provided iterate
   * function calls returns true, false otherwise.
   *
   * For convenience, the current object context is applied to the
   * provided iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return Boolean
   */
  _someNode(nodeList, fn) {
    return Array.prototype.some.call(nodeList, fn, this);
  },

  /**
   * Iterate over a NodeList, return true if all of the provided iterate
   * function calls return true, false otherwise.
   *
   * For convenience, the current object context is applied to the
   * provided iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return Boolean
   */
  _everyNode(nodeList, fn) {
    return Array.prototype.every.call(nodeList, fn, this);
  },

  _getAllNodesWithTag(node, tagNames) {
    if (node.querySelectorAll) {
      return node.querySelectorAll(tagNames.join(","));
    }
    return [].concat.apply(
      [],
      tagNames.map(function (tag) {
        var collection = node.getElementsByTagName(tag);
        return Array.isArray(collection) ? collection : Array.from(collection);
      })
    );
  },

  /**
   * Removes the class="" attribute from every element in the given
   * subtree, except those that match CLASSES_TO_PRESERVE and
   * the classesToPreserve array from the options object.
   *
   * @param Element
   * @return void
   */
  _cleanClasses(node) {
    var classesToPreserve = this._classesToPreserve;
    var className = (node.getAttribute("class") || "")
      .split(/\s+/)
      .filter(cls => classesToPreserve.includes(cls))
      .join(" ");

    if (className) {
      node.setAttribute("class", className);
    } else {
      node.removeAttribute("class");
    }

    for (node = node.firstElementChild; node; node = node.nextElementSibling) {
      this._cleanClasses(node);
    }
  },

  /**
   * Tests whether a string is a URL or not.
   *
   * @param {string} str The string to test
   * @return {boolean} true if str is a URL, false if not
   */
  _isUrl(str) {
    try {
      new URL(str);
      return true;
    } catch {
      return false;
    }
  },
  /**
   * Converts each <a> and <img> uri in the given element to an absolute URI,
   * ignoring #ref URIs.
   *
   * @param Element
   * @return void
   */
  _fixRelativeUris(articleContent) {
    var baseURI = this._doc.baseURI;
    var documentURI = this._doc.documentURI;
    function toAbsoluteURI(uri) {
      // Leave hash links alone if the base URI matches the document URI:
      if (baseURI == documentURI && uri.charAt(0) == "#") {
        return uri;
      }

      // Otherwise, resolve against base URI:
      try {
        return new URL(uri, baseURI).href;
      } catch (ex) {
        // Something went wrong, just return the original:
      }
      return uri;
    }

    var links = this._getAllNodesWithTag(articleContent, ["a"]);
    this._forEachNode(links, function (link) {
      var href = link.getAttribute("href");
      if (href) {
        // Remove links with javascript: URIs, since
        // they won't work after scripts have been removed from the page.
        if (href.indexOf("javascript:") === 0) {
          // if the link only contains simple text content, it can be converted to a text node
          if (
            link.childNodes.length === 1 &&
            link.childNodes[0].nodeType === this.TEXT_NODE
          ) {
            var text = this._doc.createTextNode(link.textContent);
            link.parentNode.replaceChild(text, link);
          } else {
            // if the link has multiple children, they should all be preserved
            var container = this._doc.createElement("span");
            while (link.firstChild) {
              container.appendChild(link.firstChild);
            }
            link.parentNode.replaceChild(container, link);
          }
        } else {
          link.setAttribute("href", toAbsoluteURI(href));
        }
      }
    });

    var medias = this._getAllNodesWithTag(articleContent, [
      "img",
      "picture",
      "figure",
      "video",
      "audio",
      "source",
    ]);

    this._forEachNode(medias, function (media) {
      var src = media.getAttribute("src");
      var poster = media.getAttribute("poster");
      var srcset = media.getAttribute("srcset");

      if (src) {
        media.setAttribute("src", toAbsoluteURI(src));
      }

      if (poster) {
        media.setAttribute("poster", toAbsoluteURI(poster));
      }

      if (srcset) {
        var newSrcset = srcset.replace(
          this.REGEXPS.srcsetUrl,
          function (_, p1, p2, p3) {
            return toAbsoluteURI(p1) + (p2 || "") + p3;
          }
        );

        media.setAttribute("srcset", newSrcset);
      }
    });
  },

  _simplifyNestedElements(articleContent) {
    var node = articleContent;

    while (node) {
      if (
        node.parentNode &&
        ["DIV", "SECTION"].includes(node.tagName) &&
        !(node.id && node.id.startsWith("readability"))
      ) {
        if (this._isElementWithoutContent(node)) {
          node = this._removeAndGetNext(node);
          continue;
        } else if (
          this._hasSingleTagInsideElement(node, "DIV") ||
          this._hasSingleTagInsideElement(node, "SECTION")
        ) {
          var child = node.children[0];
          for (var i = 0; i < node.attributes.length; i++) {
            child.setAttributeNode(node.attributes[i].cloneNode());
          }
          node.parentNode.replaceChild(child, node);
          node = child;
          continue;
        }
      }

      node = this._getNextNode(node);
    }
  },

  /**
   * Get the article title as an H1.
   *
   * @return string
   **/
  _getArticleTitle() {
    var doc = this._doc;
    var curTitle = "";
    var origTitle = "";

    try {
      curTitle = origTitle = doc.title.trim();

      // If they had an element with id "title" in their HTML
      if (typeof curTitle !== "string") {
        curTitle = origTitle = this._getInnerText(
          doc.getElementsByTagName("title")[0]
        );
      }
    } catch (e) {
      /* ignore exceptions setting the title. */
    }

    var titleHadHierarchicalSeparators = false;
    function wordCount(str) {
      return str.split(/\s+/).length;
    }

    // If there's a separator in the title, first remove the final part
    if (/ [\|\-\\\/>»] /.test(curTitle)) {
      titleHadHierarchicalSeparators = / [\\\/>»] /.test(curTitle);
      let allSeparators = Array.from(origTitle.matchAll(/ [\|\-\\\/>»] /gi));
      curTitle = origTitle.substring(0, allSeparators.pop().index);

      // If the resulting title is too short, remove the first part instead:
      if (wordCount(curTitle) < 3) {
        curTitle = origTitle.replace(/^[^\|\-\\\/>»]*[\|\-\\\/>»]/gi, "");
      }
    } else if (curTitle.includes(": ")) {
      // Check if we have an heading containing this exact string, so we
      // could assume it's the full title.
      var headings = this._getAllNodesWithTag(doc, ["h1", "h2"]);
      var trimmedTitle = curTitle.trim();
      var match = this._someNode(headings, function (heading) {
        return heading.textContent.trim() === trimmedTitle;
      });

      // If we don't, let's extract the title out of the original title string.
      if (!match) {
        curTitle = origTitle.substring(origTitle.lastIndexOf(":") + 1);

        // If the title is now too short, try the first colon instead:
        if (wordCount(curTitle) < 3) {
          curTitle = origTitle.substring(origTitle.indexOf(":") + 1);
          // But if we have too many words before the colon there's something weird
          // with the titles and the H tags so let's just use the original title instead
        } else if (wordCount(origTitle.substr(0, origTitle.indexOf(":"))) > 5) {
          curTitle = origTitle;
        }
      }
    } else if (curTitle.length > 150 || curTitle.length < 15) {
      var hOnes = doc.getElementsByTagName("h1");

      if (hOnes.length === 1) {
        curTitle = this._getInnerText(hOnes[0]);
      }
    }

    curTitle = curTitle.trim().replace(this.REGEXPS.normalize, " ");
    // If we now have 4 words or fewer as our title, and either no
    // 'hierarchical' separators (\, /, > or ») were found in the original
    // title or we decreased the number of words by more than 1 word, use
    // the original title.
    var curTitleWordCount = wordCount(curTitle);
    if (
      curTitleWordCount <= 4 &&
      (!titleHadHierarchicalSeparators ||
        curTitleWordCount !=
          wordCount(origTitle.replace(/[\|\-\\\/>»]+/g, "")) - 1)
    ) {
      curTitle = origTitle;
    }

    return curTitle;
  },

  /**
   * Prepare the HTML document for readability to scrape it.
   * This includes things like stripping javascript, CSS, and handling terrible markup.
   *
   * @return void
   **/
  _prepDocument() {
    var doc = this._doc;

    // Remove all style tags in head
    this._removeNodes(this._getAllNodesWithTag(doc, ["style"]));

    if (doc.body) {
      this._replaceBrs(doc.body);
    }

    this._replaceNodeTags(this._getAllNodesWithTag(doc, ["font"]), "SPAN");
  },

  /**
   * Finds the next node, starting from the given node, and ignoring
   * whitespace in between. If the given node is an element, the same node is
   * returned.
   */
  _nextNode(node) {
    var next = node;
    while (
      next &&
      next.nodeType != this.ELEMENT_NODE &&
      this.REGEXPS.whitespace.test(next.textContent)
    ) {
      next = next.nextSibling;
    }
    return next;
  },

  /**
   * Replaces 2 or more successive <br> elements with a single <p>.
   * Whitespace between <br> elements are ignored. For example:
   *   <div>foo<br>bar<br> <br><br>abc</div>
   * will become:
   *   <div>foo<br>bar<p>abc</p></div>
   */
  _replaceBrs(elem) {
    this._forEachNode(this._getAllNodesWithTag(elem, ["br"]), function (br) {
      var next = br.nextSibling;

      // Whether 2 or more <br> elements have been found and replaced with a
      // <p> block.
      var replaced = false;

      // If we find a <br> chain, remove the <br>s until we hit another node
      // or non-whitespace. This leaves behind the first <br> in the chain
      // (which will be replaced with a <p> later).
      while ((next = this._nextNode(next)) && next.tagName == "BR") {
        replaced = true;
        var brSibling = next.nextSibling;
        next.remove();
        next = brSibling;
      }

      // If we removed a <br> chain, replace the remaining <br> with a <p>. Add
      // all sibling nodes as children of the <p> until we hit another <br>
      // chain.
      if (replaced) {
        var p = this._doc.createElement("p");
        br.parentNode.replaceChild(p, br);

        next = p.nextSibling;
        while (next) {
          // If we've hit another <br><br>, we're done adding children to this <p>.
          if (next.tagName == "BR") {
            var nextElem = this._nextNode(next.nextSibling);
            if (nextElem && nextElem.tagName == "BR") {
              break;
            }
          }

          if (!this._isPhrasingContent(next)) {
            break;
          }

          // Otherwise, make this node a child of the new <p>.
          var sibling = next.nextSibling;
          p.appendChild(next);
          next = sibling;
        }

        while (p.lastChild && this._isWhitespace(p.lastChild)) {
          p.lastChild.remove();
        }

        if (p.parentNode.tagName === "P") {
          this._setNodeTag(p.parentNode, "DIV");
        }
      }
    });
  },

  _setNodeTag(node, tag) {
    this.log("_setNodeTag", node, tag);
    if (this._docJSDOMParser) {
      node.localName = tag.toLowerCase();
      node.tagName = tag.toUpperCase();
      return node;
    }

    var replacement = node.ownerDocument.createElement(tag);
    while (node.firstChild) {
      replacement.appendChild(node.firstChild);
    }
    node.parentNode.replaceChild(replacement, node);
    if (node.readability) {
      replacement.readability = node.readability;
    }

    for (var i = 0; i < node.attributes.length; i++) {
      replacement.setAttributeNode(node.attributes[i].cloneNode());
    }
    return replacement;
  },

  /**
   * Prepare the article node for display. Clean out any inline styles,
   * iframes, forms, strip extraneous <p> tags, etc.
   *
   * @param Element
   * @return void
   **/
  _prepArticle(articleContent) {
    this._cleanStyles(articleContent);

    // Check for data tables before we continue, to avoid removing items in
    // those tables, which will often be isolated even though they're
    // visually linked to other content-ful elements (text, images, etc.).
    this._markDataTables(articleContent);

    this._fixLazyImages(articleContent);

    // Clean out junk from the article content
    this._cleanConditionally(articleContent, "form");
    this._cleanConditionally(articleContent, "fieldset");
    this._clean(articleContent, "object");
    this._clean(articleContent, "embed");
    this._clean(articleContent, "footer");
    this._clean(articleContent, "link");
    this._clean(articleContent, "aside");

    // Clean out elements with little content that have "share" in their id/class combinations from final top candidates,
    // which means we don't remove the top candidates even they have "share".

    var shareElementThreshold = this.DEFAULT_CHAR_THRESHOLD;

    this._forEachNode(articleContent.children, function (topCandidate) {
      this._cleanMatchedNodes(topCandidate, function (node, matchString) {
        return (
          this.REGEXPS.shareElements.test(matchString) &&
          node.textContent.length < shareElementThreshold
        );
      });
    });

    this._clean(articleContent, "iframe");
    this._clean(articleContent, "input");
    this._clean(articleContent, "textarea");
    this._clean(articleContent, "select");
    this._clean(articleContent, "button");
    this._cleanHeaders(articleContent);

    // Do these last as the previous stuff may have removed junk
    // that will affect these
    this._cleanConditionally(articleContent, "table");
    this._cleanConditionally(articleContent, "ul");
    this._cleanConditionally(articleContent, "div");

    // replace H1 with H2 as H1 should be only title that is displayed separately
    this._replaceNodeTags(
      this._getAllNodesWithTag(articleContent, ["h1"]),
      "h2"
    );

    // Remove extra paragraphs
    this._removeNodes(
      this._getAllNodesWithTag(articleContent, ["p"]),
      function (paragraph) {
        // At this point, nasty iframes have been removed; only embedded video
        // ones remain.
        var contentElementCount = this._getAllNodesWithTag(paragraph, [
          "img",
          "embed",
          "object",
          "iframe",
        ]).length;
        return (
          contentElementCount === 0 && !this._getInnerText(paragraph, false)
        );
      }
    );

    this._forEachNode(
      this._getAllNodesWithTag(articleContent, ["br"]),
      function (br) {
        var next = this._nextNode(br.nextSibling);
        if (next && next.tagName == "P") {
          br.remove();
        }
      }
    );

    // Remove single-cell tables
    this._forEachNode(
      this._getAllNodesWithTag(articleContent, ["table"]),
      function (table) {
        var tbody = this._hasSingleTagInsideElement(table, "TBODY")
          ? table.firstElementChild
          : table;
        if (this._hasSingleTagInsideElement(tbody, "TR")) {
          var row = tbody.firstElementChild;
          if (this._hasSingleTagInsideElement(row, "TD")) {
            var cell = row.firstElementChild;
            cell = this._setNodeTag(
              cell,
              this._everyNode(cell.childNodes, this._isPhrasingContent)
                ? "P"
                : "DIV"
            );
            table.parentNode.replaceChild(cell, table);
          }
        }
      }
    );
  },

  /**
   * Initialize a node with the readability object. Also checks the
   * className/id for special names to add to its score.
   *
   * @param Element
   * @return void
   **/
  _initializeNode(node) {
    node.readability = { contentScore: 0 };

    switch (node.tagName) {
      case "DIV":
        node.readability.contentScore += 5;
        break;

      case "PRE":
      case "TD":
      case "BLOCKQUOTE":
        node.readability.contentScore += 3;
        break;

      case "ADDRESS":
      case "OL":
      case "UL":
      case "DL":
      case "DD":
      case "DT":
      case "LI":
      case "FORM":
        node.readability.contentScore -= 3;
        break;

      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
      case "TH":
        node.readability.contentScore -= 5;
        break;
    }

    node.readability.contentScore += this._getClassWeight(node);
  },

  _removeAndGetNext(node) {
    var nextNode = this._getNextNode(node, true);
    node.remove();
    return nextNode;
  },

  /**
   * Traverse the DOM from node to node, starting at the node passed in.
   * Pass true for the second parameter to indicate this node itself
   * (and its kids) are going away, and we want the next node over.
   *
   * Calling this in a loop will traverse the DOM depth-first.
   *
   * @param {Element} node
   * @param {boolean} ignoreSelfAndKids
   * @return {Element}
   */
  _getNextNode(node, ignoreSelfAndKids) {
    // First check for kids if those aren't being ignored
    if (!ignoreSelfAndKids && node.firstElementChild) {
      return node.firstElementChild;
    }
    // Then for siblings...
    if (node.nextElementSibling) {
      return node.nextElementSibling;
    }
    // And finally, move up the parent chain *and* find a sibling
    // (because this is depth-first traversal, we will have already
    // seen the parent nodes themselves).
    do {
      node = node.parentNode;
    } while (node && !node.nextElementSibling);
    return node && node.nextElementSibling;
  },

  // compares second text to first one
  // 1 = same text, 0 = completely different text
  // works the way that it splits both texts into words and then finds words that are unique in second text
  // the result is given by the lower length of unique parts
  _textSimilarity(textA, textB) {
    var tokensA = textA
      .toLowerCase()
      .split(this.REGEXPS.tokenize)
      .filter(Boolean);
    var tokensB = textB
      .toLowerCase()
      .split(this.REGEXPS.tokenize)
      .filter(Boolean);
    if (!tokensA.length || !tokensB.length) {
      return 0;
    }
    var uniqTokensB = tokensB.filter(token => !tokensA.includes(token));
    var distanceB = uniqTokensB.join(" ").length / tokensB.join(" ").length;
    return 1 - distanceB;
  },

  /**
   * Checks whether an element node contains a valid byline
   *
   * @param node {Element}
   * @param matchString {string}
   * @return boolean
   */
  _isValidByline(node, matchString) {
    var rel = node.getAttribute("rel");
    var itemprop = node.getAttribute("itemprop");
    var bylineLength = node.textContent.trim().length;

    return (
      (rel === "author" ||
        (itemprop && itemprop.includes("author")) ||
        this.REGEXPS.byline.test(matchString)) &&
      !!bylineLength &&
      bylineLength < 100
    );
  },

  _getNodeAncestors(node, maxDepth) {
    maxDepth = maxDepth || 0;
    var i = 0,
      ancestors = [];
    while (node.parentNode) {
      ancestors.push(node.parentNode);
      if (maxDepth && ++i === maxDepth) {
        break;
      }
      node = node.parentNode;
    }
    return ancestors;
  },

  /***
   * grabArticle - Using a variety of metrics (content score, classname, element types), find the content that is
   *         most likely to be the stuff a user wants to read. Then return it wrapped up in a div.
   *
   * @param page a document to run upon. Needs to be a full document, complete with body.
   * @return Element
   **/
  /* eslint-disable-next-line complexity */
  _grabArticle(page) {
    this.log("**** grabArticle ****");
    var doc = this._doc;
    var isPaging = page !== null;
    page = page ? page : this._doc.body;

    // We can't grab an article if we don't have a page!
    if (!page) {
      this.log("No body found in document. Abort.");
      return null;
    }

    var pageCacheHtml = page.innerHTML;

    while (true) {
      this.log("Starting grabArticle loop");
      var stripUnlikelyCandidates = this._flagIsActive(
        this.FLAG_STRIP_UNLIKELYS
      );

      // First, node prepping. Trash nodes that look cruddy (like ones with the
      // class name "comment", etc), and turn divs into P tags where they have been
      // used inappropriately (as in, where they contain no other block level elements.)
      var elementsToScore = [];
      var node = this._doc.documentElement;

      let shouldRemoveTitleHeader = true;

      while (node) {
        if (node.tagName === "HTML") {
          this._articleLang = node.getAttribute("lang");
        }

        var matchString = node.className + " " + node.id;

        if (!this._isProbablyVisible(node)) {
          this.log("Removing hidden node - " + matchString);
          node = this._removeAndGetNext(node);
          continue;
        }

        // User is not able to see elements applied with both "aria-modal = true" and "role = dialog"
        if (
          node.getAttribute("aria-modal") == "true" &&
          node.getAttribute("role") == "dialog"
        ) {
          node = this._removeAndGetNext(node);
          continue;
        }

        // If we don't have a byline yet check to see if this node is a byline; if it is store the byline and remove the node.
        if (
          !this._articleByline &&
          !this._metadata.byline &&
          this._isValidByline(node, matchString)
        ) {
          // Find child node matching [itemprop="name"] and use that if it exists for a more accurate author name byline
          var endOfSearchMarkerNode = this._getNextNode(node, true);
          var next = this._getNextNode(node);
          var itemPropNameNode = null;
          while (next && next != endOfSearchMarkerNode) {
            var itemprop = next.getAttribute("itemprop");
            if (itemprop && itemprop.includes("name")) {
              itemPropNameNode = next;
              break;
            } else {
              next = this._getNextNode(next);
            }
          }
          this._articleByline = (itemPropNameNode ?? node).textContent.trim();
          node = this._removeAndGetNext(node);
          continue;
        }

        if (shouldRemoveTitleHeader && this._headerDuplicatesTitle(node)) {
          this.log(
            "Removing header: ",
            node.textContent.trim(),
            this._articleTitle.trim()
          );
          shouldRemoveTitleHeader = false;
          node = this._removeAndGetNext(node);
          continue;
        }

        // Remove unlikely candidates
        if (stripUnlikelyCandidates) {
          if (
            this.REGEXPS.unlikelyCandidates.test(matchString) &&
            !this.REGEXPS.okMaybeItsACandidate.test(matchString) &&
            !this._hasAncestorTag(node, "table") &&
            !this._hasAncestorTag(node, "code") &&
            node.tagName !== "BODY" &&
            node.tagName !== "A"
          ) {
            this.log("Removing unlikely candidate - " + matchString);
            node = this._removeAndGetNext(node);
            continue;
          }

          if (this.UNLIKELY_ROLES.includes(node.getAttribute("role"))) {
            this.log(
              "Removing content with role " +
                node.getAttribute("role") +
                " - " +
                matchString
            );
            node = this._removeAndGetNext(node);
            continue;
          }
        }

        // Remove DIV, SECTION, and HEADER nodes without any content(e.g. text, image, video, or iframe).
        if (
          (node.tagName === "DIV" ||
            node.tagName === "SECTION" ||
            node.tagName === "HEADER" ||
            node.tagName === "H1" ||
            node.tagName === "H2" ||
            node.tagName === "H3" ||
            node.tagName === "H4" ||
            node.tagName === "H5" ||
            node.tagName === "H6") &&
          this._isElementWithoutContent(node)
        ) {
          node = this._removeAndGetNext(node);
          continue;
        }

        if (this.DEFAULT_TAGS_TO_SCORE.includes(node.tagName)) {
          elementsToScore.push(node);
        }

        // Turn all divs that don't have children block level elements into p's
        if (node.tagName === "DIV") {
          // Put phrasing content into paragraphs.
          var p = null;
          var childNode = node.firstChild;
          while (childNode) {
            var nextSibling = childNode.nextSibling;
            if (this._isPhrasingContent(childNode)) {
              if (p !== null) {
                p.appendChild(childNode);
              } else if (!this._isWhitespace(childNode)) {
                p = doc.createElement("p");
                node.replaceChild(p, childNode);
                p.appendChild(childNode);
              }
            } else if (p !== null) {
              while (p.lastChild && this._isWhitespace(p.lastChild)) {
                p.lastChild.remove();
              }
              p = null;
            }
            childNode = nextSibling;
          }

          // Sites like http://mobile.slate.com encloses each paragraph with a DIV
          // element. DIVs with only a P element inside and no text content can be
          // safely converted into plain P elements to avoid confusing the scoring
          // algorithm with DIVs with are, in practice, paragraphs.
          if (
            this._hasSingleTagInsideElement(node, "P") &&
            this._getLinkDensity(node) < 0.25
          ) {
            var newNode = node.children[0];
            node.parentNode.replaceChild(newNode, node);
            node = newNode;
            elementsToScore.push(node);
          } else if (!this._hasChildBlockElement(node)) {
            node = this._setNodeTag(node, "P");
            elementsToScore.push(node);
          }
        }
        node = this._getNextNode(node);
      }

      /**
       * Loop through all paragraphs, and assign a score to them based on how content-y they look.
       * Then add their score to their parent node.
       *
       * A score is determined by things like number of commas, class names, etc. Maybe eventually link density.
       **/
      var candidates = [];
      this._forEachNode(elementsToScore, function (elementToScore) {
        if (
          !elementToScore.parentNode ||
          typeof elementToScore.parentNode.tagName === "undefined"
        ) {
          return;
        }

        // If this paragraph is less than 25 characters, don't even count it.
        var innerText = this._getInnerText(elementToScore);
        if (innerText.length < 25) {
          return;
        }

        // Exclude nodes with no ancestor.
        var ancestors = this._getNodeAncestors(elementToScore, 5);
        if (ancestors.length === 0) {
          return;
        }

        var contentScore = 0;

        // Add a point for the paragraph itself as a base.
        contentScore += 1;

        // Add points for any commas within this paragraph.
        contentScore += innerText.split(this.REGEXPS.commas).length;

        // For every 100 characters in this paragraph, add another point. Up to 3 points.
        contentScore += Math.min(Math.floor(innerText.length / 100), 3);

        // Initialize and score ancestors.
        this._forEachNode(ancestors, function (ancestor, level) {
          if (
            !ancestor.tagName ||
            !ancestor.parentNode ||
            typeof ancestor.parentNode.tagName === "undefined"
          ) {
            return;
          }

          if (typeof ancestor.readability === "undefined") {
            this._initializeNode(ancestor);
            candidates.push(ancestor);
          }

          // Node score divider:
          // - parent:             1 (no division)
          // - grandparent:        2
          // - great grandparent+: ancestor level * 3
          if (level === 0) {
            var scoreDivider = 1;
          } else if (level === 1) {
            scoreDivider = 2;
          } else {
            scoreDivider = level * 3;
          }
          ancestor.readability.contentScore += contentScore / scoreDivider;
        });
      });

      // After we've calculated scores, loop through all of the possible
      // candidate nodes we found and find the one with the highest score.
      var topCandidates = [];
      for (var c = 0, cl = candidates.length; c < cl; c += 1) {
        var candidate = candidates[c];

        // Scale the final candidates score based on link density. Good content
        // should have a relatively small link density (5% or less) and be mostly
        // unaffected by this operation.
        var candidateScore =
          candidate.readability.contentScore *
          (1 - this._getLinkDensity(candidate));
        candidate.readability.contentScore = candidateScore;

        this.log("Candidate:", candidate, "with score " + candidateScore);

        for (var t = 0; t < this._nbTopCandidates; t++) {
          var aTopCandidate = topCandidates[t];

          if (
            !aTopCandidate ||
            candidateScore > aTopCandidate.readability.contentScore
          ) {
            topCandidates.splice(t, 0, candidate);
            if (topCandidates.length > this._nbTopCandidates) {
              topCandidates.pop();
            }
            break;
          }
        }
      }

      var topCandidate = topCandidates[0] || null;
      var neededToCreateTopCandidate = false;
      var parentOfTopCandidate;

      // If we still have no top candidate, just use the body as a last resort.
      // We also have to copy the body node so it is something we can modify.
      if (topCandidate === null || topCandidate.tagName === "BODY") {
        // Move all of the page's children into topCandidate
        topCandidate = doc.createElement("DIV");
        neededToCreateTopCandidate = true;
        // Move everything (not just elements, also text nodes etc.) into the container
        // so we even include text directly in the body:
        while (page.firstChild) {
          this.log("Moving child out:", page.firstChild);
          topCandidate.appendChild(page.firstChild);
        }

        page.appendChild(topCandidate);

        this._initializeNode(topCandidate);
      } else if (topCandidate) {
        // Find a better top candidate node if it contains (at least three) nodes which belong to `topCandidates` array
        // and whose scores are quite closed with current `topCandidate` node.
        var alternativeCandidateAncestors = [];
        for (var i = 1; i < topCandidates.length; i++) {
          if (
            topCandidates[i].readability.contentScore /
              topCandidate.readability.contentScore >=
            0.75
          ) {
            alternativeCandidateAncestors.push(
              this._getNodeAncestors(topCandidates[i])
            );
          }
        }
        var MINIMUM_TOPCANDIDATES = 3;
        if (alternativeCandidateAncestors.length >= MINIMUM_TOPCANDIDATES) {
          parentOfTopCandidate = topCandidate.parentNode;
          while (parentOfTopCandidate.tagName !== "BODY") {
            var listsContainingThisAncestor = 0;
            for (
              var ancestorIndex = 0;
              ancestorIndex < alternativeCandidateAncestors.length &&
              listsContainingThisAncestor < MINIMUM_TOPCANDIDATES;
              ancestorIndex++
            ) {
              listsContainingThisAncestor += Number(
                alternativeCandidateAncestors[ancestorIndex].includes(
                  parentOfTopCandidate
                )
              );
            }
            if (listsContainingThisAncestor >= MINIMUM_TOPCANDIDATES) {
              topCandidate = parentOfTopCandidate;
              break;
            }
            parentOfTopCandidate = parentOfTopCandidate.parentNode;
          }
        }
        if (!topCandidate.readability) {
          this._initializeNode(topCandidate);
        }

        // Because of our bonus system, parents of candidates might have scores
        // themselves. They get half of the node. There won't be nodes with higher
        // scores than our topCandidate, but if we see the score going *up* in the first
        // few steps up the tree, that's a decent sign that there might be more content
        // lurking in other places that we want to unify in. The sibling stuff
        // below does some of that - but only if we've looked high enough up the DOM
        // tree.
        parentOfTopCandidate = topCandidate.parentNode;
        var lastScore = topCandidate.readability.contentScore;
        // The scores shouldn't get too low.
        var scoreThreshold = lastScore / 3;
        while (parentOfTopCandidate.tagName !== "BODY") {
          if (!parentOfTopCandidate.readability) {
            parentOfTopCandidate = parentOfTopCandidate.parentNode;
            continue;
          }
          var parentScore = parentOfTopCandidate.readability.contentScore;
          if (parentScore < scoreThreshold) {
            break;
          }
          if (parentScore > lastScore) {
            // Alright! We found a better parent to use.
            topCandidate = parentOfTopCandidate;
            break;
          }
          lastScore = parentOfTopCandidate.readability.contentScore;
          parentOfTopCandidate = parentOfTopCandidate.parentNode;
        }

        // If the top candidate is the only child, use parent instead. This will help sibling
        // joining logic when adjacent content is actually located in parent's sibling node.
        parentOfTopCandidate = topCandidate.parentNode;
        while (
          parentOfTopCandidate.tagName != "BODY" &&
          parentOfTopCandidate.children.length == 1
        ) {
          topCandidate = parentOfTopCandidate;
          parentOfTopCandidate = topCandidate.parentNode;
        }
        if (!topCandidate.readability) {
          this._initializeNode(topCandidate);
        }
      }

      // Now that we have the top candidate, look through its siblings for content
      // that might also be related. Things like preambles, content split by ads
      // that we removed, etc.
      var articleContent = doc.createElement("DIV");
      if (isPaging) {
        articleContent.id = "readability-content";
      }

      var siblingScoreThreshold = Math.max(
        10,
        topCandidate.readability.contentScore * 0.2
      );
      // Keep potential top candidate's parent node to try to get text direction of it later.
      parentOfTopCandidate = topCandidate.parentNode;
      var siblings = parentOfTopCandidate.children;

      for (var s = 0, sl = siblings.length; s < sl; s++) {
        var sibling = siblings[s];
        var append = false;

        this.log(
          "Looking at sibling node:",
          sibling,
          sibling.readability
            ? "with score " + sibling.readability.contentScore
            : ""
        );
        this.log(
          "Sibling has score",
          sibling.readability ? sibling.readability.contentScore : "Unknown"
        );

        if (sibling === topCandidate) {
          append = true;
        } else {
          var contentBonus = 0;

          // Give a bonus if sibling nodes and top candidates have the example same classname
          if (
            sibling.className === topCandidate.className &&
            topCandidate.className !== ""
          ) {
            contentBonus += topCandidate.readability.contentScore * 0.2;
          }

          if (
            sibling.readability &&
            sibling.readability.contentScore + contentBonus >=
              siblingScoreThreshold
          ) {
            append = true;
          } else if (sibling.nodeName === "P") {
            var linkDensity = this._getLinkDensity(sibling);
            var nodeContent = this._getInnerText(sibling);
            var nodeLength = nodeContent.length;

            if (nodeLength > 80 && linkDensity < 0.25) {
              append = true;
            } else if (
              nodeLength < 80 &&
              nodeLength > 0 &&
              linkDensity === 0 &&
              nodeContent.search(/\.( |$)/) !== -1
            ) {
              append = true;
            }
          }
        }

        if (append) {
          this.log("Appending node:", sibling);

          if (!this.ALTER_TO_DIV_EXCEPTIONS.includes(sibling.nodeName)) {
            // We have a node that isn't a common block level element, like a form or td tag.
            // Turn it into a div so it doesn't get filtered out later by accident.
            this.log("Altering sibling:", sibling, "to div.");

            sibling = this._setNodeTag(sibling, "DIV");
          }

          articleContent.appendChild(sibling);
          // Fetch children again to make it compatible
          // with DOM parsers without live collection support.
          siblings = parentOfTopCandidate.children;
          // siblings is a reference to the children array, and
          // sibling is removed from the array when we call appendChild().
          // As a result, we must revisit this index since the nodes
          // have been shifted.
          s -= 1;
          sl -= 1;
        }
      }

      if (this._debug) {
        this.log("Article content pre-prep: " + articleContent.innerHTML);
      }
      // So we have all of the content that we need. Now we clean it up for presentation.
      this._prepArticle(articleContent);
      if (this._debug) {
        this.log("Article content post-prep: " + articleContent.innerHTML);
      }

      if (neededToCreateTopCandidate) {
        // We already created a fake div thing, and there wouldn't have been any siblings left
        // for the previous loop, so there's no point trying to create a new div, and then
        // move all the children over. Just assign IDs and class names here. No need to append
        // because that already happened anyway.
        topCandidate.id = "readability-page-1";
        topCandidate.className = "page";
      } else {
        var div = doc.createElement("DIV");
        div.id = "readability-page-1";
        div.className = "page";
        while (articleContent.firstChild) {
          div.appendChild(articleContent.firstChild);
        }
        articleContent.appendChild(div);
      }

      if (this._debug) {
        this.log("Article content after paging: " + articleContent.innerHTML);
      }

      var parseSuccessful = true;

      // Now that we've gone through the full algorithm, check to see if
      // we got any meaningful content. If we didn't, we may need to re-run
      // grabArticle with different flags set. This gives us a higher likelihood of
      // finding the content, and the sieve approach gives us a higher likelihood of
      // finding the -right- content.
      var textLength = this._getInnerText(articleContent, true).length;
      if (textLength < this._charThreshold) {
        parseSuccessful = false;
        // eslint-disable-next-line no-unsanitized/property
        page.innerHTML = pageCacheHtml;

        this._attempts.push({
          articleContent,
          textLength,
        });

        if (this._flagIsActive(this.FLAG_STRIP_UNLIKELYS)) {
          this._removeFlag(this.FLAG_STRIP_UNLIKELYS);
        } else if (this._flagIsActive(this.FLAG_WEIGHT_CLASSES)) {
          this._removeFlag(this.FLAG_WEIGHT_CLASSES);
        } else if (this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY)) {
          this._removeFlag(this.FLAG_CLEAN_CONDITIONALLY);
        } else {
          // No luck after removing flags, just return the longest text we found during the different loops
          this._attempts.sort(function (a, b) {
            return b.textLength - a.textLength;
          });

          // But first check if we actually have something
          if (!this._attempts[0].textLength) {
            return null;
          }

          articleContent = this._attempts[0].articleContent;
          parseSuccessful = true;
        }
      }

      if (parseSuccessful) {
        // Find out text direction from ancestors of final top candidate.
        var ancestors = [parentOfTopCandidate, topCandidate].concat(
          this._getNodeAncestors(parentOfTopCandidate)
        );
        this._someNode(ancestors, function (ancestor) {
          if (!ancestor.tagName) {
            return false;
          }
          var articleDir = ancestor.getAttribute("dir");
          if (articleDir) {
            this._articleDir = articleDir;
            return true;
          }
          return false;
        });
        return articleContent;
      }
    }
  },

  /**
   * Converts some of the common HTML entities in string to their corresponding characters.
   *
   * @param str {string} - a string to unescape.
   * @return string without HTML entity.
   */
  _unescapeHtmlEntities(str) {
    if (!str) {
      return str;
    }

    var htmlEscapeMap = this.HTML_ESCAPE_MAP;
    return str
      .replace(/&(quot|amp|apos|lt|gt);/g, function (_, tag) {
        return htmlEscapeMap[tag];
      })
      .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, function (_, hex, numStr) {
        var num = parseInt(hex || numStr, hex ? 16 : 10);

        // these character references are replaced by a conforming HTML parser
        if (num == 0 || num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)) {
          num = 0xfffd;
        }

        return String.fromCodePoint(num);
      });
  },

  /**
   * Try to extract metadata from JSON-LD object.
   * For now, only Schema.org objects of type Article or its subtypes are supported.
   * @return Object with any metadata that could be extracted (possibly none)
   */
  _getJSONLD(doc) {
    var scripts = this._getAllNodesWithTag(doc, ["script"]);

    var metadata;

    this._forEachNode(scripts, function (jsonLdElement) {
      if (
        !metadata &&
        jsonLdElement.getAttribute("type") === "application/ld+json"
      ) {
        try {
          // Strip CDATA markers if present
          var content = jsonLdElement.textContent.replace(
            /^\s*<!\[CDATA\[|\]\]>\s*$/g,
            ""
          );
          var parsed = JSON.parse(content);

          if (Array.isArray(parsed)) {
            parsed = parsed.find(it => {
              return (
                it["@type"] &&
                it["@type"].match(this.REGEXPS.jsonLdArticleTypes)
              );
            });
            if (!parsed) {
              return;
            }
          }

          var schemaDotOrgRegex = /^https?\:\/\/schema\.org\/?$/;
          var matches =
            (typeof parsed["@context"] === "string" &&
              parsed["@context"].match(schemaDotOrgRegex)) ||
            (typeof parsed["@context"] === "object" &&
              typeof parsed["@context"]["@vocab"] == "string" &&
              parsed["@context"]["@vocab"].match(schemaDotOrgRegex));

          if (!matches) {
            return;
          }

          if (!parsed["@type"] && Array.isArray(parsed["@graph"])) {
            parsed = parsed["@graph"].find(it => {
              return (it["@type"] || "").match(this.REGEXPS.jsonLdArticleTypes);
            });
          }

          if (
            !parsed ||
            !parsed["@type"] ||
            !parsed["@type"].match(this.REGEXPS.jsonLdArticleTypes)
          ) {
            return;
          }

          metadata = {};

          if (
            typeof parsed.name === "string" &&
            typeof parsed.headline === "string" &&
            parsed.name !== parsed.headline
          ) {
            // we have both name and headline element in the JSON-LD. They should both be the same but some websites like aktualne.cz
            // put their own name into "name" and the article title to "headline" which confuses Readability. So we try to check if either
            // "name" or "headline" closely matches the html title, and if so, use that one. If not, then we use "name" by default.

            var title = this._getArticleTitle();
            var nameMatches = this._textSimilarity(parsed.name, title) > 0.75;
            var headlineMatches =
              this._textSimilarity(parsed.headline, title) > 0.75;

            if (headlineMatches && !nameMatches) {
              metadata.title = parsed.headline;
            } else {
              metadata.title = parsed.name;
            }
          } else if (typeof parsed.name === "string") {
            metadata.title = parsed.name.trim();
          } else if (typeof parsed.headline === "string") {
            metadata.title = parsed.headline.trim();
          }
          if (parsed.author) {
            if (typeof parsed.author.name === "string") {
              metadata.byline = parsed.author.name.trim();
            } else if (
              Array.isArray(parsed.author) &&
              parsed.author[0] &&
              typeof parsed.author[0].name === "string"
            ) {
              metadata.byline = parsed.author
                .filter(function (author) {
                  return author && typeof author.name === "string";
                })
                .map(function (author) {
                  return author.name.trim();
                })
                .join(", ");
            }
          }
          if (typeof parsed.description === "string") {
            metadata.excerpt = parsed.description.trim();
          }
          if (parsed.publisher && typeof parsed.publisher.name === "string") {
            metadata.siteName = parsed.publisher.name.trim();
          }
          if (typeof parsed.datePublished === "string") {
            metadata.datePublished = parsed.datePublished.trim();
          }
        } catch (err) {
          this.log(err.message);
        }
      }
    });
    return metadata ? metadata : {};
  },

  /**
   * Attempts to get excerpt and byline metadata for the article.
   *
   * @param {Object} jsonld — object containing any metadata that
   * could be extracted from JSON-LD object.
   *
   * @return Object with optional "excerpt" and "byline" properties
   */
  _getArticleMetadata(jsonld) {
    var metadata = {};
    var values = {};
    var metaElements = this._doc.getElementsByTagName("meta");

    // property is a space-separated list of values
    var propertyPattern =
      /\s*(article|dc|dcterm|og|twitter)\s*:\s*(author|creator|description|published_time|title|site_name)\s*/gi;

    // name is a single value
    var namePattern =
      /^\s*(?:(dc|dcterm|og|twitter|parsely|weibo:(article|webpage))\s*[-\.:]\s*)?(author|creator|pub-date|description|title|site_name)\s*$/i;

    // Find description tags.
    this._forEachNode(metaElements, function (element) {
      var elementName = element.getAttribute("name");
      var elementProperty = element.getAttribute("property");
      var content = element.getAttribute("content");
      if (!content) {
        return;
      }
      var matches = null;
      var name = null;

      if (elementProperty) {
        matches = elementProperty.match(propertyPattern);
        if (matches) {
          // Convert to lowercase, and remove any whitespace
          // so we can match below.
          name = matches[0].toLowerCase().replace(/\s/g, "");
          // multiple authors
          values[name] = content.trim();
        }
      }
      if (!matches && elementName && namePattern.test(elementName)) {
        name = elementName;
        if (content) {
          // Convert to lowercase, remove any whitespace, and convert dots
          // to colons so we can match below.
          name = name.toLowerCase().replace(/\s/g, "").replace(/\./g, ":");
          values[name] = content.trim();
        }
      }
    });

    // get title
    metadata.title =
      jsonld.title ||
      values["dc:title"] ||
      values["dcterm:title"] ||
      values["og:title"] ||
      values["weibo:article:title"] ||
      values["weibo:webpage:title"] ||
      values.title ||
      values["twitter:title"] ||
      values["parsely-title"];

    if (!metadata.title) {
      metadata.title = this._getArticleTitle();
    }

    const articleAuthor =
      typeof values["article:author"] === "string" &&
      !this._isUrl(values["article:author"])
        ? values["article:author"]
        : undefined;

    // get author
    metadata.byline =
      jsonld.byline ||
      values["dc:creator"] ||
      values["dcterm:creator"] ||
      values.author ||
      values["parsely-author"] ||
      articleAuthor;

    // get description
    metadata.excerpt =
      jsonld.excerpt ||
      values["dc:description"] ||
      values["dcterm:description"] ||
      values["og:description"] ||
      values["weibo:article:description"] ||
      values["weibo:webpage:description"] ||
      values.description ||
      values["twitter:description"];

    // get site name
    metadata.siteName = jsonld.siteName || values["og:site_name"];

    // get article published time
    metadata.publishedTime =
      jsonld.datePublished ||
      values["article:published_time"] ||
      values["parsely-pub-date"] ||
      null;

    // in many sites the meta value is escaped with HTML entities,
    // so here we need to unescape it
    metadata.title = this._unescapeHtmlEntities(metadata.title);
    metadata.byline = this._unescapeHtmlEntities(metadata.byline);
    metadata.excerpt = this._unescapeHtmlEntities(metadata.excerpt);
    metadata.siteName = this._unescapeHtmlEntities(metadata.siteName);
    metadata.publishedTime = this._unescapeHtmlEntities(metadata.publishedTime);

    return metadata;
  },

  /**
   * Check if node is image, or if node contains exactly only one image
   * whether as a direct child or as its descendants.
   *
   * @param Element
   **/
  _isSingleImage(node) {
    while (node) {
      if (node.tagName === "IMG") {
        return true;
      }
      if (node.children.length !== 1 || node.textContent.trim() !== "") {
        return false;
      }
      node = node.children[0];
    }
    return false;
  },

  /**
   * Find all <noscript> that are located after <img> nodes, and which contain only one
   * <img> element. Replace the first image with the image from inside the <noscript> tag,
   * and remove the <noscript> tag. This improves the quality of the images we use on
   * some sites (e.g. Medium).
   *
   * @param Element
   **/
  _unwrapNoscriptImages(doc) {
    // Find img without source or attributes that might contains image, and remove it.
    // This is done to prevent a placeholder img is replaced by img from noscript in next step.
    var imgs = Array.from(doc.getElementsByTagName("img"));
    this._forEachNode(imgs, function (img) {
      for (var i = 0; i < img.attributes.length; i++) {
        var attr = img.attributes[i];
        switch (attr.name) {
          case "src":
          case "srcset":
          case "data-src":
          case "data-srcset":
            return;
        }

        if (/\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
          return;
        }
      }

      img.remove();
    });

    // Next find noscript and try to extract its image
    var noscripts = Array.from(doc.getElementsByTagName("noscript"));
    this._forEachNode(noscripts, function (noscript) {
      // Parse content of noscript and make sure it only contains image
      if (!this._isSingleImage(noscript)) {
        return;
      }
      var tmp = doc.createElement("div");
      // We're running in the document context, and using unmodified
      // document contents, so doing this should be safe.
      // (Also we heavily discourage people from allowing script to
      // run at all in this document...)
      // eslint-disable-next-line no-unsanitized/property
      tmp.innerHTML = noscript.innerHTML;

      // If noscript has previous sibling and it only contains image,
      // replace it with noscript content. However we also keep old
      // attributes that might contains image.
      var prevElement = noscript.previousElementSibling;
      if (prevElement && this._isSingleImage(prevElement)) {
        var prevImg = prevElement;
        if (prevImg.tagName !== "IMG") {
          prevImg = prevElement.getElementsByTagName("img")[0];
        }

        var newImg = tmp.getElementsByTagName("img")[0];
        for (var i = 0; i < prevImg.attributes.length; i++) {
          var attr = prevImg.attributes[i];
          if (attr.value === "") {
            continue;
          }

          if (
            attr.name === "src" ||
            attr.name === "srcset" ||
            /\.(jpg|jpeg|png|webp)/i.test(attr.value)
          ) {
            if (newImg.getAttribute(attr.name) === attr.value) {
              continue;
            }

            var attrName = attr.name;
            if (newImg.hasAttribute(attrName)) {
              attrName = "data-old-" + attrName;
            }

            newImg.setAttribute(attrName, attr.value);
          }
        }

        noscript.parentNode.replaceChild(tmp.firstElementChild, prevElement);
      }
    });
  },

  /**
   * Removes script tags from the document.
   *
   * @param Element
   **/
  _removeScripts(doc) {
    this._removeNodes(this._getAllNodesWithTag(doc, ["script", "noscript"]));
  },

  /**
   * Check if this node has only whitespace and a single element with given tag
   * Returns false if the DIV node contains non-empty text nodes
   * or if it contains no element with given tag or more than 1 element.
   *
   * @param Element
   * @param string tag of child element
   **/
  _hasSingleTagInsideElement(element, tag) {
    // There should be exactly 1 element child with given tag
    if (element.children.length != 1 || element.children[0].tagName !== tag) {
      return false;
    }

    // And there should be no text nodes with real content
    return !this._someNode(element.childNodes, function (node) {
      return (
        node.nodeType === this.TEXT_NODE &&
        this.REGEXPS.hasContent.test(node.textContent)
      );
    });
  },

  _isElementWithoutContent(node) {
    return (
      node.nodeType === this.ELEMENT_NODE &&
      !node.textContent.trim().length &&
      (!node.children.length ||
        node.children.length ==
          node.getElementsByTagName("br").length +
            node.getElementsByTagName("hr").length)
    );
  },

  /**
   * Determine whether element has any children block level elements.
   *
   * @param Element
   */
  _hasChildBlockElement(element) {
    return this._someNode(element.childNodes, function (node) {
      return (
        this.DIV_TO_P_ELEMS.has(node.tagName) ||
        this._hasChildBlockElement(node)
      );
    });
  },

  /***
   * Determine if a node qualifies as phrasing content.
   * https://developer.mozilla.org/en-US/docs/Web/Guide/HTML/Content_categories#Phrasing_content
   **/
  _isPhrasingContent(node) {
    return (
      node.nodeType === this.TEXT_NODE ||
      this.PHRASING_ELEMS.includes(node.tagName) ||
      ((node.tagName === "A" ||
        node.tagName === "DEL" ||
        node.tagName === "INS") &&
        this._everyNode(node.childNodes, this._isPhrasingContent))
    );
  },

  _isWhitespace(node) {
    return (
      (node.nodeType === this.TEXT_NODE &&
        node.textContent.trim().length === 0) ||
      (node.nodeType === this.ELEMENT_NODE && node.tagName === "BR")
    );
  },

  /**
   * Get the inner text of a node - cross browser compatibly.
   * This also strips out any excess whitespace to be found.
   *
   * @param Element
   * @param Boolean normalizeSpaces (default: true)
   * @return string
   **/
  _getInnerText(e, normalizeSpaces) {
    normalizeSpaces =
      typeof normalizeSpaces === "undefined" ? true : normalizeSpaces;
    var textContent = e.textContent.trim();

    if (normalizeSpaces) {
      return textContent.replace(this.REGEXPS.normalize, " ");
    }
    return textContent;
  },

  /**
   * Get the number of times a string s appears in the node e.
   *
   * @param Element
   * @param string - what to split on. Default is ","
   * @return number (integer)
   **/
  _getCharCount(e, s) {
    s = s || ",";
    return this._getInnerText(e).split(s).length - 1;
  },

  /**
   * Remove the style attribute on every e and under.
   * TODO: Test if getElementsByTagName(*) is faster.
   *
   * @param Element
   * @return void
   **/
  _cleanStyles(e) {
    if (!e || e.tagName.toLowerCase() === "svg") {
      return;
    }

    // Remove `style` and deprecated presentational attributes
    for (var i = 0; i < this.PRESENTATIONAL_ATTRIBUTES.length; i++) {
      e.removeAttribute(this.PRESENTATIONAL_ATTRIBUTES[i]);
    }

    if (this.DEPRECATED_SIZE_ATTRIBUTE_ELEMS.includes(e.tagName)) {
      e.removeAttribute("width");
      e.removeAttribute("height");
    }

    var cur = e.firstElementChild;
    while (cur !== null) {
      this._cleanStyles(cur);
      cur = cur.nextElementSibling;
    }
  },

  /**
   * Get the density of links as a percentage of the content
   * This is the amount of text that is inside a link divided by the total text in the node.
   *
   * @param Element
   * @return number (float)
   **/
  _getLinkDensity(element) {
    var textLength = this._getInnerText(element).length;
    if (textLength === 0) {
      return 0;
    }

    var linkLength = 0;

    // XXX implement _reduceNodeList?
    this._forEachNode(element.getElementsByTagName("a"), function (linkNode) {
      var href = linkNode.getAttribute("href");
      var coefficient = href && this.REGEXPS.hashUrl.test(href) ? 0.3 : 1;
      linkLength += this._getInnerText(linkNode).length * coefficient;
    });

    return linkLength / textLength;
  },

  /**
   * Get an elements class/id weight. Uses regular expressions to tell if this
   * element looks good or bad.
   *
   * @param Element
   * @return number (Integer)
   **/
  _getClassWeight(e) {
    if (!this._flagIsActive(this.FLAG_WEIGHT_CLASSES)) {
      return 0;
    }

    var weight = 0;

    // Look for a special classname
    if (typeof e.className === "string" && e.className !== "") {
      if (this.REGEXPS.negative.test(e.className)) {
        weight -= 25;
      }

      if (this.REGEXPS.positive.test(e.className)) {
        weight += 25;
      }
    }

    // Look for a special ID
    if (typeof e.id === "string" && e.id !== "") {
      if (this.REGEXPS.negative.test(e.id)) {
        weight -= 25;
      }

      if (this.REGEXPS.positive.test(e.id)) {
        weight += 25;
      }
    }

    return weight;
  },

  /**
   * Clean a node of all elements of type "tag".
   * (Unless it's a youtube/vimeo video. People love movies.)
   *
   * @param Element
   * @param string tag to clean
   * @return void
   **/
  _clean(e, tag) {
    var isEmbed = ["object", "embed", "iframe"].includes(tag);

    this._removeNodes(this._getAllNodesWithTag(e, [tag]), function (element) {
      // Allow youtube and vimeo videos through as people usually want to see those.
      if (isEmbed) {
        // First, check the elements attributes to see if any of them contain youtube or vimeo
        for (var i = 0; i < element.attributes.length; i++) {
          if (this._allowedVideoRegex.test(element.attributes[i].value)) {
            return false;
          }
        }

        // For embed with <object> tag, check inner HTML as well.
        if (
          element.tagName === "object" &&
          this._allowedVideoRegex.test(element.innerHTML)
        ) {
          return false;
        }
      }

      return true;
    });
  },

  /**
   * Check if a given node has one of its ancestor tag name matching the
   * provided one.
   * @param  HTMLElement node
   * @param  String      tagName
   * @param  Number      maxDepth
   * @param  Function    filterFn a filter to invoke to determine whether this node 'counts'
   * @return Boolean
   */
  _hasAncestorTag(node, tagName, maxDepth, filterFn) {
    maxDepth = maxDepth || 3;
    tagName = tagName.toUpperCase();
    var depth = 0;
    while (node.parentNode) {
      if (maxDepth > 0 && depth > maxDepth) {
        return false;
      }
      if (
        node.parentNode.tagName === tagName &&
        (!filterFn || filterFn(node.parentNode))
      ) {
        return true;
      }
      node = node.parentNode;
      depth++;
    }
    return false;
  },

  /**
   * Return an object indicating how many rows and columns this table has.
   */
  _getRowAndColumnCount(table) {
    var rows = 0;
    var columns = 0;
    var trs = table.getElementsByTagName("tr");
    for (var i = 0; i < trs.length; i++) {
      var rowspan = trs[i].getAttribute("rowspan") || 0;
      if (rowspan) {
        rowspan = parseInt(rowspan, 10);
      }
      rows += rowspan || 1;

      // Now look for column-related info
      var columnsInThisRow = 0;
      var cells = trs[i].getElementsByTagName("td");
      for (var j = 0; j < cells.length; j++) {
        var colspan = cells[j].getAttribute("colspan") || 0;
        if (colspan) {
          colspan = parseInt(colspan, 10);
        }
        columnsInThisRow += colspan || 1;
      }
      columns = Math.max(columns, columnsInThisRow);
    }
    return { rows, columns };
  },

  /**
   * Look for 'data' (as opposed to 'layout') tables, for which we use
   * similar checks as
   * https://searchfox.org/mozilla-central/rev/f82d5c549f046cb64ce5602bfd894b7ae807c8f8/accessible/generic/TableAccessible.cpp#19
   */
  _markDataTables(root) {
    var tables = root.getElementsByTagName("table");
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      var role = table.getAttribute("role");
      if (role == "presentation") {
        table._readabilityDataTable = false;
        continue;
      }
      var datatable = table.getAttribute("datatable");
      if (datatable == "0") {
        table._readabilityDataTable = false;
        continue;
      }
      var summary = table.getAttribute("summary");
      if (summary) {
        table._readabilityDataTable = true;
        continue;
      }

      var caption = table.getElementsByTagName("caption")[0];
      if (caption && caption.childNodes.length) {
        table._readabilityDataTable = true;
        continue;
      }

      // If the table has a descendant with any of these tags, consider a data table:
      var dataTableDescendants = ["col", "colgroup", "tfoot", "thead", "th"];
      var descendantExists = function (tag) {
        return !!table.getElementsByTagName(tag)[0];
      };
      if (dataTableDescendants.some(descendantExists)) {
        this.log("Data table because found data-y descendant");
        table._readabilityDataTable = true;
        continue;
      }

      // Nested tables indicate a layout table:
      if (table.getElementsByTagName("table")[0]) {
        table._readabilityDataTable = false;
        continue;
      }

      var sizeInfo = this._getRowAndColumnCount(table);

      if (sizeInfo.columns == 1 || sizeInfo.rows == 1) {
        // single colum/row tables are commonly used for page layout purposes.
        table._readabilityDataTable = false;
        continue;
      }

      if (sizeInfo.rows >= 10 || sizeInfo.columns > 4) {
        table._readabilityDataTable = true;
        continue;
      }
      // Now just go by size entirely:
      table._readabilityDataTable = sizeInfo.rows * sizeInfo.columns > 10;
    }
  },

  /* convert images and figures that have properties like data-src into images that can be loaded without JS */
  _fixLazyImages(root) {
    this._forEachNode(
      this._getAllNodesWithTag(root, ["img", "picture", "figure"]),
      function (elem) {
        // In some sites (e.g. Kotaku), they put 1px square image as base64 data uri in the src attribute.
        // So, here we check if the data uri is too short, just might as well remove it.
        if (elem.src && this.REGEXPS.b64DataUrl.test(elem.src)) {
          // Make sure it's not SVG, because SVG can have a meaningful image in under 133 bytes.
          var parts = this.REGEXPS.b64DataUrl.exec(elem.src);
          if (parts[1] === "image/svg+xml") {
            return;
          }

          // Make sure this element has other attributes which contains image.
          // If it doesn't, then this src is important and shouldn't be removed.
          var srcCouldBeRemoved = false;
          for (var i = 0; i < elem.attributes.length; i++) {
            var attr = elem.attributes[i];
            if (attr.name === "src") {
              continue;
            }

            if (/\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
              srcCouldBeRemoved = true;
              break;
            }
          }

          // Here we assume if image is less than 100 bytes (or 133 after encoded to base64)
          // it will be too small, therefore it might be placeholder image.
          if (srcCouldBeRemoved) {
            var b64starts = parts[0].length;
            var b64length = elem.src.length - b64starts;
            if (b64length < 133) {
              elem.removeAttribute("src");
            }
          }
        }

        // also check for "null" to work around https://github.com/jsdom/jsdom/issues/2580
        if (
          (elem.src || (elem.srcset && elem.srcset != "null")) &&
          !elem.className.toLowerCase().includes("lazy")
        ) {
          return;
        }

        for (var j = 0; j < elem.attributes.length; j++) {
          attr = elem.attributes[j];
          if (
            attr.name === "src" ||
            attr.name === "srcset" ||
            attr.name === "alt"
          ) {
            continue;
          }
          var copyTo = null;
          if (/\.(jpg|jpeg|png|webp)\s+\d/.test(attr.value)) {
            copyTo = "srcset";
          } else if (/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/.test(attr.value)) {
            copyTo = "src";
          }
          if (copyTo) {
            //if this is an img or picture, set the attribute directly
            if (elem.tagName === "IMG" || elem.tagName === "PICTURE") {
              elem.setAttribute(copyTo, attr.value);
            } else if (
              elem.tagName === "FIGURE" &&
              !this._getAllNodesWithTag(elem, ["img", "picture"]).length
            ) {
              //if the item is a <figure> that does not contain an image or picture, create one and place it inside the figure
              //see the nytimes-3 testcase for an example
              var img = this._doc.createElement("img");
              img.setAttribute(copyTo, attr.value);
              elem.appendChild(img);
            }
          }
        }
      }
    );
  },

  _getTextDensity(e, tags) {
    var textLength = this._getInnerText(e, true).length;
    if (textLength === 0) {
      return 0;
    }
    var childrenLength = 0;
    var children = this._getAllNodesWithTag(e, tags);
    this._forEachNode(
      children,
      child => (childrenLength += this._getInnerText(child, true).length)
    );
    return childrenLength / textLength;
  },

  /**
   * Clean an element of all tags of type "tag" if they look fishy.
   * "Fishy" is an algorithm based on content length, classnames, link density, number of images & embeds, etc.
   *
   * @return void
   **/
  _cleanConditionally(e, tag) {
    if (!this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY)) {
      return;
    }

    // Gather counts for other typical elements embedded within.
    // Traverse backwards so we can remove nodes at the same time
    // without effecting the traversal.
    //
    // TODO: Consider taking into account original contentScore here.
    this._removeNodes(this._getAllNodesWithTag(e, [tag]), function (node) {
      // First check if this node IS data table, in which case don't remove it.
      var isDataTable = function (t) {
        return t._readabilityDataTable;
      };

      var isList = tag === "ul" || tag === "ol";
      if (!isList) {
        var listLength = 0;
        var listNodes = this._getAllNodesWithTag(node, ["ul", "ol"]);
        this._forEachNode(
          listNodes,
          list => (listLength += this._getInnerText(list).length)
        );
        isList = listLength / this._getInnerText(node).length > 0.9;
      }

      if (tag === "table" && isDataTable(node)) {
        return false;
      }

      // Next check if we're inside a data table, in which case don't remove it as well.
      if (this._hasAncestorTag(node, "table", -1, isDataTable)) {
        return false;
      }

      if (this._hasAncestorTag(node, "code")) {
        return false;
      }

      // keep element if it has a data tables
      if (
        [...node.getElementsByTagName("table")].some(
          tbl => tbl._readabilityDataTable
        )
      ) {
        return false;
      }

      var weight = this._getClassWeight(node);

      this.log("Cleaning Conditionally", node);

      var contentScore = 0;

      if (weight + contentScore < 0) {
        return true;
      }

      if (this._getCharCount(node, ",") < 10) {
        // If there are not very many commas, and the number of
        // non-paragraph elements is more than paragraphs or other
        // ominous signs, remove the element.
        var p = node.getElementsByTagName("p").length;
        var img = node.getElementsByTagName("img").length;
        var li = node.getElementsByTagName("li").length - 100;
        var input = node.getElementsByTagName("input").length;
        var headingDensity = this._getTextDensity(node, [
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
        ]);

        var embedCount = 0;
        var embeds = this._getAllNodesWithTag(node, [
          "object",
          "embed",
          "iframe",
        ]);

        for (var i = 0; i < embeds.length; i++) {
          // If this embed has attribute that matches video regex, don't delete it.
          for (var j = 0; j < embeds[i].attributes.length; j++) {
            if (this._allowedVideoRegex.test(embeds[i].attributes[j].value)) {
              return false;
            }
          }

          // For embed with <object> tag, check inner HTML as well.
          if (
            embeds[i].tagName === "object" &&
            this._allowedVideoRegex.test(embeds[i].innerHTML)
          ) {
            return false;
          }

          embedCount++;
        }

        var innerText = this._getInnerText(node);

        // toss any node whose inner text contains nothing but suspicious words
        if (
          this.REGEXPS.adWords.test(innerText) ||
          this.REGEXPS.loadingWords.test(innerText)
        ) {
          return true;
        }

        var contentLength = innerText.length;
        var linkDensity = this._getLinkDensity(node);
        var textishTags = ["SPAN", "LI", "TD"].concat(
          Array.from(this.DIV_TO_P_ELEMS)
        );
        var textDensity = this._getTextDensity(node, textishTags);
        var isFigureChild = this._hasAncestorTag(node, "figure");

        // apply shadiness checks, then check for exceptions
        const shouldRemoveNode = () => {
          const errs = [];
          if (!isFigureChild && img > 1 && p / img < 0.5) {
            errs.push(`Bad p to img ratio (img=${img}, p=${p})`);
          }
          if (!isList && li > p) {
            errs.push(`Too many li's outside of a list. (li=${li} > p=${p})`);
          }
          if (input > Math.floor(p / 3)) {
            errs.push(`Too many inputs per p. (input=${input}, p=${p})`);
          }
          if (
            !isList &&
            !isFigureChild &&
            headingDensity < 0.9 &&
            contentLength < 25 &&
            (img === 0 || img > 2) &&
            linkDensity > 0
          ) {
            errs.push(
              `Suspiciously short. (headingDensity=${headingDensity}, img=${img}, linkDensity=${linkDensity})`
            );
          }
          if (
            !isList &&
            weight < 25 &&
            linkDensity > 0.2 + this._linkDensityModifier
          ) {
            errs.push(
              `Low weight and a little linky. (linkDensity=${linkDensity})`
            );
          }
          if (weight >= 25 && linkDensity > 0.5 + this._linkDensityModifier) {
            errs.push(
              `High weight and mostly links. (linkDensity=${linkDensity})`
            );
          }
          if ((embedCount === 1 && contentLength < 75) || embedCount > 1) {
            errs.push(
              `Suspicious embed. (embedCount=${embedCount}, contentLength=${contentLength})`
            );
          }
          if (img === 0 && textDensity === 0) {
            errs.push(
              `No useful content. (img=${img}, textDensity=${textDensity})`
            );
          }

          if (errs.length) {
            this.log("Checks failed", errs);
            return true;
          }

          return false;
        };

        var haveToRemove = shouldRemoveNode();

        // Allow simple lists of images to remain in pages
        if (isList && haveToRemove) {
          for (var x = 0; x < node.children.length; x++) {
            let child = node.children[x];
            // Don't filter in lists with li's that contain more than one child
            if (child.children.length > 1) {
              return haveToRemove;
            }
          }
          let li_count = node.getElementsByTagName("li").length;
          // Only allow the list to remain if every li contains an image
          if (img == li_count) {
            return false;
          }
        }
        return haveToRemove;
      }
      return false;
    });
  },

  /**
   * Clean out elements that match the specified conditions
   *
   * @param Element
   * @param Function determines whether a node should be removed
   * @return void
   **/
  _cleanMatchedNodes(e, filter) {
    var endOfSearchMarkerNode = this._getNextNode(e, true);
    var next = this._getNextNode(e);
    while (next && next != endOfSearchMarkerNode) {
      if (filter.call(this, next, next.className + " " + next.id)) {
        next = this._removeAndGetNext(next);
      } else {
        next = this._getNextNode(next);
      }
    }
  },

  /**
   * Clean out spurious headers from an Element.
   *
   * @param Element
   * @return void
   **/
  _cleanHeaders(e) {
    let headingNodes = this._getAllNodesWithTag(e, ["h1", "h2"]);
    this._removeNodes(headingNodes, function (node) {
      let shouldRemove = this._getClassWeight(node) < 0;
      if (shouldRemove) {
        this.log("Removing header with low class weight:", node);
      }
      return shouldRemove;
    });
  },

  /**
   * Check if this node is an H1 or H2 element whose content is mostly
   * the same as the article title.
   *
   * @param Element  the node to check.
   * @return boolean indicating whether this is a title-like header.
   */
  _headerDuplicatesTitle(node) {
    if (node.tagName != "H1" && node.tagName != "H2") {
      return false;
    }
    var heading = this._getInnerText(node, false);
    this.log("Evaluating similarity of header:", heading, this._articleTitle);
    return this._textSimilarity(this._articleTitle, heading) > 0.75;
  },

  _flagIsActive(flag) {
    return (this._flags & flag) > 0;
  },

  _removeFlag(flag) {
    this._flags = this._flags & ~flag;
  },

  _isProbablyVisible(node) {
    // Have to null-check node.style and node.className.includes to deal with SVG and MathML nodes.
    return (
      (!node.style || node.style.display != "none") &&
      (!node.style || node.style.visibility != "hidden") &&
      !node.hasAttribute("hidden") &&
      //check for "fallback-image" so that wikimedia math images are displayed
      (!node.hasAttribute("aria-hidden") ||
        node.getAttribute("aria-hidden") != "true" ||
        (node.className &&
          node.className.includes &&
          node.className.includes("fallback-image")))
    );
  },

  /**
   * Runs readability.
   *
   * Workflow:
   *  1. Prep the document by removing script tags, css, etc.
   *  2. Build readability's DOM tree.
   *  3. Grab the article content from the current dom tree.
   *  4. Replace the current DOM tree with the new one.
   *  5. Read peacefully.
   *
   * @return void
   **/
  parse() {
    // Avoid parsing too large documents, as per configuration option
    if (this._maxElemsToParse > 0) {
      var numTags = this._doc.getElementsByTagName("*").length;
      if (numTags > this._maxElemsToParse) {
        throw new Error(
          "Aborting parsing document; " + numTags + " elements found"
        );
      }
    }

    // Unwrap image from noscript
    this._unwrapNoscriptImages(this._doc);

    // Extract JSON-LD metadata before removing scripts
    var jsonLd = this._disableJSONLD ? {} : this._getJSONLD(this._doc);

    // Remove script tags from the document.
    this._removeScripts(this._doc);

    this._prepDocument();

    var metadata = this._getArticleMetadata(jsonLd);
    this._metadata = metadata;
    this._articleTitle = metadata.title;

    var articleContent = this._grabArticle();
    if (!articleContent) {
      return null;
    }

    this.log("Grabbed: " + articleContent.innerHTML);

    this._postProcessContent(articleContent);

    // If we haven't found an excerpt in the article's metadata, use the article's
    // first paragraph as the excerpt. This is used for displaying a preview of
    // the article's content.
    if (!metadata.excerpt) {
      var paragraphs = articleContent.getElementsByTagName("p");
      if (paragraphs.length) {
        metadata.excerpt = paragraphs[0].textContent.trim();
      }
    }

    var textContent = articleContent.textContent;
    return {
      title: this._articleTitle,
      byline: metadata.byline || this._articleByline,
      dir: this._articleDir,
      lang: this._articleLang,
      content: this._serializer(articleContent),
      textContent,
      length: textContent.length,
      excerpt: metadata.excerpt,
      siteName: metadata.siteName || this._articleSiteName,
      publishedTime: metadata.publishedTime,
    };
  },
};

if (true) {
  /* eslint-disable-next-line no-redeclare */
  /* global module */
  module.exports = Readability;
}


/***/ }),
/* 145 */
/***/ ((module) => {

/*
 * Copyright (c) 2010 Arc90 Inc
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * This code is heavily based on Arc90's readability.js (1.7.1) script
 * available at: http://code.google.com/p/arc90labs-readability
 */

var REGEXPS = {
  // NOTE: These two regular expressions are duplicated in
  // Readability.js. Please keep both copies in sync.
  unlikelyCandidates:
    /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
  okMaybeItsACandidate: /and|article|body|column|content|main|shadow/i,
};

function isNodeVisible(node) {
  // Have to null-check node.style and node.className.includes to deal with SVG and MathML nodes.
  return (
    (!node.style || node.style.display != "none") &&
    !node.hasAttribute("hidden") &&
    //check for "fallback-image" so that wikimedia math images are displayed
    (!node.hasAttribute("aria-hidden") ||
      node.getAttribute("aria-hidden") != "true" ||
      (node.className &&
        node.className.includes &&
        node.className.includes("fallback-image")))
  );
}

/**
 * Decides whether or not the document is reader-able without parsing the whole thing.
 * @param {Object} options Configuration object.
 * @param {number} [options.minContentLength=140] The minimum node content length used to decide if the document is readerable.
 * @param {number} [options.minScore=20] The minumum cumulated 'score' used to determine if the document is readerable.
 * @param {Function} [options.visibilityChecker=isNodeVisible] The function used to determine if a node is visible.
 * @return {boolean} Whether or not we suspect Readability.parse() will suceeed at returning an article object.
 */
function isProbablyReaderable(doc, options = {}) {
  // For backward compatibility reasons 'options' can either be a configuration object or the function used
  // to determine if a node is visible.
  if (typeof options == "function") {
    options = { visibilityChecker: options };
  }

  var defaultOptions = {
    minScore: 20,
    minContentLength: 140,
    visibilityChecker: isNodeVisible,
  };
  options = Object.assign(defaultOptions, options);

  var nodes = doc.querySelectorAll("p, pre, article");

  // Get <div> nodes which have <br> node(s) and append them into the `nodes` variable.
  // Some articles' DOM structures might look like
  // <div>
  //   Sentences<br>
  //   <br>
  //   Sentences<br>
  // </div>
  var brNodes = doc.querySelectorAll("div > br");
  if (brNodes.length) {
    var set = new Set(nodes);
    [].forEach.call(brNodes, function (node) {
      set.add(node.parentNode);
    });
    nodes = Array.from(set);
  }

  var score = 0;
  // This is a little cheeky, we use the accumulator 'score' to decide what to return from
  // this callback:
  return [].some.call(nodes, function (node) {
    if (!options.visibilityChecker(node)) {
      return false;
    }

    var matchString = node.className + " " + node.id;
    if (
      REGEXPS.unlikelyCandidates.test(matchString) &&
      !REGEXPS.okMaybeItsACandidate.test(matchString)
    ) {
      return false;
    }

    if (node.matches("li p")) {
      return false;
    }

    var textContentLength = node.textContent.trim().length;
    if (textContentLength < options.minContentLength) {
      return false;
    }

    score += Math.sqrt(textContentLength - options.minContentLength);

    if (score > options.minScore) {
      return true;
    }
    return false;
  });
}

if (true) {
  /* eslint-disable-next-line no-redeclare */
  /* global module */
  module.exports = isProbablyReaderable;
}


/***/ }),
/* 146 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MassReviewAction: () => (/* binding */ MassReviewAction)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(20);
/* harmony import */ var _shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(147);
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(4);
/* harmony import */ var _shared_messages_background_batch_review_command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(43);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(33);
/* harmony import */ var _flash_words__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(126);
/* harmony import */ var _keybind_manager__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(109);
/* harmony import */ var _registry__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(90);
/* harmony import */ var _review_cooldown__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(114);
/* harmony import */ var _transient_message__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(148);











const CONFIRM_WINDOW_MS = 1250;
// A second press sooner than this after the first is treated as accidental (key
// auto-repeat / typing) and re-arms the prompt instead of confirming.
const CONFIRM_MIN_DELAY_MS = 200;
/**
 * Page-global action that reviews all on-screen (viewport-visible) words as "good".
 * Triggered by a keybind (with optional double-press confirmation) or the status-bar button.
 */
class MassReviewAction {
    constructor() {
        this._keyManager = new _keybind_manager__WEBPACK_IMPORTED_MODULE_7__.KeybindManager(['massReviewKey'], undefined, () => this.canTrigger());
        this._disableReviews = false;
        this._includeNew = true;
        this._includeDue = true;
        this._includeYoung = false;
        this._includeMature = false;
        this._cooldownHours = 20;
        this._requireConfirm = true;
        this._keyDisplay = '';
        this._paused = false;
        this._pendingConfirmAt = 0;
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__.onBroadcastMessage)('configurationUpdated', () => void this.applyConfiguration(), true);
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__.onBroadcastMessage)('parsingPaused', (paused) => {
            this._paused = paused;
        });
        void (0,_shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_2__.getParsingPaused)().then((paused) => {
            this._paused = paused;
        });
        _registry__WEBPACK_IMPORTED_MODULE_8__.Registry.events.on('massReviewKey', () => void this.onKeybind());
        this._keyManager.activate();
    }
    /** Triggered by the status-bar button: always confirms through a modal. */
    async confirmViaDialog() {
        if (!this.canTrigger()) {
            return;
        }
        const candidates = await this.collectCandidates();
        if (candidates.length === 0) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('success', 'No words on screen to review.');
            return;
        }
        (0,_flash_words__WEBPACK_IMPORTED_MODULE_6__.setPendingHighlight)(candidates.map(({ element }) => element));
        const confirmed = await (0,_transient_message__WEBPACK_IMPORTED_MODULE_10__.showConfirmDialog)(`Review ${candidates.length} ${MassReviewAction.pluralise(candidates.length)} on screen as good?`);
        if (confirmed) {
            await this.execute(candidates);
        }
        else {
            (0,_flash_words__WEBPACK_IMPORTED_MODULE_6__.clearPendingHighlight)();
        }
    }
    /**
     * The keybind is only captured (and the action runnable) when reviews are enabled, parsing
     * isn't paused, and the page has actually been parsed (i.e. parsed word elements exist).
     * Otherwise the key is left untouched so it passes through for normal use rather than being
     * silently swallowed — a present-but-idle parser (e.g. a trigger parser before manual parsing,
     * or a host not covered by metadata) must not hijack the key.
     */
    canTrigger() {
        if (this._disableReviews || this._paused) {
            return false;
        }
        return document.querySelector('.jiten-word[wordId][readingIndex]') !== null;
    }
    async onKeybind() {
        if (this._disableReviews) {
            return;
        }
        const candidates = await this.collectCandidates();
        if (candidates.length === 0) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('success', 'No words on screen to review.');
            this.clearPendingConfirm();
            return;
        }
        if (!this._requireConfirm) {
            await this.execute(candidates);
            return;
        }
        const now = Date.now();
        // Only a deliberate second press — after the minimum delay and within the window —
        // confirms; faster repeats just re-arm the prompt.
        if (this._confirmTimer !== undefined && now - this._pendingConfirmAt >= CONFIRM_MIN_DELAY_MS) {
            this.clearPendingConfirm();
            await this.execute(candidates);
            return;
        }
        this.armConfirm(candidates, now);
    }
    armConfirm(candidates, now) {
        this._pendingConfirmAt = now;
        (0,_flash_words__WEBPACK_IMPORTED_MODULE_6__.setPendingHighlight)(candidates.map(({ element }) => element));
        const count = candidates.length;
        const prompt = this._keyDisplay ? `Press ${this._keyDisplay} again` : 'Press again';
        (0,_transient_message__WEBPACK_IMPORTED_MODULE_10__.showTransientMessage)(`${prompt} to review ${count} ${MassReviewAction.pluralise(count)}`);
        if (this._confirmTimer) {
            clearTimeout(this._confirmTimer);
        }
        this._confirmTimer = setTimeout(() => {
            this._confirmTimer = undefined;
            (0,_flash_words__WEBPACK_IMPORTED_MODULE_6__.clearPendingHighlight)();
        }, CONFIRM_WINDOW_MS);
    }
    clearPendingConfirm() {
        (0,_flash_words__WEBPACK_IMPORTED_MODULE_6__.clearPendingHighlight)();
        if (this._confirmTimer) {
            clearTimeout(this._confirmTimer);
            this._confirmTimer = undefined;
        }
    }
    async collectCandidates() {
        const seen = new Set();
        const candidates = [];
        const elements = document.querySelectorAll('.jiten-word[wordId][readingIndex]');
        for (const element of elements) {
            if (!MassReviewAction.isInViewport(element)) {
                continue;
            }
            const card = _registry__WEBPACK_IMPORTED_MODULE_8__.Registry.getCardFromElement(element);
            if (!card) {
                continue;
            }
            const key = `${card.wordId}/${card.readingIndex}`;
            if (seen.has(key) || !this.shouldReview(card)) {
                continue;
            }
            if (await _review_cooldown__WEBPACK_IMPORTED_MODULE_9__.ReviewCooldown.isCoolingDown(card.wordId, card.readingIndex, this._cooldownHours)) {
                continue;
            }
            seen.add(key);
            candidates.push({ element, card });
        }
        return candidates;
    }
    shouldReview(card) {
        const states = card.cardState;
        if (states.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_3__.JitenCardState.REDUNDANT) ||
            states.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_3__.JitenCardState.MASTERED) ||
            states.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_3__.JitenCardState.BLACKLISTED)) {
            return false;
        }
        if (_registry__WEBPACK_IMPORTED_MODULE_8__.Registry.isSessionTouched(card.wordId, card.readingIndex)) {
            return false;
        }
        // States are not mutually exclusive (a word can be both due and young), so any
        // enabled matching state qualifies it.
        return ((this._includeDue && states.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_3__.JitenCardState.DUE)) ||
            (this._includeNew && states.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_3__.JitenCardState.NEW)) ||
            (this._includeYoung && states.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_3__.JitenCardState.YOUNG)) ||
            (this._includeMature && states.includes(_shared_jiten_types__WEBPACK_IMPORTED_MODULE_3__.JitenCardState.MATURE)));
    }
    async execute(candidates) {
        (0,_flash_words__WEBPACK_IMPORTED_MODULE_6__.clearPendingHighlight)();
        const items = candidates.map(({ card }) => ({
            wordId: card.wordId,
            readingIndex: card.readingIndex,
            rating: 'good',
        }));
        try {
            const result = await new _shared_messages_background_batch_review_command__WEBPACK_IMPORTED_MODULE_4__.BatchReviewCommand(items).call();
            if (!result?.success) {
                (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('error', 'Failed to review words on screen.');
                return;
            }
            await _review_cooldown__WEBPACK_IMPORTED_MODULE_9__.ReviewCooldown.mark(candidates.map(({ card }) => ({ wordId: card.wordId, readingIndex: card.readingIndex })), this._cooldownHours);
            (0,_flash_words__WEBPACK_IMPORTED_MODULE_6__.flashElements)(candidates.map(({ element }) => element), 'good');
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('success', `Reviewed ${result.processed} ${MassReviewAction.pluralise(result.processed)} as good.`);
        }
        catch {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_1__.displayToast)('error', 'Failed to review words on screen.');
        }
    }
    async applyConfiguration() {
        this._disableReviews = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenDisableReviews');
        this._includeNew = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('massReviewNew');
        this._includeDue = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('massReviewDue');
        this._includeYoung = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('massReviewYoung');
        this._includeMature = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('massReviewMature');
        this._cooldownHours = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('massReviewCooldownHours');
        this._requireConfirm = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('massReviewRequireConfirm');
        this._keyDisplay = MassReviewAction.formatKeybind(await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('massReviewKey'));
    }
    static formatKeybind(keybinds) {
        const first = Array.isArray(keybinds)
            ? keybinds.find((candidate) => candidate?.code)
            : keybinds.code
                ? keybinds
                : undefined;
        if (!first) {
            return '';
        }
        return [...first.modifiers, first.key || first.code].join(' + ');
    }
    static isInViewport(element) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            return false;
        }
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        return (rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth);
    }
    static pluralise(count) {
        return count === 1 ? 'word' : 'words';
    }
}


/***/ }),
/* 147 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getParsingPaused: () => (/* binding */ getParsingPaused)
/* harmony export */ });
const getParsingPaused = async () => {
    const result = await chrome.storage.local.get('parsingPaused');
    return result.parsingPaused ?? false;
};


/***/ }),
/* 148 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   showConfirmDialog: () => (/* binding */ showConfirmDialog),
/* harmony export */   showTransientMessage: () => (/* binding */ showTransientMessage)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(25);


const CONTAINER_ID = 'ajb-overlay-container';
const Z_INDEX = '2147483647';
function getOverlayRoot() {
    const existing = (0,_shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__.findElement)(`#${CONTAINER_ID}`)?.shadowRoot;
    if (existing) {
        return existing;
    }
    const host = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', { id: CONTAINER_ID, style: { all: 'initial' } });
    const root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    return root;
}
let activeMessage;
/**
 * Shows a centred, translucent, auto-dismissing message. Used for the
 * "press again to review" confirmation hint.
 */
function showTransientMessage(text, durationMs = 1600) {
    const root = getOverlayRoot();
    if (activeMessage) {
        clearTimeout(activeMessage.timer);
        activeMessage.element.remove();
        activeMessage = undefined;
    }
    const element = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
        innerText: text,
        style: {
            position: 'fixed',
            top: '20%',
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: '80vw',
            padding: '10px 18px',
            borderRadius: '8px',
            background: 'rgba(0, 0, 0, 0.82)',
            color: '#ffffff',
            fontFamily: 'sans-serif',
            fontSize: '15px',
            textAlign: 'center',
            pointerEvents: 'none',
            opacity: '0',
            transition: 'opacity 0.2s ease',
            zIndex: Z_INDEX,
        },
    });
    root.appendChild(element);
    requestAnimationFrame(() => (element.style.opacity = '1'));
    const timer = setTimeout(() => {
        element.style.opacity = '0';
        setTimeout(() => element.remove(), 250);
        activeMessage = undefined;
    }, durationMs);
    activeMessage = { element, timer };
}
/**
 * Shows a centred Yes/Cancel modal and resolves with the user's choice.
 */
function showConfirmDialog(text, confirmLabel = 'Review', cancelLabel = 'Cancel') {
    return new Promise((resolve) => {
        const root = getOverlayRoot();
        let settled = false;
        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            window.removeEventListener('keydown', onKeydown, true);
            backdrop.remove();
            resolve(result);
        };
        const onKeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
            }
        };
        const message = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            innerText: text,
            style: { color: '#ffffff', fontSize: '15px', lineHeight: '1.4', marginBottom: '16px' },
        });
        const cancelButton = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('button', {
            innerText: cancelLabel,
            handler: () => finish(false),
            style: {
                padding: '6px 14px',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.3)',
                background: 'transparent',
                color: '#ffffff',
                cursor: 'pointer',
                fontSize: '14px',
            },
        });
        const confirmButton = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('button', {
            innerText: confirmLabel,
            handler: () => finish(true),
            style: {
                padding: '6px 14px',
                borderRadius: '6px',
                border: 'none',
                background: '#4caf50',
                color: '#ffffff',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '600',
            },
        });
        const buttons = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            style: { display: 'flex', justifyContent: 'flex-end', gap: '10px' },
            children: [cancelButton, confirmButton],
        });
        const dialog = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            style: {
                maxWidth: 'min(420px, 86vw)',
                padding: '20px',
                borderRadius: '10px',
                background: '#222222',
                boxShadow: '0 8px 30px rgba(0, 0, 0, 0.5)',
                fontFamily: 'sans-serif',
            },
            children: [message, buttons],
        });
        const backdrop = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__.createElement)('div', {
            handler: (event) => {
                if (event?.target === backdrop) {
                    finish(false);
                }
            },
            style: {
                position: 'fixed',
                inset: '0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.45)',
                zIndex: Z_INDEX,
            },
            children: [dialog],
        });
        root.appendChild(backdrop);
        window.addEventListener('keydown', onKeydown, true);
    });
}


/***/ }),
/* 149 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AutomaticParser: () => (/* binding */ AutomaticParser)
/* harmony export */ });
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(134);
/* harmony import */ var _shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(147);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(33);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(90);
/* harmony import */ var _base_parser__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(150);





class AutomaticParser extends _base_parser__WEBPACK_IMPORTED_MODULE_4__.BaseParser {
    constructor(meta) {
        super(meta);
        this._disposers.push((0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_2__.onBroadcastMessage)('parsingPaused', (paused) => {
            if (paused) {
                this.disconnectObservers();
            }
            else {
                this.reconnectObservers();
            }
        }));
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
    destroy() {
        this.disconnectObservers();
        super.destroy();
    }
    startParsing() {
        if (this._destroyed) {
            return;
        }
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
        if (this._lazyDetectTimer !== undefined) {
            clearTimeout(this._lazyDetectTimer);
            this._lazyDetectTimer = undefined;
        }
    }
    reconnectObservers() {
        if (this._destroyed) {
            return;
        }
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('AutomaticParser: Reconnecting observers after unpause');
        this.startParsing();
    }
    init() {
        /* NOP */
    }
    /** Sets up a `getParseVisibleObserver (IntersectionObserver)` for the page */
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
    /**
     * Sets up a `getAddedObserver (MutationObserver)` for the page.
     *
     * If a `visibleObserver` is set, the elements that are added will be observed.
     * If not, the elements will be parsed immediately.
     */
    setupAddedObserver() {
        if (this._meta.addedObserver.lazy) {
            this.pollForLazyTarget();
            return;
        }
        this.installFullAddedObserver();
    }
    /**
     * The callback to call when nodes are added in @see setupAddedObserver
     *
     * @param {HTMLElement[]} nodes The added nodes
     * @returns {void}
     */
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
    installFullAddedObserver() {
        this._addedObserver = this.getAddedObserver(this._meta.addedObserver.observeFrom ?? 'body', this._meta.addedObserver.notifyFor, this._meta.addedObserver.checkNested, this._meta.addedObserver.config ?? { childList: true, subtree: true }, (nodes) => this.addedObserverCallback(nodes), (nodes) => this.removedObserverCallback(nodes));
    }
    pollForLazyTarget() {
        const selector = this._meta.addedObserver.notifyFor;
        const check = () => {
            if (this._destroyed) {
                return;
            }
            const found = document.querySelector(selector);
            if (found) {
                (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('AutomaticParser: Lazy target detected, installing full observer');
                this._lazyDetectTimer = undefined;
                this.installFullAddedObserver();
                return;
            }
            this._lazyDetectTimer = setTimeout(check, 2000);
        };
        check();
    }
}


/***/ }),
/* 150 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BaseParser: () => (/* binding */ BaseParser)
/* harmony export */ });
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(134);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(21);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(90);
/* harmony import */ var _text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(129);




class BaseParser {
    /** The root element to parse */
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
    /** @param {HostMeta} _meta The host meta */
    constructor(_meta) {
        this._meta = _meta;
        this._destroyed = false;
        this._hasInjectedClass = false;
        this._nodeRemovalObservers = [];
        this._disposers = [];
    }
    destroy() {
        this._destroyed = true;
        this._nodeRemovalObservers.forEach((observer) => observer.disconnect());
        this._nodeRemovalObservers = [];
        this._disposers.forEach((dispose) => dispose());
        this._disposers = [];
    }
    /**
     * Parse the currently selected text
     *
     * @returns {void}
     */
    parseSelection() {
        const selection = window.getSelection();
        const range = selection.getRangeAt(0);
        this.parseNode(range.commonAncestorContainer, (node) => range.intersectsNode(node) && this.filter(node));
    }
    /**
     * Parse the entire page based on the specified root element
     *
     * @returns {void}
     */
    parsePage() {
        const { root } = this;
        if (!root) {
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('parsePage: No root element found, aborting parsing');
            return;
        }
        this.parseNode(root, this.filter);
    }
    /**
     * Parse a given node
     *
     * @param {Node | Element} node A Node or Element to parse
     * @param {(node: Node | Element) => boolean} filter A filter for the nodes childnodes. Childnodes that do not pass the filter will not be parsed
     */
    parseNode(node, filter) {
        this.parseNodes([node], filter);
    }
    /**
     * Parse a list of nodes
     *
     * @param {(Node | Element)[]} nodes A list of nodes to parse
     * @param {(node: Node | Element) => boolean} filter A filter for the nodes childnodes. Childnodes that do not pass the filter will not be parsed
     */
    parseNodes(nodes, filter) {
        if (this._destroyed) {
            return;
        }
        this.installAppStyles();
        const { batchController } = _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry;
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('parseNodes called with nodes:', nodes, 'filter:', filter);
        batchController.registerNodes(nodes, {
            filter,
            collapseWhitespace: this._meta.collapseWhitespace,
        });
        batchController.parseBatches();
    }
    /**
     * Gets a MutationObserver that observes for added nodes. When a node is added, the callback is called with the added nodes.
     * Also, the callback is called with the initial nodes that match the notifyFor selector.
     *
     * Used to parse elements that are only available after a certain event or when new text is added in intervals.
     *
     * @param {string | string[]} observeFrom The root element to observe from. If an array is provided, the first element that matches is used.
     * @param {string} notifyFor The selector to match the added nodes against
     * @param {string} checkNested If added elements match `checkNested`, check if they contain nested elements matching the `notifyFor` selector.
     * @param {MutationObserverInit} config The mutation observer configuration
     * @param {(nodes: HTMLElement[]) => void} onAdded The callback to call when nodes are added.
     * @param {(nodes: HTMLElement[]) => void} onRemoved The callback to call when nodes are removed.
     * @returns {MutationObserver}
     */
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
                    // If an element is a Breader token, it should be ignored
                    if (isBreaderToken) {
                        return false;
                    }
                    // Fetch direct matches
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
                // If we used checkNested, the found items may be nestend somewhere we dont want to parse directly - filter them out
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
                            this._nodeRemovalObservers = this._nodeRemovalObservers.filter((o) => o !== observer);
                        }
                    });
                });
            });
            if (node.parentNode) {
                observer.observe(node.parentNode, { childList: true });
                this._nodeRemovalObservers.push(observer);
            }
        });
    }
    /**
     * Gets an IntersectionObserver that observes for elements that are visible in the viewport.
     * When an element is visible, the onEnter callback is called with the visible elements.
     * When an element is not visible, the onExit callback is called with the not visible elements.
     *
     * Used to parse elements that may become visible at a later point in time, for example when scrolling.
     * Unlike the getParseVisibleObserver method, this method does not parse the visible elements, only notifies when they are visible.
     *
     * @param {(elements: Element[]) => void} onEnter The callback to call when elements are visible
     * @param {(elements: Element[]) => void} onExit The callback to call when elements are not visible
     * @returns {IntersectionObserver}
     */
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
    /**
     * Gets an IntersectionObserver that observes for elements that become visible in the viewport and parses them.
     *
     * Used to parse elements that may become visible at a later point in time, for example when scrolling.
     * Unlike the getVisibleObserver method, this method also parses the visible elements.
     *
     * @param {(node: HTMLElement | Text) => boolean} filter A filter for the now visible nodes childnodes. Childnodes that do not pass the filter will not be parsed
     * @returns {IntersectionObserver}
     */
    getParseVisibleObserver(filter) {
        const observer = this.getVisibleObserver((elements) => this.visibleObserverOnEnter(elements, observer, filter), (elements) => this.visibleObserverOnExit(elements, observer));
        return observer;
    }
    /**
     * Called when an item becomes visible in the viewport
     * Used as callback for the `getParseVisibleObserver` method
     *
     * Registers the items in the batch controller and parses them
     *
     * @param {Element[]} elements The element changes
     * @param {IntersectionObserver} observer The observer instance
     * @param {(node: HTMLElement | Text) => boolean} filter A filter function to filter the childnodes of the elements
     */
    visibleObserverOnEnter(elements, observer, filter) {
        const { batchController } = _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry;
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('visibleObserverOnEnter', elements);
        this.installAppStyles();
        batchController.registerNodes(elements, {
            filter,
            onEmpty: (e) => e instanceof Element && observer.unobserve(e),
            getParagraphsFn: this.getParagraphsFn,
            collapseWhitespace: this._meta.collapseWhitespace,
        });
        batchController.parseBatches();
    }
    /**
     * Called when an item is no longer visible in the viewport
     * Used as callback for the `getParseVisibleObserver` method
     *
     * Dismisses the items from the batch controller
     *
     * @param {Element[]} elements The element changes
     * @param {IntersectionObserver} _observer The observer instance
     */
    visibleObserverOnExit(elements, _observer) {
        const { batchController } = _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry;
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
        if (!document.querySelector('link[data-jiten-style="word"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_1__.getStyleUrl)('word');
            link.setAttribute('data-jiten-style', 'word');
            document.head.appendChild(link);
        }
        if (!(0,_text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_3__.hasWordStyles)()) {
            void (0,_text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_3__.applyWordStyles)();
        }
    }
    pascalCaseToKebabCase(str) {
        return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    }
}


/***/ }),
/* 151 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getCustomParser: () => (/* binding */ getCustomParser)
/* harmony export */ });
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(134);
/* harmony import */ var _custom_parsers_aozora_parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(152);
/* harmony import */ var _custom_parsers_bunpro_parser__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(153);
/* harmony import */ var _custom_parsers_ex_static_parser__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(154);
/* harmony import */ var _custom_parsers_manatan_manga_parser__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(155);
/* harmony import */ var _custom_parsers_mokuro_legacy_parser__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(158);
/* harmony import */ var _custom_parsers_mokuro_parser__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(160);
/* harmony import */ var _custom_parsers_readwok_parser__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(161);
/* harmony import */ var _custom_parsers_satori_reader_parser__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(162);
/* harmony import */ var _custom_parsers_ttsu_parser__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(166);
/* harmony import */ var _custom_parsers_yatsu_parser__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(169);











const getCustomParser = (name, meta) => {
    const parsers = {
        AozoraParser: _custom_parsers_aozora_parser__WEBPACK_IMPORTED_MODULE_1__.AozoraParser,
        BunproParser: _custom_parsers_bunpro_parser__WEBPACK_IMPORTED_MODULE_2__.BunproParser,
        ManatanMangaParser: _custom_parsers_manatan_manga_parser__WEBPACK_IMPORTED_MODULE_4__.ManatanMangaParser,
        MokuroParser: _custom_parsers_mokuro_parser__WEBPACK_IMPORTED_MODULE_6__.MokuroParser,
        MokuroLegacyParser: _custom_parsers_mokuro_legacy_parser__WEBPACK_IMPORTED_MODULE_5__.MokuroLegacyParser,
        ReadwokParser: _custom_parsers_readwok_parser__WEBPACK_IMPORTED_MODULE_7__.ReadwokParser,
        TtsuParser: _custom_parsers_ttsu_parser__WEBPACK_IMPORTED_MODULE_9__.TtsuParser,
        YatsuParser: _custom_parsers_yatsu_parser__WEBPACK_IMPORTED_MODULE_10__.YatsuParser,
        ExStaticParser: _custom_parsers_ex_static_parser__WEBPACK_IMPORTED_MODULE_3__.ExStaticParser,
        SatoriReaderParser: _custom_parsers_satori_reader_parser__WEBPACK_IMPORTED_MODULE_8__.SatoriReaderParser,
    };
    const parser = parsers[name];
    (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)(`getCustomParser called with name: ${name}`, 'meta:', meta);
    return new parser(meta);
};


/***/ }),
/* 152 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AozoraParser: () => (/* binding */ AozoraParser)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(90);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(149);


class AozoraParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_1__.AutomaticParser {
    init() {
        const mainText = document.querySelector('.main_text');
        if (!mainText) {
            return;
        }
        this.installAppStyles();
        this.parseSections(mainText);
    }
    parseSections(mainText) {
        let currentWrapper = null;
        for (const child of Array.from(mainText.childNodes)) {
            const isDiv = child instanceof HTMLDivElement;
            if (child instanceof HTMLBRElement || isDiv) {
                this.registerWrapper(currentWrapper);
                currentWrapper = null;
                if (isDiv && child.textContent?.trim()) {
                    _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.registerNode(child, { filter: this.filter });
                }
                continue;
            }
            if (child instanceof Text && !child.data.trim()) {
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
        this.registerWrapper(currentWrapper);
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.parseBatches();
    }
    registerWrapper(wrapper) {
        if (wrapper?.textContent?.trim()) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.registerNode(wrapper, { filter: this.filter });
        }
    }
}


/***/ }),
/* 153 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BunproParser: () => (/* binding */ BunproParser)
/* harmony export */ });
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(149);

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
/* 154 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ExStaticParser: () => (/* binding */ ExStaticParser)
/* harmony export */ });
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(149);

class ExStaticParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_0__.AutomaticParser {
    /**
     * Gets a MutationObserver that observes for added nodes. When a node is added, the callback is called with the added nodes.
     * Also, the callback is called with the initial nodes that match the notifyFor selector.
     *
     * Used to parse elements that are only available after a certain event or when new text is added in intervals.
     *
     * @param {string | string[]} observeFrom The root element to observe from. If an array is provided, the first element that matches is used.
     * @param {string} notifyFor The selector to match the added nodes against
     * @param {string} checkNested If added elements match `checkNested`, check if they contain nested elements matching the `notifyFor` selector.
     * @param {MutationObserverInit} config The mutation observer configuration
     * @param {(nodes: HTMLElement[]) => void} onAdded The callback to call when nodes are added.
     * @returns {MutationObserver}
     */
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
/* 155 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ManatanMangaParser: () => (/* binding */ ManatanMangaParser)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_extension_get_url__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(17);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(90);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(149);
/* harmony import */ var _manatan_manga_get_manatan_manga_paragraphs__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(156);
/* harmony import */ var _manatan_manga_manatan_manga_apply_tokens__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(157);






class ManatanMangaParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_3__.AutomaticParser {
    constructor() {
        super(...arguments);
        this._textObservers = new Map();
        this._debounceTimers = new Map();
        this._popupKeybinds = [];
        this._pressedCodes = new Set();
        this._keyboardPassThrough = false;
        this._middleClickPassThrough = false;
    }
    destroy() {
        if (this._keydownHandler) {
            document.removeEventListener('keydown', this._keydownHandler);
        }
        if (this._keyupHandler) {
            document.removeEventListener('keyup', this._keyupHandler);
        }
        if (this._mousedownHandler) {
            document.removeEventListener('mousedown', this._mousedownHandler, true);
        }
        if (this._mouseupHandler) {
            document.removeEventListener('mouseup', this._mouseupHandler, true);
        }
        if (this._auxclickHandler) {
            document.removeEventListener('auxclick', this._auxclickHandler, true);
        }
        if (this._blurHandler) {
            window.removeEventListener('blur', this._blurHandler);
        }
        if (this._visibilityHandler) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
        }
        document.body.classList.remove(ManatanMangaParser.YOMITAN_PASS_THROUGH_CLASS);
        this._pressedCodes.clear();
        this._keyboardPassThrough = false;
        this._middleClickPassThrough = false;
        this.sendMainWorldPatchControl('uninstall');
        this._textObservers.forEach((obs) => obs.disconnect());
        this._textObservers.clear();
        this._debounceTimers.forEach((t) => clearTimeout(t));
        this._debounceTimers.clear();
        super.destroy();
    }
    init() {
        _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.sentenceManager.disable();
        this.installMainWorldCaretPatch();
        this.setupYomitanPassThroughToggle();
        void this.loadPopupKeybinds();
    }
    setupVisibleObserver() {
        this._visibleObserver = this.getParseVisibleObserver();
    }
    visibleObserverOnEnter(elements) {
        let registered = false;
        for (const element of elements) {
            const box = element;
            if (box.hasAttribute('data-jiten-parsed')) {
                continue;
            }
            this.watchTextChanges(box);
            this.registerBox(box);
            registered = true;
        }
        if (registered) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.batchController.parseBatches();
            this.installAppStyles();
        }
    }
    visibleObserverOnExit(elements) {
        for (const element of elements) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.batchController.dismissNode(element);
        }
    }
    addedObserverCallback(elements) {
        for (const element of elements) {
            this._visibleObserver?.observe(element);
        }
    }
    installMainWorldCaretPatch() {
        const existing = document.getElementById(ManatanMangaParser.MAIN_WORLD_SCRIPT_ID);
        if (existing) {
            this.sendMainWorldPatchControl('install');
            return;
        }
        const script = document.createElement('script');
        script.id = ManatanMangaParser.MAIN_WORLD_SCRIPT_ID;
        script.src = (0,_shared_extension_get_url__WEBPACK_IMPORTED_MODULE_1__.getURL)('assets/manatan-main-world-caret-patch.js');
        script.onload = () => {
            script.remove();
            this.sendMainWorldPatchControl('install');
        };
        script.onerror = () => {
            script.remove();
        };
        (document.head || document.documentElement).appendChild(script);
    }
    setupYomitanPassThroughToggle() {
        this._keydownHandler = (event) => {
            this._pressedCodes.add(event.code);
            this.updateKeyboardPassThrough();
        };
        this._keyupHandler = (event) => {
            this._pressedCodes.delete(event.code);
            this.updateKeyboardPassThrough();
        };
        this._mousedownHandler = (event) => {
            if (event.button === 1) {
                this._middleClickPassThrough = true;
                this.syncPassThroughClass();
            }
        };
        const releaseMiddlePassThrough = () => {
            this._middleClickPassThrough = false;
            this.syncPassThroughClass();
        };
        this._mouseupHandler = (event) => {
            if (event.button === 1) {
                setTimeout(releaseMiddlePassThrough, 0);
            }
        };
        this._auxclickHandler = (event) => {
            if (event.button === 1) {
                setTimeout(releaseMiddlePassThrough, 0);
            }
        };
        this._blurHandler = () => {
            this._pressedCodes.clear();
            this._keyboardPassThrough = false;
            this._middleClickPassThrough = false;
            this.syncPassThroughClass();
        };
        this._visibilityHandler = () => {
            if (document.visibilityState !== 'visible') {
                this._pressedCodes.clear();
                this._keyboardPassThrough = false;
                this._middleClickPassThrough = false;
                this.syncPassThroughClass();
            }
        };
        document.addEventListener('keydown', this._keydownHandler);
        document.addEventListener('keyup', this._keyupHandler);
        document.addEventListener('mousedown', this._mousedownHandler, true);
        document.addEventListener('mouseup', this._mouseupHandler, true);
        document.addEventListener('auxclick', this._auxclickHandler, true);
        window.addEventListener('blur', this._blurHandler);
        document.addEventListener('visibilitychange', this._visibilityHandler);
    }
    async loadPopupKeybinds() {
        const raw = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('showPopupKey');
        this._popupKeybinds = (Array.isArray(raw) ? raw.filter((v) => v?.code) : raw?.code ? [raw] : []);
        this.updateKeyboardPassThrough();
    }
    updateKeyboardPassThrough() {
        this._keyboardPassThrough =
            this._pressedCodes.size > 0 && !this.matchesShowPopupKeyFromPressedState();
        this.syncPassThroughClass();
    }
    matchesShowPopupKeyFromPressedState() {
        return this._popupKeybinds.some((keybind) => this.matchesKeybindFromPressedState(keybind));
    }
    matchesKeybindFromPressedState(keybind) {
        if (!keybind?.code) {
            return false;
        }
        const required = [...keybind.modifiers, this.mapCodeToState(keybind.code)].filter(Boolean);
        return required.length > 0 && required.every((state) => this.isStatePressed(state));
    }
    isStatePressed(state) {
        switch (state) {
            case 'Shift':
                return this._pressedCodes.has('ShiftLeft') || this._pressedCodes.has('ShiftRight');
            case 'Control':
                return this._pressedCodes.has('ControlLeft') || this._pressedCodes.has('ControlRight');
            case 'Alt':
                return this._pressedCodes.has('AltLeft') || this._pressedCodes.has('AltRight');
            case 'Meta':
                return this._pressedCodes.has('MetaLeft') || this._pressedCodes.has('MetaRight');
            default:
                return this._pressedCodes.has(state);
        }
    }
    mapCodeToState(code) {
        return ManatanMangaParser.MODIFIER_CODE_MAP[code] ?? code;
    }
    syncPassThroughClass() {
        const passThrough = this._keyboardPassThrough || this._middleClickPassThrough;
        document.body.classList.toggle(ManatanMangaParser.YOMITAN_PASS_THROUGH_CLASS, passThrough);
    }
    sendMainWorldPatchControl(action) {
        window.dispatchEvent(new CustomEvent(ManatanMangaParser.MAIN_WORLD_CONTROL_EVENT, {
            detail: { action },
        }));
    }
    registerBox(box) {
        _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.batchController.registerNode(box, {
            getParagraphsFn: _manatan_manga_get_manatan_manga_paragraphs__WEBPACK_IMPORTED_MODULE_4__.getManatanMangaParagraphs,
            applyFn: (paragraph, tokens) => {
                (0,_manatan_manga_manatan_manga_apply_tokens__WEBPACK_IMPORTED_MODULE_5__.manatanMangaApplyTokens)(paragraph, tokens);
            },
        });
    }
    watchTextChanges(box) {
        if (this._textObservers.has(box)) {
            return;
        }
        const observer = new MutationObserver((mutations) => {
            const isOverlayChange = mutations.every((m) => {
                if (m.type !== 'childList') {
                    return false;
                }
                const nodes = [...m.addedNodes, ...m.removedNodes];
                return (nodes.length > 0 &&
                    nodes.every((n) => n instanceof HTMLElement && n.classList.contains('jiten-manatan-overlay')));
            });
            if (isOverlayChange) {
                return;
            }
            const existing = this._debounceTimers.get(box);
            if (existing) {
                clearTimeout(existing);
            }
            this._debounceTimers.set(box, setTimeout(() => {
                this._debounceTimers.delete(box);
                this.reparseTextBox(box);
            }, 300));
        });
        observer.observe(box, {
            characterData: true,
            childList: true,
            subtree: true,
        });
        this._textObservers.set(box, observer);
    }
    reparseTextBox(box) {
        box.querySelector('.jiten-manatan-overlay')?.remove();
        box.removeAttribute('data-jiten-parsed');
        _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.batchController.dismissNode(box);
        this.registerBox(box);
        _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.batchController.parseBatches();
    }
}
ManatanMangaParser.MAIN_WORLD_CONTROL_EVENT = 'jiten:manatan-caret-patch-control';
ManatanMangaParser.MAIN_WORLD_SCRIPT_ID = 'jiten-manatan-main-world-caret-patch';
ManatanMangaParser.YOMITAN_PASS_THROUGH_CLASS = 'jiten-manatan-pass-through';
ManatanMangaParser.MODIFIER_CODE_MAP = {
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    ControlLeft: 'Control',
    ControlRight: 'Control',
    AltLeft: 'Alt',
    AltRight: 'Alt',
    MetaLeft: 'Meta',
    MetaRight: 'Meta',
};


/***/ }),
/* 156 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getManatanMangaParagraphs: () => (/* binding */ getManatanMangaParagraphs)
/* harmony export */ });
const getManatanMangaParagraphs = (node) => {
    const el = node;
    const boxes = el.classList?.contains('gemini-ocr-text-box')
        ? [el]
        : [...el.querySelectorAll('.gemini-ocr-text-box')];
    return boxes
        .filter((box) => !box.hasAttribute('data-jiten-parsed'))
        .map((box) => {
        const textNode = [...box.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        if (!textNode?.data?.length) {
            return [];
        }
        return [
            {
                node: textNode,
                start: 0,
                end: textNode.length,
                length: textNode.length,
                hasRuby: false,
            },
        ];
    })
        .filter((p) => p.length > 0);
};


/***/ }),
/* 157 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   manatanMangaApplyTokens: () => (/* binding */ manatanMangaApplyTokens)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(90);

let statsUpdateTimeout;
const manatanMangaApplyTokens = (fragments, tokens) => {
    if (!fragments.length) {
        return;
    }
    const fragment = fragments[0];
    const textNode = fragment.node;
    const box = textNode.parentElement;
    if (!box) {
        return;
    }
    box.querySelector('.jiten-manatan-overlay')?.remove();
    box.setAttribute('data-jiten-parsed', '');
    const overlay = document.createElement('div');
    overlay.className = 'jiten-manatan-overlay';
    const fullText = textNode.data;
    let cursor = fragment.start;
    const sortedTokens = [...tokens].sort((a, b) => a.start - b.start);
    for (const token of sortedTokens) {
        const tokenStart = token.start - fragment.start;
        const tokenEnd = token.end - fragment.start;
        if (tokenStart > cursor - fragment.start) {
            appendUnparsedSpan(overlay, fullText.substring(cursor - fragment.start, tokenStart));
        }
        const span = createTokenSpan(token, fullText.substring(tokenStart, tokenEnd));
        overlay.appendChild(span);
        cursor = token.end;
    }
    if (cursor - fragment.start < fullText.length) {
        appendUnparsedSpan(overlay, fullText.substring(cursor - fragment.start));
    }
    box.appendChild(overlay);
    if (statsUpdateTimeout) {
        clearTimeout(statsUpdateTimeout);
    }
    statsUpdateTimeout = window.setTimeout(() => {
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.statusBar?.recalculateStats();
        statsUpdateTimeout = undefined;
    }, 100);
};
const createTokenSpan = (token, text) => {
    const { markFrequency, markAll, generatePitch, markIPlus1, newStates } = _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.textHighlighterOptions;
    const { card, pitchClass, sentence, conjugations } = token;
    const span = document.createElement('span');
    span.setAttribute('ajb', 'true');
    span.setAttribute('data-text', text);
    if (card) {
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.addCard(card, span, conjugations);
        span.classList.add('jiten-word', ...card.cardState);
        if (markFrequency && card.frequencyRank <= markFrequency) {
            const isNew = card.cardState.some((s) => newStates.includes(s));
            if (markAll || isNew) {
                span.classList.add('frequent');
            }
        }
        if (pitchClass && generatePitch) {
            span.classList.add(pitchClass);
        }
        span.setAttribute('wordId', card.wordId.toString());
        span.setAttribute('readingIndex', card.readingIndex.toString());
        if (markIPlus1) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.sentenceManager.addElement(span, token);
        }
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.wordEventDelegator.setSentence(span, sentence);
    }
    else {
        span.classList.add('jiten-word', 'unparsed');
    }
    return span;
};
const appendUnparsedSpan = (parent, text) => {
    if (!text) {
        return;
    }
    const span = document.createElement('span');
    span.className = 'jiten-word unparsed';
    span.setAttribute('ajb', 'true');
    span.setAttribute('data-text', text);
    parent.appendChild(span);
};


/***/ }),
/* 158 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MokuroLegacyParser: () => (/* binding */ MokuroLegacyParser)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(90);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(149);
/* harmony import */ var _mokuro_get_mokuro_paragraphs__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(159);



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
/* 159 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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
/* 160 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MokuroParser: () => (/* binding */ MokuroParser)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(90);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(149);
/* harmony import */ var _mokuro_get_mokuro_paragraphs__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(159);



class MokuroParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_1__.AutomaticParser {
    constructor() {
        super(...arguments);
        this._trackedRoots = new Set();
        this._visibleRoots = new Set();
    }
    destroy() {
        clearTimeout(this._debounceTimeout);
        this._rootObserver?.disconnect();
        this._trackedRoots.forEach((root) => _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.dismissNode(root));
        this._trackedRoots.clear();
        this._visibleRoots.clear();
        super.destroy();
    }
    init() {
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.sentenceManager.disable();
        this._rootObserver = new IntersectionObserver((entries) => this.onIntersection(entries), {
            rootMargin: '50% 50% 50% 50%',
        });
        const onPageChange = () => this.scheduleRescan();
        document.addEventListener('mokuro-reader:page.change', onPageChange);
        this._disposers.push(() => document.removeEventListener('mokuro-reader:page.change', onPageChange));
        this.rescan();
    }
    scheduleRescan() {
        clearTimeout(this._debounceTimeout);
        this._debounceTimeout = setTimeout(() => {
            this._debounceTimeout = undefined;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (!this._destroyed) {
                        this.rescan();
                    }
                });
            });
        }, 300);
    }
    rescan() {
        const currentRoots = this.discoverPageRoots();
        let needsParse = false;
        for (const root of this._trackedRoots) {
            if (!currentRoots.has(root) || !root.isConnected) {
                _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.dismissNode(root);
                this._rootObserver.unobserve(root);
                this._trackedRoots.delete(root);
                this._visibleRoots.delete(root);
            }
        }
        for (const root of currentRoots) {
            if (this._trackedRoots.has(root)) {
                // Content was replaced by Mokuro — re-parse
                if (this._visibleRoots.has(root) && !root.querySelector('.jiten-word')) {
                    _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.dismissNode(root);
                    this.prepareRoot(root);
                    needsParse = true;
                }
                continue;
            }
            this._trackedRoots.add(root);
            this._rootObserver.observe(root);
        }
        if (needsParse) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.parseBatches();
        }
    }
    onIntersection(entries) {
        let needsParse = false;
        for (const entry of entries) {
            const root = entry.target;
            if (!entry.isIntersecting) {
                this._visibleRoots.delete(root);
                _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.dismissNode(root);
                continue;
            }
            this._visibleRoots.add(root);
            this.prepareRoot(root);
            needsParse = true;
        }
        if (needsParse) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.parseBatches();
        }
    }
    discoverPageRoots() {
        const roots = new Set();
        document.querySelectorAll('.textBox').forEach((box) => {
            if (box.parentElement) {
                roots.add(box.parentElement);
            }
        });
        return roots;
    }
    prepareRoot(root) {
        this.cleanupTextBoxes(root);
        this.installAppStyles();
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.batchController.registerNode(root, {
            getParagraphsFn: _mokuro_get_mokuro_paragraphs__WEBPACK_IMPORTED_MODULE_2__.getMokuroParagraphs,
        });
    }
    cleanupTextBoxes(root) {
        root.querySelectorAll('.textBox p').forEach((p) => {
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
                let textContent = '';
                if (child instanceof Element) {
                    const clone = child.cloneNode(true);
                    clone.querySelectorAll('rt, rp').forEach((el) => el.remove());
                    textContent = clone.textContent || '';
                }
                else {
                    textContent = child.textContent || '';
                }
                if (textContent) {
                    newChildren.push(document.createTextNode(textContent));
                }
            }
            p.replaceChildren(...newChildren);
        });
    }
}


/***/ }),
/* 161 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ReadwokParser: () => (/* binding */ ReadwokParser)
/* harmony export */ });
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(149);

class ReadwokParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_0__.AutomaticParser {
    /**
     * Called when an item becomes visible in the viewport
     * Used as callback for the `getParseVisibleObserver` method
     *
     * Registers the items in the batch controller and parses them
     *
     * @param {Element[]} elements The element changes
     * @param {IntersectionObserver} observer The observer instance
     * @param {(node: HTMLElement | Text) => boolean} filter A filter function to filter the childnodes of the elements
     */
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
/* 162 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SatoriReaderParser: () => (/* binding */ SatoriReaderParser)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(33);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(90);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(149);
/* harmony import */ var _satori_desktop__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(163);
/* harmony import */ var _satori_mobile__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(165);






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
        this._disposers.push((0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_1__.onBroadcastMessage)('configurationUpdated', async () => {
            const touchActive = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('touchscreenSupport');
            this.desktop.setDisplay(touchActive);
            this.mobile.setDisplay(touchActive);
        }, true));
    }
    enableBreader(isActive) {
        this.desktop.setMode(isActive);
        this.mobile.setMode(isActive);
        _integration_registry__WEBPACK_IMPORTED_MODULE_2__.Registry.skipTouchEvents = !isActive;
    }
}


/***/ }),
/* 163 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SatoriDesktop: () => (/* binding */ SatoriDesktop)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(25);
/* harmony import */ var _shared_dom_with_elements__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(164);



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
/* 164 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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
/* 165 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SatoriMobile: () => (/* binding */ SatoriMobile)
/* harmony export */ });
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(22);
/* harmony import */ var _shared_dom_find_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(25);
/* harmony import */ var _shared_dom_find_elements__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(121);
/* harmony import */ var _shared_dom_with_element__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(122);




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
/* 166 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TtsuParser: () => (/* binding */ TtsuParser)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(90);
/* harmony import */ var _paragraph_reader_ttsu_paragraph_reader__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(167);
/* harmony import */ var _automatic_parser__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(149);
/* harmony import */ var _ttsu_text_highlighter__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(168);




let statsUpdateTimeout;
const ttsuApplyTokens = (fragments, tokens) => {
    new _ttsu_text_highlighter__WEBPACK_IMPORTED_MODULE_3__.TtsuTextHighlighter(fragments, tokens).apply();
    if (statsUpdateTimeout) {
        clearTimeout(statsUpdateTimeout);
    }
    statsUpdateTimeout = window.setTimeout(() => {
        _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.statusBar?.recalculateStats();
        statsUpdateTimeout = undefined;
    }, 100);
};
const getTtsuParagraphs = (node, filter, collapseWhitespace) => {
    return new _paragraph_reader_ttsu_paragraph_reader__WEBPACK_IMPORTED_MODULE_1__.TtsuParagraphReader(node, filter, collapseWhitespace).read();
};
class TtsuParser extends _automatic_parser__WEBPACK_IMPORTED_MODULE_2__.AutomaticParser {
    constructor() {
        super(...arguments);
        this._hasReservedFuriganaSpace = false;
    }
    destroy() {
        this._pageObserver?.disconnect();
        this._chapterObserver?.disconnect();
        super.destroy();
    }
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
    parseNodes(nodes, filter) {
        if (this._destroyed) {
            return;
        }
        this.installAppStyles();
        this.reserveFuriganaSpace();
        const { batchController } = _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry;
        batchController.registerNodes(nodes, {
            filter,
            collapseWhitespace: this._meta.collapseWhitespace,
            getParagraphsFn: getTtsuParagraphs,
            applyFn: ttsuApplyTokens,
            onComplete: () => window.dispatchEvent(new Event('resize')),
        });
        batchController.parseBatches();
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
    reserveFuriganaSpace() {
        if (this._hasReservedFuriganaSpace || _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.textHighlighterOptions.skipFurigana) {
            return;
        }
        this._hasReservedFuriganaSpace = true;
        const style = document.createElement('style');
        style.setAttribute('data-jiten-style', 'ttsu-furigana-reservation');
        // Reserve room for the absolutely-positioned furigana on the block-start side. Logical so it
        // adapts to vertical writing mode, and in em so it scales with the reader font (a fixed px
        // reserve overflowed into the previous line once the user enlarged the text). When the book's
        // line-height is too tight to hold furigana between lines/columns, floor it (only ever raising
        // it, so loosely-set books keep their exact spacing) - one consistent reflow, not a live shift.
        const rules = [
            '.book-content-container > *:not(.ttu-book-html-wrapper) > *,',
            '.book-content-container > div.ttu-book-html-wrapper > div.ttu-book-body-wrapper > * {',
            '  padding-block-start: 0.85em !important;',
        ];
        if (this.needsLineHeightFloor()) {
            rules.push(`  line-height: ${TtsuParser.MIN_FURIGANA_LINE_HEIGHT} !important;`);
        }
        rules.push('}');
        style.textContent = rules.join('\n');
        document.head.appendChild(style);
        window.dispatchEvent(new Event('resize'));
    }
    needsLineHeightFloor() {
        const sample = document.querySelector('.book-content-container');
        if (!sample) {
            return true;
        }
        const { lineHeight, fontSize } = getComputedStyle(sample);
        const resolvedLineHeight = parseFloat(lineHeight);
        const resolvedFontSize = parseFloat(fontSize);
        if (Number.isNaN(resolvedLineHeight) || !resolvedFontSize) {
            return true;
        }
        return resolvedLineHeight / resolvedFontSize < TtsuParser.MIN_FURIGANA_LINE_HEIGHT;
    }
}
TtsuParser.MIN_FURIGANA_LINE_HEIGHT = 1.65;


/***/ }),
/* 167 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TtsuParagraphReader: () => (/* binding */ TtsuParagraphReader)
/* harmony export */ });
/* harmony import */ var _paragraph_reader__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(97);

class TtsuParagraphReader extends _paragraph_reader__WEBPACK_IMPORTED_MODULE_0__.ParagraphReader {
    pushText(fragments, offset, text, hasRuby, rubyElement) {
        // Add zero-width space after all ideographic spaces "　" (U+3000)
        text.data = text.data.replace(/\u3000/g, '\u3000\u200B');
        return super.pushText(fragments, offset, text, hasRuby, rubyElement);
    }
}


/***/ }),
/* 168 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TtsuTextHighlighter: () => (/* binding */ TtsuTextHighlighter)
/* harmony export */ });
/* harmony import */ var _text_highlighter_text_highlighter__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(94);

const RT_SCALE = 0.6;
const WIDEN_HEADROOM = 0.1;
class TtsuTextHighlighter extends _text_highlighter_text_highlighter__WEBPACK_IMPORTED_MODULE_0__.TextHighlighter {
    createRubyNodesForFragment(fragment, rubies) {
        const nodeText = fragment.node.textContent;
        const docFrag = document.createDocumentFragment();
        const sortedRubies = [...rubies].sort((a, b) => a.start - b.start);
        let lastIndex = 0;
        for (const ruby of sortedRubies) {
            const rubyStart = ruby.start - fragment.start;
            const rubyEnd = ruby.end - fragment.start;
            if (rubyStart > lastIndex) {
                docFrag.append(document.createTextNode(nodeText.slice(lastIndex, rubyStart)));
            }
            const baseText = nodeText.slice(rubyStart, rubyEnd);
            const rubyElem = document.createElement('ruby');
            const rt = document.createElement('rt');
            rubyElem.append(document.createTextNode(baseText));
            rubyElem.setAttribute('data-furi', ruby.text);
            const furiInline = ruby.text.length * RT_SCALE;
            if (furiInline > baseText.length) {
                rubyElem.style.minInlineSize = `${(furiInline + WIDEN_HEADROOM).toFixed(2)}em`;
            }
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
}


/***/ }),
/* 169 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   YatsuParser: () => (/* binding */ YatsuParser)
/* harmony export */ });
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(90);
/* harmony import */ var _ttsu_parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(166);


class YatsuParser extends _ttsu_parser__WEBPACK_IMPORTED_MODULE_1__.TtsuParser {
    visibleObserverOnEnter(elements) {
        const [element] = elements;
        const container = element.querySelector('.book-content-container');
        const chapters = element.querySelectorAll('[id^="ttu"], [id^="section-"]');
        if (container) {
            this._pageObserver = new MutationObserver(() => {
                _integration_registry__WEBPACK_IMPORTED_MODULE_0__.Registry.sentenceManager.reset();
                this.parseNode(container);
            });
            this._pageObserver.observe(container, {
                attributes: true,
                attributeFilter: ['id'],
            });
            this.parseNode(container);
            return;
        }
        if (chapters.length) {
            this.setupChapterObservers(chapters);
            return;
        }
        this._pageObserver = new MutationObserver(() => {
            if (element.querySelector('.book-content-container')) {
                this._pageObserver?.disconnect();
                this.visibleObserverOnEnter(elements);
            }
        });
        this._pageObserver.observe(element, { childList: true, subtree: true });
    }
}


/***/ }),
/* 170 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   NoParser: () => (/* binding */ NoParser)
/* harmony export */ });
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(20);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(90);
/* harmony import */ var _trigger_parser__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(171);



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
/* 171 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TriggerParser: () => (/* binding */ TriggerParser)
/* harmony export */ });
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(134);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(22);
/* harmony import */ var _shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(147);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(21);
/* harmony import */ var _shared_host_meta_is_disabled__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(172);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(33);
/* harmony import */ var _shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(100);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(109);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(90);
/* harmony import */ var _base_parser__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(150);










const GSM_SHOW_PARSE_BUTTON = false;
class TriggerParser extends _base_parser__WEBPACK_IMPORTED_MODULE_9__.BaseParser {
    destroy() {
        this._parseKeyManager.destroy();
        this._buttonRoot.remove();
        super.destroy();
    }
    constructor(meta) {
        super(meta);
        this._parseKeyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_7__.KeybindManager(['parseKey']);
        this._buttonRoot = (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', {
            id: 'ajb-parse-button',
        });
        this._parseKeyManager.activate();
        const parseKeyHandler = () => this.initParse();
        _integration_registry__WEBPACK_IMPORTED_MODULE_8__.Registry.events.on('parseKey', parseKeyHandler);
        this._disposers.push(() => _integration_registry__WEBPACK_IMPORTED_MODULE_8__.Registry.events.off('parseKey', parseKeyHandler));
        this._disposers.push((0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_6__.receiveBackgroundMessage)('parsePage', () => this.parsePage()));
        this._disposers.push((0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_6__.receiveBackgroundMessage)('parseSelection', () => this.parseSelection()));
        this._disposers.push((0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__.onBroadcastMessage)('configurationUpdated', async () => {
            const show = GSM_SHOW_PARSE_BUTTON;
            const paused = await (0,_shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_2__.getParsingPaused)();
            this._buttonRoot.style.display = show && !paused ? 'block' : 'none';
        }, true));
        this._disposers.push((0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_5__.onBroadcastMessage)('parsingPaused', (paused) => {
            if (paused) {
                this._buttonRoot.style.display = 'none';
                this._parseKeyManager.deactivate();
            }
            else {
                const show = GSM_SHOW_PARSE_BUTTON;
                this._buttonRoot.style.display = show ? 'block' : 'none';
                this._parseKeyManager.activate();
            }
        }));
        void Promise.all([(0,_shared_host_meta_is_disabled__WEBPACK_IMPORTED_MODULE_4__.isDisabled)(window.location.href), (0,_shared_extension_get_parsing_paused__WEBPACK_IMPORTED_MODULE_2__.getParsingPaused)()]).then(([disabled, paused]) => {
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
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('TriggerParser: Parsing selection');
            return this.parseSelection();
        }
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_0__.debug)('TriggerParser: Parsing page');
        return this.parsePage();
    }
    installParseButton() {
        const shadowRoot = this._buttonRoot.attachShadow({ mode: 'open' });
        shadowRoot.append((0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('link', {
            attributes: { rel: 'stylesheet', href: (0,_shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_3__.getStyleUrl)('parse') },
        }), (0,_shared_dom_create_element__WEBPACK_IMPORTED_MODULE_1__.createElement)('div', { innerText: 'Parse', handler: () => this.initParse() }));
        // GSM keeps page parsing command-driven; do not inject Jiten's floating page button.
    }
}


/***/ }),
/* 172 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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
/* 173 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   StatusBar: () => (/* binding */ StatusBar)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(11);
/* harmony import */ var _shared_dom_create_element__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(22);
/* harmony import */ var _shared_extension_get_style_url__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(21);
/* harmony import */ var _shared_extension_get_url__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(17);
/* harmony import */ var _shared_messages_background_open_settings_command__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(64);
/* harmony import */ var _shared_messages_background_update_badge_command__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(66);
/* harmony import */ var _shared_messages_broadcast_configuration_updated_command__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(174);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(33);
/* harmony import */ var _shared_theme_get_theme_css_vars__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(124);
/* harmony import */ var _stats_calculator__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(175);











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
        this._stats = {
            total: 0,
            mastered: 0,
            mature: 0,
            young: 0,
            blacklisted: 0,
            new: 0,
            due: 0,
        };
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
        this.updateBadge(coverageStats);
    }
    updateBadge(coverage) {
        if (!this._showBadge || !this._hasContent) {
            new _shared_messages_background_update_badge_command__WEBPACK_IMPORTED_MODULE_6__.UpdateBadgeCommand(null).send();
            return;
        }
        const coverageStats = coverage ?? (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.calculateCoverageFromDOM)();
        const comprehension = (0,_stats_calculator__WEBPACK_IMPORTED_MODULE_10__.calculateComprehension)(coverageStats);
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
/* 174 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
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
/* 175 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   calculateComprehension: () => (/* binding */ calculateComprehension),
/* harmony export */   calculateCoverageFromDOM: () => (/* binding */ calculateCoverageFromDOM),
/* harmony export */   calculateStatsFromRegistry: () => (/* binding */ calculateStatsFromRegistry),
/* harmony export */   calculateUniqueComprehension: () => (/* binding */ calculateUniqueComprehension),
/* harmony export */   getComprehensionColour: () => (/* binding */ getComprehensionColour)
/* harmony export */ });
/* harmony import */ var _shared_jiten_types__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(4);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(90);


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
            element.classList.contains('blacklisted') ||
            element.classList.contains('redundant')) {
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
/******/ 	/* webpack/runtime/compat get default export */
/******/ 	(() => {
/******/ 		// getDefaultExport function for compatibility with non-harmony modules
/******/ 		__webpack_require__.n = (module) => {
/******/ 			var getter = module && module.__esModule ?
/******/ 				() => (module['default']) :
/******/ 				() => (module);
/******/ 			__webpack_require__.d(getter, { a: getter });
/******/ 			return getter;
/******/ 		};
/******/ 	})();
/******/ 	
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
// This entry needs to be wrapped in an IIFE because it needs to be in strict mode.
(() => {
"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AJB: () => (/* binding */ AJB)
/* harmony export */ });
/* harmony import */ var _shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var _shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(11);
/* harmony import */ var _shared_debug__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(134);
/* harmony import */ var _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(20);
/* harmony import */ var _shared_messages_background_fetch_study_decks_command__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(49);
/* harmony import */ var _shared_messages_background_lookup_text_command__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(70);
/* harmony import */ var _shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(33);
/* harmony import */ var _shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(100);
/* harmony import */ var _features_get_features__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(138);
/* harmony import */ var _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(109);
/* harmony import */ var _integration_mass_review_action__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(146);
/* harmony import */ var _integration_no_focus_trigger__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(110);
/* harmony import */ var _integration_registry__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(90);
/* harmony import */ var _parser_automatic_parser__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(149);
/* harmony import */ var _parser_get_custom_parser__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(151);
/* harmony import */ var _parser_no_parser__WEBPACK_IMPORTED_MODULE_15__ = __webpack_require__(170);
/* harmony import */ var _parser_trigger_parser__WEBPACK_IMPORTED_MODULE_16__ = __webpack_require__(171);
/* harmony import */ var _popup_popup_manager__WEBPACK_IMPORTED_MODULE_17__ = __webpack_require__(108);
/* harmony import */ var _status_bar_status_bar__WEBPACK_IMPORTED_MODULE_18__ = __webpack_require__(173);
/* harmony import */ var _text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_19__ = __webpack_require__(129);




















class AJB {
    constructor() {
        this._lookupKeyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_9__.KeybindManager(['lookupSelectionKey']);
        this._statusBarKeyManager = new _integration_keybind_manager__WEBPACK_IMPORTED_MODULE_9__.KeybindManager(['toggleStatusBarKey']);
        this._massReviewAction = new _integration_mass_review_action__WEBPACK_IMPORTED_MODULE_10__.MassReviewAction();
        this._lastUrl = location.href;
        this._lastMetaKey = '';
        this._navigationGeneration = 0;
        this._canBeTriggered = false;
        (0,_shared_debug__WEBPACK_IMPORTED_MODULE_2__.debug)('Initialize AJB', { mainFrame: window === window.top });
        this._lookupKeyManager.activate();
        _integration_no_focus_trigger__WEBPACK_IMPORTED_MODULE_11__.NoFocusTrigger.get().install();
        _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.wordEventDelegator.initialise();
        (0,_shared_messages_receiving_receive_background_message__WEBPACK_IMPORTED_MODULE_7__.receiveBackgroundMessage)('toast', _shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast);
        _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.events.on('lookupSelectionKey', () => {
            this.withHiddenRT(() => {
                this.lookupText(window.getSelection()?.toString());
            });
        });
        this.installParsers();
        this.watchNavigation();
        _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.popupManager = new _popup_popup_manager__WEBPACK_IMPORTED_MODULE_17__.PopupManager();
        if (_integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.isMainFrame) {
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.statusBar = new _status_bar_status_bar__WEBPACK_IMPORTED_MODULE_18__.StatusBar();
            this._statusBarKeyManager.activate();
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.events.on('toggleStatusBarKey', () => {
                _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.statusBar?.toggle();
            });
            void this.installReviewButton();
        }
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_6__.onBroadcastMessage)('cardStateUpdated', (wordId, readingIndex, state, deckIds) => {
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.updateCard(wordId, readingIndex, state, deckIds);
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.statusBar?.recalculateStats();
        });
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_6__.onBroadcastMessage)('configurationUpdated', async () => {
            const skipFurigana = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('skipFurigana');
            const generatePitch = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('generatePitch');
            const markTopX = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markTopX');
            const markTopXCount = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markTopXCount');
            const markAllTypes = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markAllTypes');
            const markIPlus1 = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markIPlus1');
            const minSentenceLength = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('minSentenceLength');
            const iPlusOneMaxFrequency = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('iPlusOneMaxFrequency');
            const iPlusOneMaxFrequencyCount = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('iPlusOneMaxFrequencyCount');
            const newStates = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('newStates');
            const markWordsInDeck = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('markWordsInDeck');
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.textHighlighterOptions.skipFurigana = skipFurigana;
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.textHighlighterOptions.generatePitch = generatePitch;
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.textHighlighterOptions.markIPlus1 = markIPlus1;
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.textHighlighterOptions.markAll = markAllTypes;
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.textHighlighterOptions.markFrequency = markTopX ? markTopXCount : false;
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.textHighlighterOptions.minSentenceLength = minSentenceLength;
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.textHighlighterOptions.iPlusOneMaxFrequency = iPlusOneMaxFrequency
                ? iPlusOneMaxFrequencyCount
                : false;
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.textHighlighterOptions.newStates = newStates;
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.textHighlighterOptions.markWordsInDeck = markWordsInDeck;
            await (0,_text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_19__.applyWordStyles)();
        }, true);
        (0,_shared_messages_receiving_on_broadcast_message__WEBPACK_IMPORTED_MODULE_6__.onBroadcastMessage)('profileSwitched', (_profileId) => {
            (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.invalidateProfileCache)();
            (0,_shared_configuration_set_configuration__WEBPACK_IMPORTED_MODULE_1__.invalidateSetConfigurationCache)();
            void (0,_text_highlighter_apply_word_styles__WEBPACK_IMPORTED_MODULE_19__.applyWordStyles)();
            if (this._canBeTriggered && _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.isMainFrame) {
                void this.loadStudyDecks();
            }
        });
        void this.installFeatures();
    }
    async loadStudyDecks() {
        try {
            const decks = await new _shared_messages_background_fetch_study_decks_command__WEBPACK_IMPORTED_MODULE_4__.FetchStudyDecksCommand().call();
            _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.setStudyDecks(decks);
        }
        catch {
            // Not signed in / API unavailable — deck membership marking simply stays inert.
        }
    }
    lookupText(text) {
        if (!text?.length) {
            (0,_shared_dom_display_toast__WEBPACK_IMPORTED_MODULE_3__.displayToast)('error', 'No text to lookup!');
            return;
        }
        new _shared_messages_background_lookup_text_command__WEBPACK_IMPORTED_MODULE_5__.LookupTextCommand(text).send();
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
        const { hostEvaluator, parsers } = _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry;
        const isPredefined = (meta) => 'id' in meta;
        const generation = this._navigationGeneration;
        void hostEvaluator.load().then(({ canBeTriggered, relevantMeta }) => {
            if (generation !== this._navigationGeneration) {
                return;
            }
            this._lastMetaKey = hostEvaluator.metaKey;
            this._canBeTriggered = canBeTriggered;
            if (!canBeTriggered) {
                parsers.push(new _parser_no_parser__WEBPACK_IMPORTED_MODULE_15__.NoParser(hostEvaluator.rejectionReason));
            }
            else if (_integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.isMainFrame) {
                // Decks are only needed to mark membership during highlighting, which
                // never happens on unparseable pages — so skip the fetch entirely there.
                void this.loadStudyDecks();
            }
            for (const meta of relevantMeta) {
                if (!meta.auto) {
                    if (!meta.disabled) {
                        parsers.push(new _parser_trigger_parser__WEBPACK_IMPORTED_MODULE_16__.TriggerParser(meta));
                    }
                    continue;
                }
                if (isPredefined(meta) && meta.custom) {
                    parsers.push((0,_parser_get_custom_parser__WEBPACK_IMPORTED_MODULE_14__.getCustomParser)(meta.custom, meta));
                    continue;
                }
                parsers.push(new _parser_automatic_parser__WEBPACK_IMPORTED_MODULE_13__.AutomaticParser(meta));
            }
        });
    }
    async installFeatures() {
        const features = await (0,_features_get_features__WEBPACK_IMPORTED_MODULE_8__.getFeatures)();
        for (const feature of features) {
            feature.apply();
        }
    }
    async installReviewButton() {
        const showButton = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('statusBarShowReviewButton');
        const disableReviews = await (0,_shared_configuration_get_configuration__WEBPACK_IMPORTED_MODULE_0__.getConfiguration)('jitenDisableReviews');
        if (!showButton || disableReviews) {
            return;
        }
        _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.statusBar?.addButton({
            id: 'ajb-review-btn',
            icon: '✅',
            tooltip: 'Review on-screen words as good',
            handler: () => void this._massReviewAction.confirmViaDialog(),
        });
    }
    watchNavigation() {
        setInterval(() => {
            if (location.href !== this._lastUrl) {
                this._lastUrl = location.href;
                this.handleNavigationChange();
            }
        }, 500);
        window.addEventListener('popstate', () => {
            if (location.href !== this._lastUrl) {
                this._lastUrl = location.href;
                this.handleNavigationChange();
            }
        });
    }
    handleNavigationChange() {
        const { hostEvaluator } = _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry;
        const generation = ++this._navigationGeneration;
        hostEvaluator.updateUrl(location.href);
        void hostEvaluator.load().then(() => {
            if (generation !== this._navigationGeneration) {
                return;
            }
            const newMetaKey = hostEvaluator.metaKey;
            if (newMetaKey === this._lastMetaKey) {
                return;
            }
            (0,_shared_debug__WEBPACK_IMPORTED_MODULE_2__.debug)('SPA navigation detected, reinstalling parsers');
            this.destroyParsers();
            this.installParsers();
        });
    }
    destroyParsers() {
        const { batchController, parsers, sentenceManager } = _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry;
        batchController.abortAll();
        parsers.forEach((parser) => parser.destroy());
        parsers.length = 0;
        sentenceManager.reset();
        _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.clearCards();
        _integration_registry__WEBPACK_IMPORTED_MODULE_12__.Registry.statusBar?.recalculateStats();
    }
}
new AJB();

})();

/******/ })()
;