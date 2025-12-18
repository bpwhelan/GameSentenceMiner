import {
	LineType,
	OnlineFont,
	Theme,
	type DialogResult,
	type LineItem,
	type ReplacementItem,
	type SettingPreset,
	type Settings,
} from './../types';

import { mdiHelpCircle } from '@mdi/js';
import { Subject } from 'rxjs';
import { writable } from 'svelte/store';
import { writableBooleanSubject } from './transformer/writeable-boolean-subject';
import { writableNumberSubject } from './transformer/writeable-number-subject';
import { writeableArraySubject } from './transformer/writeable-object-sibject';
import { writableStringSubject } from './transformer/writeable-string-subject';
import { writableSubject } from './transformer/writeable-subject';

export const defaultSettings: Settings = {
	theme$: Theme.BUSINESS,
	replacements$: [],
	windowTitle$: '',
	websocketUrl$: 'ws://localhost:55001',
	secondaryWebsocketUrl$: '',
	fontSize$: 32,
	characterMilestone$: 0,
	onlineFont$: OnlineFont.OFF,
	preventLastDuplicate$: 0,
	maxLines$: 1000,
	maxPipLines$: 1,
	afkTimer$: 0,
	adjustTimerOnAfk$: false,
	enableExternalClipboardMonitor$: false,
	showPresetQuickSwitch$: false,
	skipResetConfirmations$: false,
	persistStats$: true,
	persistNotes$: true,
	persistLines$: true,
	persistActionHistory$: false,
	enablePaste$: false,
	blockCopyOnPage$: false,
	allowPasteDuringPause$: false,
	allowNewLineDuringPause$: true,
	autoStartTimerDuringPausePaste$: false,
	autoStartTimerDuringPause$: false,
	preventGlobalDuplicate$: false,
	mergeEqualLineStarts$: false,
	filterNonCJKLines: false,
	flashOnMissedLine$: true,
	displayVertical$: false,
	reverseLineOrder$: false,
	preserveWhitespace$: true,
	removeAllWhitespace$: false,
	showTimer$: true,
	showSpeed$: true,
	showCharacterCount$: true,
	showLineCount$: true,
	blurStats$: false,
	enableLineAnimation$: false,
	enableAfkBlur$: false,
	enableAfkBlurRestart$: false,
	continuousReconnect$: true,
	showConnectionErrors$: false,
	customCSS$: '',
	autoTranslateLines$: false,
	blurAutoTranslatedLines$: false,
	unblurTLTimer$: 0,
	showScreenshotButton$: false,
	showTranslateButton$: true,
	showAudioButton$: true,
	showGSMCheckboxes$: true,
};

export const theme$ = writableStringSubject()('bannou-texthooker-theme', defaultSettings.theme$);

export const settingPresets$ = writeableArraySubject<SettingPreset>()('bannou-texthooker-settingPresets', []);

export const replacements$ = writeableArraySubject<ReplacementItem>()('bannou-texthooker-replacements', []);

export const windowTitle$ = writableStringSubject()('bannou-texthooker-windowTitle', defaultSettings.windowTitle$);

export const websocketUrl$ = writableStringSubject()('bannou-texthooker-websocketUrl', defaultSettings.websocketUrl$);

export const secondaryWebsocketUrl$ = writableStringSubject()(
	'bannou-texthooker-secondary-websocketUrl',
	defaultSettings.secondaryWebsocketUrl$
);

export const fontSize$ = writableNumberSubject()('bannou-texthooker-fontSize', defaultSettings.fontSize$);

export const characterMilestone$ = writableNumberSubject()(
	'bannou-texthooker-characterMilestone',
	defaultSettings.characterMilestone$
);

export const onlineFont$ = writableStringSubject()('bannou-texthooker-onlineFont', defaultSettings.onlineFont$);

export const preventLastDuplicate$ = writableNumberSubject()(
	'bannou-texthooker-preventLastDuplicate',
	defaultSettings.preventLastDuplicate$
);

export const maxLines$ = writableNumberSubject()('bannou-texthooker-maxLines', defaultSettings.maxLines$);

if (maxLines$.getValue() == 0) {
	maxLines$.next(1000);
}


export const maxPipLines$ = writableNumberSubject()('bannou-texthooker-maxPipLines', defaultSettings.maxPipLines$);

export const afkTimer$ = writableNumberSubject()('bannou-texthooker-afkTimer', defaultSettings.afkTimer$);

export const adjustTimerOnAfk$ = writableBooleanSubject()(
	'bannou-texthooker-adjustTimerOnAfk',
	defaultSettings.adjustTimerOnAfk$
);

export const enableExternalClipboardMonitor$ = writableBooleanSubject()(
	'bannou-texthooker-enableExternalClipboardMonitor',
	defaultSettings.enableExternalClipboardMonitor$
);

export const showPresetQuickSwitch$ = writableBooleanSubject()(
	'bannou-texthooker-showPresetQuickSwitch',
	defaultSettings.showPresetQuickSwitch$
);

export const skipResetConfirmations$ = writableBooleanSubject()(
	'bannou-texthooker-skipResetConfirmations',
	defaultSettings.skipResetConfirmations$
);

export const persistStats$ = writableBooleanSubject()('bannou-texthooker-persistStats', defaultSettings.persistStats$);

export const persistNotes$ = writableBooleanSubject()('bannou-texthooker-persistNotes', defaultSettings.persistNotes$);

export const persistLines$ = writableBooleanSubject()('bannou-texthooker-persistLines', defaultSettings.persistLines$);

export const persistActionHistory$ = writableBooleanSubject()(
	'bannou-texthooker-persistActionHistory',
	defaultSettings.persistActionHistory$
);

export const enablePaste$ = writableBooleanSubject()('bannou-texthooker-enablePaste', defaultSettings.enablePaste$);

export const blockCopyOnPage$ = writableBooleanSubject()(
	'bannou-texthooker-blockCopyOnPage',
	defaultSettings.blockCopyOnPage$
);

export const allowPasteDuringPause$ = writableBooleanSubject()(
	'bannou-texthooker-allowPasteDuringPause',
	defaultSettings.allowPasteDuringPause$
);

export const allowNewLineDuringPause$ = writableBooleanSubject()(
	'bannou-texthooker-allowNewLineDuringPause',
	defaultSettings.allowNewLineDuringPause$
);

export const autoStartTimerDuringPausePaste$ = writableBooleanSubject()(
	'bannou-texthooker-autoStartTimerDuringPausePaste',
	defaultSettings.autoStartTimerDuringPausePaste$
);

export const autoStartTimerDuringPause$ = writableBooleanSubject()(
	'bannou-texthooker-autoStartTimerDuringPause',
	defaultSettings.autoStartTimerDuringPause$
);

export const preventGlobalDuplicate$ = writableBooleanSubject()(
	'bannou-texthooker-preventGlobalDuplicate',
	defaultSettings.preventGlobalDuplicate$
);

export const mergeEqualLineStarts$ = writableBooleanSubject()(
	'bannou-texthooker-mergeEqualLineStarts',
	defaultSettings.mergeEqualLineStarts$
);

export const filterNonCJKLines$ = writableBooleanSubject()(
	'bannou-texthooker-filterNonCJKLines',
	defaultSettings.mergeEqualLineStarts$
);

export const flashOnMissedLine$ = writableBooleanSubject()(
	'bannou-texthooker-flashOnMissedLine',
	defaultSettings.flashOnMissedLine$
);

export const displayVertical$ = writableBooleanSubject()(
	'bannou-texthooker-displayVertical',
	defaultSettings.displayVertical$
);

export const reverseLineOrder$ = writableBooleanSubject()(
	'bannou-texthooker-reverseLineOrder',
	defaultSettings.reverseLineOrder$
);

export const preserveWhitespace$ = writableBooleanSubject()(
	'bannou-texthooker-preserveWhitespace',
	defaultSettings.preserveWhitespace$
);

export const removeAllWhitespace$ = writableBooleanSubject()(
	'bannou-texthooker-removeAllWhitespace',
	defaultSettings.removeAllWhitespace$
);

export const showTimer$ = writableBooleanSubject()('bannou-texthooker-showTimer', defaultSettings.showTimer$);

export const showSpeed$ = writableBooleanSubject()('bannou-texthooker-showSpeed', defaultSettings.showSpeed$);

export const showCharacterCount$ = writableBooleanSubject()(
	'bannou-texthooker-showCharacterCount',
	defaultSettings.showCharacterCount$
);

export const showLineCount$ = writableBooleanSubject()(
	'bannou-texthooker-showLineCount',
	defaultSettings.showLineCount$
);

export const blurStats$ = writableBooleanSubject()('bannou-texthooker-blurStats', defaultSettings.blurStats$);

export const enableLineAnimation$ = writableBooleanSubject()(
	'bannou-texthooker-enableLineAnimation',
	defaultSettings.enableLineAnimation$
);

export const enableAfkBlur$ = writableBooleanSubject()(
	'bannou-texthooker-enableAfkBlur',
	defaultSettings.enableAfkBlur$
);

export const enableAfkBlurRestart$ = writableBooleanSubject()(
	'bannou-texthooker-enableAfkBlurRestart',
	defaultSettings.enableAfkBlurRestart$
);

export const continuousReconnect$ = writableBooleanSubject()(
	'bannou-texthooker-continuousReconnect',
	defaultSettings.continuousReconnect$
);

export const showConnectionErrors$ = writableBooleanSubject()(
	'bannou-texthooker-showConnectionErrors',
	defaultSettings.showConnectionErrors$
);

export const customCSS$ = writableStringSubject()('bannou-texthooker-customCSS', defaultSettings.customCSS$);

export const timeValue$ = writableNumberSubject()('bannou-texthooker-timeValue', 0, persistStats$);

export const notesOpen$ = writableSubject<boolean>(false);

export const userNotes$ = writableStringSubject()('bannou-texthooker-userNotes', '', persistNotes$);

export const socketState$ = writableSubject<number>(-1);

export const secondarySocketState$ = writableSubject<number>(-1);

export const openDialog$ = writableSubject<Record<string, any>>(undefined);

export const dialogOpen$ = writableSubject<boolean>(false);

export const lastSettingPreset$ = writableStringSubject()('bannou-texthooker-lastSettingPreset', '');

export const lineData$ = writeableArraySubject<LineItem>()('bannou-texthooker-lineData', [], persistLines$);

export const lineIDs$ = writeableArraySubject<string>()('bannou-texthooker-lineIDs', []);

export const timedOutIDs$ = writeableArraySubject<string>()('bannou-texthooker-timedOutIDs', []);

export const milestoneLines$ = writable<Map<string, string>>(new Map<string, string>());

export const actionHistory$ = writeableArraySubject<LineItem[]>()(
	'bannou-texthooker-actionHistory',
	[],
	persistActionHistory$
);

export const flashOnPauseTimeout$ = writable<number>(undefined);

export const isPaused$ = writableSubject<boolean>(true);

export const newLine$ = new Subject<[string, LineType, string]>();

export const reconnectSocket$ = new Subject<void>();

export const reconnectSecondarySocket$ = new Subject<void>();

export const showSpinner$ = writable<boolean>(false);

export const enabledReplacements$ = writable<ReplacementItem[]>([]);

export const autoTranslateLines$ = writableBooleanSubject()('bannou-texthooker-autoTranslateLines', false);

export const blurAutoTranslatedLines$ = writableBooleanSubject()('bannou-texthooker-blurAutoTranslatedLines', false);

export const unblurTLTimer$ = writableNumberSubject()('bannou-texthooker-unblurTLTimer', 0);

export const showScreenshotButton$ = writableBooleanSubject()('bannou-texthooker-showScreenshotButton', false);

export const showTranslateButton$ = writableBooleanSubject()('bannou-texthooker-showTranslateButton', true);

export const showAudioButton$ = writableBooleanSubject()('bannou-texthooker-showAudioButton', true);

export const showGSMCheckboxes$ = writableBooleanSubject()('bannou-texthooker-showGSMCheckboxes', true);

export const lastPipHeight$ = writableNumberSubject()('bannou-texthooker-lastPipHeight', 0);

export const lastPipWidth$ = writableNumberSubject()('bannou-texthooker-lastPipWidth', 0);

export async function resetAllData() {
	if (!skipResetConfirmations$.getValue()) {
		const { canceled } = await new Promise<DialogResult>((resolve) => {
			openDialog$.next({
				icon: mdiHelpCircle,
				message: 'All Settings and Data will be reset',
				callback: resolve,
			});
		});

		if (canceled) {
			return;
		}
	}

	lastSettingPreset$.next('');
	settingPresets$.next([]);
	isPaused$.next(true);
	timeValue$.next(0);
	userNotes$.next('');
	lineData$.next([]);
	actionHistory$.next([]);
	flashOnPauseTimeout$.set(undefined);

	window.localStorage.removeItem('bannou-texthooker-timeValue');
	window.localStorage.removeItem('bannou-texthooker-userNotes');
	window.localStorage.removeItem('bannou-texthooker-lineData');
	window.localStorage.removeItem('bannou-texthooker-actionHistory');

	theme$.next(defaultSettings.theme$);
	replacements$.next(defaultSettings.replacements$);
	windowTitle$.next(defaultSettings.windowTitle$);
	websocketUrl$.next(defaultSettings.websocketUrl$);
	secondaryWebsocketUrl$.next(defaultSettings.secondaryWebsocketUrl$);
	fontSize$.next(defaultSettings.fontSize$);
	characterMilestone$.next(defaultSettings.characterMilestone$);
	onlineFont$.next(defaultSettings.onlineFont$);
	preventLastDuplicate$.next(defaultSettings.preventLastDuplicate$);
	maxPipLines$.next(defaultSettings.maxPipLines$);
	afkTimer$.next(defaultSettings.afkTimer$);
	adjustTimerOnAfk$.next(defaultSettings.adjustTimerOnAfk$);
	enableExternalClipboardMonitor$.next(defaultSettings.enableExternalClipboardMonitor$);
	showPresetQuickSwitch$.next(defaultSettings.showPresetQuickSwitch$);
	skipResetConfirmations$.next(defaultSettings.skipResetConfirmations$);
	persistStats$.next(defaultSettings.persistStats$);
	persistNotes$.next(defaultSettings.persistNotes$);
	persistLines$.next(defaultSettings.persistLines$);
	persistActionHistory$.next(defaultSettings.persistActionHistory$);
	enablePaste$.next(defaultSettings.enablePaste$);
	blockCopyOnPage$.next(defaultSettings.blockCopyOnPage$);
	allowPasteDuringPause$.next(defaultSettings.allowPasteDuringPause$);
	allowNewLineDuringPause$.next(defaultSettings.allowNewLineDuringPause$);
	autoStartTimerDuringPausePaste$.next(defaultSettings.autoStartTimerDuringPausePaste$);
	autoStartTimerDuringPause$.next(defaultSettings.autoStartTimerDuringPause$);
	preventGlobalDuplicate$.next(defaultSettings.preventGlobalDuplicate$);
	mergeEqualLineStarts$.next(defaultSettings.mergeEqualLineStarts$);
	filterNonCJKLines$.next(defaultSettings.filterNonCJKLines);
	flashOnMissedLine$.next(defaultSettings.flashOnMissedLine$);
	displayVertical$.next(defaultSettings.displayVertical$);
	reverseLineOrder$.next(defaultSettings.reverseLineOrder$);
	preserveWhitespace$.next(defaultSettings.preserveWhitespace$);
	removeAllWhitespace$.next(defaultSettings.removeAllWhitespace$);
	showTimer$.next(defaultSettings.showTimer$);
	showSpeed$.next(defaultSettings.showSpeed$);
	showCharacterCount$.next(defaultSettings.showCharacterCount$);
	showLineCount$.next(defaultSettings.showLineCount$);
	blurStats$.next(defaultSettings.blurStats$);
	enableLineAnimation$.next(defaultSettings.enableLineAnimation$);
	enableAfkBlur$.next(defaultSettings.enableAfkBlur$);
	enableAfkBlurRestart$.next(defaultSettings.enableAfkBlurRestart$);
	continuousReconnect$.next(defaultSettings.continuousReconnect$);
	showConnectionErrors$.next(defaultSettings.showConnectionErrors$);
	customCSS$.next(defaultSettings.customCSS$);
	autoTranslateLines$.next(defaultSettings.autoTranslateLines$);
	blurAutoTranslatedLines$.next(defaultSettings.blurAutoTranslatedLines$);
	unblurTLTimer$.next(defaultSettings.unblurTLTimer$);
	showScreenshotButton$.next(defaultSettings.showScreenshotButton$);
	showTranslateButton$.next(defaultSettings.showTranslateButton$);
	showAudioButton$.next(defaultSettings.showAudioButton$);
	showGSMCheckboxes$.next(defaultSettings.showGSMCheckboxes$);
}