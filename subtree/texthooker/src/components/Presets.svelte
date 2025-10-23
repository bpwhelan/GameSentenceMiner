<script lang="ts">
	import { mdiContentSave, mdiDatabaseSync, mdiDelete, mdiHelpCircle, mdiReload } from '@mdi/js';
	import { createEventDispatcher, tick } from 'svelte';
	import {
		adjustTimerOnAfk$,
		afkTimer$,
		allowNewLineDuringPause$,
		allowPasteDuringPause$,
		autoStartTimerDuringPause$,
		autoStartTimerDuringPausePaste$,
		blockCopyOnPage$,
		blurStats$,
		characterMilestone$,
		continuousReconnect$,
		customCSS$,
		defaultSettings,
		displayVertical$,
		enableAfkBlur$,
		enableAfkBlurRestart$,
		enableExternalClipboardMonitor$,
		enableLineAnimation$,
		enablePaste$,
		filterNonCJKLines$,
		flashOnMissedLine$,
		fontSize$,
		lastSettingPreset$,
		maxLines$,
		maxPipLines$,
		mergeEqualLineStarts$,
		milestoneLines$,
		onlineFont$,
		openDialog$,
		persistActionHistory$,
		persistLines$,
		persistNotes$,
		persistStats$,
		preserveWhitespace$,
		preventGlobalDuplicate$,
		preventLastDuplicate$,
		reconnectSecondarySocket$,
		reconnectSocket$,
		removeAllWhitespace$,
		replacements$,
		reverseLineOrder$,
		secondarySocketState$,
		secondaryWebsocketUrl$,
		settingPresets$,
		showCharacterCount$,
		showConnectionErrors$,
		showLineCount$,
		showPresetQuickSwitch$,
		showSpeed$,
		showTimer$,
		skipResetConfirmations$,
		socketState$,
		theme$,
		websocketUrl$,
		windowTitle$,
	} from '../stores/stores';
	import type { DialogResult, SettingPreset, Settings } from '../types';
	import { dummyFn } from '../util';
	import Icon from './Icon.svelte';

	export let isQuickSwitch = false;

	export function getCurrentSettings(): Settings {
		return {
			theme$: $theme$,
			replacements$: $replacements$,
			windowTitle$: $windowTitle$,
			websocketUrl$: $websocketUrl$,
			secondaryWebsocketUrl$: $secondaryWebsocketUrl$,
			fontSize$: $fontSize$,
			characterMilestone$: $characterMilestone$,
			onlineFont$: $onlineFont$,
			preventLastDuplicate$: $preventLastDuplicate$,
			maxLines$: $maxLines$,
			maxPipLines$: $maxPipLines$,
			afkTimer$: $afkTimer$,
			adjustTimerOnAfk$: $adjustTimerOnAfk$,
			enableExternalClipboardMonitor$: $enableExternalClipboardMonitor$,
			showPresetQuickSwitch$: $showPresetQuickSwitch$,
			skipResetConfirmations$: $skipResetConfirmations$,
			persistStats$: $persistStats$,
			persistNotes$: $persistNotes$,
			persistLines$: $persistLines$,
			persistActionHistory$: $persistActionHistory$,
			enablePaste$: $enablePaste$,
			blockCopyOnPage$: $blockCopyOnPage$,
			allowPasteDuringPause$: $allowPasteDuringPause$,
			allowNewLineDuringPause$: $allowNewLineDuringPause$,
			autoStartTimerDuringPausePaste$: $autoStartTimerDuringPausePaste$,
			autoStartTimerDuringPause$: $autoStartTimerDuringPause$,
			preventGlobalDuplicate$: $preventGlobalDuplicate$,
			mergeEqualLineStarts$: $mergeEqualLineStarts$,
			filterNonCJKLines: $filterNonCJKLines$,
			flashOnMissedLine$: $flashOnMissedLine$,
			displayVertical$: $displayVertical$,
			reverseLineOrder$: $reverseLineOrder$,
			preserveWhitespace$: $preserveWhitespace$,
			removeAllWhitespace$: $removeAllWhitespace$,
			showTimer$: $showTimer$,
			showSpeed$: $showSpeed$,
			showCharacterCount$: $showCharacterCount$,
			showLineCount$: $showLineCount$,
			blurStats$: $blurStats$,
			enableLineAnimation$: $enableLineAnimation$,
			enableAfkBlur$: $enableAfkBlur$,
			enableAfkBlurRestart$: $enableAfkBlurRestart$,
			continuousReconnect$: $continuousReconnect$,
			showConnectionErrors$: $showConnectionErrors$,
			customCSS$: $customCSS$,
		};
	}

	export function updateSettingsWithPreset(preset: SettingPreset, updateLastPreset = true) {
		theme$.next(preset.settings.theme$ ?? defaultSettings.theme$);
		replacements$.next(preset.settings.replacements$ ?? defaultSettings.replacements$);
		windowTitle$.next(preset.settings.windowTitle$ ?? defaultSettings.windowTitle$);
		websocketUrl$.next(preset.settings.websocketUrl$ ?? defaultSettings.websocketUrl$);
		secondaryWebsocketUrl$.next(preset.settings.secondaryWebsocketUrl$ ?? '');
		fontSize$.next(preset.settings.fontSize$ ?? defaultSettings.fontSize$);
		characterMilestone$.next(preset.settings.characterMilestone$ ?? defaultSettings.characterMilestone$);
		onlineFont$.next(preset.settings.onlineFont$ ?? defaultSettings.onlineFont$);
		preventLastDuplicate$.next(preset.settings.preventLastDuplicate$ ?? defaultSettings.preventLastDuplicate$);
		maxLines$.next(preset.settings.maxLines$ ?? defaultSettings.maxLines$);
		maxPipLines$.next(preset.settings.maxPipLines$ ?? defaultSettings.maxPipLines$);
		afkTimer$.next(preset.settings.afkTimer$ ?? defaultSettings.afkTimer$);
		adjustTimerOnAfk$.next(preset.settings.adjustTimerOnAfk$ ?? defaultSettings.adjustTimerOnAfk$);
		enableExternalClipboardMonitor$.next(
			preset.settings.enableExternalClipboardMonitor$ ?? defaultSettings.enableExternalClipboardMonitor$,
		);
		showPresetQuickSwitch$.next(preset.settings.showPresetQuickSwitch$ ?? defaultSettings.showPresetQuickSwitch$);
		skipResetConfirmations$.next(
			preset.settings.skipResetConfirmations$ ?? defaultSettings.skipResetConfirmations$,
		);
		persistStats$.next(preset.settings.persistStats$ ?? defaultSettings.persistStats$);
		persistNotes$.next(preset.settings.persistNotes$ ?? defaultSettings.persistNotes$);
		persistLines$.next(preset.settings.persistLines$ ?? defaultSettings.persistLines$);
		persistActionHistory$.next(preset.settings.persistActionHistory$ ?? defaultSettings.persistActionHistory$);
		enablePaste$.next(preset.settings.enablePaste$ ?? defaultSettings.enablePaste$);
		blockCopyOnPage$.next(preset.settings.blockCopyOnPage$ ?? defaultSettings.blockCopyOnPage$);
		allowPasteDuringPause$.next(preset.settings.allowPasteDuringPause$ ?? defaultSettings.allowPasteDuringPause$);
		allowNewLineDuringPause$.next(
			preset.settings.allowNewLineDuringPause$ ?? defaultSettings.allowNewLineDuringPause$,
		);
		autoStartTimerDuringPausePaste$.next(
			preset.settings.autoStartTimerDuringPausePaste$ ?? defaultSettings.autoStartTimerDuringPausePaste$,
		);
		autoStartTimerDuringPause$.next(
			preset.settings.autoStartTimerDuringPause$ ?? defaultSettings.autoStartTimerDuringPause$,
		);
		preventGlobalDuplicate$.next(
			preset.settings.preventGlobalDuplicate$ ?? defaultSettings.preventGlobalDuplicate$,
		);
		mergeEqualLineStarts$.next(preset.settings.mergeEqualLineStarts$ ?? defaultSettings.mergeEqualLineStarts$);
		filterNonCJKLines$.next(preset.settings.filterNonCJKLines ?? defaultSettings.filterNonCJKLines);
		flashOnMissedLine$.next(preset.settings.flashOnMissedLine$ ?? defaultSettings.flashOnMissedLine$);
		displayVertical$.next(preset.settings.displayVertical$ ?? defaultSettings.displayVertical$);
		reverseLineOrder$.next(preset.settings.reverseLineOrder$ ?? defaultSettings.reverseLineOrder$);
		preserveWhitespace$.next(preset.settings.preserveWhitespace$ ?? defaultSettings.preserveWhitespace$);
		removeAllWhitespace$.next(preset.settings.removeAllWhitespace$ ?? defaultSettings.removeAllWhitespace$);
		showTimer$.next(preset.settings.showTimer$ ?? defaultSettings.showTimer$);
		showSpeed$.next(preset.settings.showSpeed$ ?? defaultSettings.showSpeed$);
		showCharacterCount$.next(preset.settings.showCharacterCount$ ?? defaultSettings.showCharacterCount$);
		showLineCount$.next(preset.settings.showLineCount$ ?? defaultSettings.showLineCount$);
		blurStats$.next(preset.settings.blurStats$ ?? defaultSettings.blurStats$);
		enableLineAnimation$.next(preset.settings.enableLineAnimation$ ?? defaultSettings.enableLineAnimation$);
		enableAfkBlur$.next(preset.settings.enableAfkBlur$ ?? defaultSettings.enableAfkBlur$);
		enableAfkBlurRestart$.next(preset.settings.enableAfkBlurRestart$ ?? defaultSettings.enableAfkBlurRestart$);
		continuousReconnect$.next(preset.settings.continuousReconnect$ ?? defaultSettings.continuousReconnect$);
		showConnectionErrors$.next(preset.settings.showConnectionErrors$ ?? defaultSettings.showConnectionErrors$);
		customCSS$.next(preset.settings.customCSS$ ?? defaultSettings.customCSS$);

		if (updateLastPreset) {
			$lastSettingPreset$ = preset.name;
		}

		if ($characterMilestone$ === 0) {
			$milestoneLines$ = new Map<string, string>();
		}

		tick().then(() => {
			dispatch('layoutChange');

			if ($socketState$ !== 1 && $continuousReconnect$) {
				reconnectSocket$.next();
			}

			if ($secondarySocketState$ !== 1 && $continuousReconnect$) {
				reconnectSecondarySocket$.next();
			}
		});
	}

	const fallbackPresetEntry = [{ name: '' }];
	const dispatch = createEventDispatcher<{ layoutChange: void; exportImportPreset: MouseEvent }>();

	function selectPreset(event: Event) {
		const target = event.target as HTMLSelectElement;

		changePreset(target.selectedOptions[0].value);
	}

	function changePreset(presetName: string) {
		const existingEntry = $settingPresets$.find((entry) => entry.name === presetName);

		if (existingEntry) {
			updateSettingsWithPreset(existingEntry);
		}
	}

	async function savePreset() {
		const { canceled, data } = await new Promise<DialogResult<string>>((resolve) => {
			$openDialog$ = {
				icon: mdiHelpCircle,
				askForData: 'text',
				dataValue: $lastSettingPreset$ || 'Preset Name',
				message: '',
				callback: resolve,
			};
		});

		if (canceled || !data) {
			return;
		}

		const existingEntryIndex = $settingPresets$.findIndex((entry) => entry.name === data);
		const entry: SettingPreset = {
			name: data,
			settings: getCurrentSettings(),
		};

		if (existingEntryIndex > -1) {
			$settingPresets$[existingEntryIndex] = entry;
		} else {
			$settingPresets$ = [...$settingPresets$, entry];
		}

		$lastSettingPreset$ = data;
	}

	async function deletePreset() {
		if (!$skipResetConfirmations$) {
			const { canceled } = await new Promise<DialogResult>((resolve) => {
				$openDialog$ = {
					icon: mdiHelpCircle,
					message: 'Preset will be deleted',
					callback: resolve,
				};
			});

			if (canceled) {
				return;
			}
		}

		$settingPresets$ = $settingPresets$.filter((entry) => entry.name !== $lastSettingPreset$);
		$lastSettingPreset$ = '';
	}
</script>

{#if isQuickSwitch}
	<select
		class="w-48 hidden sm:block"
		class:sm:hidden={!$showPresetQuickSwitch$ || $settingPresets$.length < 2}
		value={$lastSettingPreset$}
		on:change={selectPreset}
	>
		{#each $settingPresets$.length ? $settingPresets$ : fallbackPresetEntry as preset (preset.name)}
			<option value={preset.name}>
				{preset.name}
			</option>
		{/each}
	</select>
{:else}
	<details role="button" class="col-span-4 mb-2">
		<summary>Presets</summary>
		<div class="flex items-center justify-between mt-2">
			<select class="select flex-1 max-w-md" value={$lastSettingPreset$} on:change={selectPreset}>
				{#each $settingPresets$.length ? $settingPresets$ : fallbackPresetEntry as preset (preset.name)}
					<option value={preset.name}>
						{preset.name || 'No Presets stored'}
					</option>
				{/each}
			</select>
			<div
				role="button"
				class="flex flex-col items-center hover:text-primary ml-3"
				on:click={savePreset}
				on:keyup={dummyFn}
			>
				<Icon path={mdiContentSave} />
				<span class="label-text">Save</span>
			</div>
			<div
				role="button"
				class="flex flex-col items-center hover:text-primary ml-3"
				on:click={(event) => dispatch('exportImportPreset', event)}
				on:keyup={dummyFn}
			>
				<Icon path={mdiDatabaseSync} />
				<span class="label-text">Export/Import</span>
			</div>
			<div
				role="button"
				class="flex flex-col items-center hover:text-primary ml-3"
				class:invisible={!$lastSettingPreset$}
				on:click={() => changePreset($lastSettingPreset$)}
				on:keyup={dummyFn}
			>
				<Icon path={mdiReload} />
				<span class="label-text">Reload</span>
			</div>
			<div
				role="button"
				class="flex flex-col items-center hover:text-primary ml-3"
				class:invisible={!$lastSettingPreset$}
				on:click={deletePreset}
				on:keyup={dummyFn}
			>
				<Icon path={mdiDelete} />
				<span class="label-text">Delete</span>
			</div>
		</div>
	</details>
{/if}
