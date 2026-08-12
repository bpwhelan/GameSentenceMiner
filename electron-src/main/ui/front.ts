import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    BASE_DIR,
    getOverlayAppAsarPath,
    getOverlayExecName,
    getOverlayPath,
    getOverlayResourcesPath,
    getResourcesDir,
    isDev,
    OVERLAY_RESOURCES_ENV,
} from '../util.js';
import {
    getFrontPageState,
    getSteamGames,
    getVNs,
    getYuzuRomsPath,
    LaunchableGame,
    HookableGameType,
    OCRGame,
    setFrontPageState,
} from '../store.js';
import { getConfiguredYuzuGames, getYuzuGames } from './yuzu.js';
import { getOBSConnection, getOBSScenes } from './obs.js';
import { getSceneOCRConfig } from './ocr.js';
import { sendOpenTexthooker } from '../main.js';
import { USE_IN_PROCESS_OVERLAY } from '../overlay_runtime_config.js';
import {
    isInProcessOverlayRunning,
    startInProcessOverlay,
    stopInProcessOverlay,
    waitForInProcessOverlayShutdown,
} from '../overlay_runtime.js';
import {
    getHoshidictsControlPort,
    HOSHIDICTS_CONTROL_ENV,
} from '../features/hoshidicts/control_channel.js';
import { getConfiguredHoshidictsEnabled } from '../gsm_config.js';
import {
    createDefaultHoshidictsPopupButtons,
    DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
    DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY,
    DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
    DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
    DEFAULT_HOSHIDICTS_PITCH_ACCENT_FURIGANA_DICTIONARY,
    DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE,
    DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA,
    DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS,
    DEFAULT_HOSHIDICTS_AVERAGE_FREQUENCY,
    DEFAULT_HOSHIDICTS_SHOW_FREQUENCY_DICTIONARY_NAMES,
    DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
    DEFAULT_HOSHIDICTS_MAX_RESULTS,
    DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
    DEFAULT_HOSHIDICTS_POPUP_COLUMNS,
    DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
    DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
    DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
    DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
    DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
    DEFAULT_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT,
    DEFAULT_HOSHIDICTS_SCAN_LENGTH,
    DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY,
    DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER,
    DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
    DEFAULT_HOSHIDICTS_THEME,
    isHoshidictsActivationKey,
    isHoshidictsPopupToolbarPosition,
    isHoshidictsSortFrequencyDictionaryOrder,
    isHoshidictsTheme,
    MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
    MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
    MAX_HOSHIDICTS_MAX_RESULTS,
    MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
    MAX_HOSHIDICTS_POPUP_COLUMNS,
    MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT,
    MAX_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
    MAX_HOSHIDICTS_POPUP_WIDTH_PX,
    MAX_HOSHIDICTS_SCAN_LENGTH,
    MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
    MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
    MIN_HOSHIDICTS_MAX_RESULTS,
    MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
    MIN_HOSHIDICTS_POPUP_COLUMNS,
    MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
    MIN_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
    MIN_HOSHIDICTS_POPUP_WIDTH_PX,
    MIN_HOSHIDICTS_SCAN_LENGTH,
    type HoshidictsActivationKey,
    type HoshidictsDefinitionBlurPreferences,
    type HoshidictsLookupMode,
    type HoshidictsPopupToolbarPosition,
    type HoshidictsPopupButtons,
    type HoshidictsTheme,
    type HoshidictsAudioProfile,
    type HoshidictsReaderPreferences,
    type HoshidictsSortFrequencyDictionaryOrder,
} from '../../shared/features/hoshidicts.js';

const OCR_CONFIG_DIR = path.join(BASE_DIR, 'ocr_config');
let overlayProcess: ChildProcess | null = null;
export type OverlayLaunchSource = 'manual' | 'startup' | 'auto-launcher';
let overlayLaunchSource: OverlayLaunchSource | null = null;
let overlayHoshidictsEnabledAtLaunch: boolean | null = null;
let overlayHoshidictsLookupModeAtLaunch: HoshidictsLookupMode | null = null;
let overlayHoshidictsLookupControlsAtLaunch: HoshidictsLookupControls | null =
    null;
let overlayHoshidictsActivationKeyAtLaunch: HoshidictsActivationKey | null = null;
let overlayHoshidictsSourceHighlightEnabledAtLaunch: boolean | null = null;
let overlayHoshidictsOnlyScanJapaneseTextAtLaunch: boolean | null = null;
let overlayHoshidictsPopupHideDelayAtLaunch: number | null = null;
let overlayHoshidictsShowLookupCountsAtLaunch: boolean | null = null;
let overlayHoshidictsShowCompactDefinitionSummaryAtLaunch: boolean | null = null;
let overlayHoshidictsCompactDefinitionSummaryCountAtLaunch: number | null = null;
let overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch: string | null =
    null;
let overlayHoshidictsShowPitchAccentFuriganaAtLaunch: boolean | null = null;
let overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch: string | null =
    null;
let overlayHoshidictsShowPitchAccentBadgeAtLaunch: boolean | null = null;
let overlayHoshidictsHidePopupGrammarTagsAtLaunch: boolean | null = null;
let overlayHoshidictsAudioProfileRestartRequired = false;
let overlayHoshidictsPopupNestingMaxDepthAtLaunch: number | null = null;
let overlayHoshidictsDefinitionBlurAtLaunch: HoshidictsDefinitionBlurPreferences | null = null;
let overlayHoshidictsPopupWidthAtLaunch: number | null = null;
let overlayHoshidictsPopupHeightAtLaunch: number | null = null;
let overlayHoshidictsPopupColumnsAtLaunch: number | null = null;
let overlayHoshidictsThemeAtLaunch: HoshidictsTheme | null = null;
let overlayHoshidictsPopupOpacityPercentAtLaunch: number | null = null;
let overlayHoshidictsPopupBackdropBlurPxAtLaunch: number | null = null;
let overlayHoshidictsPopupToolbarPositionAtLaunch: HoshidictsPopupToolbarPosition | null =
    null;
let overlayHoshidictsPopupButtonsApplied: HoshidictsPopupButtons | null = null;
let overlayHoshidictsCustomPopupCssApplied: string | null = null;
let hoshidictsLookupModeProvider: () => Promise<HoshidictsLookupMode> =
    async () => 'shift';
let hoshidictsLookupControlsProvider: () => Promise<HoshidictsLookupControls> =
    async () => defaultHoshidictsLookupControls();
let hoshidictsActivationKeyProvider: () => Promise<HoshidictsActivationKey> =
    async () => DEFAULT_HOSHIDICTS_ACTIVATION_KEY;
let hoshidictsSourceHighlightProvider: () => Promise<boolean> = async () =>
    DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED;
let hoshidictsOnlyScanJapaneseTextProvider: () => Promise<boolean> = async () =>
    DEFAULT_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT;
let hoshidictsPopupHideDelayProvider: () => Promise<number> =
    async () => DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS;
let hoshidictsShowLookupCountsProvider: () => Promise<boolean> =
    async () => true;
let hoshidictsShowCompactDefinitionSummaryProvider: () => Promise<boolean> =
    async () => DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY;
let hoshidictsCompactDefinitionSummaryCountProvider: () => Promise<number> =
    async () => DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT;
let hoshidictsCompactDefinitionSummaryDictionaryProvider: () => Promise<
    string | null
> = async () => null;
let hoshidictsShowPitchAccentFuriganaProvider: () => Promise<boolean> =
    async () => DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA;
let hoshidictsPitchAccentFuriganaDictionaryProvider: () => Promise<
    string | null
> = async () => DEFAULT_HOSHIDICTS_PITCH_ACCENT_FURIGANA_DICTIONARY;
let hoshidictsShowPitchAccentBadgeProvider: () => Promise<boolean> =
    async () => DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE;
let hoshidictsHidePopupGrammarTagsProvider: () => Promise<boolean> =
    async () => DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS;
let hoshidictsPopupNestingMaxDepthProvider: () => Promise<number> =
    async () => DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH;
let hoshidictsDefinitionBlurProvider: () => Promise<HoshidictsDefinitionBlurPreferences> =
    async () => ({ ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR });
let hoshidictsPopupWidthProvider: () => Promise<number> =
    async () => DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX;
let hoshidictsPopupHeightProvider: () => Promise<number> =
    async () => DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX;
let hoshidictsPopupColumnsProvider: () => Promise<number> =
    async () => DEFAULT_HOSHIDICTS_POPUP_COLUMNS;
let hoshidictsThemeProvider: () => Promise<HoshidictsTheme> =
    async () => DEFAULT_HOSHIDICTS_THEME;
let hoshidictsPopupOpacityPercentProvider: () => Promise<number> =
    async () => DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT;
let hoshidictsPopupBackdropBlurPxProvider: () => Promise<number> =
    async () => DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX;
let hoshidictsPopupToolbarPositionProvider: () => Promise<HoshidictsPopupToolbarPosition> =
    async () => DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION;
let hoshidictsCustomDictionarySyncProvider: () => Promise<void> =
    async () => undefined;

export interface OverlayRuntimeState {
    isRunning: boolean;
    source: OverlayLaunchSource | null;
}

export interface HoshidictsLookupControls {
    scanLength: number;
    maxResults: number;
    sortFrequencyDictionary: string | null;
    sortFrequencyDictionaryOrder: HoshidictsSortFrequencyDictionaryOrder;
    averageFrequency: boolean;
    showFrequencyDictionaryNames: boolean;
}

function defaultHoshidictsLookupControls(): HoshidictsLookupControls {
    return {
        scanLength: DEFAULT_HOSHIDICTS_SCAN_LENGTH,
        maxResults: DEFAULT_HOSHIDICTS_MAX_RESULTS,
        sortFrequencyDictionary:
            DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY,
        sortFrequencyDictionaryOrder:
            DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER,
        averageFrequency: DEFAULT_HOSHIDICTS_AVERAGE_FREQUENCY,
        showFrequencyDictionaryNames:
            DEFAULT_HOSHIDICTS_SHOW_FREQUENCY_DICTIONARY_NAMES,
    };
}

function normalizeHoshidictsLookupControls(
    controls: HoshidictsLookupControls
): HoshidictsLookupControls {
    return {
        scanLength:
            Number.isInteger(controls?.scanLength) &&
            controls.scanLength >= MIN_HOSHIDICTS_SCAN_LENGTH &&
            controls.scanLength <= MAX_HOSHIDICTS_SCAN_LENGTH
                ? controls.scanLength
                : DEFAULT_HOSHIDICTS_SCAN_LENGTH,
        maxResults:
            Number.isInteger(controls?.maxResults) &&
            controls.maxResults >= MIN_HOSHIDICTS_MAX_RESULTS &&
            controls.maxResults <= MAX_HOSHIDICTS_MAX_RESULTS
                ? controls.maxResults
                : DEFAULT_HOSHIDICTS_MAX_RESULTS,
        sortFrequencyDictionary:
            controls?.sortFrequencyDictionary === null ||
            (typeof controls?.sortFrequencyDictionary === 'string' &&
                controls.sortFrequencyDictionary.trim().length > 0 &&
                controls.sortFrequencyDictionary.length <= 4096)
                ? controls.sortFrequencyDictionary
                : DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY,
        sortFrequencyDictionaryOrder:
            isHoshidictsSortFrequencyDictionaryOrder(
                controls?.sortFrequencyDictionaryOrder
            )
                ? controls.sortFrequencyDictionaryOrder
                : DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER,
        averageFrequency: controls?.averageFrequency === true,
        showFrequencyDictionaryNames:
            controls?.showFrequencyDictionaryNames !== false,
    };
}

export function configureHoshidictsLookupModeProvider(
    provider: () => Promise<HoshidictsLookupMode>
): void {
    hoshidictsLookupModeProvider = provider;
}

export function configureHoshidictsLookupControlsProvider(
    provider: () => Promise<HoshidictsLookupControls>
): void {
    hoshidictsLookupControlsProvider = provider;
}

export function configureHoshidictsActivationKeyProvider(
    provider: () => Promise<HoshidictsActivationKey>
): void {
    hoshidictsActivationKeyProvider = provider;
}

export function configureHoshidictsSourceHighlightProvider(
    provider: () => Promise<boolean>
): void {
    hoshidictsSourceHighlightProvider = provider;
}

export function configureHoshidictsOnlyScanJapaneseTextProvider(
    provider: () => Promise<boolean>
): void {
    hoshidictsOnlyScanJapaneseTextProvider = provider;
}

export function configureHoshidictsPopupHideDelayProvider(
    provider: () => Promise<number>
): void {
    hoshidictsPopupHideDelayProvider = provider;
}

export function configureHoshidictsShowLookupCountsProvider(
    provider: () => Promise<boolean>
): void {
    hoshidictsShowLookupCountsProvider = provider;
}

export function configureHoshidictsShowCompactDefinitionSummaryProvider(
    provider: () => Promise<boolean>
): void {
    hoshidictsShowCompactDefinitionSummaryProvider = provider;
}

export function configureHoshidictsCompactDefinitionSummaryCountProvider(
    provider: () => Promise<number>
): void {
    hoshidictsCompactDefinitionSummaryCountProvider = provider;
}

export function configureHoshidictsCompactDefinitionSummaryDictionaryProvider(
    provider: () => Promise<string | null>
): void {
    hoshidictsCompactDefinitionSummaryDictionaryProvider = provider;
}

export function configureHoshidictsShowPitchAccentFuriganaProvider(
    provider: () => Promise<boolean>
): void {
    hoshidictsShowPitchAccentFuriganaProvider = provider;
}

export function configureHoshidictsPitchAccentFuriganaDictionaryProvider(
    provider: () => Promise<string | null>
): void {
    hoshidictsPitchAccentFuriganaDictionaryProvider = provider;
}

export function configureHoshidictsShowPitchAccentBadgeProvider(
    provider: () => Promise<boolean>
): void {
    hoshidictsShowPitchAccentBadgeProvider = provider;
}

export function configureHoshidictsHidePopupGrammarTagsProvider(
    provider: () => Promise<boolean>
): void {
    hoshidictsHidePopupGrammarTagsProvider = provider;
}

export function configureHoshidictsPopupNestingMaxDepthProvider(
    provider: () => Promise<number>
): void {
    hoshidictsPopupNestingMaxDepthProvider = provider;
}

export function configureHoshidictsDefinitionBlurProvider(
    provider: () => Promise<HoshidictsDefinitionBlurPreferences>
): void {
    hoshidictsDefinitionBlurProvider = provider;
}

export function configureHoshidictsPopupWidthProvider(
    provider: () => Promise<number>
): void {
    hoshidictsPopupWidthProvider = provider;
}

export function configureHoshidictsPopupHeightProvider(
    provider: () => Promise<number>
): void {
    hoshidictsPopupHeightProvider = provider;
}

export function configureHoshidictsPopupColumnsProvider(
    provider: () => Promise<number>
): void {
    hoshidictsPopupColumnsProvider = provider;
}

export function configureHoshidictsThemeProvider(
    provider: () => Promise<HoshidictsTheme>
): void {
    hoshidictsThemeProvider = provider;
}

export function configureHoshidictsPopupOpacityPercentProvider(
    provider: () => Promise<number>
): void {
    hoshidictsPopupOpacityPercentProvider = provider;
}

export function configureHoshidictsPopupBackdropBlurPxProvider(
    provider: () => Promise<number>
): void {
    hoshidictsPopupBackdropBlurPxProvider = provider;
}

export function configureHoshidictsPopupToolbarPositionProvider(
    provider: () => Promise<HoshidictsPopupToolbarPosition>
): void {
    hoshidictsPopupToolbarPositionProvider = provider;
}

export function configureHoshidictsCustomDictionarySyncProvider(
    provider: () => Promise<void>
): void {
    hoshidictsCustomDictionarySyncProvider = provider;
}

function warnCustomDictionarySyncFailure(error: unknown): void {
    console.warn(
        '[Hoshidicts] Could not refresh the custom dictionary before overlay launch; using the last active version.',
        error
    );
}

function normalizeHoshidictsDefinitionBlur(
    preferences: HoshidictsDefinitionBlurPreferences
): HoshidictsDefinitionBlurPreferences {
    if (
        typeof preferences?.enabled !== 'boolean' ||
        !Number.isInteger(preferences.lookupThreshold) ||
        preferences.lookupThreshold <
            MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD ||
        preferences.lookupThreshold >
            MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD ||
        (preferences.revealMode !== 'timed' &&
            preferences.revealMode !== 'hover') ||
        !Number.isInteger(preferences.revealDelayMs) ||
        preferences.revealDelayMs <
            MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS ||
        preferences.revealDelayMs >
            MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS
    ) {
        return { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR };
    }
    return { ...preferences };
}

function normalizeHoshidictsPopupDimension(
    value: number,
    minimum: number,
    maximum: number,
    fallback: number
): number {
    return Number.isInteger(value) && value >= minimum && value <= maximum
        ? value
        : fallback;
}

interface StopOverlayOptions {
    onlyIfSource?: OverlayLaunchSource;
}

function joinRuntimePath(basePath: string, ...parts: string[]): string {
    return /^[A-Za-z]:[\\/]/u.test(basePath) || basePath.startsWith('\\\\')
        ? path.win32.join(basePath, ...parts)
        : path.join(basePath, ...parts);
}

export function registerFrontPageIPC() {
    // Save the front page state
    ipcMain.handle('front.saveState', async (_, state: any) => {
        try {
            const { hookableGames, ocrGames, ...restState } = state;
            setFrontPageState(restState); // Use the store method to save the state without hookableGames and ocrGames
            return { status: 'success', message: 'State saved successfully' };
        } catch (error) {
            console.error('Error saving front page state:', error);
            return { status: 'error', message: 'Failed to save state' };
        }
    });

    // Get the saved front page state
    ipcMain.handle('front.getSavedState', async () => {
        try {
            const state = getFrontPageState(); // Use the store method to retrieve the state
            const vns = getVNs();
            const steamGames = getSteamGames();
            const yuzuGames = getConfiguredYuzuGames();
            // Combine the games into a single array for hookable games

            state.launchableGames = [
                {
                    name: 'Game',
                    id: '0',
                    type: HookableGameType.None,
                    isHeader: true,
                    scene: undefined,
                },
                ...steamGames.map((game) => ({
                    name: game.name,
                    id: String(game.id),
                    type: HookableGameType.Steam,
                    scene: game.scene,
                })),
                // {name: "Misc/VN", id: "0", type: HookableGameType.None, isHeader: true, scene: undefined},
                // ...vns.map(vn => ({name: vn.path, id: vn.path, type: HookableGameType.VN, scene: vn.scene})),
                {
                    name: 'Yuzu',
                    id: '0',
                    type: HookableGameType.None,
                    isHeader: true,
                    scene: undefined,
                },
                ...yuzuGames.map((game) => ({
                    name: game.name,
                    id: game.id,
                    type: HookableGameType.Yuzu,
                    scene: game.scene,
                })),
            ];

            return state || null;
        } catch (error) {
            console.error('Error retrieving saved front page state:', error);
            return null;
        }
    });

    // Get all OCR configs
    ipcMain.handle('front.getAllOCRConfigs', async () => {
        return await getAllOCRConfigs();
    });

    ipcMain.handle('open-external-link', async (_, url: string) => {
        const { shell } = await import('electron');
        await shell.openExternal(url);
    });

    ipcMain.handle('openTexthooker', async () => {
        sendOpenTexthooker();
    });

    ipcMain.handle('runOverlay', async () => {
        await runOverlay();
    });

    ipcMain.handle('getOverlayStatus', () => {
        return getOverlayRuntimeState();
    });
}

export async function runOverlay() {
    return runOverlayWithSource('manual');
}

export function getOverlayRuntimeState(): OverlayRuntimeState {
    const isRunning = USE_IN_PROCESS_OVERLAY
        ? isInProcessOverlayRunning()
        : Boolean(overlayProcess && overlayProcess.exitCode === null);
    if (!isRunning) {
        overlayLaunchSource = null;
        overlayHoshidictsEnabledAtLaunch = null;
        overlayHoshidictsLookupModeAtLaunch = null;
        overlayHoshidictsLookupControlsAtLaunch = null;
        overlayHoshidictsActivationKeyAtLaunch = null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
        overlayHoshidictsOnlyScanJapaneseTextAtLaunch = null;
        overlayHoshidictsPopupHideDelayAtLaunch = null;
        overlayHoshidictsShowLookupCountsAtLaunch = null;
        overlayHoshidictsShowCompactDefinitionSummaryAtLaunch = null;
        overlayHoshidictsCompactDefinitionSummaryCountAtLaunch = null;
        overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch = null;
        overlayHoshidictsShowPitchAccentFuriganaAtLaunch = null;
        overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch = null;
        overlayHoshidictsShowPitchAccentBadgeAtLaunch = null;
        overlayHoshidictsHidePopupGrammarTagsAtLaunch = null;
        overlayHoshidictsAudioProfileRestartRequired = false;
        overlayHoshidictsPopupNestingMaxDepthAtLaunch = null;
        overlayHoshidictsDefinitionBlurAtLaunch = null;
        overlayHoshidictsPopupWidthAtLaunch = null;
        overlayHoshidictsPopupHeightAtLaunch = null;
        overlayHoshidictsPopupColumnsAtLaunch = null;
        overlayHoshidictsThemeAtLaunch = null;
        overlayHoshidictsPopupOpacityPercentAtLaunch = null;
        overlayHoshidictsPopupBackdropBlurPxAtLaunch = null;
        overlayHoshidictsPopupToolbarPositionAtLaunch = null;
        overlayHoshidictsPopupButtonsApplied = null;
        overlayHoshidictsCustomPopupCssApplied = null;
    }
    return {
        isRunning,
        source: overlayLaunchSource,
    };
}

export function getOverlayHoshidictsEnabledAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsEnabledAtLaunch;
}

export function getOverlayHoshidictsLookupModeAtLaunch(): HoshidictsLookupMode | null {
    getOverlayRuntimeState();
    return overlayHoshidictsLookupModeAtLaunch;
}

export function getOverlayHoshidictsLookupControlsAtLaunch(): HoshidictsLookupControls | null {
    getOverlayRuntimeState();
    return overlayHoshidictsLookupControlsAtLaunch
        ? { ...overlayHoshidictsLookupControlsAtLaunch }
        : null;
}

export function getOverlayHoshidictsActivationKeyAtLaunch(): HoshidictsActivationKey | null {
    getOverlayRuntimeState();
    return overlayHoshidictsActivationKeyAtLaunch;
}

export function getOverlayHoshidictsSourceHighlightEnabledAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsSourceHighlightEnabledAtLaunch;
}

export function getOverlayHoshidictsOnlyScanJapaneseTextAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsOnlyScanJapaneseTextAtLaunch;
}

export function getOverlayHoshidictsPopupHideDelayAtLaunch(): number | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupHideDelayAtLaunch;
}

export function getOverlayHoshidictsShowLookupCountsAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsShowLookupCountsAtLaunch;
}

export function getOverlayHoshidictsShowCompactDefinitionSummaryAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsShowCompactDefinitionSummaryAtLaunch;
}

export function getOverlayHoshidictsCompactDefinitionSummaryCountAtLaunch(): number | null {
    getOverlayRuntimeState();
    return overlayHoshidictsCompactDefinitionSummaryCountAtLaunch;
}

export function getOverlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch(): string | null {
    getOverlayRuntimeState();
    return overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch;
}

export function getOverlayHoshidictsShowPitchAccentFuriganaAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsShowPitchAccentFuriganaAtLaunch;
}

export function getOverlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch(): string | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch;
}

export function getOverlayHoshidictsShowPitchAccentBadgeAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsShowPitchAccentBadgeAtLaunch;
}

export function getOverlayHoshidictsHidePopupGrammarTagsAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsHidePopupGrammarTagsAtLaunch;
}

export function getOverlayHoshidictsPopupNestingMaxDepthAtLaunch(): number | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupNestingMaxDepthAtLaunch;
}

export function getOverlayHoshidictsDefinitionBlurAtLaunch(): HoshidictsDefinitionBlurPreferences | null {
    getOverlayRuntimeState();
    return overlayHoshidictsDefinitionBlurAtLaunch
        ? { ...overlayHoshidictsDefinitionBlurAtLaunch }
        : null;
}

export function getOverlayHoshidictsPopupWidthAtLaunch(): number | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupWidthAtLaunch;
}

export function getOverlayHoshidictsPopupHeightAtLaunch(): number | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupHeightAtLaunch;
}

export function getOverlayHoshidictsPopupColumnsAtLaunch(): number | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupColumnsAtLaunch;
}

export function getOverlayHoshidictsThemeAtLaunch(): HoshidictsTheme | null {
    getOverlayRuntimeState();
    return overlayHoshidictsThemeAtLaunch;
}

export function getOverlayHoshidictsPopupOpacityPercentAtLaunch(): number | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupOpacityPercentAtLaunch;
}

export function getOverlayHoshidictsPopupBackdropBlurPxAtLaunch(): number | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupBackdropBlurPxAtLaunch;
}

export function getOverlayHoshidictsPopupToolbarPositionAtLaunch(): HoshidictsPopupToolbarPosition | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupToolbarPositionAtLaunch;
}

export function getOverlayHoshidictsPopupButtonsApplied(): HoshidictsPopupButtons | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupButtonsApplied
        ? {
              ...overlayHoshidictsPopupButtonsApplied,
              customLinks: overlayHoshidictsPopupButtonsApplied.customLinks.map(
                  (link) => ({ ...link })
              ),
          }
        : null;
}

export function getOverlayHoshidictsCustomPopupCssApplied(): string | null {
    getOverlayRuntimeState();
    return overlayHoshidictsCustomPopupCssApplied;
}

export function getOverlayHoshidictsAudioProfileRestartRequired(): boolean {
    return getOverlayRuntimeState().isRunning &&
        overlayHoshidictsAudioProfileRestartRequired;
}

export function markOverlayHoshidictsReaderPreferencesApplied(
    preferences: HoshidictsReaderPreferences
): boolean {
    if (!getOverlayRuntimeState().isRunning) {
        return false;
    }
    overlayHoshidictsLookupModeAtLaunch = preferences.lookupMode;
    overlayHoshidictsLookupControlsAtLaunch = {
        scanLength: preferences.scanLength,
        maxResults: preferences.maxResults,
        sortFrequencyDictionary: preferences.sortFrequencyDictionary,
        sortFrequencyDictionaryOrder: preferences.sortFrequencyDictionaryOrder,
        averageFrequency: preferences.averageFrequency,
        showFrequencyDictionaryNames: preferences.showFrequencyDictionaryNames,
    };
    overlayHoshidictsActivationKeyAtLaunch = preferences.activationKey;
    overlayHoshidictsSourceHighlightEnabledAtLaunch =
        preferences.sourceHighlightEnabled;
    overlayHoshidictsOnlyScanJapaneseTextAtLaunch =
        preferences.onlyScanJapaneseText;
    overlayHoshidictsPopupHideDelayAtLaunch = preferences.popupHideDelayMs;
    overlayHoshidictsShowLookupCountsAtLaunch = preferences.showLookupCounts;
    overlayHoshidictsShowCompactDefinitionSummaryAtLaunch =
        preferences.showCompactDefinitionSummary;
    overlayHoshidictsCompactDefinitionSummaryCountAtLaunch =
        preferences.compactDefinitionSummaryCount;
    overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch =
        preferences.compactDefinitionSummaryDictionary;
    overlayHoshidictsShowPitchAccentFuriganaAtLaunch =
        preferences.showPitchAccentFurigana;
    overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch =
        preferences.pitchAccentFuriganaDictionary;
    overlayHoshidictsShowPitchAccentBadgeAtLaunch =
        preferences.showPitchAccentBadge;
    overlayHoshidictsHidePopupGrammarTagsAtLaunch =
        preferences.hidePopupGrammarTags;
    overlayHoshidictsPopupNestingMaxDepthAtLaunch =
        preferences.popupNestingMaxDepth;
    overlayHoshidictsDefinitionBlurAtLaunch = {
        ...preferences.definitionBlur,
    };
    overlayHoshidictsPopupWidthAtLaunch = preferences.popupWidthPx;
    overlayHoshidictsPopupHeightAtLaunch = preferences.popupHeightPx;
    overlayHoshidictsPopupColumnsAtLaunch = preferences.popupColumns;
    overlayHoshidictsThemeAtLaunch = preferences.theme;
    overlayHoshidictsPopupOpacityPercentAtLaunch =
        preferences.popupOpacityPercent;
    overlayHoshidictsPopupBackdropBlurPxAtLaunch =
        preferences.popupBackdropBlurPx;
    overlayHoshidictsPopupToolbarPositionAtLaunch =
        preferences.popupToolbarPosition;
    overlayHoshidictsPopupButtonsApplied = {
        ...preferences.popupButtons,
        customLinks: preferences.popupButtons.customLinks.map((link) => ({
            ...link,
        })),
    };
    overlayHoshidictsCustomPopupCssApplied = preferences.customPopupCss;
    return true;
}

export function markOverlayHoshidictsAudioProfileApplied(
    _profile: HoshidictsAudioProfile
): boolean {
    if (!getOverlayRuntimeState().isRunning) {
        return false;
    }
    overlayHoshidictsAudioProfileRestartRequired = false;
    return true;
}

export function markOverlayHoshidictsAudioProfileSyncFailed(): boolean {
    if (!getOverlayRuntimeState().isRunning) {
        return false;
    }
    overlayHoshidictsAudioProfileRestartRequired = true;
    return true;
}

export function stopOverlay(options: StopOverlayOptions = {}): boolean {
    if (USE_IN_PROCESS_OVERLAY) {
        if (!isInProcessOverlayRunning()) {
            overlayLaunchSource = null;
            return false;
        }
        if (options.onlyIfSource && overlayLaunchSource !== options.onlyIfSource) {
            return false;
        }
        const stopRequested = stopInProcessOverlay();
        if (stopRequested) {
            overlayLaunchSource = null;
            overlayHoshidictsEnabledAtLaunch = null;
            overlayHoshidictsLookupModeAtLaunch = null;
            overlayHoshidictsLookupControlsAtLaunch = null;
            overlayHoshidictsActivationKeyAtLaunch = null;
            overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
            overlayHoshidictsOnlyScanJapaneseTextAtLaunch = null;
            overlayHoshidictsPopupHideDelayAtLaunch = null;
            overlayHoshidictsShowLookupCountsAtLaunch = null;
            overlayHoshidictsShowCompactDefinitionSummaryAtLaunch = null;
            overlayHoshidictsCompactDefinitionSummaryCountAtLaunch = null;
            overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch = null;
            overlayHoshidictsShowPitchAccentFuriganaAtLaunch = null;
            overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch = null;
            overlayHoshidictsShowPitchAccentBadgeAtLaunch = null;
            overlayHoshidictsHidePopupGrammarTagsAtLaunch = null;
            overlayHoshidictsAudioProfileRestartRequired = false;
            overlayHoshidictsPopupNestingMaxDepthAtLaunch = null;
            overlayHoshidictsDefinitionBlurAtLaunch = null;
            overlayHoshidictsPopupWidthAtLaunch = null;
            overlayHoshidictsPopupHeightAtLaunch = null;
            overlayHoshidictsPopupColumnsAtLaunch = null;
            overlayHoshidictsThemeAtLaunch = null;
            overlayHoshidictsPopupOpacityPercentAtLaunch = null;
            overlayHoshidictsPopupBackdropBlurPxAtLaunch = null;
            overlayHoshidictsPopupToolbarPositionAtLaunch = null;
            overlayHoshidictsPopupButtonsApplied = null;
            overlayHoshidictsCustomPopupCssApplied = null;
        }
        return stopRequested;
    }

    if (!overlayProcess || overlayProcess.exitCode !== null) {
        overlayProcess = null;
        overlayLaunchSource = null;
        overlayHoshidictsEnabledAtLaunch = null;
        overlayHoshidictsLookupModeAtLaunch = null;
        overlayHoshidictsLookupControlsAtLaunch = null;
        overlayHoshidictsActivationKeyAtLaunch = null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
        overlayHoshidictsOnlyScanJapaneseTextAtLaunch = null;
        overlayHoshidictsPopupHideDelayAtLaunch = null;
        overlayHoshidictsShowLookupCountsAtLaunch = null;
        overlayHoshidictsShowCompactDefinitionSummaryAtLaunch = null;
        overlayHoshidictsCompactDefinitionSummaryCountAtLaunch = null;
        overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch = null;
        overlayHoshidictsShowPitchAccentFuriganaAtLaunch = null;
        overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch = null;
        overlayHoshidictsShowPitchAccentBadgeAtLaunch = null;
        overlayHoshidictsHidePopupGrammarTagsAtLaunch = null;
        overlayHoshidictsAudioProfileRestartRequired = false;
        overlayHoshidictsPopupNestingMaxDepthAtLaunch = null;
        overlayHoshidictsDefinitionBlurAtLaunch = null;
        overlayHoshidictsPopupWidthAtLaunch = null;
        overlayHoshidictsPopupHeightAtLaunch = null;
        overlayHoshidictsPopupColumnsAtLaunch = null;
        overlayHoshidictsThemeAtLaunch = null;
        overlayHoshidictsPopupOpacityPercentAtLaunch = null;
        overlayHoshidictsPopupBackdropBlurPxAtLaunch = null;
        overlayHoshidictsPopupToolbarPositionAtLaunch = null;
        overlayHoshidictsPopupButtonsApplied = null;
        overlayHoshidictsCustomPopupCssApplied = null;
        return false;
    }

    if (options.onlyIfSource && overlayLaunchSource !== options.onlyIfSource) {
        return false;
    }

    const processHandle = overlayProcess;
    try {
        terminateOverlayProcess(processHandle);
        return true;
    } catch (error) {
        console.error('Failed to stop overlay process:', error);
        return false;
    }
}

export async function waitForOverlayShutdown(): Promise<void> {
    if (USE_IN_PROCESS_OVERLAY) {
        await waitForInProcessOverlayShutdown();
        return;
    }

    const processHandle = overlayProcess;
    if (!processHandle || processHandle.exitCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timeout);
            processHandle.removeListener('exit', done);
            processHandle.removeListener('error', done);
            resolve();
        };
        const timeout = setTimeout(done, 10_000);
        processHandle.once('exit', done);
        processHandle.once('error', done);
    });
}

export async function restartOverlay(): Promise<boolean> {
    const state = getOverlayRuntimeState();
    const source = state.source ?? 'manual';
    if (state.isRunning) {
        if (!stopOverlay()) {
            return false;
        }
        await waitForOverlayShutdown();
        if (getOverlayRuntimeState().isRunning) {
            return false;
        }
    }
    return await runOverlayWithSource(source);
}

function terminateOverlayProcess(processHandle: ChildProcess): void {
    if (process.platform === 'win32' && processHandle.pid) {
        execFile(
            'taskkill',
            ['/PID', String(processHandle.pid), '/T', '/F'],
            { windowsHide: true },
            (error) => {
                if (error && processHandle.exitCode === null && !processHandle.killed) {
                    processHandle.kill();
                }
            }
        );
        return;
    }

    processHandle.kill();
}

function registerOverlayProcess(
    processHandle: ChildProcess,
    source: OverlayLaunchSource,
    hoshidictsEnabled: boolean,
    hoshidictsLookupMode: HoshidictsLookupMode,
    hoshidictsPopupHideDelayMs: number,
    hoshidictsActivationKey: HoshidictsActivationKey,
    hoshidictsSourceHighlightEnabled: boolean,
    hoshidictsOnlyScanJapaneseText: boolean,
    hoshidictsPopupNestingMaxDepth: number,
    hoshidictsDefinitionBlur: HoshidictsDefinitionBlurPreferences,
    hoshidictsShowLookupCounts: boolean,
    hoshidictsShowCompactDefinitionSummary: boolean,
    hoshidictsCompactDefinitionSummaryCount: number,
    hoshidictsCompactDefinitionSummaryDictionary: string | null,
    hoshidictsPopupWidthPx: number,
    hoshidictsPopupHeightPx: number,
    hoshidictsPopupColumns: number,
    hoshidictsTheme: HoshidictsTheme,
    hoshidictsPopupOpacityPercent: number,
    hoshidictsPopupToolbarPosition: HoshidictsPopupToolbarPosition,
    hoshidictsLookupControls: HoshidictsLookupControls,
    hoshidictsHidePopupGrammarTags: boolean,
    hoshidictsShowPitchAccentFurigana: boolean,
    hoshidictsPitchAccentFuriganaDictionary: string | null,
    hoshidictsShowPitchAccentBadge: boolean,
    hoshidictsPopupBackdropBlurPx: number
): void {
    overlayProcess = processHandle;
    overlayLaunchSource = source;
    overlayHoshidictsEnabledAtLaunch = hoshidictsEnabled;
    overlayHoshidictsLookupModeAtLaunch = hoshidictsLookupMode;
    overlayHoshidictsLookupControlsAtLaunch = {
        ...hoshidictsLookupControls,
    };
    overlayHoshidictsActivationKeyAtLaunch = hoshidictsActivationKey;
    overlayHoshidictsSourceHighlightEnabledAtLaunch =
        hoshidictsSourceHighlightEnabled;
    overlayHoshidictsOnlyScanJapaneseTextAtLaunch =
        hoshidictsOnlyScanJapaneseText;
    overlayHoshidictsPopupHideDelayAtLaunch = hoshidictsPopupHideDelayMs;
    overlayHoshidictsShowLookupCountsAtLaunch = hoshidictsShowLookupCounts;
    overlayHoshidictsShowCompactDefinitionSummaryAtLaunch =
        hoshidictsShowCompactDefinitionSummary;
    overlayHoshidictsCompactDefinitionSummaryCountAtLaunch =
        hoshidictsCompactDefinitionSummaryCount;
    overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch =
        hoshidictsCompactDefinitionSummaryDictionary;
    overlayHoshidictsShowPitchAccentFuriganaAtLaunch =
        hoshidictsShowPitchAccentFurigana;
    overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch =
        hoshidictsPitchAccentFuriganaDictionary;
    overlayHoshidictsShowPitchAccentBadgeAtLaunch =
        hoshidictsShowPitchAccentBadge;
    overlayHoshidictsHidePopupGrammarTagsAtLaunch =
        hoshidictsHidePopupGrammarTags;
    overlayHoshidictsAudioProfileRestartRequired = false;
    overlayHoshidictsPopupNestingMaxDepthAtLaunch =
        hoshidictsPopupNestingMaxDepth;
    overlayHoshidictsDefinitionBlurAtLaunch = {
        ...hoshidictsDefinitionBlur,
    };
    overlayHoshidictsPopupWidthAtLaunch = hoshidictsPopupWidthPx;
    overlayHoshidictsPopupHeightAtLaunch = hoshidictsPopupHeightPx;
    overlayHoshidictsPopupColumnsAtLaunch = hoshidictsPopupColumns;
    overlayHoshidictsThemeAtLaunch = hoshidictsTheme;
    overlayHoshidictsPopupOpacityPercentAtLaunch =
        hoshidictsPopupOpacityPercent;
    overlayHoshidictsPopupBackdropBlurPxAtLaunch =
        hoshidictsPopupBackdropBlurPx;
    overlayHoshidictsPopupToolbarPositionAtLaunch =
        hoshidictsPopupToolbarPosition;
    overlayHoshidictsPopupButtonsApplied = createDefaultHoshidictsPopupButtons();
    overlayHoshidictsCustomPopupCssApplied =
        DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS;
    overlayProcess.once('exit', () => {
        overlayProcess = null;
        overlayLaunchSource = null;
        overlayHoshidictsEnabledAtLaunch = null;
        overlayHoshidictsLookupModeAtLaunch = null;
        overlayHoshidictsLookupControlsAtLaunch = null;
        overlayHoshidictsActivationKeyAtLaunch = null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
        overlayHoshidictsOnlyScanJapaneseTextAtLaunch = null;
        overlayHoshidictsPopupHideDelayAtLaunch = null;
        overlayHoshidictsShowLookupCountsAtLaunch = null;
        overlayHoshidictsShowCompactDefinitionSummaryAtLaunch = null;
        overlayHoshidictsCompactDefinitionSummaryCountAtLaunch = null;
        overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch = null;
        overlayHoshidictsShowPitchAccentFuriganaAtLaunch = null;
        overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch = null;
        overlayHoshidictsShowPitchAccentBadgeAtLaunch = null;
        overlayHoshidictsHidePopupGrammarTagsAtLaunch = null;
        overlayHoshidictsAudioProfileRestartRequired = false;
        overlayHoshidictsPopupNestingMaxDepthAtLaunch = null;
        overlayHoshidictsDefinitionBlurAtLaunch = null;
        overlayHoshidictsPopupWidthAtLaunch = null;
        overlayHoshidictsPopupHeightAtLaunch = null;
        overlayHoshidictsPopupColumnsAtLaunch = null;
        overlayHoshidictsThemeAtLaunch = null;
        overlayHoshidictsPopupOpacityPercentAtLaunch = null;
        overlayHoshidictsPopupBackdropBlurPxAtLaunch = null;
        overlayHoshidictsPopupToolbarPositionAtLaunch = null;
        overlayHoshidictsPopupButtonsApplied = null;
        overlayHoshidictsCustomPopupCssApplied = null;
    });
    overlayProcess.once('error', (error: Error) => {
        console.error('Overlay process error:', error);
        overlayProcess = null;
        overlayLaunchSource = null;
        overlayHoshidictsEnabledAtLaunch = null;
        overlayHoshidictsLookupModeAtLaunch = null;
        overlayHoshidictsLookupControlsAtLaunch = null;
        overlayHoshidictsActivationKeyAtLaunch = null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
        overlayHoshidictsOnlyScanJapaneseTextAtLaunch = null;
        overlayHoshidictsPopupHideDelayAtLaunch = null;
        overlayHoshidictsShowLookupCountsAtLaunch = null;
        overlayHoshidictsShowCompactDefinitionSummaryAtLaunch = null;
        overlayHoshidictsCompactDefinitionSummaryCountAtLaunch = null;
        overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch = null;
        overlayHoshidictsShowPitchAccentFuriganaAtLaunch = null;
        overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch = null;
        overlayHoshidictsShowPitchAccentBadgeAtLaunch = null;
        overlayHoshidictsHidePopupGrammarTagsAtLaunch = null;
        overlayHoshidictsAudioProfileRestartRequired = false;
        overlayHoshidictsPopupNestingMaxDepthAtLaunch = null;
        overlayHoshidictsDefinitionBlurAtLaunch = null;
        overlayHoshidictsPopupWidthAtLaunch = null;
        overlayHoshidictsPopupHeightAtLaunch = null;
        overlayHoshidictsPopupColumnsAtLaunch = null;
        overlayHoshidictsThemeAtLaunch = null;
        overlayHoshidictsPopupOpacityPercentAtLaunch = null;
        overlayHoshidictsPopupBackdropBlurPxAtLaunch = null;
        overlayHoshidictsPopupToolbarPositionAtLaunch = null;
        overlayHoshidictsPopupButtonsApplied = null;
        overlayHoshidictsCustomPopupCssApplied = null;
    });
}

export function buildHoshidictsOverlayEnvironment(
    enabled: boolean,
    lookupMode: HoshidictsLookupMode = 'shift',
    popupHideDelayMs = DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    activationKey: HoshidictsActivationKey = DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
    sourceHighlightEnabled = DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
    popupNestingMaxDepth = DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
    definitionBlur: HoshidictsDefinitionBlurPreferences = {
        ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
    },
    showLookupCounts = true,
    showCompactDefinitionSummary =
        DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY,
    compactDefinitionSummaryCount =
        DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
    compactDefinitionSummaryDictionary: string | null = null,
    popupWidthPx = DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
    popupHeightPx = DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
    popupColumns = DEFAULT_HOSHIDICTS_POPUP_COLUMNS,
    theme: HoshidictsTheme = DEFAULT_HOSHIDICTS_THEME,
    popupOpacityPercent = DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
    onlyScanJapaneseText = DEFAULT_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT,
    popupToolbarPosition: HoshidictsPopupToolbarPosition =
        DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
    lookupControls: HoshidictsLookupControls =
        defaultHoshidictsLookupControls(),
    hidePopupGrammarTags = DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS,
    showPitchAccentFurigana =
        DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA,
    pitchAccentFuriganaDictionary: string | null =
        DEFAULT_HOSHIDICTS_PITCH_ACCENT_FURIGANA_DICTIONARY,
    showPitchAccentBadge = DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE,
    popupBackdropBlurPx = DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX
): Record<string, string> {
    const normalizedDefinitionBlur =
        normalizeHoshidictsDefinitionBlur(definitionBlur);
    const normalizedLookupControls =
        normalizeHoshidictsLookupControls(lookupControls);
    const normalizedCompactDefinitionSummaryCount =
        Number.isInteger(compactDefinitionSummaryCount) &&
        compactDefinitionSummaryCount >=
            MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT &&
        compactDefinitionSummaryCount <=
            MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT
            ? compactDefinitionSummaryCount
            : DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT;
    return {
        GSM_HOSHIDICTS_ENABLED: enabled ? '1' : '0',
        GSM_HOSHIDICTS_LOOKUP_MODE: lookupMode,
        GSM_HOSHIDICTS_ACTIVATION_KEY: activationKey,
        GSM_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED:
            sourceHighlightEnabled ? '1' : '0',
        GSM_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT:
            onlyScanJapaneseText ? '1' : '0',
        GSM_HOSHIDICTS_POPUP_HIDE_DELAY_MS: String(popupHideDelayMs),
        GSM_HOSHIDICTS_SHOW_LOOKUP_COUNTS: showLookupCounts ? '1' : '0',
        GSM_HOSHIDICTS_SHOW_COMPACT_DEFINITION_SUMMARY:
            showCompactDefinitionSummary ? '1' : '0',
        GSM_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT:
            String(normalizedCompactDefinitionSummaryCount),
        GSM_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_DICTIONARY:
            typeof compactDefinitionSummaryDictionary === 'string' &&
            compactDefinitionSummaryDictionary.trim().length > 0 &&
            compactDefinitionSummaryDictionary.length <= 4096
                ? compactDefinitionSummaryDictionary
                : '',
        GSM_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA:
            showPitchAccentFurigana ? '1' : '0',
        GSM_HOSHIDICTS_PITCH_ACCENT_FURIGANA_DICTIONARY:
            typeof pitchAccentFuriganaDictionary === 'string' &&
            pitchAccentFuriganaDictionary.trim().length > 0 &&
            pitchAccentFuriganaDictionary.length <= 4096
                ? pitchAccentFuriganaDictionary
                : '',
        GSM_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE:
            showPitchAccentBadge ? '1' : '0',
        GSM_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS:
            hidePopupGrammarTags ? '1' : '0',
        GSM_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH: String(
            popupNestingMaxDepth
        ),
        GSM_HOSHIDICTS_DEFINITION_BLUR_ENABLED:
            normalizedDefinitionBlur.enabled ? '1' : '0',
        GSM_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD: String(
            normalizedDefinitionBlur.lookupThreshold
        ),
        GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_MODE:
            normalizedDefinitionBlur.revealMode,
        GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS: String(
            normalizedDefinitionBlur.revealDelayMs
        ),
        GSM_HOSHIDICTS_POPUP_WIDTH_PX: String(
            normalizeHoshidictsPopupDimension(
                popupWidthPx,
                MIN_HOSHIDICTS_POPUP_WIDTH_PX,
                MAX_HOSHIDICTS_POPUP_WIDTH_PX,
                DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX
            )
        ),
        GSM_HOSHIDICTS_POPUP_HEIGHT_PX: String(
            normalizeHoshidictsPopupDimension(
                popupHeightPx,
                MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
                MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
                DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX
            )
        ),
        GSM_HOSHIDICTS_POPUP_COLUMNS: String(
            normalizeHoshidictsPopupDimension(
                popupColumns,
                MIN_HOSHIDICTS_POPUP_COLUMNS,
                MAX_HOSHIDICTS_POPUP_COLUMNS,
                DEFAULT_HOSHIDICTS_POPUP_COLUMNS
            )
        ),
        GSM_HOSHIDICTS_THEME: isHoshidictsTheme(theme)
            ? theme
            : DEFAULT_HOSHIDICTS_THEME,
        GSM_HOSHIDICTS_POPUP_OPACITY_PERCENT: String(
            normalizeHoshidictsPopupDimension(
                popupOpacityPercent,
                MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
                MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT,
                DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT
            )
        ),
        GSM_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX: String(
            normalizeHoshidictsPopupDimension(
                popupBackdropBlurPx,
                MIN_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
                MAX_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
                DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX
            )
        ),
        GSM_HOSHIDICTS_POPUP_TOOLBAR_POSITION:
            isHoshidictsPopupToolbarPosition(popupToolbarPosition)
                ? popupToolbarPosition
                : DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
        GSM_HOSHIDICTS_SCAN_LENGTH: String(normalizedLookupControls.scanLength),
        GSM_HOSHIDICTS_MAX_RESULTS: String(normalizedLookupControls.maxResults),
        GSM_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY:
            normalizedLookupControls.sortFrequencyDictionary ?? '',
        GSM_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER:
            normalizedLookupControls.sortFrequencyDictionaryOrder,
        GSM_HOSHIDICTS_AVERAGE_FREQUENCY:
            normalizedLookupControls.averageFrequency ? '1' : '0',
        GSM_HOSHIDICTS_SHOW_FREQUENCY_DICTIONARY_NAMES:
            normalizedLookupControls.showFrequencyDictionaryNames ? '1' : '0',
    };
}

export function buildHoshidictsControlEnvironment(): Record<string, string> {
    const port = getHoshidictsControlPort();
    if (!port) {
        return {};
    }
    return {
        [HOSHIDICTS_CONTROL_ENV]: String(port),
    };
}

function removeOverlayControlEnvironment(env: NodeJS.ProcessEnv): void {
    for (const name of Object.keys(env)) {
        if (
            name.startsWith('GSM_BROKER_') ||
            name === 'GSM_CLIENT_ID' ||
            name === HOSHIDICTS_CONTROL_ENV
        ) {
            delete env[name];
        }
    }
}

export function buildOverlayProcessEnvironment(
    source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
    const env = { ...source };
    removeOverlayControlEnvironment(env);
    return env;
}

function spawnOverlayFromSource(
    overlayDir: string,
    env: NodeJS.ProcessEnv
) {
    if (
        process.platform === 'win32' ||
        /^[A-Za-z]:[\\/]/u.test(overlayDir) ||
        overlayDir.startsWith('\\\\')
    ) {
        return {
            command: 'cmd.exe',
            args: ['/d', '/s', '/c', 'npm run start'],
            options: {
                cwd: overlayDir,
                detached: false,
                stdio: 'ignore' as const,
                env,
            },
        };
    }

    return {
        command: 'npm',
        args: ['run', 'start'],
        options: {
            cwd: overlayDir,
            detached: false,
            stdio: 'ignore' as const,
            env,
        },
    };
}

function spawnSharedOverlayRuntime(
    spawn: typeof import('child_process').spawn,
    baseEnvironment: NodeJS.ProcessEnv,
    hoshidictsEnvironment: Record<string, string>
): ChildProcess {
    const overlayResourcesPath = getOverlayResourcesPath();
    const env: NodeJS.ProcessEnv = {
        ...baseEnvironment,
        GSM_OVERLAY_CHILD: '1',
        GSM_OVERLAY_SHARED_RUNTIME: '1',
        [OVERLAY_RESOURCES_ENV]: overlayResourcesPath,
        ...hoshidictsEnvironment,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    return spawn(
        process.execPath,
        [],
        {
            detached: false,
            stdio: 'ignore',
            env,
        }
    );
}

export async function runOverlayWithSource(
    source: OverlayLaunchSource = 'manual'
): Promise<boolean> {
    const hoshidictsEnabled = getConfiguredHoshidictsEnabled();
    let hoshidictsLookupMode: HoshidictsLookupMode = 'shift';
    let hoshidictsLookupControls = defaultHoshidictsLookupControls();
    let hoshidictsActivationKey = DEFAULT_HOSHIDICTS_ACTIVATION_KEY;
    let hoshidictsSourceHighlightEnabled =
        DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED;
    let hoshidictsOnlyScanJapaneseText =
        DEFAULT_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT;
    let hoshidictsPopupHideDelayMs = DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS;
    let hoshidictsShowLookupCounts = true;
    let hoshidictsShowCompactDefinitionSummary =
        DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY;
    let hoshidictsCompactDefinitionSummaryCount =
        DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT;
    let hoshidictsCompactDefinitionSummaryDictionary: string | null = null;
    let hoshidictsShowPitchAccentFurigana =
        DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA;
    let hoshidictsPitchAccentFuriganaDictionary: string | null =
        DEFAULT_HOSHIDICTS_PITCH_ACCENT_FURIGANA_DICTIONARY;
    let hoshidictsShowPitchAccentBadge =
        DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE;
    let hoshidictsHidePopupGrammarTags =
        DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS;
    let hoshidictsPopupNestingMaxDepth =
        DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH;
    let hoshidictsDefinitionBlur: HoshidictsDefinitionBlurPreferences = {
        ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
    };
    let hoshidictsPopupWidthPx = DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX;
    let hoshidictsPopupHeightPx = DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX;
    let hoshidictsPopupColumns = DEFAULT_HOSHIDICTS_POPUP_COLUMNS;
    let hoshidictsTheme: HoshidictsTheme = DEFAULT_HOSHIDICTS_THEME;
    let hoshidictsPopupOpacityPercent =
        DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT;
    let hoshidictsPopupBackdropBlurPx =
        DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX;
    let hoshidictsPopupToolbarPosition: HoshidictsPopupToolbarPosition =
        DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION;
    if (hoshidictsEnabled) {
        try {
            void hoshidictsCustomDictionarySyncProvider().catch(
                warnCustomDictionarySyncFailure
            );
        } catch (error) {
            warnCustomDictionarySyncFailure(error);
        }
        try {
            hoshidictsLookupMode =
                (await hoshidictsLookupModeProvider()) === 'hover'
                    ? 'hover'
                    : 'shift';
            hoshidictsLookupControls = normalizeHoshidictsLookupControls(
                await hoshidictsLookupControlsProvider()
            );
            const configuredActivationKey =
                await hoshidictsActivationKeyProvider();
            hoshidictsActivationKey = isHoshidictsActivationKey(
                configuredActivationKey
            )
                ? configuredActivationKey
                : DEFAULT_HOSHIDICTS_ACTIVATION_KEY;
            hoshidictsSourceHighlightEnabled =
                (await hoshidictsSourceHighlightProvider()) === true;
            hoshidictsOnlyScanJapaneseText =
                (await hoshidictsOnlyScanJapaneseTextProvider()) !== false;
            const configuredHideDelay = await hoshidictsPopupHideDelayProvider();
            hoshidictsPopupHideDelayMs =
                Number.isInteger(configuredHideDelay) &&
                configuredHideDelay >= 0 &&
                configuredHideDelay <= MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS
                    ? configuredHideDelay
                    : DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS;
            hoshidictsShowLookupCounts =
                (await hoshidictsShowLookupCountsProvider()) !== false;
            hoshidictsShowCompactDefinitionSummary =
                (await hoshidictsShowCompactDefinitionSummaryProvider()) === true;
            const configuredCompactDefinitionSummaryCount =
                await hoshidictsCompactDefinitionSummaryCountProvider();
            hoshidictsCompactDefinitionSummaryCount =
                Number.isInteger(configuredCompactDefinitionSummaryCount) &&
                configuredCompactDefinitionSummaryCount >=
                    MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT &&
                configuredCompactDefinitionSummaryCount <=
                    MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT
                    ? configuredCompactDefinitionSummaryCount
                    : DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT;
            const configuredCompactDefinitionSummaryDictionary =
                await hoshidictsCompactDefinitionSummaryDictionaryProvider();
            hoshidictsCompactDefinitionSummaryDictionary =
                typeof configuredCompactDefinitionSummaryDictionary === 'string' &&
                configuredCompactDefinitionSummaryDictionary.trim().length > 0 &&
                configuredCompactDefinitionSummaryDictionary.length <= 4096
                    ? configuredCompactDefinitionSummaryDictionary
                    : null;
            hoshidictsShowPitchAccentFurigana =
                (await hoshidictsShowPitchAccentFuriganaProvider()) !== false;
            const configuredPitchAccentFuriganaDictionary =
                await hoshidictsPitchAccentFuriganaDictionaryProvider();
            hoshidictsPitchAccentFuriganaDictionary =
                typeof configuredPitchAccentFuriganaDictionary === 'string' &&
                configuredPitchAccentFuriganaDictionary.trim().length > 0 &&
                configuredPitchAccentFuriganaDictionary.length <= 4096
                    ? configuredPitchAccentFuriganaDictionary
                    : null;
            hoshidictsShowPitchAccentBadge =
                (await hoshidictsShowPitchAccentBadgeProvider()) === true;
            hoshidictsHidePopupGrammarTags =
                (await hoshidictsHidePopupGrammarTagsProvider()) !== false;
            const configuredNestingMaxDepth =
                await hoshidictsPopupNestingMaxDepthProvider();
            hoshidictsPopupNestingMaxDepth =
                Number.isSafeInteger(configuredNestingMaxDepth) &&
                configuredNestingMaxDepth >= 0
                    ? configuredNestingMaxDepth
                    : DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH;
            hoshidictsDefinitionBlur = normalizeHoshidictsDefinitionBlur(
                await hoshidictsDefinitionBlurProvider()
            );
            hoshidictsPopupWidthPx = normalizeHoshidictsPopupDimension(
                await hoshidictsPopupWidthProvider(),
                MIN_HOSHIDICTS_POPUP_WIDTH_PX,
                MAX_HOSHIDICTS_POPUP_WIDTH_PX,
                DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX
            );
            hoshidictsPopupHeightPx = normalizeHoshidictsPopupDimension(
                await hoshidictsPopupHeightProvider(),
                MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
                MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
                DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX
            );
            hoshidictsPopupColumns = normalizeHoshidictsPopupDimension(
                await hoshidictsPopupColumnsProvider(),
                MIN_HOSHIDICTS_POPUP_COLUMNS,
                MAX_HOSHIDICTS_POPUP_COLUMNS,
                DEFAULT_HOSHIDICTS_POPUP_COLUMNS
            );
            const configuredTheme = await hoshidictsThemeProvider();
            hoshidictsTheme = isHoshidictsTheme(configuredTheme)
                ? configuredTheme
                : DEFAULT_HOSHIDICTS_THEME;
            hoshidictsPopupOpacityPercent =
                normalizeHoshidictsPopupDimension(
                    await hoshidictsPopupOpacityPercentProvider(),
                    MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
                    MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT,
                    DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT
                );
            hoshidictsPopupBackdropBlurPx =
                normalizeHoshidictsPopupDimension(
                    await hoshidictsPopupBackdropBlurPxProvider(),
                    MIN_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
                    MAX_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
                    DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX
                );
            const configuredPopupToolbarPosition =
                await hoshidictsPopupToolbarPositionProvider();
            hoshidictsPopupToolbarPosition =
                isHoshidictsPopupToolbarPosition(
                    configuredPopupToolbarPosition
                )
                    ? configuredPopupToolbarPosition
                    : DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION;
        } catch (error) {
            console.warn(
                '[Hoshidicts] Could not load reader preferences; using defaults.',
                error
            );
        }
    }
    const hoshidictsEnvironment = buildHoshidictsOverlayEnvironment(
        hoshidictsEnabled,
        hoshidictsLookupMode,
        hoshidictsPopupHideDelayMs,
        hoshidictsActivationKey,
        hoshidictsSourceHighlightEnabled,
        hoshidictsPopupNestingMaxDepth,
        hoshidictsDefinitionBlur,
        hoshidictsShowLookupCounts,
        hoshidictsShowCompactDefinitionSummary,
        hoshidictsCompactDefinitionSummaryCount,
        hoshidictsCompactDefinitionSummaryDictionary,
        hoshidictsPopupWidthPx,
        hoshidictsPopupHeightPx,
        hoshidictsPopupColumns,
        hoshidictsTheme,
        hoshidictsPopupOpacityPercent,
        hoshidictsOnlyScanJapaneseText,
        hoshidictsPopupToolbarPosition,
        hoshidictsLookupControls,
        hoshidictsHidePopupGrammarTags,
        hoshidictsShowPitchAccentFurigana,
        hoshidictsPitchAccentFuriganaDictionary,
        hoshidictsShowPitchAccentBadge,
        hoshidictsPopupBackdropBlurPx
    );
    const hoshidictsControlEnvironment = buildHoshidictsControlEnvironment();
    const overlayProcessEnvironment = buildOverlayProcessEnvironment();
    if (USE_IN_PROCESS_OVERLAY) {
        if (isInProcessOverlayRunning()) {
            console.log('Overlay is already running.');
            return true;
        }
        removeOverlayControlEnvironment(process.env);
        Object.assign(
            process.env,
            hoshidictsEnvironment,
            hoshidictsControlEnvironment
        );
        const started = await startInProcessOverlay();
        overlayLaunchSource = started ? source : null;
        overlayHoshidictsEnabledAtLaunch = started
            ? hoshidictsEnabled
            : null;
        overlayHoshidictsLookupModeAtLaunch = started
            ? hoshidictsLookupMode
            : null;
        overlayHoshidictsLookupControlsAtLaunch = started
            ? { ...hoshidictsLookupControls }
            : null;
        overlayHoshidictsActivationKeyAtLaunch = started
            ? hoshidictsActivationKey
            : null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = started
            ? hoshidictsSourceHighlightEnabled
            : null;
        overlayHoshidictsOnlyScanJapaneseTextAtLaunch = started
            ? hoshidictsOnlyScanJapaneseText
            : null;
        overlayHoshidictsPopupHideDelayAtLaunch = started
            ? hoshidictsPopupHideDelayMs
            : null;
        overlayHoshidictsShowLookupCountsAtLaunch = started
            ? hoshidictsShowLookupCounts
            : null;
        overlayHoshidictsShowCompactDefinitionSummaryAtLaunch = started
            ? hoshidictsShowCompactDefinitionSummary
            : null;
        overlayHoshidictsCompactDefinitionSummaryCountAtLaunch = started
            ? hoshidictsCompactDefinitionSummaryCount
            : null;
        overlayHoshidictsCompactDefinitionSummaryDictionaryAtLaunch = started
            ? hoshidictsCompactDefinitionSummaryDictionary
            : null;
        overlayHoshidictsShowPitchAccentFuriganaAtLaunch = started
            ? hoshidictsShowPitchAccentFurigana
            : null;
        overlayHoshidictsPitchAccentFuriganaDictionaryAtLaunch = started
            ? hoshidictsPitchAccentFuriganaDictionary
            : null;
        overlayHoshidictsShowPitchAccentBadgeAtLaunch = started
            ? hoshidictsShowPitchAccentBadge
            : null;
        overlayHoshidictsHidePopupGrammarTagsAtLaunch = started
            ? hoshidictsHidePopupGrammarTags
            : null;
        overlayHoshidictsAudioProfileRestartRequired = false;
        overlayHoshidictsPopupNestingMaxDepthAtLaunch = started
            ? hoshidictsPopupNestingMaxDepth
            : null;
        overlayHoshidictsDefinitionBlurAtLaunch = started
            ? { ...hoshidictsDefinitionBlur }
            : null;
        overlayHoshidictsPopupWidthAtLaunch = started
            ? hoshidictsPopupWidthPx
            : null;
        overlayHoshidictsPopupHeightAtLaunch = started
            ? hoshidictsPopupHeightPx
            : null;
        overlayHoshidictsPopupColumnsAtLaunch = started
            ? hoshidictsPopupColumns
            : null;
        overlayHoshidictsThemeAtLaunch = started ? hoshidictsTheme : null;
        overlayHoshidictsPopupOpacityPercentAtLaunch = started
            ? hoshidictsPopupOpacityPercent
            : null;
        overlayHoshidictsPopupBackdropBlurPxAtLaunch = started
            ? hoshidictsPopupBackdropBlurPx
            : null;
        overlayHoshidictsPopupToolbarPositionAtLaunch = started
            ? hoshidictsPopupToolbarPosition
            : null;
        overlayHoshidictsPopupButtonsApplied = started
            ? createDefaultHoshidictsPopupButtons()
            : null;
        overlayHoshidictsCustomPopupCssApplied = started
            ? DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS
            : null;
        return started;
    }

    if (overlayProcess && overlayProcess.exitCode === null) {
        console.log('Overlay is already running.');
        return true;
    }

    const { spawn } = await import('child_process');

    if (isDev) {
        const overlayDir = joinRuntimePath(getResourcesDir(), 'GSM_Overlay');
        const overlayPackagePath = joinRuntimePath(overlayDir, 'package.json');

        if (!fs.existsSync(overlayPackagePath)) {
            console.error('Overlay package.json not found at:', overlayPackagePath);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }

        const sourceLaunch = spawnOverlayFromSource(overlayDir, {
            ...overlayProcessEnvironment,
            ...hoshidictsEnvironment,
            ...hoshidictsControlEnvironment,
        });
        let processHandle: ChildProcess;
        try {
            processHandle = spawn(
                sourceLaunch.command,
                sourceLaunch.args,
                sourceLaunch.options
            );
        } catch (error) {
            console.error('Failed to launch overlay from source:', error);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }

        registerOverlayProcess(
            processHandle,
            source,
            hoshidictsEnabled,
            hoshidictsLookupMode,
            hoshidictsPopupHideDelayMs,
            hoshidictsActivationKey,
            hoshidictsSourceHighlightEnabled,
            hoshidictsOnlyScanJapaneseText,
            hoshidictsPopupNestingMaxDepth,
            hoshidictsDefinitionBlur,
            hoshidictsShowLookupCounts,
            hoshidictsShowCompactDefinitionSummary,
            hoshidictsCompactDefinitionSummaryCount,
            hoshidictsCompactDefinitionSummaryDictionary,
            hoshidictsPopupWidthPx,
            hoshidictsPopupHeightPx,
            hoshidictsPopupColumns,
            hoshidictsTheme,
            hoshidictsPopupOpacityPercent,
            hoshidictsPopupToolbarPosition,
            hoshidictsLookupControls,
            hoshidictsHidePopupGrammarTags,
            hoshidictsShowPitchAccentFurigana,
            hoshidictsPitchAccentFuriganaDictionary,
            hoshidictsShowPitchAccentBadge,
            hoshidictsPopupBackdropBlurPx
        );
        console.log('Overlay launched successfully from source.');
        return true;
    }

    const overlayAppAsarPath = getOverlayAppAsarPath();
    if (fs.existsSync(overlayAppAsarPath)) {
        try {
            const processHandle = spawnSharedOverlayRuntime(
                spawn,
                overlayProcessEnvironment,
                {
                    ...hoshidictsEnvironment,
                    ...hoshidictsControlEnvironment,
                }
            );
            registerOverlayProcess(
                processHandle,
                source,
                hoshidictsEnabled,
                hoshidictsLookupMode,
                hoshidictsPopupHideDelayMs,
                hoshidictsActivationKey,
                hoshidictsSourceHighlightEnabled,
                hoshidictsOnlyScanJapaneseText,
                hoshidictsPopupNestingMaxDepth,
                hoshidictsDefinitionBlur,
                hoshidictsShowLookupCounts,
                hoshidictsShowCompactDefinitionSummary,
                hoshidictsCompactDefinitionSummaryCount,
                hoshidictsCompactDefinitionSummaryDictionary,
                hoshidictsPopupWidthPx,
                hoshidictsPopupHeightPx,
                hoshidictsPopupColumns,
                hoshidictsTheme,
                hoshidictsPopupOpacityPercent,
            hoshidictsPopupToolbarPosition,
            hoshidictsLookupControls,
            hoshidictsHidePopupGrammarTags,
            hoshidictsShowPitchAccentFurigana,
            hoshidictsPitchAccentFuriganaDictionary,
            hoshidictsShowPitchAccentBadge,
            hoshidictsPopupBackdropBlurPx
        );
            console.log('Overlay launched successfully with shared Electron runtime.');
            return true;
        } catch (error) {
            console.error('Failed to launch overlay with shared Electron runtime:', error);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }
    }

    const overlayPath = joinRuntimePath(getOverlayPath(), getOverlayExecName());
    if (fs.existsSync(overlayPath)) {
        try {
            const processHandle = spawn(overlayPath, [], {
                detached: false,
                stdio: 'ignore',
                env: {
                    ...overlayProcessEnvironment,
                    ...hoshidictsEnvironment,
                    ...hoshidictsControlEnvironment,
                },
            });
            registerOverlayProcess(
                processHandle,
                source,
                hoshidictsEnabled,
                hoshidictsLookupMode,
                hoshidictsPopupHideDelayMs,
                hoshidictsActivationKey,
                hoshidictsSourceHighlightEnabled,
                hoshidictsOnlyScanJapaneseText,
                hoshidictsPopupNestingMaxDepth,
                hoshidictsDefinitionBlur,
                hoshidictsShowLookupCounts,
                hoshidictsShowCompactDefinitionSummary,
                hoshidictsCompactDefinitionSummaryCount,
                hoshidictsCompactDefinitionSummaryDictionary,
                hoshidictsPopupWidthPx,
                hoshidictsPopupHeightPx,
                hoshidictsPopupColumns,
                hoshidictsTheme,
                hoshidictsPopupOpacityPercent,
            hoshidictsPopupToolbarPosition,
            hoshidictsLookupControls,
            hoshidictsHidePopupGrammarTags,
            hoshidictsShowPitchAccentFurigana,
            hoshidictsPitchAccentFuriganaDictionary,
            hoshidictsShowPitchAccentBadge,
            hoshidictsPopupBackdropBlurPx
        );
            console.log('Overlay launched successfully with legacy standalone runtime.');
            return true;
        } catch (error) {
            console.error('Failed to launch overlay executable:', error);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }
    } else {
        console.error('Overlay app bundle not found at:', overlayAppAsarPath);
        console.error('Overlay executable not found at:', overlayPath);
        overlayProcess = null;
        overlayLaunchSource = null;
        return false;
    }
}

async function getAllOCRConfigs(): Promise<OCRGame[]> {
    // try {
    await getOBSConnection();
    const scenes = await getOBSScenes();
    return scenes
        .filter((scene) => fs.existsSync(getSceneOCRConfig(scene)))
        .map((scene) => {
            return {
                scene: scene,
                configPath: getSceneOCRConfig(scene),
            } as OCRGame;
        });
    //     const files = await fs.promises.readdir(OCR_CONFIG_DIR);
    //
    //     const configs = await Promise.all(
    //         files
    //             .filter(file => file.endsWith('.json'))
    //             .map(async file => {
    //             const filePath = path.join(OCR_CONFIG_DIR, file);
    //             const content = await fs.promises.readFile(filePath, 'utf-8');
    //             const json = JSON.parse(content);
    //             if (json.scene) {
    //                     return { scene: json.scene, configPath: filePath };
    //         }
    //                 return null;
    //             })
    //     );
    //
    //     // Filter out any null values
    //     return configs.filter(config => config !== null) as OCRGame[];
    // } catch (error) {
    //     console.error('Error getting OCR configs:', error);
    //     return [];
    // }
}
