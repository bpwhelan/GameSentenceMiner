<script lang="ts">
	import {
		mdiClose,
		mdiDatabaseSync,
		mdiDelete,
		mdiHelpCircle,
		mdiTimerCancel,
		mdiTimerEdit,
		mdiWeatherNight,
		mdiWhiteBalanceSunny,
	} from '@mdi/js';
	import { createEventDispatcher, tick } from 'svelte';
	import {
		actionHistory$,
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
		dialogOpen$,
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
		lineData$,
		maxLines$,
		maxPipLines$,
		mergeEqualLineStarts$,
		milestoneLines$,
		newLine$,
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
		resetAllData,
		reverseLineOrder$,
		secondaryWebsocketUrl$,
		settingPresets$,
		showCharacterCount$,
		showConnectionErrors$,
		showLineCount$,
		showPresetQuickSwitch$,
		showSpeed$,
		showSpinner$,
		showTimer$,
		skipResetConfirmations$,
		theme$,
		timeValue$,
		userNotes$,
		websocketUrl$,
		windowTitle$,
		autoTranslateLines$,
		blurAutoTranslatedLines$,
	} from '../stores/stores';
	import {
		LineType,
		OnlineFont,
		Theme,
		type DialogResult,
		type ExportedData,
		type ExportedSettings,
		type LineItem,
		type SettingPreset,
	} from '../types';
	import { clickOutside } from '../use-click-outside';
	import { applyCustomCSS, dummyFn, timeStringToSeconds } from '../util';
	import Icon from './Icon.svelte';
	import Presets from './Presets.svelte';
	import ReplacementSettings from './ReplacementSettings.svelte';
	import { getGSMEndpoint } from '../gsm';

	export let selectedLineIds: string[];
	export let settingsOpen: boolean;
	export let settingsElement: SVGElement;
	export let pipAvailable: boolean;

	export async function handleReset(linesOnly: boolean) {
		if (!$skipResetConfirmations$) {
			const { canceled } = await new Promise<DialogResult>((resolve) => {
				$openDialog$ = {
					icon: mdiHelpCircle,
					message: linesOnly
						? 'All displayed and stored Lines will be cleared'
						: 'Clear stored Lines + set Timer to 00:00:00',
					callback: resolve,
				};
			});

			if (canceled) {
				return;
			}
		}

		$lineData$ = [];
		selectedLineIds = [];
		window.localStorage.removeItem('bannou-texthooker-lineData');

		if (!linesOnly) {
			$timeValue$ = 0;
		}
	}

	const dispatch = createEventDispatcher<{ layoutChange: void; maxLinesChange: void }>();
	const onlineFonts = [
		OnlineFont.OFF,
		OnlineFont.NOTO,
		OnlineFont.KLEE,
		OnlineFont.SHIPPORI,
		OnlineFont.ACKAISYO,
		OnlineFont.CINECAPTION226,
	];

	let dataFileInput: HTMLInputElement;
	let settingsFileInput: HTMLInputElement;
	let presetFileInput: HTMLInputElement;
	let presetComponent: Presets;
	let clipboardMutationObserver: MutationObserver | undefined;

	$: websocketUrl = $websocketUrl$;

	$: secondaryWebsocketUrl = "";

	$: document.body.dataset.theme = $theme$;

	$: updateExternalClipboardMonitor($enableExternalClipboardMonitor$);

	$: applyCustomCSS(document, $customCSS$);

	$: getWebsocketPort().then((port) => {
		// If Protocol is https, do not replace, let them do whatever
		if (window.location.protocol === 'https:') {
			return;
		}
		const hostname = window.location.hostname;
			if (port && $websocketUrl$ !== `ws://${hostname}:${port}`) {
				$websocketUrl$ = `ws://${hostname}:${port}`;
			}
		});

	function handleSecondaryWebsocketChange(event: Event) {
		const target = event.target as HTMLInputElement;

		target.setCustomValidity('');

		if (secondaryWebsocketUrl === websocketUrl) {
			target.setCustomValidity('Duplicate Websocket');
			secondaryWebsocketUrl = '';
			$secondaryWebsocketUrl$ = '';
		} else {
			$secondaryWebsocketUrl$ = target.value;
		}

		target.reportValidity();
	}

	function updateExternalClipboardMonitor(enableExternalClipboardMonitor: boolean) {
		if (enableExternalClipboardMonitor && !clipboardMutationObserver) {
			tick().then(() => {
				clipboardMutationObserver = new MutationObserver(clipboardMutationObserverCallback);
				clipboardMutationObserver.observe(document.body, { childList: true });
			});
		} else if (!enableExternalClipboardMonitor && clipboardMutationObserver) {
			clipboardMutationObserver.disconnect();
			clipboardMutationObserver = undefined;
		}
	}

	function clipboardMutationObserverCallback(mutations: MutationRecord[]) {
		for (let index = 0, { length } = mutations; index < length; index += 1) {
			const { addedNodes } = mutations[index];

			for (let index2 = 0, { length: length2 } = addedNodes; index2 < length2; index2 += 1) {
				const addedNode = addedNodes[index] as HTMLElement;

				if (addedNode?.tagName === 'P') {
					newLine$.next([addedNode.textContent, LineType.EXTERNAL, '']);
					addedNode.remove();
				}
			}
		}
	}

	function updateCustomCSS(customCSS: string) {
		const textNode = document.createTextNode(customCSS);

		let styleElement = document.getElementById('user-css');

		if (styleElement) {
			styleElement.replaceChild(textNode, styleElement.firstChild);
		} else {
			styleElement = document.createElement('style');
			styleElement.id = 'user-css';

			styleElement.appendChild(textNode);
			document.head.append(styleElement);
		}
	}

	function handleSettingsClick(event: MouseEvent) {
		const target = event.target as any;

		if (
			!$showSpinner$ &&
			target !== settingsElement &&
			target.parentElement !== settingsElement &&
			target !== dataFileInput &&
			target !== settingsFileInput &&
			target !== presetFileInput &&
			!$dialogOpen$
		) {
			settingsOpen = false;
		}
	}

	async function handleSetTimer() {
		const { canceled, data } = await new Promise<DialogResult<string>>((resolve) => {
			$openDialog$ = {
				icon: mdiHelpCircle,
				askForData: 'text',
				dataValue: '00:00:00',
				message: 'New Time',
				callback: resolve,
			};
		});

		if (canceled) {
			return;
		}

		if (!/^[\d]{1,}:[\d]{1,2}:[\d]{1,2}$/.test(data)) {
			return new Promise<DialogResult<string>>((resolve) => {
				$openDialog$ = {
					icon: mdiClose,
					type: 'error',
					message: 'Invalid Time value (x:xx:xx)',
					showCancel: false,
					callback: resolve,
				};
			});
		}

		$timeValue$ = timeStringToSeconds(data);
	}

	async function handleResetTimer() {
		if (!$skipResetConfirmations$) {
			const { canceled } = await new Promise<DialogResult>((resolve) => {
				$openDialog$ = {
					icon: mdiHelpCircle,
					message: 'Timer will be set to 00:00:00',
					callback: resolve,
				};
			});

			if (canceled) {
				return;
			}
		}

		$timeValue$ = 0;
	}

	async function handleExportImportData(event: MouseEvent) {
		if (event.altKey) {
			await handleImport(dataFileInput, 'Existing Data will be overwritten');
		} else {
			handleExport<ExportedData>('texthooker-ui_data.json', {
				'bannou-texthooker-timeValue': $timeValue$,
				'bannou-texthooker-userNotes': $userNotes$,
				'bannou-texthooker-lineData': $lineData$,
				'bannou-texthooker-actionHistory': $actionHistory$,
			});
		}
	}

	async function handleExportImportSettings(event: MouseEvent) {
		if (event.altKey) {
			await handleImport(settingsFileInput, 'Presets, Settings etc. will be overwritten');
		} else {
			handleExport<ExportedSettings>('texthooker-ui_settings.json', {
				currentSettings: presetComponent.getCurrentSettings(),
				settingPresets: $settingPresets$,
				lastSettingsPreset: $lastSettingPreset$,
			});
		}
	}

	async function handleExportImportPreset(event: MouseEvent) {
		if (event.altKey) {
			await handleImport(presetFileInput, 'Preset will be overwritten or otherwise added');
		} else if ($lastSettingPreset$) {
			const existingEntry = $settingPresets$.find((entry) => entry.name === $lastSettingPreset$);

			if (existingEntry) {
				handleExport<SettingPreset>('texthooker-ui_preset.json', {
					name: existingEntry.name,
					settings: existingEntry.settings,
				});
			}
		}
	}

	async function handleDataFileChange() {
		const data = await loadFile<ExportedData>(dataFileInput).catch(({ message }) => {
			$openDialog$ = {
				type: 'error',
				message,
				showCancel: false,
			};
		});

		if (data) {
			const entries = Object.entries(data);

			for (let index = 0, { length } = entries; index < length; index += 1) {
				const [key, value] = entries[index];

				switch (key) {
					case 'bannou-texthooker-timeValue':
						$timeValue$ = value;
						break;
					case 'bannou-texthooker-userNotes':
						$userNotes$ = value;
						break;
					case 'bannou-texthooker-lineData':
						$lineData$ = value;
						break;
					case 'bannou-texthooker-actionHistory':
						$actionHistory$ = value;
						break;
					default:
						break;
				}
			}
		}

		dataFileInput.value = null;
	}

	async function handleSettingsFileChange() {
		const data = await loadFile<ExportedSettings>(settingsFileInput).catch(({ message }) => {
			$openDialog$ = {
				type: 'error',
				message,
				showCancel: false,
			};
		});

		if (data) {
			$settingPresets$ = data.settingPresets || [];
			$lastSettingPreset$ = data.lastSettingsPreset || '';

			if (data.currentSettings) {
				presetComponent.updateSettingsWithPreset({ name: '', settings: data.currentSettings }, false);
			}
		}

		settingsFileInput.value = null;
	}

	async function handlePresetFileChange() {
		const data = await loadFile<SettingPreset>(presetFileInput).catch(({ message }) => {
			$openDialog$ = {
				type: 'error',
				message,
				showCancel: false,
			};
		});

		if (data && data.name && data.settings) {
			const presetIndex = $settingPresets$.findIndex((entry) => entry.name === data.name);

			if (presetIndex > -1) {
				$settingPresets$[presetIndex] = data;
				$settingPresets$ = [...$settingPresets$];
			} else {
				$settingPresets$ = [...$settingPresets$, data];
			}

			$lastSettingPreset$ = data.name;
			presetComponent.updateSettingsWithPreset(data);
		}

		presetFileInput.value = null;
	}

	async function handlePersistenceChange(settingEnabled: boolean, message: String, storageKey: string) {
		if (settingEnabled) {
			return;
		}

		const { canceled } = await new Promise<DialogResult>((resolve) => {
			$openDialog$ = {
				icon: mdiHelpCircle,
				message,
				callback: resolve,
			};
		});

		if (!canceled) {
			window.localStorage.removeItem(storageKey);
		}
	}

	function handleCharacterMilestoneBlur(event) {
		const target = event.target as HTMLInputElement;
		const value = Number.parseInt(target.value || '0');

		if (!value || value < 2) {
			$characterMilestone$ = 0;
		} else {
			$characterMilestone$ = value;
		}

		if ($characterMilestone$ === 0) {
			$milestoneLines$ = new Map<string, string>();
		}

		target.value = `${$characterMilestone$}`;
	}

	function handlePreventLastDuplicateBlur(event) {
		const target = event.target as HTMLInputElement;
		const value = Number.parseInt(target.value || '0');
		const wasChange = value !== $preventLastDuplicate$;

		if (!value || value < 0) {
			$preventLastDuplicate$ = 0;
		} else {
			$preventLastDuplicate$ = value;
		}

		target.value = `${$preventLastDuplicate$}`;

		if (wasChange) {
			handlePreventLastDuplicateChange();
		}
	}

	async function handlePreventLastDuplicateChange() {
		if (!$preventLastDuplicate$ || $lineData$.length < 2) {
			return;
		}

		const { canceled } = await new Promise<DialogResult>((resolve) => {
			$openDialog$ = {
				icon: mdiHelpCircle,
				message: 'Apply to current lines',
				callback: resolve,
			};
		});

		if (canceled) {
			return;
		}

		const nonDuplicateLines: LineItem[] = [];
		const nonDuplicateLineText = new Set<string>();
		const removedIds = new Set<string>();
		const lines = $lineData$.splice(-($preventLastDuplicate$ + 1));

		for (let index = 0, { length } = lines; index < length; index += 1) {
			const line = lines[index];

			if (nonDuplicateLineText.has(line.text)) {
				removedIds.add(line.id);
			} else {
				nonDuplicateLines.push(line);
				nonDuplicateLineText.add(line.text);
			}
		}

		$lineData$ = [...$lineData$, ...nonDuplicateLines];
		selectedLineIds = selectedLineIds.filter((selectedLineId) => !removedIds.has(selectedLineId));
	}

	function handleMaxLinesBlur(event) {
		const target = event.target as HTMLInputElement;
		const value = Number.parseInt(target.value || '0');
		const wasChange = value !== $maxLines$;

		if (!value || value < 0) {
			$maxLines$ = 1000;
		} else {
			$maxLines$ = value;
		}

		target.value = `${$maxLines$}`;

		if (wasChange) {
			handleMaxLinesChange();
		}
	}

	function handleMaxPipLinesBlur(event) {
		const target = event.target as HTMLInputElement;
		const value = Number.parseInt(target.value || '0');

		if (!value || value < 0) {
			$maxPipLines$ = 1;
		} else {
			$maxPipLines$ = value;
		}

		target.value = `${$maxPipLines$}`;
	}

	async function handleMaxLinesChange() {
		const lineDiff = $lineData$.length - $maxLines$;

		if (!$maxLines$ || lineDiff < 1) {
			return;
		}

		const { canceled } = await new Promise<DialogResult>((resolve) => {
			$openDialog$ = {
				icon: mdiHelpCircle,
				message: `This will remove the first ${lineDiff} line(s)`,
				callback: resolve,
			};
		});

		if (canceled) {
			$maxLines$ = 0;
		} else {
			dispatch('maxLinesChange');
		}
	}

	async function handlePreventGlobalDuplicateChange() {
		if (!$preventGlobalDuplicate$ || $lineData$.length < 2) {
			return;
		}

		const { canceled } = await new Promise<DialogResult>((resolve) => {
			$openDialog$ = {
				icon: mdiHelpCircle,
				message: 'Apply to current lines',
				callback: resolve,
			};
		});

		if (!canceled) {
			const uniqueLines = new Set<string>();
			const removedLineIds = new Set<string>();

			$lineData$ = $lineData$.filter((line) => {
				if (uniqueLines.has(line.text)) {
					removedLineIds.add(line.id);
					return false;
				}

				uniqueLines.add(line.text);
				return true;
			});
			selectedLineIds = selectedLineIds.filter((selectedLineId) => !removedLineIds.has(selectedLineId));
		}
	}

	async function handleRemoveAllWhiteSpaceChange() {
		if ($removeAllWhitespace$) {
			const { canceled } = await new Promise<DialogResult>((resolve) => {
				$openDialog$ = {
					icon: mdiHelpCircle,
					message: 'Apply to current Lines',
					callback: resolve,
				};
			});

			if (!canceled) {
				$lineData$ = $lineData$.map((oldLine) => {
					oldLine.text = oldLine.text.replace(/\s/g, '').trim();
					return oldLine;
				});
			}
		}
	}

	function handleCustomCSSBlur(event: FocusEvent) {
		$customCSS$ = (event.target as HTMLTextAreaElement).value;
	}

	async function handleImport(fileInput: HTMLInputElement, message: string) {
		if (!$skipResetConfirmations$) {
			const { canceled } = await new Promise<DialogResult>((resolve) => {
				$openDialog$ = {
					icon: mdiHelpCircle,
					message,
					callback: resolve,
				};
			});

			if (canceled) {
				return;
			}
		}

		fileInput.click();
	}

	function handleExport<T>(fileName: string, exportData: T) {
		const a = document.createElement('a');

		a.href = URL.createObjectURL(new Blob([JSON.stringify(exportData)], { type: `application/json` }));
		a.rel = 'noopener';
		a.download = fileName;

		setTimeout(() => {
			URL.revokeObjectURL(a.href);
		}, 1e4);

		setTimeout(() => {
			a.click();
		});
	}

	function loadFile<T>(inputElement: HTMLInputElement) {
		return new Promise<T | void>((resolve, reject) => {
			const [file] = inputElement.files;
			const fileReader = new FileReader();

			if (!file) {
				return resolve();
			}

			if (!file.name.endsWith('.json')) {
				$openDialog$ = {
					type: 'error',
					message: `Expected json File`,
					showCancel: false,
				};

				inputElement.value = null;
				return resolve();
			}

			fileReader.addEventListener('loadend', (event) => {
				try {
					const data = JSON.parse(event.target.result as string);

					resolve(data);
				} catch (error) {
					reject(new Error('Error parsing File'));
				}
			});
			fileReader.addEventListener('error', () => reject(new Error('Failed to read File')));
			fileReader.readAsText(file, 'utf-8');
		});
	}

	async function getWebsocketPort() {
		try {
			const response = await fetch(getGSMEndpoint('/get_websocket_port'));
			if (!response.ok) {
				throw new Error('Failed to fetch websocket port');
			}
			const data = await response.json();
			return data.port;
		} catch (error) {
			console.error('Error fetching websocket port:', error);
			return null;
		}
	}
</script>

<svelte:head>
	<title>{$windowTitle$ || 'Texthooker UI'}</title>
</svelte:head>

{#if settingsOpen}
	<input class="hidden" type="file" bind:this={dataFileInput} on:change={handleDataFileChange} />
	<input class="hidden" type="file" bind:this={settingsFileInput} on:change={handleSettingsFileChange} />
	<input class="hidden" type="file" bind:this={presetFileInput} on:change={handlePresetFileChange} />
	<div
		class="flex flex-col max-[800px]:w-[90vw] min-[800px]:grid grid-cols-[max-content,auto,max-content,auto] gap-3 absolute overflow-auto h-[90vh] top-11 z-10 py-4 pr-8 pl-4 border bg-base-200 overscroll-contain"
		use:clickOutside={handleSettingsClick}
	>
		<div class="mb-2" style="grid-column: 1/5;">
			<div class="flex text-sm gap-x-5 min-[600px]:justify-between max-[600px]:flex-wrap max-[600px]:gap-y-5">
				<div
					role="button"
					class="flex flex-col items-center hover:text-primary"
					on:click={handleSetTimer}
					on:keyup={dummyFn}
				>
					<Icon path={mdiTimerEdit} />
					<span class="label-text">Set Timer</span>
				</div>
				<div
					role="button"
					class="flex flex-col items-center hover:text-primary"
					on:click={handleResetTimer}
					on:keyup={dummyFn}
				>
					<Icon path={mdiTimerCancel} />
					<span class="label-text">Reset Timer</span>
				</div>
				<div
					role="button"
					class="flex flex-col items-center hover:text-primary"
					on:click={() => handleReset(true)}
					on:keyup={dummyFn}
				>
					<Icon path={mdiDelete} />
					<span class="label-text">Reset Lines</span>
				</div>
				<div
					role="button"
					class="flex flex-col items-center hover:text-primary"
					on:click={() => handleReset(false)}
					on:keyup={dummyFn}
				>
					<Icon path={mdiDelete} />
					<span class="label-text">Reset Data</span>
				</div>
				<div
					role="button"
					class="flex flex-col items-center hover:text-primary"
					on:click={resetAllData}
					on:keyup={dummyFn}
				>
					<Icon path={mdiDelete} />
					<span class="label-text">Reset All</span>
				</div>
				<div
					role="button"
					class="flex flex-col items-center hover:text-primary"
					on:click={handleExportImportData}
					on:keyup={dummyFn}
				>
					<Icon path={mdiDatabaseSync} />
					<span class="label-text">Ex-/Import Data</span>
				</div>
				<div
					role="button"
					class="flex flex-col items-center hover:text-primary"
					on:click={handleExportImportSettings}
					on:keyup={dummyFn}
				>
					<Icon path={mdiDatabaseSync} />
					<span class="label-text">Ex-/Import Settings</span>
				</div>
				<div
					role="button"
					class="flex flex-col items-center hover:text-primary"
					on:click={() => ($theme$ = $theme$ === Theme.BUSINESS ? Theme.GARDEN : Theme.BUSINESS)}
					on:keyup={dummyFn}
				>
					<label class="swap swap-rotate">
						<input
							type="checkbox"
							checked={$theme$ === Theme.BUSINESS}
							on:change={() => ($theme$ = $theme$ === Theme.BUSINESS ? Theme.GARDEN : Theme.BUSINESS)}
						/>
						<Icon class="swap-on" path={mdiWeatherNight} />
						<Icon class="swap-off" path={mdiWhiteBalanceSunny} />
					</label>
					<span class="label-text">Theme</span>
				</div>
			</div>
		</div>
		<details role="button" class="col-span-4 mb-2">
			<summary>Links</summary>
			<ul>
				<li class="my-0.5 hover:text-primary">
					<a href="https://github.com/Renji-XD/texthooker-ui" target="_blank" rel="noreferrer">
						texthooker-ui Repository
					</a>
				</li>
				<li class="my-0.5 hover:text-primary">
					<a href="https://github.com/Artikash/Textractor" target="_blank" rel="noreferrer">Textractor</a>
				</li>
				<li class="my-0.5 hover:text-primary">
					<a href="https://github.com/kuroahna/textractor_websocket" target="_blank" rel="noreferrer">
						textractor-websocket Extension
					</a>
				</li>
				<li class="my-0.5 hover:text-primary">
					<a href="https://github.com/KamWithK/TextractorSender" target="_blank" rel="noreferrer">
						TextractorSender Extension
					</a>
				</li>
				<li class="my-0.5 hover:text-primary">
					<a href="https://github.com/kuroahna/mpv_websocket" target="_blank" rel="noreferrer">
						mpv_websocket Plugin
					</a>
				</li>
				<li class="my-0.5 hover:text-primary">
					<a href="https://github.com/0xDC00/agent" target="_blank" rel="noreferrer"> Agent </a>
				</li>
				<li class="my-0.5 hover:text-primary">
					<a href="https://github.com/kmltml/clipboard-inserter" target="_blank" rel="noreferrer">
						Clipboard Inserter
					</a>
				</li>
				<li class="my-0.5 hover:text-primary">
					<a href="https://github.com/laplus-sadness/lap-clipboard-inserter" target="_blank" rel="noreferrer">
						lap-clipboard-inserter
					</a>
				</li>
			</ul>
		</details>
		<Presets
			on:layoutChange
			on:exportImportPreset={({ detail }) => handleExportImportPreset(detail)}
			bind:this={presetComponent}
		/>
		<ReplacementSettings on:applyReplacements />
		<span class="label-text col-span-2">Window Title</span>
		<input class="input input-bordered h-8 col-span-2" bind:value={$windowTitle$} />
		<span class="label-text col-span-2">Primary Websocket</span>
		<input
			class="input input-bordered h-8 col-span-2"
			bind:value={websocketUrl}
			on:change={() => ($websocketUrl$ = websocketUrl)}
		/>
		<!-- <span class="label-text col-span-2">Secondary Websocket</span>
		<input
			class="input input-bordered h-8 col-span-2"
			bind:value={secondaryWebsocketUrl}
			on:change={handleSecondaryWebsocketChange}
		/> -->
		<span class="label-text col-span-2">Font Size</span>
		<input
			type="number"
			class="input input-bordered h-8 col-span-2"
			min="1"
			bind:value={$fontSize$}
			on:blur={() => {
				if (!$fontSize$ || $fontSize$ < 1) {
					$fontSize$ = 24;
				}
			}}
		/>
		<span class="label-text col-span-2">Character Milestone</span>
		<input
			type="number"
			class="input input-bordered h-8 col-span-2"
			min="0"
			value={$characterMilestone$}
			on:blur={handleCharacterMilestoneBlur}
		/>
		<span class="label-text mr-4 col-span-2">Online Font</span>
		<select class="select col-span-2" bind:value={$onlineFont$}>
			{#each onlineFonts as font (font)}
				<option value={font}>
					{font}
				</option>
			{/each}
		</select>
		<span class="label-text col-span-2">Prevent Last Line Duplicate</span>
		<input
			type="number"
			class="input input-bordered h-8 col-span-2"
			min="0"
			value={$preventLastDuplicate$}
			on:blur={handlePreventLastDuplicateBlur}
		/>
		<span class="label-text col-span-2">Max lines</span>
		<input
			type="number"
			class="input input-bordered h-8 mb-2 col-span-2"
			min="0"
			value={$maxLines$}
			on:blur={handleMaxLinesBlur}
		/>
		{#if pipAvailable}
			<span class="label-text col-span-2">Max lines (floating window)</span>
			<input
				type="number"
				class="input input-bordered h-8 mb-2 col-span-2"
				min="0"
				value={$maxPipLines$}
				on:blur={handleMaxPipLinesBlur}
			/>
		{/if}
		<span class="label-text col-span-2">AFK Timer (s)</span>
		<input
			type="number"
			class="input input-bordered h-8 mb-2 col-span-2"
			min="0"
			bind:value={$afkTimer$}
			on:blur={() => {
				if ($afkTimer$ === null || $afkTimer$ < 0) {
					$afkTimer$ = 0;
				}
			}}
		/>
		<span class="label-text">Adjust Timer after AFK</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$adjustTimerOnAfk$} />
		<span class="label-text">Enable external Clipboard Monitor</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$enableExternalClipboardMonitor$} />
		<span class="label-text">Show Preset Quick Switch</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$showPresetQuickSwitch$} />
		<span class="label-text">Skip Reset Confirmations</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$skipResetConfirmations$} />
		<span class="label-text">Store Stats persistently</span>
		<input
			type="checkbox"
			class="checkbox checkbox-primary ml-2"
			bind:checked={$persistStats$}
			on:change={() =>
				handlePersistenceChange($persistStats$, 'Clear stored stats', 'bannou-texthooker-timeValue')}
		/>
		<span class="label-text">Store Notes persistently</span>
		<input
			type="checkbox"
			class="checkbox checkbox-primary ml-2"
			bind:checked={$persistNotes$}
			on:change={() =>
				handlePersistenceChange($persistNotes$, 'Clear stored notes', 'bannou-texthooker-userNotes')}
		/>
		<span class="label-text">Store Lines persistently</span>
		<input
			type="checkbox"
			class="checkbox checkbox-primary ml-2"
			bind:checked={$persistLines$}
			on:change={() =>
				handlePersistenceChange($persistLines$, 'Clear stored lines', 'bannou-texthooker-lineData')}
		/>
		<span class="label-text">Store Action History persistently</span>
		<input
			type="checkbox"
			class="checkbox checkbox-primary ml-2"
			bind:checked={$persistActionHistory$}
			on:change={() =>
				handlePersistenceChange(
					$persistActionHistory$,
					'Clear action history',
					'bannou-texthooker-actionHistory',
				)}
		/>
		<span class="label-text">Enable Paste</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$enablePaste$} />
		<span class="label-text">Block Copy from Page</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$blockCopyOnPage$} />
		<span class="label-text">Allow Paste during Pause</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$allowPasteDuringPause$} />
		<span class="label-text">Allow new Line during Pause</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$allowNewLineDuringPause$} />
		<span class="label-text">Autostart Timer by Paste during Pause</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$autoStartTimerDuringPausePaste$} />
		<span class="label-text">Autostart Timer by Line during Pause</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$autoStartTimerDuringPause$} />
		<span class="label-text">Prevent Global Duplicate</span>
		<input
			type="checkbox"
			class="checkbox checkbox-primary ml-2"
			bind:checked={$preventGlobalDuplicate$}
			on:change={handlePreventGlobalDuplicateChange}
		/>
		<span class="label-text">Merge equal Line Starts</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$mergeEqualLineStarts$} />
		<span class="label-text">Filter lines without jp content</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$filterNonCJKLines$} />
		<span class="label-text">Flash on missed Line</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$flashOnMissedLine$} />
		<span class="label-text">Display Text vertically</span>
		<input
			type="checkbox"
			class="checkbox checkbox-primary ml-2"
			bind:checked={$displayVertical$}
			on:change={() => dispatch('layoutChange')}
		/>
		<span class="label-text">Reverse Line Order</span>
		<input
			type="checkbox"
			class="checkbox checkbox-primary ml-2"
			bind:checked={$reverseLineOrder$}
			on:change={() => dispatch('layoutChange')}
		/>
		<span class="label-text">Preserve Whitespace</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$preserveWhitespace$} />
		<span class="label-text">Remove all Whitespace</span>
		<input
			type="checkbox"
			class="checkbox checkbox-primary ml-2"
			bind:checked={$removeAllWhitespace$}
			on:change={handleRemoveAllWhiteSpaceChange}
		/>
		<span class="label-text">Show Timer</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$showTimer$} />
		<span class="label-text">Show Speed</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$showSpeed$} />
		<span class="label-text">Show Character Count</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$showCharacterCount$} />
		<span class="label-text">Show Line Count</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$showLineCount$} />
		<span class="label-text">Blur Stats</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$blurStats$} />
		<span class="label-text">Enable Line Animation</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$enableLineAnimation$} />
		<span class="label-text">Enable AFK Blur</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$enableAfkBlur$} />
		<span class="label-text">Restart Timer after AFK Blur</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$enableAfkBlurRestart$} />
		<span class="label-text">Continuous Reconnect</span>
		<input
			type="checkbox"
			class="checkbox checkbox-primary ml-2"
			bind:checked={$continuousReconnect$}
			on:change={() => {
				reconnectSocket$.next();
				reconnectSecondarySocket$.next();
			}}
		/>
		<span class="label-text">Show Connection Errors</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$showConnectionErrors$} />
		<span class="label-text">Auto Translate Lines:</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$autoTranslateLines$} />
		<span class="label-text">Blur Auto Translated Lines:</span>
		<input type="checkbox" class="checkbox checkbox-primary ml-2" bind:checked={$blurAutoTranslatedLines$} />
		<span class="label-text" style="grid-column: 1/5;">Custom CSS</span>
		<textarea
			class="p-1 min-h-[10rem] font-mono"
			style="grid-column: 1/5;"
			rows="5"
			value={$customCSS$}
			on:blur={handleCustomCSSBlur}
		/>
	</div>
{/if}
