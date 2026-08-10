<script lang="ts">
	import { mdiClockOutline, mdiHistory, mdiMenu, mdiPlay, mdiStop, mdiTrophy } from '@mdi/js';
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import {
		alwaysScrollToNewest$,
		displayVertical$,
		enableLineAnimation$,
		preserveWhitespace$,
		reverseLineOrder$,
		lineIDs$,
		lineData$,
		autoTranslateLines$,
		blurAutoTranslatedLines$,
		milestoneLines$,
		timedOutIDs$,
		unblurTLTimer$,
		showGSMCheckboxes$,
		showScreenshotButton$,
		showAudioButton$,
		showTrimVideoButton$,
		showTranslateButton$,
		settingsOpen$,
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
	import { getGSMEndpoint } from '../gsm';

	export let line: LineItem;
	export let index: number;
	export let isLast: boolean;
	export let pipWindow: Window | undefined = undefined;
	export let audioLineId = '';
	export let audioIsPlaying = false;
	export let audioPendingLineId = '';

	export function deselect() {
		isSelected = false;
	}

	export function getIdIfSelected(range: Range) {
		return isSelected || range.intersectsNode(paragraph) ? line.id : undefined;
	}

	const dispatch = createEventDispatcher<{
		deselected: string;
		selected: string;
		edit: LineItemEditEvent;
		audioToggle: { lineId: string; text: string };
		videoTrim: { lineId: string; text: string };
	}>();

	let paragraph: HTMLElement;
	let originalText = '';
	let componentMounted = false;
	let lineTextMounted = false;
	let autoTranslationRevision = -1;
	let isSelected = false;
	let isEditable = false;
	let actionsMenuOpen = false;
	let actionsMenuElement: HTMLElement;
	let actionsMenuButton: HTMLButtonElement;
	let actionsMenuPopover: HTMLElement;
	let actionsMenuStyle = 'visibility: hidden;';
	$: isAudioLine = audioLineId === line.id;
	$: isAudioPending = audioPendingLineId === line.id;
	$: audioButtonTitle = isAudioPending ? 'Preparing audio...' : isAudioLine && audioIsPlaying ? 'Stop audio' : 'Play audio';
	$: isActiveGSMLine = line.gsmStatus === 'active' || (!line.gsmStatus && $lineIDs$?.includes(line.id));
	$: isTimedOutGSMLine = line.gsmStatus === 'timed_out' || (!line.gsmStatus && $timedOutIDs$.includes(line.id));

	$: isVerticalDisplay = !pipWindow && $displayVertical$;
	$: if (
		componentMounted &&
		line.recordState === 'frozen' &&
		!line.sessionBackfill &&
		$autoTranslateLines$ &&
		Number(line.revision ?? 0) > autoTranslationRevision
	) {
		autoTranslationRevision = Number(line.revision ?? 0);
		handleAction(line.id, 'TL', $blurAutoTranslatedLines$);
	}

	onMount(() => {
		componentMounted = true;
		void revealLineText();
	});

	onDestroy(() => {
		componentMounted = false;
		document.removeEventListener('click', clickOutsideHandler, false);
		removeActionsMenuListeners();
		dispatch('edit', { inEdit: false });
	});

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
		if (shouldAutoScroll($alwaysScrollToNewest$, getAutoScrollStick(!!pipWindow))) {
			updateScroll(
				pipWindow || window,
				paragraph.parentElement?.parentElement ?? null,
				$reverseLineOrder$,
				isVerticalDisplay,
				$enableLineAnimation$ ? 'smooth' : 'auto',
			);
		}
		if (isActiveGSMLine && !line.recordState && !line.sessionBackfill && $autoTranslateLines$) {
			handleAction(line.id, 'TL', $blurAutoTranslatedLines$);
		}
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
		actionsMenuOpen = false;
		actionsMenuStyle = 'visibility: hidden;';
		removeActionsMenuListeners();
	}

	function positionActionsMenu() {
		if (!actionsMenuButton || !actionsMenuPopover) {
			return;
		}

		const view = getActionsWindow();
		const buttonRect = actionsMenuButton.getBoundingClientRect();
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

	function toggleActionsMenu(event: MouseEvent) {
		event.stopPropagation();
		if (actionsMenuOpen) {
			closeActionsMenu();
			return;
		}

		actionsMenuOpen = true;
		tick().then(() => {
			positionActionsMenu();
			getActionsDocument().addEventListener('click', actionsMenuClickOutsideHandler, false);
			getActionsDocument().addEventListener('keydown', actionsMenuKeyHandler, false);
			getActionsWindow().addEventListener('resize', closeActionsMenu, false);
			getActionsDocument().addEventListener('scroll', closeActionsMenu, true);
		});
	}

	function actionsMenuClickOutsideHandler(event: MouseEvent) {
		if (!actionsMenuElement?.contains(event.target as Node)) {
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
			originalText = paragraph.innerText;
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
				data: { originalText, newText: paragraph.innerText, lineIndex: index, line },
			});
		}
	}

	async function toggleCheckbox(id: string) {
		try {
			const res = await fetch(getGSMEndpoint('/update_checkbox'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id }),
			});
			if (!res.ok) {
				throw new Error(`HTTP error! Status: ${res.status}`);
			}
		} catch (error) {
			console.error('Error updating checkbox:', error);
		}
	}

	function handleAudioToggle() {
		closeActionsMenu();
		dispatch('audioToggle', { lineId: line.id, text: line.text });
	}

	function handleVideoTrim() {
		closeActionsMenu();
		dispatch('videoTrim', { lineId: line.id, text: line.text });
	}

	function handleAction(id: string, action: string, blurTranslate: boolean = false) {
		closeActionsMenu();
		const endpoints: Record<string, string> = {
			TL: '/translate-line',
			Screenshot: '/get-screenshot',
		};
		const endpoint = endpoints[action];
		if (!endpoint) {
			return;
		}
		fetch(getGSMEndpoint(endpoint), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, text: line.text }),
		})
			.then((response) => {
				if (!response.ok) {
					throw new Error(`HTTP error! Status: ${response.status}`);
				}
				return response.json();
			})
			.then((data) => {
				if (action === 'TL') {
					// Capture before render so a delayed translation respects the selected scroll behavior.
					const shouldFollowTranslation =
						isLast &&
						shouldAutoScroll(
							$alwaysScrollToNewest$,
							isScrolledToEnd(
								pipWindow || window,
								paragraph.parentElement?.parentElement ?? null,
								$reverseLineOrder$,
								isVerticalDisplay,
							),
						);

					line.translation = data['TL'];
					if (blurTranslate) {
						line.blurTranslation = true;
					} else {
						line.blurTranslation = false;
					}
					if ($unblurTLTimer$ > 0 && line.blurTranslation) {
						setTimeout(() => {
							line.blurTranslation = false;
						}, $unblurTLTimer$ * 1000);
					}

					if (!line.text.endsWith('\n')) {
						line.text += '\n';
					}
					if (line.index !== undefined) {
						$lineData$[line.index] = line;
					}
					if (shouldFollowTranslation) {
						tick().then(() => {
							const behavior = $enableLineAnimation$ ? 'smooth' : 'auto';
							paragraph?.scrollIntoView({
								behavior,
								block: $reverseLineOrder$ ? 'start' : 'end',
								inline: isVerticalDisplay ? 'end' : 'nearest',
							});
							// Scroll a bit more down
							(pipWindow || window).scrollBy(0, 50);
						});
					}
				}
			})
			.catch((error) => {
				console.error(`Error performing ${action} action for event ID: ${id}`, error);
			});
	}
</script>

{#key line.text}
	<div class="textline2">
		{#if $showGSMCheckboxes$}
			<input
				type="checkbox"
				class="multi-line-checkbox"
				class:invisible={!isActiveGSMLine}
				id="multi-line-checkbox-{line.id}"
				aria-label={line.id}
				on:change={() => toggleCheckbox(line.id)}
			/>
		{/if}
		{#if lineTextMounted}
			<p
				class="my-2 cursor-pointer border-2"
				class:py-4={!isVerticalDisplay}
				class:px-2={!isVerticalDisplay}
				class:py-2={isVerticalDisplay}
				class:px-4={isVerticalDisplay}
				class:border-transparent={!isSelected}
				class:cursor-text={isEditable}
				class:border-primary={isSelected}
				class:border-accent-focus={isEditable}
				class:whitespace-pre-wrap={$preserveWhitespace$}
				contenteditable={isEditable}
				on:dblclick={handleDblClick}
				on:keyup={dummyFn}
				bind:this={paragraph}
				in:fly={{ x: isVerticalDisplay ? 100 : -100, duration: $enableLineAnimation$ ? 250 : 0 }}
			>
				{line.text}
				{#if line.translation}
					<span
						class:blur-translation={line.blurTranslation}
						style="color: #888; padding-bottom: 16px; padding-top: 16px; width: 100%; {line.blurTranslation
							? 'filter: blur(8px); transition: filter 0.2s;'
							: ''}"
						on:mouseenter={line.blurTranslation
							? function (event: MouseEvent) {
									const target = event.currentTarget as HTMLElement;
									target.style.filter = 'blur(0px)';
									target.style.transition = 'filter 0.3s';
								}
							: undefined}
						on:mouseleave={line.blurTranslation
							? function (event: MouseEvent) {
									(event.currentTarget as HTMLElement).style.filter = 'blur(8px)';
								}
							: undefined}
					>
						<i>{line.translation}</i>
					</span>
				{/if}
			</p>
		{/if}
		<div class="line-actions-container" class:hidden={$settingsOpen$}>
			{#if line.excludedFromStats}
				<div
					class="line-badge unselectable"
					title="This line was relayed while GSM text intake was paused, so GSM did not count it toward stats or trigger overlay processing."
					tabindex="-1"
				>
					Not in GSM stats
				</div>
			{/if}
			{#if isActiveGSMLine}
				<div class="textline-buttons unselectable">
					{#if $showScreenshotButton$}
						<button
							class="hide-on-mobile action-button"
							on:click={() => handleAction(line.id, 'Screenshot')}
							title="Screenshot"
							tabindex="-1"
						>
							&#x1F4F7;
						</button>
					{/if}
					{#if $showTrimVideoButton$}
						<button
							class="hide-on-mobile action-button"
							on:click={handleVideoTrim}
							title="Save cropped replay"
							tabindex="-1"
						>
							🎬
						</button>
					{/if}
					{#if $showAudioButton$}
						<button
							class="hide-on-mobile action-button"
							class:audio-active={isAudioLine && audioIsPlaying}
							on:click={handleAudioToggle}
							title={audioButtonTitle}
							tabindex="-1"
							disabled={isAudioPending}
						>
							<Icon path={isAudioLine && audioIsPlaying ? mdiStop : mdiPlay} width="16px" height="16px" />
						</button>
					{/if}
					{#if $showTranslateButton$}
						<button
							class="action-button"
							on:click={() => handleAction(line.id, 'TL')}
							title="Translate"
							tabindex="-1"
						>
							🌐
						</button>
					{/if}
					<div class="actions-menu" bind:this={actionsMenuElement}>
						<button
							class="action-button menu-toggle"
							class:menu-open={actionsMenuOpen}
							on:click={toggleActionsMenu}
							title="More line actions"
							aria-label="More line actions"
							aria-expanded={actionsMenuOpen}
							tabindex="-1"
							bind:this={actionsMenuButton}
						>
							<Icon path={mdiMenu} width="16px" height="16px" />
						</button>
						{#if actionsMenuOpen}
							<div
								class="actions-menu-popover"
								style={actionsMenuStyle}
								bind:this={actionsMenuPopover}
							>
								<button on:click={() => handleAction(line.id, 'Screenshot')}>
									<span aria-hidden="true">📷</span>
									<span>Screenshot</span>
								</button>
								<button on:click={handleVideoTrim}>
									<span aria-hidden="true">🎬</span>
									<span>Save cropped replay</span>
								</button>
								<button on:click={handleAudioToggle} disabled={isAudioPending}>
									<Icon
										path={isAudioLine && audioIsPlaying ? mdiStop : mdiPlay}
										width="16px"
										height="16px"
									/>
									<span>{audioButtonTitle}</span>
								</button>
								<button on:click={() => handleAction(line.id, 'TL')}>
									<span aria-hidden="true">🌐</span>
									<span>Translate</span>
								</button>
							</div>
						{/if}
					</div>
				</div>
			{:else if isTimedOutGSMLine}
				<div
					class="line-indicator unselectable"
					title="Line is outside replay buffer"
					tabindex="-1"
					style="color: #666;"
				>
					<Icon path={mdiClockOutline} width="32px" height="32px" />
				</div>
				{#if $showTranslateButton$}
					<button
						class="action-button"
						on:click={() => handleAction(line.id, 'TL')}
						title="Translate"
						style="margin-left: 5px;"
						tabindex="-1"
					>
						🌐
					</button>
				{/if}
			{:else if line.gsmStatus === 'external'}
				{#if $showTranslateButton$}
					<button
						class="action-button"
						on:click={() => handleAction(line.id, 'TL')}
						title="Translate"
						tabindex="-1"
					>
						🌐
					</button>
				{/if}
			{:else}
				<!-- Show different icon for lines that are from before GSM was started. -->
				<div
					class="line-indicator unselectable"
					title="Line is from before GSM was started"
					tabindex="-1"
					style="color: #666;"
				>
					<Icon path={mdiHistory} width="32px" height="32px" />
				</div>
			{/if}
		</div>
	</div>
{/key}
{@html newLineCharacter}
{#if $milestoneLines$.has(line.id)}
	<div
		class="flex justify-center text-xs my-2 py-2 border-primary border-dashed milestone"
		class:border-x-2={$displayVertical$}
		class:border-y-2={!$displayVertical$}
		class:py-4={!isVerticalDisplay}
		class:px-2={!isVerticalDisplay}
		class:py-2={isVerticalDisplay}
		class:px-4={isVerticalDisplay}
	>
		<div class="flex items-center">
			<Icon class={$displayVertical$ ? '' : 'mr-2'} path={mdiTrophy}></Icon>
			<span class:mt-2={$displayVertical$}>{$milestoneLines$.get(line.id)}</span>
		</div>
	</div>
{/if}

<style>
	p:focus-visible {
		outline: none;
	}

	.multi-line-checkbox {
		transform: scale(1.5);
		margin-right: 10px;
		background-color: #00ffff !important; /* Cyan/Electric Blue */
		border: 4px solid #00ffff; /* Keep the border the same color */
	}

	.multi-line-checkbox.invisible {
		visibility: hidden;
	}

	.action-button {
		background-color: #333;
		color: #fff;
		border: 1px solid #555;
		padding: 6px 10px;
		font-size: 10px;
		border-radius: 4px;
		cursor: pointer;
		transition: background-color 0.2s ease;
		user-select: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 28px;
		min-width: 28px;
	}

	.action-button:hover {
		background-color: #444;
		cursor: pointer;
	}

	.action-button.audio-active {
		background-color: #1f5f4f;
		border-color: #2f8a73;
	}

	.action-button.menu-open {
		background-color: #444;
		border-color: #777;
	}

	.action-button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.textline-buttons {
		margin-left: auto; /* Align buttons to the right */
		display: flex;
		gap: 10px;
	}

	.actions-menu {
		position: relative;
		display: inline-flex;
	}

	.actions-menu-popover {
		position: fixed;
		z-index: 70;
		display: flex;
		width: min(172px, calc(100vw - 16px));
		flex-direction: column;
		overflow: hidden;
		border: 1px solid #555;
		border-radius: 4px;
		background: #222;
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
		border-bottom: 1px solid #444;
		background: transparent;
		color: #fff;
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
		background: #3a3a3a;
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
		margin: 15px 0;
		padding: 15px;
		display: flex;
		align-items: center;
		gap: 15px;
	}

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

	.line-actions-container {
		margin-left: auto;
		min-width: 128px; /* Reserve minimum space for icons */
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
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
