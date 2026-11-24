<script lang="ts" module>
	import {
		mdiCheck, mdiClockOutline, mdiCameraOutline, mdiContentSave, mdiContentSaveCheck,
		mdiHistory, mdiDotsHorizontal, mdiMovieOutline, mdiPlay, mdiStop, mdiTranslate,
	} from '@mdi/js';

	import { combineLatest, shareReplay } from 'rxjs';
	import {
		alwaysScrollToNewest$,
		displayVertical$,
		enableLineAnimation$,
		preserveWhitespace$,
		reverseLineOrder$,
		autoTranslateLines$,
		blurAutoTranslatedLines$,
		unblurTLTimer$,
		showMenuButton$,
		showExpiredIcon$,
		showScreenshotButton$,
		showAudioButton$,
		showTrimVideoButton$,
		showSaveClipButton$,
		showTranslateButton$,
	} from '../stores/stores';

	// One shared upstream subscription for page-wide options, even with thousands of rows.
	const lineSettings = combineLatest({
		alwaysScrollToNewest: alwaysScrollToNewest$,
		displayVertical: displayVertical$,
		enableLineAnimation: enableLineAnimation$,
		preserveWhitespace: preserveWhitespace$,
		reverseLineOrder: reverseLineOrder$,
		autoTranslateLines: autoTranslateLines$,
		blurAutoTranslatedLines: blurAutoTranslatedLines$,
		unblurTLTimer: unblurTLTimer$,
		showMenuButton: showMenuButton$,
		showExpiredIcon: showExpiredIcon$,
		showScreenshotButton: showScreenshotButton$,
		showAudioButton: showAudioButton$,
		showTrimVideoButton: showTrimVideoButton$,
		showSaveClipButton: showSaveClipButton$,
		showTranslateButton: showTranslateButton$,
	}).pipe(shareReplay({ bufferSize: 1, refCount: true }));

	function iconMask(path: string) {
		return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${path}"/></svg>`)}")`;
	}

	const masks = {
		check: iconMask(mdiCheck), clock: iconMask(mdiClockOutline), camera: iconMask(mdiCameraOutline),
		save: iconMask(mdiContentSave), saved: iconMask(mdiContentSaveCheck), history: iconMask(mdiHistory),
		menu: iconMask(mdiDotsHorizontal), video: iconMask(mdiMovieOutline), play: iconMask(mdiPlay),
		stop: iconMask(mdiStop), translate: iconMask(mdiTranslate),
	};
</script>

<script lang="ts">
	import {
		mdiCreationOutline,
		mdiTrophy,
	} from '@mdi/js';
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import {
		lineIDs$,
		lineData$,
		milestoneLines$,
		settingsOpen$,
		timedOutIDs$,
	} from '../stores/stores';
	import type { LineItem, LineItemEditEvent } from '../types';
	import {
		dummyFn,
		getAutoScrollStick,
		isScrolledToEnd,
		newLineCharacter,
		shouldAutoScroll,
		updateScroll,
	} from '../util';
	import Icon from './Icon.svelte';
	import AIHelp from './AIHelp.svelte';
	import { formatMegabytes, getGSMEndpoint } from '../gsm';
	import type { MiningClickDetail, MiningStartDetail } from '../mining-selection';

	export let line: LineItem;
	export let index: number;
	export let isLast: boolean;
	export let pipWindow: Window | undefined = undefined;
	export let audioLineId = '';
	export let audioIsPlaying = false;
	export let audioPendingLineId = '';
	export let isSavingClip = false;
	export let isClipSaved = false;
	export let clipSizeBytes: number | undefined = undefined;
	export let miningSelected = false;
	export let isSelected = false;

	export function deselect() {
		isSelected = false;
	}

	export function getIdIfSelected(range: Range) {
		return isSelected || (paragraph && range.intersectsNode(paragraph)) ? line.id : undefined;
	}

	const dispatch = createEventDispatcher<{
		deselected: string;
		selected: string;
		edit: LineItemEditEvent;
		audioToggle: { lineId: string; text: string };
		videoTrim: { lineId: string; text: string };
		saveClip: { lineId: string };
		deleteClip: { lineId: string };
		openClipFolder: { lineId: string };
		miningStart: MiningStartDetail;
		miningToggle: { id: string; checked: boolean; shiftKey: boolean };
		miningClick: MiningClickDetail;
	}>();

	let paragraph: HTMLElement;
	let originalText = '';
	let previousLineText = line.text;
	let componentMounted = false;
	let lineTextMounted = false;
	let autoTranslationRevision = -1;
	let translatedSourceText = line.translation ? line.text.trim() : null;
	let pendingTranslations: Set<string> | undefined;
	let unblurTranslationTimer: ReturnType<typeof setTimeout> | undefined;
	let isEditable = false;
	// One popover for the line's menus: the ☰ actions, or the saved clip's own menu.
	let openMenu: 'actions' | 'clip' | null = null;
	let menuAnchor: HTMLElement | undefined;
	let aiHelpOpen = false;
	let actionsMenuButton: HTMLButtonElement;
	let actionsMenuPopover: HTMLElement;
	let actionsMenuStyle = 'visibility: hidden;';
	let aiError = '';
	let isTranslating = false;
	$: actionsMenuOpen = openMenu === 'actions';
	$: if (!$lineSettings.showMenuButton && openMenu === 'actions') closeActionsMenu();
	$: isAudioLine = audioLineId === line.id;
	$: isAudioPending = audioPendingLineId === line.id;
	$: audioButtonTitle = isAudioPending ? 'Preparing audio...' : isAudioLine && audioIsPlaying ? 'Stop audio' : 'Play audio';
	$: isActiveGSMLine = line.gsmStatus === 'active' || (!line.gsmStatus && $lineIDs$?.includes(line.id));
	$: isTimedOutGSMLine = line.gsmStatus === 'timed_out' || (!line.gsmStatus && $timedOutIDs$.includes(line.id));
	$: clipSizeLabel = clipSizeBytes ? formatMegabytes(clipSizeBytes) : '';
	$: canAskAI = !!line.id && (isActiveGSMLine || isTimedOutGSMLine || isClipSaved || line.gsmStatus === 'external');

	$: isVerticalDisplay = !pipWindow && $lineSettings.displayVertical;
	$: if (line.text !== previousLineText) {
		if (translatedSourceText !== null && line.text.trim() !== translatedSourceText) {
			clearTimeout(unblurTranslationTimer);
			line.translation = undefined;
			line.blurTranslation = false;
			translatedSourceText = null;
		}
		previousLineText = line.text;
		void followUpdatedLineText();
	}
	$: if (
		componentMounted &&
		line.recordState === 'frozen' &&
		!line.sessionBackfill &&
		$lineSettings.autoTranslateLines &&
		Number(line.revision ?? 0) > autoTranslationRevision
	) {
		autoTranslationRevision = Number(line.revision ?? 0);
		handleAction(line.id, 'TL', $lineSettings.blurAutoTranslatedLines, true);
	}

	onMount(() => {
		componentMounted = true;
		void revealLineText();
	});

	onDestroy(() => {
		componentMounted = false;
		clearTimeout(unblurTranslationTimer);
		document.removeEventListener('click', clickOutsideHandler, false);
		removeActionsMenuListeners();
		dispatch('edit', { inEdit: false });
	});

	function introduceLine(node: HTMLElement) {
		if ($lineSettings.enableLineAnimation && !line.sessionBackfill) {
			return fly(node, { x: isVerticalDisplay ? 100 : -100, duration: 250 });
		}
		return { duration: 0 };
	}

	async function revealLineText() {
		// Svelte 5 builds each line off-DOM before inserting its wrapper. Reveal the
		// text after attachment so extension MutationObservers receive a connected
		// child-list mutation, matching the insertion behavior of the legacy build.
		await tick();
		if (!componentMounted) {
			return;
		}
		lineTextMounted = true;
		await tick();
		if (!componentMounted || !isLast) {
			return;
		}

		// Keep the reader's position unless continuous following is enabled.
		if (shouldAutoScroll($lineSettings.alwaysScrollToNewest, getAutoScrollStick(!!pipWindow))) {
			updateScroll(
				pipWindow || window,
				paragraph.closest<HTMLElement>('.textline2')?.parentElement ?? null,
				$lineSettings.reverseLineOrder,
				isVerticalDisplay,
				$lineSettings.enableLineAnimation ? 'smooth' : 'auto',
			);
		}
		if (isActiveGSMLine && !line.recordState && !line.sessionBackfill && $lineSettings.autoTranslateLines) {
			handleAction(line.id, 'TL', $lineSettings.blurAutoTranslatedLines, true);
		}
	}

	async function followUpdatedLineText() {
		if (!lineTextMounted || !isLast || !paragraph) {
			return;
		}
		// Revisions reuse this component, so onMount cannot follow growing speech
		// transcripts. Capture the reader's position before the keyed text rerenders.
		const view = pipWindow || window;
		const container = paragraph.closest<HTMLElement>('.textline2')?.parentElement ?? null;
		if (
			!shouldAutoScroll(
				$lineSettings.alwaysScrollToNewest,
				isScrolledToEnd(view, container, $lineSettings.reverseLineOrder, isVerticalDisplay),
			)
		) {
			return;
		}
		await tick();
		if (!componentMounted || !isLast) {
			return;
		}
		updateScroll(view, container, $lineSettings.reverseLineOrder, isVerticalDisplay, $lineSettings.enableLineAnimation ? 'smooth' : 'auto');
	}

	function getActionsWindow() {
		return pipWindow || window;
	}

	function getActionsDocument() {
		return getActionsWindow().document;
	}

	function removeActionsMenuListeners() {
		getActionsDocument().removeEventListener('click', actionsMenuClickOutsideHandler, false);
		getActionsDocument().removeEventListener('keydown', actionsMenuKeyHandler, false);
		getActionsWindow().removeEventListener('resize', closeActionsMenu, false);
		getActionsDocument().removeEventListener('scroll', closeActionsMenu, true);
	}

	function closeActionsMenu() {
		openMenu = null;
		actionsMenuStyle = 'visibility: hidden;';
		removeActionsMenuListeners();
	}

	function positionActionsMenu() {
		if (!menuAnchor || !actionsMenuPopover) {
			return;
		}

		const view = getActionsWindow();
		const buttonRect = menuAnchor.getBoundingClientRect();
		const menuRect = actionsMenuPopover.getBoundingClientRect();
		const viewportGap = 8;
		const menuGap = 5;
		const maxLeft = Math.max(viewportGap, view.innerWidth - menuRect.width - viewportGap);
		const left = Math.min(maxLeft, Math.max(viewportGap, buttonRect.right - menuRect.width));
		const fitsBelow = buttonRect.bottom + menuGap + menuRect.height <= view.innerHeight - viewportGap;
		const top = fitsBelow
			? buttonRect.bottom + menuGap
			: Math.max(viewportGap, buttonRect.top - menuGap - menuRect.height);

		actionsMenuStyle = `left: ${Math.round(left)}px; top: ${Math.round(top)}px; visibility: visible;`;
	}

	function toggleMenu(event: MouseEvent, menu: 'actions' | 'clip') {
		event.stopPropagation();
		const wasOpen = openMenu === menu;
		closeActionsMenu();
		if (wasOpen) {
			return;
		}

		openMenu = menu;
		menuAnchor = event.currentTarget as HTMLElement;
		tick().then(() => {
			positionActionsMenu();
			getActionsDocument().addEventListener('click', actionsMenuClickOutsideHandler, false);
			getActionsDocument().addEventListener('keydown', actionsMenuKeyHandler, false);
			getActionsWindow().addEventListener('resize', closeActionsMenu, false);
			getActionsDocument().addEventListener('scroll', closeActionsMenu, true);
		});
	}

	function actionsMenuClickOutsideHandler(event: MouseEvent) {
		const target = event.target as Node;
		if (!actionsMenuPopover?.contains(target) && !menuAnchor?.contains(target)) {
			closeActionsMenu();
		}
	}

	function actionsMenuKeyHandler(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			closeActionsMenu();
		}
	}

	function handleDblClick(event: MouseEvent) {
		if (pipWindow) {
			return;
		}

		window.getSelection()?.removeAllRanges();

		if (event.ctrlKey || event.metaKey) {
			if (isSelected) {
				isSelected = false;
				dispatch('deselected', line.id);
			} else {
				isSelected = true;
				dispatch('selected', line.id);
			}
		} else {
			originalText = line.text;
			isEditable = true;

			dispatch('edit', { inEdit: true });

			document.addEventListener('click', clickOutsideHandler, false);

			tick().then(() => {
				paragraph.focus();
			});
		}
	}

	function clickOutsideHandler(event: MouseEvent) {
		const target = event.target as Node;

		if (!paragraph.contains(target)) {
			isEditable = false;
			document.removeEventListener('click', clickOutsideHandler, false);

			dispatch('edit', {
				inEdit: false,
				data: { originalText, newText: paragraph.innerText ?? paragraph.textContent ?? '', lineIndex: index, line },
			});
		}
	}

	function toggleMiningFromKeyboard(event: KeyboardEvent) {
		if (event.target !== event.currentTarget || !isActiveGSMLine || isEditable || $settingsOpen$
			|| event.repeat || event.ctrlKey || event.metaKey || event.altKey
			|| (event.key !== ' ' && event.key !== 'Enter')) return;
		event.preventDefault();
		dispatch('miningToggle', { id: line.id, checked: !miningSelected, shiftKey: event.shiftKey });
	}

	function isMiningSelectorTarget(event: MouseEvent) {
		return isActiveGSMLine && !isEditable && !$settingsOpen$ && !event.defaultPrevented
			&& !event.ctrlKey && !event.metaKey && !event.altKey;
	}

	function startSelectorMining(event: PointerEvent) {
		// Keep touch drags available for scrolling the feed.
		if (event.button !== 0 || event.pointerType === 'touch' || !isMiningSelectorTarget(event)) return;
		event.preventDefault();
		dispatch('miningStart', { id: line.id, checked: !miningSelected, event });
	}

	function clickSelectorMining(event: MouseEvent) {
		if (event.button === 0 && isMiningSelectorTarget(event)) dispatch('miningClick', { id: line.id, event });
	}

	function miningSelectorEvents(node: HTMLElement) {
		node.addEventListener('pointerdown', startSelectorMining);
		node.addEventListener('click', clickSelectorMining);
		node.addEventListener('keydown', toggleMiningFromKeyboard);
		return {
			destroy() {
				node.removeEventListener('pointerdown', startSelectorMining);
				node.removeEventListener('click', clickSelectorMining);
				node.removeEventListener('keydown', toggleMiningFromKeyboard);
			},
		};
	}

	function handleAudioToggle() {
		closeActionsMenu();
		dispatch('audioToggle', { lineId: line.id, text: line.text });
	}

	function handleVideoTrim() {
		closeActionsMenu();
		dispatch('videoTrim', { lineId: line.id, text: line.text });
	}

	function handleSaveClip() {
		closeActionsMenu();
		dispatch('saveClip', { lineId: line.id });
	}

	function handleOpenClipFolder() {
		closeActionsMenu();
		dispatch('openClipFolder', { lineId: line.id });
	}

	function handleDeleteClip() {
		closeActionsMenu();
		if (getActionsWindow().confirm('Move this clip to the trash? You can restore it from there.')) {
			dispatch('deleteClip', { lineId: line.id });
		}
	}

	function openAIHelp() {
		closeActionsMenu();
		aiHelpOpen = true;
	}

	function closeAIHelp() {
		aiHelpOpen = false;
		tick().then(() => actionsMenuButton?.focus());
	}

	async function handleDeleteFromStats() {
		if (!getActionsWindow().confirm('Delete this line from stats?')) {
			return;
		}

		closeActionsMenu();
		try {
			const response = await fetch(getGSMEndpoint('/api/delete-sentence-lines'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ line_ids: [line.id] }),
			});
			if (!response.ok) {
				throw new Error(`HTTP error! Status: ${response.status}`);
			}
		} catch (error) {
			console.error(`Error deleting line ${line.id} from stats:`, error);
		}
	}

	function handleAction(id: string, action: string, blurTranslate: boolean = false, automatic: boolean = false) {
		closeActionsMenu();
		if (action === 'TL') aiError = '';
		const endpoints: Record<string, string> = {
			TL: '/translate-line',
			Screenshot: '/get-screenshot',
		};
		const endpoint = endpoints[action];
		if (!endpoint) {
			return;
		}
		const requestText = line.text.trim();
		if (action === 'TL') {
			if (pendingTranslations?.has(requestText)) return;
			// Manual requests consult GSM's cache so a changed target language
			// can select a new result without relying on stale reader state.
			if (automatic && line.translation && translatedSourceText === requestText) return;
			(pendingTranslations ??= new Set()).add(requestText);
			isTranslating = true;
		}
		fetch(getGSMEndpoint(endpoint), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, text: line.text, automatic }),
		})
			.then(async (response) => {
				if (!response.ok) {
					const data = await response.json().catch(() => ({}));
					throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
				}
				return response.json();
			})
			.then((data) => {
				if (action === 'TL') {
					if (!componentMounted || line.id !== id || line.text.trim() !== requestText) return;
					const container = paragraph.closest<HTMLElement>('.textline2')?.parentElement ?? null;
					// Capture before render so a delayed translation respects the selected scroll behavior.
					const shouldFollowTranslation =
						isLast &&
						shouldAutoScroll(
							$lineSettings.alwaysScrollToNewest,
							isScrolledToEnd(
								pipWindow || window,
								container,
								$lineSettings.reverseLineOrder,
								isVerticalDisplay,
							),
						);

					translatedSourceText = requestText;
					line.translation = data['TL'];
					if (blurTranslate) {
						line.blurTranslation = true;
					} else {
						line.blurTranslation = false;
					}
					clearTimeout(unblurTranslationTimer);
					if ($lineSettings.unblurTLTimer > 0 && line.blurTranslation) {
						unblurTranslationTimer = setTimeout(() => {
							line.blurTranslation = false;
						}, $lineSettings.unblurTLTimer * 1000);
					}

					if (line.index !== undefined) {
						const lines = lineData$.getValue();
						if (lines[line.index]?.id === id) {
							lines[line.index] = line;
							lineData$.next(lines);
						}
					}
					if (shouldFollowTranslation) {
						updateScroll(pipWindow || window, container, $lineSettings.reverseLineOrder, isVerticalDisplay,
							$lineSettings.enableLineAnimation ? 'smooth' : 'auto');
					}
				}
			})
			.catch((error) => {
				if (action === 'TL' && componentMounted && line.id === id && line.text.trim() === requestText) {
					aiError = error.message || 'Translation failed. Check that GSM is running and retry.';
				}
				console.error(`Error performing ${action} action for event ID: ${id}`, error);
			})
			.finally(() => {
				if (action === 'TL') {
					pendingTranslations?.delete(requestText);
					isTranslating = Boolean(pendingTranslations?.size);
					if (!isTranslating) pendingTranslations = undefined;
				}
			});
	}
</script>

	<div
		class="textline2"
		class:mining-selected={miningSelected}
		class:mining-selectable={isActiveGSMLine}
		class:vertical={isVerticalDisplay}
		data-line-id={line.id}
		data-mining-id={isActiveGSMLine ? line.id : undefined}
	>
		<div class="line-body" aria-busy={isTranslating}>
		{#if lineTextMounted}
			<!-- Yomitan's sentence scan needs literal newlines around the dialogue. -->
			{@html newLineCharacter}
			{#key line.text}
			<p
				class="line-source"
				class:line-selected={isSelected}
				class:cursor-text={isEditable}
				class:border-primary={isSelected}
				class:border-accent-focus={isEditable}
				class:whitespace-pre-wrap={$lineSettings.preserveWhitespace}
				contenteditable={isEditable}
				on:dblclick={handleDblClick}
				on:keyup={dummyFn}
				bind:this={paragraph}
				in:introduceLine
			>
				<span class="source-text">{line.text}</span>
			</p>
			{/key}
			{@html newLineCharacter}
			{#if line.translation}
				<div class="line-translation" role="group" aria-label="Translation">
					{#if line.blurTranslation}
						<button type="button" class="translation-text translation-blurred" aria-label="Reveal translation" on:click={() => (line.blurTranslation = false)}>{line.translation}</button>
					{:else}
						<div class="translation-text"><span class="translation-content">{line.translation}</span></div>
					{/if}
				</div>
			{/if}
		{/if}
		</div>
		<div class="line-actions-container" class:hidden={$settingsOpen$}>
			{#if line.excludedFromStats}
				<div
					class="line-badge unselectable"
					title="GSM did not count this line toward stats because collection was paused or the line was excluded by spam detection or another explicit exclusion."
					tabindex="-1"
				>
					Not in GSM stats
				</div>
			{/if}
			{#if isActiveGSMLine || isClipSaved}
				<div class="textline-buttons unselectable">
					{#if $lineSettings.showScreenshotButton}
						<button
							class="hide-on-mobile action-button"
							style:--line-icon={masks.camera}
							on:click={() => handleAction(line.id, 'Screenshot')}
							title="Screenshot"
							tabindex="-1"
						></button>
					{/if}
					{#if $lineSettings.showTrimVideoButton}
						<button
							class="hide-on-mobile action-button"
							style:--line-icon={masks.video}
							on:click={handleVideoTrim}
							title="Save cropped replay"
							tabindex="-1"
						></button>
					{/if}
					{#if isClipSaved}
						<button
							class="action-button clip-status"
							style:--line-icon={masks.saved}
							class:menu-open={openMenu === 'clip'}
							on:click={(event) => toggleMenu(event, 'clip')}
							title="Clip saved for later"
							aria-label="Clip saved for later"
							aria-expanded={openMenu === 'clip'}
							tabindex="-1"
						></button>
					{:else if $lineSettings.showSaveClipButton}
						<!-- Kept visible on small screens: saving from a phone or tablet is the main use. -->
						<button
							class="action-button"
							style:--line-icon={masks.save}
							on:click={handleSaveClip}
							title={isSavingClip ? 'Saving…' : 'Save clip for later'}
							aria-label="Save clip for later"
							tabindex="-1"
							disabled={isSavingClip}
						></button>
					{/if}
					{#if $lineSettings.showAudioButton}
						<button
							class="hide-on-mobile action-button"
							style:--line-icon={isAudioLine && audioIsPlaying ? masks.stop : masks.play}
							class:audio-active={isAudioLine && audioIsPlaying}
							on:click={handleAudioToggle}
							title={audioButtonTitle}
							tabindex="-1"
							disabled={isAudioPending}
						></button>
					{/if}
					{#if $lineSettings.showTranslateButton}
						<button
							class="action-button"
							style:--line-icon={masks.translate}
							on:click={() => handleAction(line.id, 'TL')}
							title="Translate"
							tabindex="-1"
						></button>
					{/if}
				</div>
			{:else if isTimedOutGSMLine}
				{#if $lineSettings.showExpiredIcon}
					<div
						class="line-indicator unselectable"
						style:--line-icon={masks.clock}
						title="Line is outside replay buffer"
						tabindex="-1"
						style="color: #666;"
					></div>
				{/if}
				{#if $lineSettings.showTranslateButton}
					<button
						class="action-button"
						style:--line-icon={masks.translate}
						on:click={() => handleAction(line.id, 'TL')}
						title="Translate"
						style="margin-left: 5px;"
						tabindex="-1"
					></button>
				{/if}
			{:else if line.gsmStatus === 'external'}
				{#if $lineSettings.showTranslateButton}
					<button
						class="action-button"
						style:--line-icon={masks.translate}
						on:click={() => handleAction(line.id, 'TL')}
						title="Translate"
						tabindex="-1"
					></button>
				{/if}
			{:else if $lineSettings.showExpiredIcon}
				<!-- Show different icon for lines that are from before GSM was started. -->
				<div
					class="line-indicator unselectable"
					style:--line-icon={masks.history}
					title="Line is from before GSM was started"
					tabindex="-1"
					style="color: #666;"
				></div>
			{/if}
			{#if canAskAI && $lineSettings.showMenuButton}
				<div class="actions-menu">
					<button
						class="action-button menu-toggle"
						style:--line-icon={masks.menu}
						class:menu-open={actionsMenuOpen}
						on:click={(event) => toggleMenu(event, 'actions')}
						title="More line actions"
						aria-label="More line actions"
						aria-expanded={actionsMenuOpen}
						bind:this={actionsMenuButton}
					></button>
				</div>
			{/if}
			{#if openMenu}
				<div
					class="actions-menu-popover"
					class:clip-menu={openMenu === 'clip'}
					style={actionsMenuStyle}
					bind:this={actionsMenuPopover}
				>
					{#if openMenu === 'clip'}
						<div class="clip-menu-info" title="Disk space used by this clip">
							<span aria-hidden="true">💾</span>
							<span>Clip{clipSizeLabel ? ` · ${clipSizeLabel}` : ''}</span>
						</div>
						<button on:click={handleOpenClipFolder} title="Open clip folder">
							<span aria-hidden="true">📂</span>
							<span>Open clip folder</span>
						</button>
						<button on:click={handleDeleteClip} title="Delete clip">
							<span aria-hidden="true">🗑️</span>
							<span>Delete clip</span>
						</button>
					{:else}
						<button on:click={openAIHelp}>
							<Icon path={mdiCreationOutline} width="16px" height="16px" />
							<span>Ask AI</span>
						</button>
						{#if isActiveGSMLine || isClipSaved}
							<button on:click={() => handleAction(line.id, 'Screenshot')}>
								<span aria-hidden="true">📷</span>
								<span>Screenshot</span>
							</button>
							<button on:click={handleVideoTrim}>
								<span aria-hidden="true">🎬</span>
								<span>Save cropped replay</span>
							</button>
							{#if !isClipSaved}
								<button
									on:click={handleSaveClip}
									disabled={isSavingClip}
									title="Keep a replay clip of this line so a card can be made later"
								>
									<span aria-hidden="true">💾</span>
									<span>{isSavingClip ? 'Saving…' : 'Save clip for later'}</span>
								</button>
							{/if}
							<button on:click={handleAudioToggle} disabled={isAudioPending}>
								<Icon
									path={isAudioLine && audioIsPlaying ? mdiStop : mdiPlay}
									width="16px"
									height="16px"
								/>
								<span>{audioButtonTitle}</span>
							</button>
						{/if}
						<button on:click={() => handleAction(line.id, 'TL')} title="Translate">
							<span aria-hidden="true">🌐</span>
							<span>Translate</span>
						</button>
						{#if isActiveGSMLine}
							<button on:click={handleDeleteFromStats}>
								<span aria-hidden="true">🗑️</span>
								<span>Delete from stats</span>
							</button>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
		{#if isActiveGSMLine}
			<div
				class="mining-selector unselectable"
				class:hidden={$settingsOpen$}
				role="checkbox"
				tabindex={$settingsOpen$ ? -1 : 0}
				aria-checked={miningSelected}
				aria-label={miningSelected ? 'Selected line for mining' : 'Select line for mining'}
				aria-keyshortcuts="Space Enter"
				title="Click or drag to select lines for mining (Shift+click for range)"
				use:miningSelectorEvents
			>
				<span class="mining-checkbox" style:--line-icon={masks.check} aria-hidden="true"></span>
			</div>
		{/if}
	</div>
{#if aiError}
	<p role="alert" class="mx-4 text-sm">{aiError} <a class="underline" href="https://docs.gamesentenceminer.com/docs/features/ai-features" target="_blank" rel="noreferrer">AI setup guide</a></p>
{/if}
{#if canAskAI && aiHelpOpen && !$settingsOpen$}
	{#key `${line.id}:${line.text.trim()}`}
		<AIHelp id={line.id} text={line.text} on:close={closeAIHelp} />
	{/key}
{/if}
{#if $milestoneLines$.has(line.id)}
	<div
		class="flex justify-center text-xs my-2 py-2 border-primary border-dashed milestone"
		class:border-x-2={$lineSettings.displayVertical}
		class:border-y-2={!$lineSettings.displayVertical}
		class:py-4={!isVerticalDisplay}
		class:px-2={!isVerticalDisplay}
		class:py-2={isVerticalDisplay}
		class:px-4={isVerticalDisplay}
	>
		<div class="flex items-center">
			<Icon class={$lineSettings.displayVertical ? '' : 'mr-2'} path={mdiTrophy}></Icon>
			<span class:mt-2={$lineSettings.displayVertical}>{$milestoneLines$.get(line.id)}</span>
		</div>
	</div>
{/if}

<style>
	p:focus-visible {
		outline: none;
	}

	.textline2:focus-visible, .action-button:focus-visible,
	button.translation-text:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
	.mining-selector:focus-visible { outline: none; }
	.source-text, .translation-content { cursor: text; }
	.action-button::before, .line-indicator::before, .mining-checkbox::before {
		content: '';
		display: block;
		flex: none;
		width: 20px;
		height: 20px;
		background-color: currentColor;
		mask: var(--line-icon) center / contain no-repeat;
	}
	.line-indicator::before { width: 32px; height: 32px; }
	.mining-checkbox::before { width: 18px; height: 18px; }
	@media (forced-colors: active) {
		.action-button::before, .line-indicator::before, .mining-checkbox::before {
			forced-color-adjust: none;
			background-color: ButtonText;
		}
	}

	.action-button {
		background-color: color-mix(in srgb, var(--color-base-content) 3%, transparent);
		color: color-mix(in srgb, var(--color-base-content) 88%, transparent);
		border: 1px solid transparent;
		padding: 7px;
		font-size: 13px;
		border-radius: 7px;
		cursor: pointer;
		transition: background-color 140ms, color 140ms;
		user-select: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		min-width: 36px;
	}

	.action-button:hover {
		background-color: color-mix(in srgb, var(--color-base-content) 12%, transparent);
		color: var(--color-base-content);
		cursor: pointer;
	}

	.action-button.audio-active {
		background-color: color-mix(in srgb, var(--color-success) 15%, transparent);
		color: var(--color-success);
		border-color: color-mix(in srgb, var(--color-success) 35%, transparent);
	}

	.action-button.menu-open {
		background-color: color-mix(in srgb, var(--color-base-content) 10%, transparent);
		border-color: color-mix(in srgb, var(--color-base-content) 20%, transparent);
	}

	.action-button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.textline-buttons {
		margin-left: auto; /* Align buttons to the right */
		display: flex;
		gap: 5px;
	}

	.actions-menu {
		display: inline-flex;
	}

	.actions-menu-popover {
		position: fixed;
		z-index: 70;
		display: flex;
		width: min(172px, calc(100vw - 16px));
		flex-direction: column;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--color-base-content) 18%, transparent);
		border-radius: 9px;
		background: var(--color-base-200, #222);
		box-shadow: 0 4px 14px rgb(0 0 0 / 35%);
		font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		font-size: 12px;
		font-weight: 400;
		line-height: 1.2;
		letter-spacing: normal;
		writing-mode: horizontal-tb;
	}

	.actions-menu-popover button {
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 30px;
		border: 0;
		border-bottom: 1px solid color-mix(in srgb, var(--color-base-content) 8%, transparent);
		background: transparent;
		color: var(--color-base-content);
		padding: 6px 8px;
		font: inherit;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}

	.actions-menu-popover button:last-child {
		border-bottom: 0;
	}

	.actions-menu-popover button:hover {
		background: color-mix(in srgb, var(--color-base-content) 8%, transparent);
	}

	.actions-menu-popover button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	/* Hide only buttons with .hide-on-mobile on mobile devices */
	@media (max-width: 800px) {
		.hide-on-mobile {
			display: none !important;
		}
	}

	.textline2 {
		margin: 4px 0;
		padding: 14px 12px;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		border: 1px solid transparent;
		border-left-width: 3px;
		border-radius: 10px;
		transition: background-color 140ms, border-color 140ms;
	}
	.textline2.mining-selectable {
		grid-template-columns: minmax(0, 1fr) auto auto;
	}
	.textline2.mining-selectable:not(.mining-selected):has(.mining-selector:hover),
	.textline2.mining-selectable:not(.mining-selected):has(.mining-selector:focus-visible) {
		background: color-mix(in srgb, var(--color-base-content) 3%, transparent);
		border-left-color: color-mix(in srgb, var(--color-base-content) 25%, transparent);
	}
	.textline2.mining-selected {
		background: color-mix(in srgb, var(--color-primary) 12%, transparent);
		border-left-color: color-mix(in srgb, var(--color-primary) 75%, var(--color-base-content));
	}
	.textline2.mining-selected:has(.mining-selector:hover) { background: color-mix(in srgb, var(--color-primary) 16%, transparent); }
	.mining-selector {
		align-self: stretch;
		margin: -14px -12px -14px -6px;
		padding: 14px 12px 14px 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		touch-action: pan-y;
	}
	.mining-checkbox {
		min-width: 40px;
		min-height: 36px;
		padding: 7px 10px;
		border-radius: 7px;
		border: 1px solid color-mix(in srgb, var(--color-base-content) 14%, transparent);
		background-color: color-mix(in srgb, var(--color-base-content) 3%, transparent);
		color: color-mix(in srgb, var(--color-base-content) 26%, transparent);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: background-color 140ms, border-color 140ms, color 140ms, box-shadow 140ms;
	}
	.mining-selector:hover .mining-checkbox {
		background-color: color-mix(in srgb, var(--color-primary) 12%, var(--color-base-content) 4%);
		border-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
		color: color-mix(in srgb, var(--color-primary) 85%, var(--color-base-content));
	}
	.mining-selector:focus-visible .mining-checkbox {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}
	.textline2.mining-selected .mining-checkbox {
		border-color: color-mix(in srgb, var(--color-primary) 80%, transparent);
		background-color: var(--color-primary);
		color: var(--color-primary-content, #fff);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 16%, transparent);
	}
	.textline2.mining-selected .mining-selector:hover .mining-checkbox {
		background-color: color-mix(in srgb, var(--color-primary) 88%, var(--color-base-content));
	}
	.line-body { min-width: 0; }
	.line-source {
		margin: 0;
		padding: 0;
		inline-size: fit-content;
		max-inline-size: 100%;
		line-height: 1.65;
		border-radius: 4px;
		overflow-wrap: anywhere;
	}
	.line-source.line-selected { outline: 1px solid var(--color-primary); outline-offset: 5px; }
	.line-source[contenteditable='true'] {
		outline: 1px solid var(--color-primary);
		outline-offset: 5px;
		background: color-mix(in srgb, var(--color-primary) 5%, transparent);
	}
	.line-translation { margin-block-start: 2px; }
	.translation-text {
		display: block;
		margin: 0;
		inline-size: fit-content;
		max-inline-size: 100%;
		border: 0;
		padding: 0;
		padding-inline-start: 8px;
		background: transparent;
		color: #888;
		font: inherit;
		font-size: 0.84em;
		font-style: italic;
		line-height: 1.6;
		text-align: start;
		white-space: pre-wrap;
		word-break: normal;
		overflow-wrap: anywhere;
		transition: filter 150ms;
	}
	button.translation-text { cursor: pointer; }
	.translation-blurred { filter: blur(6px); user-select: none; }
	.translation-blurred:hover, .translation-blurred:focus-visible { filter: none; }
	.textline2.vertical { display: flex; gap: 10px; }
	.vertical .line-body { display: flex; flex-direction: column; gap: 12px; }
	.vertical .line-translation { writing-mode: horizontal-tb; inline-size: 16rem; max-inline-size: 70vh; margin: 0; align-self: flex-start; }
	.vertical .line-actions-container { writing-mode: horizontal-tb; }
	.vertical .mining-selector {
		writing-mode: horizontal-tb;
		margin: 0;
		padding: 4px;
	}
	@media (max-width: 640px) {
		.textline2 { padding: 12px 2px; gap: 6px; grid-template-columns: minmax(0, 1fr); }
		.textline2.mining-selectable { grid-template-columns: minmax(0, 1fr) auto; }
		.line-actions-container { grid-column: 1; grid-row: 2; padding-block-start: 0; }
		.mining-selector { grid-column: 2; grid-row: 1 / span 2; margin: -12px -2px -12px 0; padding: 12px 8px; }
		.action-button, .mining-checkbox { padding: 5px; min-width: 32px; min-height: 32px; }
	}
	@media (prefers-reduced-motion: reduce) { .textline2, .translation-text, .action-button, .mining-checkbox { transition: none; } }

	.unselectable,
	.unselectable * {
		user-select: none !important;
		-webkit-user-select: none !important;
		-moz-user-select: none !important;
		-ms-user-select: none !important;
	}

	.line-indicator {
		display: flex;
		align-items: center;
		opacity: 0.6;
		transition: opacity 0.2s ease;
		margin-left: 8px;
		/* cursor: help; */
		margin-left: auto;
		user-select: none; /* Make text unselectable */
		gap: 10px;
	}

	.line-indicator:hover {
		opacity: 1;
	}

	.clip-status {
		color: var(--color-success);
	}

	.clip-menu-info {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 7px 10px;
		opacity: 0.7;
	}

	.line-actions-container {
		margin-left: auto;
		min-width: 0;
		display: flex;
		align-items: center;
		align-self: center;
		justify-content: flex-end;
		gap: 5px;
	}

	.line-badge {
		background: rgba(255, 193, 7, 0.15);
		border: 1px solid rgba(255, 193, 7, 0.45);
		color: #f5d76e;
		border-radius: 999px;
		padding: 4px 10px;
		font-size: 11px;
		line-height: 1.2;
		white-space: nowrap;
	}

	.hidden {
		visibility: hidden;
	}
</style>
