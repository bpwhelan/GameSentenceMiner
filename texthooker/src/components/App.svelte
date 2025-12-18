<script lang="ts">
	import {
		mdiArrowULeftTop,
		mdiCancel,
		mdiChartBar,
		mdiCog,
		mdiDelete,
		mdiDeleteForever,
		mdiNoteEdit,
		mdiPause,
		mdiPlay,
		mdiWindowMaximize,
		mdiWindowRestore,
	} from '@mdi/js';
	import { debounceTime, filter, fromEvent, map, NEVER, switchMap, tap } from 'rxjs';
	import { onMount, tick } from 'svelte';
	import { quintInOut } from 'svelte/easing';
	import { fly } from 'svelte/transition';
	import {
		actionHistory$,
		allowNewLineDuringPause$,
		allowPasteDuringPause$,
		autoStartTimerDuringPause$,
		autoStartTimerDuringPausePaste$,
		blockCopyOnPage$,
		customCSS$,
		dialogOpen$,
		displayVertical$,
		enabledReplacements$,
		enablePaste$,
		filterNonCJKLines$,
		flashOnMissedLine$,
		flashOnPauseTimeout$,
		fontSize$,
		isPaused$,
		lastPipHeight$,
		lastPipWidth$,
		lineData$,
		lineIDs$,
		timedOutIDs$,
		maxLines$,
		maxPipLines$,
		mergeEqualLineStarts$,
		newLine$,
		notesOpen$,
		onlineFont$,
		openDialog$,
		preventGlobalDuplicate$,
		preventLastDuplicate$,
		removeAllWhitespace$,
		replacements$,
		reverseLineOrder$,
		secondaryWebsocketUrl$,
		showSpinner$,
		theme$,
		websocketUrl$
	} from '../stores/stores';
	import { type LineItem, type LineItemEditEvent, LineType, OnlineFont, Theme } from '../types';
	import {
		applyAfkBlur,
		applyCustomCSS,
		applyReplacements,
		generateRandomUUID,
		newLineCharacter,
		reduceToEmptyString,
		updateScroll
	} from '../util';
	import DialogManager from './DialogManager.svelte';
	import Icon from './Icon.svelte';
	import Line from './Line.svelte';
	import Notes from './Notes.svelte';
	import Presets from './Presets.svelte';
	import Settings from './Settings.svelte';
	import SocketConnector from './SocketConnector.svelte';
	import Spinner from './Spinner.svelte';
	import Stats from './Stats.svelte';
	import { getGSMEndpoint } from '../gsm';

	let isSmFactor = false;
	let settingsComponent: Settings;
	let selectedLineIds: string[] = [];
	let settingsContainer: HTMLElement;
	let settingsElement: SVGElement;
	let settingsOpen = false;
	let lineContainer: HTMLElement;
	let lineElements: Line[] = [];
	let lineInEdit = false;
	let blockNextExternalLine = false;
	let wakeLock = null;
	let pipContainer: HTMLElement;
	let pipWindow: Window | undefined;
	let pipResizeTimeout: number;
	let hasPipFocus = false;

	startIdPolling()

	const wakeLockAvailable = 'wakeLock' in navigator;

	const cjkCharacters = /[\p{scx=Hira}\p{scx=Kana}\p{scx=Han}]/imu;

	const uniqueLines$ = preventGlobalDuplicate$.pipe(
		map((preventGlobalDuplicate) =>
			preventGlobalDuplicate ? new Set<string>($lineData$.map((line) => line.text)) : new Set<string>(),
		),
	);

	const handleLine$ = newLine$.pipe(
		filter(([value, lineType, _1]) => {
			const isResetCheckboxes = lineType === LineType.RESETCHECKBOXES;
			const isPaste = lineType === LineType.PASTE;
			const hasNoUserInteraction = !isPaste || (!$notesOpen$ && !$dialogOpen$ && !settingsOpen && !lineInEdit);
			const skipExternalLine = blockNextExternalLine && lineType === LineType.EXTERNAL;

			if (skipExternalLine) {
				blockNextExternalLine = false;
			}

			if (isResetCheckboxes) {
				resetCheckBoxes()
				return false;
			}

			if (
				(!$isPaused$ ||
					(($allowPasteDuringPause$ || $autoStartTimerDuringPausePaste$) && isPaste) ||
					(($allowNewLineDuringPause$ || $autoStartTimerDuringPause$) && !isPaste)) &&
				hasNoUserInteraction &&
				!skipExternalLine
			) {
				if (
					$isPaused$ &&
					(($autoStartTimerDuringPausePaste$ && isPaste) || ($autoStartTimerDuringPause$ && !isPaste))
				) {
					$isPaused$ = false;
				}

				return true;
			}

			if (!skipExternalLine && hasNoUserInteraction && $flashOnMissedLine$) {
				handleMissedLine();
			}

			return false;
		}),
		tap((newLine: [string, LineType, string]) => {
			const [lineContent] = newLine;
			const type = newLine.at(1) || LineType.SOCKET;
			const text = transformLine(lineContent, type !== LineType.TL);
			const id = newLine.at(2) || generateRandomUUID();

			if (type !== LineType.TL) {
				$lineIDs$ = [...$lineIDs$, id];
			}

			if (text) {
				$lineData$ = applyEqualLineStartMerge([
					...applyMaxLinesAndGetRemainingLineData(1),
					{ id: id, text },
				]);
			}
		}),
		reduceToEmptyString(),
	);

	const pasteHandler$ = enablePaste$.pipe(
		switchMap((enablePaste) => (enablePaste ? fromEvent(document, 'paste') : NEVER)),
		tap((event: ClipboardEvent) => newLine$.next([event.clipboardData.getData('text/plain'), LineType.PASTE, ''])),
		reduceToEmptyString(),
	);

	const visibilityHandler$ = fromEvent(document, 'visibilitychange').pipe(
		tap(() => {
			if (wakeLockAvailable && wakeLock !== null && document.visibilityState === 'visible') {
				wakeLock = navigator.wakeLock
					.request('screen')
					.then((lock) => {
						return lock;
					})
					.catch((error) => {
						console.error(`Unable to aquire screen lock: ${error.message}`);
						return null;
					});
			}
		}),
		reduceToEmptyString(),
	);

	const copyBlocker$ = blockCopyOnPage$.pipe(
		switchMap((blockCopyOnPage) => {
			blockNextExternalLine = false;

			return blockCopyOnPage ? fromEvent(document, 'copy') : NEVER;
		}),
		tap(() => (blockNextExternalLine = true)),
		reduceToEmptyString(),
	);

	const resizeHandler$ = fromEvent(window, 'resize').pipe(
		debounceTime(500),
		tap(mountFunction),
		reduceToEmptyString(),
	);

	$: iconSize = isSmFactor ? '1.5rem' : '1.25rem';

	$: $enabledReplacements$ = $replacements$.filter((replacment) => replacment.enabled);

	$: pipAvailable = 'documentPictureInPicture' in window && !!pipContainer;

	$: pipLines = pipAvailable && $lineData$ ? $lineData$.slice(-$maxPipLines$) : [];

	$: if (pipWindow) {
		pipWindow.document.body.dataset.theme = $theme$;

		applyCustomCSS(pipWindow.document, $customCSS$);
	}

	onMount(() => {
		mountFunction();
		if (wakeLockAvailable) {
			wakeLock = navigator.wakeLock
				.request('screen')
				.then((lock) => {
					return lock;
				})
				.catch((error) => {
					console.error(`Unable to aquire screen lock: ${error.message}`);
					return null;
				});
		}
	});

	function mountFunction() {
		isSmFactor = window.matchMedia('(min-width: 640px)').matches;
		executeUpdateScroll();
	}

	function handleKeyPress(event: KeyboardEvent) {
		if ($notesOpen$ || $dialogOpen$ || settingsOpen || lineInEdit) {
			return;
		}

		const key = (event.key || '')?.toLowerCase();

		if (key === 'delete') {
			if (window.getSelection()?.toString().trim()) {
				const range = window.getSelection().getRangeAt(0);

				for (let index = 0, { length } = lineElements; index < length; index += 1) {
					const lineElement = lineElements[index];
					const selectedId = lineElement?.getIdIfSelected(range);

					if (selectedId) {
						selectedLineIds.push(selectedId);
					}
				}
			}

			if (selectedLineIds.length) {
				removeLines();
			} else if (event.altKey) {
				removeLastLine();
			}
		} else if (selectedLineIds.length && key === 'escape') {
			deselectLines();
		} else if (event.altKey && key === 'a') {
			settingsComponent.handleReset(false);
		} else if (event.altKey && key === 'q') {
			settingsComponent.handleReset(true);
		} else if ((event.ctrlKey || event.metaKey) && key === ' ') {
			$isPaused$ = !$isPaused$;
		}
	}

	export function startIdPolling() {
		setInterval(async () => {
			try {
				const response = await fetch(getGSMEndpoint('/get_ids'));
				if (!response.ok) {
					throw new Error(`HTTP error! Status: ${response.status}`);
				}
				const resp = await response.json();
				$lineIDs$ = resp.ids;
				$timedOutIDs$ = resp.timed_out_ids;
			} catch (error) {
				console.error('Failed to fetch ids:', error);
			}
		}, 1000);
	}

	// Assuming 'lineData' is a correctly defined array for this vanilla JS example
	function resetCheckBoxes() {
		$lineData$.forEach((line) => {
			const checkboxElement = document.getElementById(`multi-line-checkbox-${line.id}`);
			if (checkboxElement && typeof checkboxElement.checked === 'boolean') { // Check if element exists and is a checkbox
				checkboxElement.checked = false;
			} else {
				console.warn(`Checkbox with ID 'multi-line-checkbox-${line.id}' not found or is not a valid checkbox element.`);
			}
		});
	}

	async function undoLastAction() {
		if (!$actionHistory$.length) {
			return;
		}

		const linesToRevert = $actionHistory$.pop();

		let lineToRevert = linesToRevert.pop();

		while (lineToRevert) {
			const text = transformLine(lineToRevert.text, false);

			if (text) {
				const { id, index } = lineToRevert;

				if (index > $lineData$.length - 1) {
					$lineData$.push({ id, text });
				} else if ($lineData$[index].id === id) {
					$lineData$[index] = { id, text };
				} else {
					$lineData$.splice(index, 0, { id, text });
				}
			}

			lineToRevert = linesToRevert.pop();
		}

		await tick();

		$lineData$ = applyEqualLineStartMerge(applyMaxLinesAndGetRemainingLineData());
		$actionHistory$ = $actionHistory$;
	}

	function removeLastLine() {
		if (!$lineData$.length) {
			return;
		}

		const [removedLine] = $lineData$.splice($lineData$.length - 1, 1);

		selectedLineIds = selectedLineIds.filter((selectedLineId) => selectedLineId !== removedLine.id);
		$lineData$ = $lineData$;
		$actionHistory$ = [...$actionHistory$, [{ ...removedLine, index: $lineData$.length }]];

		$uniqueLines$.delete(removedLine.text);
	}

	function removeLines() {
		const linesToDelete = new Set(selectedLineIds);
		const newActionHistory: LineItem[] = [];

		$lineData$ = $lineData$.filter((oldLine, index) => {
			const hasLine = linesToDelete.has(oldLine.id);

			linesToDelete.delete(oldLine.id);

			if (hasLine) {
				newActionHistory.push({ ...oldLine, index: index - newActionHistory.length });
				$uniqueLines$.delete(oldLine.text);
			}

			return !hasLine;
		});

		selectedLineIds = linesToDelete.size ? [...linesToDelete] : [];

		if (newActionHistory.length) {
			$actionHistory$ = [...$actionHistory$, newActionHistory];
		}
	}

	function deselectLines() {
		for (let index = 0, { length } = lineElements; index < length; index += 1) {
			lineElements[index]?.deselect();
		}

		selectedLineIds = [];
	}

	async function handlePipAction() {
		if (pipWindow) {
			return pipWindow.close();
		}

		pipWindow = await window.documentPictureInPicture
			.requestWindow(
				$lastPipHeight$ > 0 && $lastPipWidth$ > 0
					? { height: $lastPipHeight$, width: $lastPipWidth$, preferInitialWindowPlacement: false }
					: { preferInitialWindowPlacement: false },
			)
			.catch(({ message }) => {
				$openDialog$ = {
					message: `Error opening floating window: ${message}`,
					showCancel: false,
				};

				return undefined;
			});

		if (!pipWindow) {
			return;
		}

		pipWindow.document.body.appendChild(pipContainer);

		pipWindow.addEventListener('pagehide', onPipHide, { once: true });
		pipWindow.addEventListener('resize', onPipResize, false);
		pipWindow.addEventListener('blur', onPipFocusBlur, false);
		pipWindow.addEventListener('focus', onPipFocusBlur, false);

		[...document.styleSheets].forEach((styleSheet) => {
			if (styleSheet.ownerNode instanceof Element && styleSheet.ownerNode.id === 'user-css') {
				return;
			}

			try {
				const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
				const style = document.createElement('style');

				style.textContent = cssRules;
				pipWindow.document.head.appendChild(style);
			} catch (_error) {
				const link = document.createElement('link');

				link.rel = 'stylesheet';
				link.type = styleSheet.type;
				link.media = styleSheet.media.toString();
				link.href = styleSheet.href;
				pipWindow.document.head.appendChild(link);
			}
		});
	}

	function onPipHide() {
		updatePipDimensions();

		pipWindow.removeEventListener('resize', onPipResize, false);
		pipWindow.removeEventListener('blur', onPipFocusBlur, false);
		pipWindow.removeEventListener('focus', onPipFocusBlur, false);

		hasPipFocus = false;
		pipWindow = undefined;
	}

	function onPipResize() {
		window.clearTimeout(pipResizeTimeout);

		pipResizeTimeout = window.setTimeout(updatePipDimensions, 500);
	}

	function updatePipDimensions() {
		if (!pipWindow) {
			return;
		}

		$lastPipHeight$ = pipWindow.document.body.clientHeight;
		$lastPipWidth$ = pipWindow.document.body.clientWidth;
	}

	function onPipFocusBlur(event: Event) {
		hasPipFocus = event.type === 'focus';
	}

	function onAfkBlur({ detail: isAfk }: CustomEvent<boolean>) {
		applyAfkBlur(document, isAfk);

		if (pipWindow) {
			applyAfkBlur(pipWindow.document, isAfk);
		}
	}

	function executeUpdateScroll() {
		updateScroll(window, lineContainer, $reverseLineOrder$, $displayVertical$);

		if (pipWindow) {
			updateScroll(pipWindow, pipContainer, $reverseLineOrder$, false);
		}
	}

	function handleMissedLine() {
		clearTimeout($flashOnPauseTimeout$);

		if ($theme$ === Theme.GARDEN) {
			settingsContainer.classList.add('bg-base-200');
			settingsContainer.classList.remove('bg-base-100');
			document.body.classList.add('bg-base-200');
		}

		document.body.classList.add('animate-[pulse_0.5s_cubic-bezier(0.4,0,0.6,1)_1]');

		$flashOnPauseTimeout$ = window.setTimeout(() => {
			if ($theme$ === Theme.GARDEN) {
				settingsContainer.classList.add('bg-base-100');
				settingsContainer.classList.remove('bg-base-200');
				document.body.classList.remove('bg-base-200');
			}

			document.body.classList.remove('animate-[pulse_0.5s_cubic-bezier(0.4,0,0.6,1)_1]');
		}, 500);
	}

	function transformLine(text: string, useReplacements = true) {
		const textToAppend = useReplacements ? applyReplacements(text, $enabledReplacements$) : text;

		let canAppend = true;
		let lineToAppend = $removeAllWhitespace$ ? textToAppend.replace(/\s/gm, '').trim() : textToAppend;

		if ($filterNonCJKLines$ && !lineToAppend.match(cjkCharacters)) {
			lineToAppend = '';
		}

		if (!lineToAppend) {
			canAppend = false;
		} else if ($preventGlobalDuplicate$) {
			canAppend = !$uniqueLines$.has(lineToAppend);
			$uniqueLines$.add(lineToAppend);
		} else if ($preventLastDuplicate$ && $lineData$.length) {
			canAppend = $lineData$.slice(-$preventLastDuplicate$).every((line) => line.text !== lineToAppend);
		}

		return canAppend ? lineToAppend : undefined;
	}

	function handleLineEdit(event) {
		const { inEdit, data } = event.detail as LineItemEditEvent;

		if (data && data.originalText !== data.newText) {
			const text = transformLine(data.newText);

			$lineData$[data.lineIndex] = {
				id: data.line.id,
				text,
			};

			if (text) {
				$actionHistory$ = [...$actionHistory$, [{ ...data.line, index: data.lineIndex }]];
				$uniqueLines$.delete(data.originalText);
				$uniqueLines$.add(text);
			} else {
				tick().then(
					() =>
						($lineData$[data.lineIndex] = {
							id: data.line.id,
							text: data.originalText,
						}),
				);
			}
		}

		lineInEdit = inEdit;
	}

	function applyMaxLinesAndGetRemainingLineData(diffMod = 0) {
		const oldLinesToRemove = new Set<string>();
		const startIndex = $maxLines$ ? $lineData$.length - $maxLines$ + diffMod : 0;
		const remainingLineData =
			startIndex > 0
				? $lineData$.filter((oldLine, index) => {
						if (index < startIndex) {
							oldLinesToRemove.add(oldLine.id);

							$uniqueLines$.delete(oldLine.text);
							return false;
						}

						return true;
					})
				: $lineData$;

		if (oldLinesToRemove.size) {
			selectedLineIds = selectedLineIds.filter((selectedLineId) => !oldLinesToRemove.has(selectedLineId));
		}

		return remainingLineData;
	}

	function updateLineData(executeUpdate: boolean) {
		if (!executeUpdate) {
			return;
		}

		$showSpinner$ = true;

		try {
			for (let index = 0, { length } = $lineData$; index < length; index += 1) {
				const line = $lineData$[index];
				const newText = transformLine(line.text);

				if (newText && newText !== line.text) {
					$uniqueLines$.delete(line.text);

					$lineData$[index] = { ...line, text: newText };
				}
			}

			$openDialog$ = {
				message: `Operation executed`,
				showCancel: false,
			};
		} catch ({ message }) {
			$openDialog$ = {
				type: 'error',
				message: `An Error occured: ${message}`,
				showCancel: false,
			};
		}

		$lineData$ = applyEqualLineStartMerge(applyMaxLinesAndGetRemainingLineData());

		$showSpinner$ = false;
	}

	function applyEqualLineStartMerge(currentLineData: LineItem[]) {
		if (!$mergeEqualLineStarts$ || currentLineData.length < 2) {
			return currentLineData;
		}

		const lastIndex = currentLineData.length - 1;
		const comparisonIndex = lastIndex - 1;
		const lastLine = currentLineData[lastIndex];
		const comparisonLine = currentLineData[comparisonIndex].text;

		if (lastLine.text.startsWith(comparisonLine)) {
			$uniqueLines$.delete(comparisonLine);

			selectedLineIds = selectedLineIds.filter(
				(selectedLineId) => selectedLineId !== currentLineData[comparisonIndex].id,
			);

			currentLineData.splice(comparisonIndex, 2, lastLine);
		}

		return currentLineData;
	}

	let numberOfLinesToTranslate = '';
	
	async function handleTranslate() {
		if (!numberOfLinesToTranslate.trim()) return;

		try {

			let ids = $lineIDs$;
			if (Number(numberOfLinesToTranslate) < ids.length) {
				ids = ids.slice(-Number(numberOfLinesToTranslate));
			}
			
			const response = await fetch(getGSMEndpoint('/translate-multiple'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ ids }),
			});
			
			if (response.ok) {
				const result = await response.text();
				// Add the translation result as a normal websocket event without adding to lineIDs
				newLine$.next([result, LineType.TL, '']);
			}
		} catch (error) {
			console.error('Translation failed:', error);
		}
	}
</script>

<svelte:window on:keyup={handleKeyPress} />

{$visibilityHandler$ ?? ''}
{$handleLine$ ?? ''}
{$pasteHandler$ ?? ''}
{$copyBlocker$ ?? ''}
{$resizeHandler$ ?? ''}

{#if $showSpinner$}
	<Spinner />
{/if}

<DialogManager />

<header class="fixed top-0 right-0 flex justify-end items-center p-2 bg-base-100" bind:this={settingsContainer}>
	<Stats on:afkBlur={onAfkBlur} />
	{#if $websocketUrl$}
		<SocketConnector />
	{/if}
	{#if $secondaryWebsocketUrl$}
		<SocketConnector isPrimary={false} />
	{/if}
	{#if $isPaused$}
		<div
			role="button"
			title="Continue"
			class="mr-1 animate-[pulse_1.25s_cubic-bezier(0.4,0,0.6,1)_infinite] hover:text-primary sm:mr-2"
		>
			<Icon path={mdiPlay} width={iconSize} height={iconSize} on:click={() => ($isPaused$ = false)} />
		</div>
	{:else}
		<div role="button" title="Pause" class="mr-1 hover:text-primary sm:mr-2">
			<Icon path={mdiPause} width={iconSize} height={iconSize} on:click={() => ($isPaused$ = true)} />
		</div>
	{/if}
	<div
		role="button"
		title="Delete last Line"
		class="mr-1 hover:text-primary sm:mr-2"
		class:opacity-50={!$lineData$.length}
		class:cursor-not-allowed={!$lineData$.length}
		class:hover:text-primary={$lineData$.length}
	>
		<Icon path={mdiDeleteForever} width={iconSize} height={iconSize} on:click={removeLastLine} />
	</div>
	<div
		role="button"
		title="Undo last Action"
		class="mr-1 hover:text-primary sm:mr-2"
		class:opacity-50={!$actionHistory$.length}
		class:cursor-not-allowed={!$actionHistory$.length}
		class:hover:text-primary={$actionHistory$.length}
	>
		<Icon path={mdiArrowULeftTop} width={iconSize} height={iconSize} on:click={undoLastAction} />
	</div>
	{#if selectedLineIds.length}
		<div role="button" title="Remove selected Lines" class="mr-1 hover:text-primary sm:mr-2">
			<Icon path={mdiDelete} width={iconSize} height={iconSize} on:click={removeLines} />
		</div>
		<div role="button" title="Deselect Lines" class="mr-1 hover:text-primary sm:mr-2">
			<Icon path={mdiCancel} width={iconSize} height={iconSize} on:click={deselectLines} />
		</div>
	{/if}
	<div role="button" title="Open Notes" class="mr-1 hover:text-primary sm:mr-2">
		<Icon path={mdiNoteEdit} width={iconSize} height={iconSize} on:click={() => ($notesOpen$ = true)} />
	</div>
	{#if pipAvailable}
		<div
			role="button"
			class="mr-1 hover:text-primary sm:mr-2"
			title={pipWindow ? 'Close Floating Window' : 'Open Floating Window'}
		>
			<Icon
				width={iconSize}
				height={iconSize}
				path={pipWindow ? mdiWindowMaximize : mdiWindowRestore}
				on:click={handlePipAction}
			/>
		</div>
	{/if}
	<div
		role="button"
		class="mr-1 hover:text-primary sm:mr-2"
		title="Open Statistics Page"
	>
		<Icon
		path={mdiChartBar}
		width={iconSize}
		height={iconSize}
		on:click={() => window.open('/overview', '_blank')}
		/>
	</div>
	
	<Icon
		class="cursor-pointer mr-1 hover:text-primary md:mr-2"
		path={mdiCog}
		width={iconSize}
		height={iconSize}
		bind:element={settingsElement}
		on:click={() => (settingsOpen = !settingsOpen)}
	/>
	<Settings
		{settingsElement}
		{pipAvailable}
		bind:settingsOpen
		bind:selectedLineIds
		bind:this={settingsComponent}
		on:applyReplacements={() => updateLineData(!!$enabledReplacements$.length)}
		on:layoutChange={executeUpdateScroll}
		on:maxLinesChange={() => ($lineData$ = applyMaxLinesAndGetRemainingLineData())}
	/>
	<Presets isQuickSwitch={true} on:layoutChange={executeUpdateScroll} />
</header>
<main
	class="flex flex-col flex-1 break-all px-4 w-full h-full overflow-auto"
	class:py-16={!$displayVertical$}
	class:py-8={$displayVertical$}
	class:opacity-50={$notesOpen$}
	class:flex-col-reverse={$reverseLineOrder$}
	style:font-size={`${$fontSize$}px`}
	style:font-family={$onlineFont$ !== OnlineFont.OFF ? $onlineFont$ : undefined}
	style:writing-mode={$displayVertical$ ? 'vertical-rl' : 'horizontal-tb'}
	bind:this={lineContainer}
>
	{@html newLineCharacter}
	{#each $lineData$ as line, index (line.id)}
		<Line
			{line}
			{index}
			isLast={$lineData$.length - 1 === index}
			bind:this={lineElements[index]}
			on:selected={({ detail }) => {
				selectedLineIds = [...selectedLineIds, detail];
			}}
			on:deselected={({ detail }) => {
				selectedLineIds = selectedLineIds.filter((selectedLineId) => selectedLineId !== detail);
			}}
			on:edit={handleLineEdit}
		/>
	{/each}
	
	
</main>

<!-- Small translate textbox positioned at bottom right -->
<div class="fixed bottom-2 right-2 z-50">
	<input
		type="text"
		bind:value={numberOfLinesToTranslate}
		on:keydown={(e) => e.key === 'Enter' && handleTranslate()}
		placeholder="TL"
		class="w-8 h-6 text-xs p-1 border border-gray-300 rounded text-center bg-base-100"
		title="Press Enter to translate a number of lines"
	/>
</div>

{#if $notesOpen$}
	<div
		class="bg-base-200 fixed top-0 right-0 z-[60] flex h-full w-full max-w-3xl flex-col justify-between"
		in:fly|local={{ x: 100, duration: 100, easing: quintInOut }}
	>
		<Notes />
	</div>
{/if}
<div
	id="pip-container"
	class="flex flex-col flex-1 flex flex-col break-all px-4 w-full h-full overflow-auto"
	class:flex-col-reverse={$reverseLineOrder$}
	class:hidden={!pipWindow}
	style:font-size={`${$fontSize$}px`}
	style:font-family={$onlineFont$ !== OnlineFont.OFF ? $onlineFont$ : undefined}
	bind:this={pipContainer}
>
	{#if pipWindow}
		{#each pipLines as line, index (line.id)}
			<Line {line} {index} {pipWindow} isLast={pipLines.length - 1 === index} />
		{/each}
	{/if}
</div>
