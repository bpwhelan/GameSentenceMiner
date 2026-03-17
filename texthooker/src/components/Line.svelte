<script lang="ts">
	import { mdiTrophy, mdiClockOutline, mdiHistory, mdiPlay, mdiStop } from '@mdi/js';
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import {
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
	import { dummyFn, newLineCharacter, updateScroll } from '../util';
	import Icon from './Icon.svelte';
	import { getGSMEndpoint } from '../gsm';

	export let line: LineItem;
	export let index: number;
	export let isLast: boolean;
	export let pipWindow: Window = undefined;
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
	let isSelected = false;
	let isEditable = false;
	$: isAudioLine = audioLineId === line.id;
	$: isAudioPending = audioPendingLineId === line.id;
	$: audioButtonTitle = isAudioPending ? 'Preparing audio...' : isAudioLine && audioIsPlaying ? 'Stop audio' : 'Play audio';

	$: isVerticalDisplay = !pipWindow && $displayVertical$;

	onMount(() => {
		if (isLast) {
			updateScroll(
				pipWindow || window,
				paragraph.parentElement.parentElement,
				$reverseLineOrder$,
				isVerticalDisplay,
				$enableLineAnimation$ ? 'smooth' : 'auto',
			);
			if ($lineIDs$ && $lineIDs$.includes(line.id) && $autoTranslateLines$) {
				handleAction(line.id, 'TL', $blurAutoTranslatedLines$);
			}
		}
	});

	onDestroy(() => {
		document.removeEventListener('click', clickOutsideHandler, false);
		dispatch('edit', { inEdit: false });
	});

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
		dispatch('audioToggle', { lineId: line.id, text: line.text });
	}

	function handleVideoTrim() {
		dispatch('videoTrim', { lineId: line.id, text: line.text });
	}

	function handleAction(id: string, action: string, blurTranslate: boolean = false) {
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
					$lineData$[line.index] = line;
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
				class:invisible={!($lineIDs$ && $lineIDs$.includes(line.id))}
				id="multi-line-checkbox-{line.id}"
				aria-label={line.id}
				on:change={() => toggleCheckbox(line.id)}
			/>
		{/if}
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
				<p
					class:blur-translation={line.blurTranslation}
					style="color: #888; padding-bottom: 16px; padding-top: 16px; width: 100%; {line.blurTranslation
						? 'filter: blur(8px); transition: filter 0.2s;'
						: ''}"
					on:mouseenter={line.blurTranslation
						? function () {
								this.style.filter = 'blur(0px)';
								this.style.transition = 'filter 0.3s';
							}
						: undefined}
					on:mouseleave={line.blurTranslation
						? function () {
								this.style.filter = 'blur(8px)';
							}
						: undefined}
				>
					<i>{line.translation}</i>
				</p>
			{/if}
		</p>
		<div class="line-actions-container" class:hidden={$settingsOpen$}>
			{#if $lineIDs$ && $lineIDs$.includes(line.id)}
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
						<button class="hide-on-mobile action-button" on:click={handleVideoTrim} title="Trim replay video" tabindex="-1">
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
				</div>
			{:else if $timedOutIDs$.includes(line.id)}
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

	.action-button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.textline-buttons {
		margin-left: auto; /* Align buttons to the right */
		display: flex;
		gap: 10px;
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
	}

	.hidden {
		visibility: hidden;
	}
</style>
