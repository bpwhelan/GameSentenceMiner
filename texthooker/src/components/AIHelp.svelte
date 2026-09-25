<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';
	import { getGSMEndpoint } from '../gsm';

	export let id: string;
	export let text: string;
	const dispatch = createEventDispatcher<{ close: void }>();
	let mode = 'sentence';
	let question = '';
	let result = '';
	let error = '';
	let busy = false;
	let modeSelect: HTMLSelectElement;
	let controller: AbortController | undefined;
	const modes = [
		['sentence', 'Sentence breakdown'], ['grammar', 'Grammar'], ['vocabulary', 'Vocabulary'],
		['nuance', 'Nuance and tone'], ['context', 'Scene summary'], ['custom', 'Ask a question'],
	];
	onDestroy(() => controller?.abort());
	onMount(() => modeSelect?.focus());

	async function explain() {
		if (busy || (mode === 'custom' && !question.trim())) return;
		busy = true;
		error = '';
		result = '';
		controller = new AbortController();
		const source = text.trim();
		try {
			const response = await fetch(getGSMEndpoint('/analyze-line'), {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, text: source, mode, question }), signal: controller.signal,
			});
			const data = await response.json();
			if (source !== text.trim()) return;
			if (!response.ok) error = data.error || 'AI request failed. Check AI / Translation settings and retry.';
			else result = data.analysis;
		} catch (cause) {
			if (!controller.signal.aborted) error = 'Could not reach GSM. Check that it is running, then retry.';
		} finally {
			busy = false;
		}
	}

	async function openSettings() {
		try {
			const response = await fetch(getGSMEndpoint('/ai/open-settings'), { method: 'POST' });
			const data = await response.json();
			error = data.settings_opened
				? 'AI setup is open. Choose a provider, paste an API key, test the connection, then retry here.'
				: 'On the computer running GSM, open Config → AI / Translation to set up a provider.';
		} catch (_) {
			error = 'Could not reach GSM. Open Config → AI / Translation on the computer running GSM.';
		}
	}
</script>

<div class="ai-help">
	<section aria-label="AI sentence help">
		<div class="heading">
			<strong>Ask AI about this line</strong>
			<button class="close-button" aria-label="Close AI help" on:click={() => dispatch('close')}>×</button>
		</div>
		<div class="controls">
			<select aria-label="Explanation type" bind:this={modeSelect} bind:value={mode} disabled={busy}>
				{#each modes as [value, label]}<option {value}>{label}</option>{/each}
			</select>
			<button disabled={busy || (mode === 'custom' && !question.trim())} on:click={explain}>{busy ? 'Explaining…' : 'Explain'}</button>
			<button on:click={openSettings}>AI setup</button>
		</div>
		{#if mode === 'custom'}
			<label>Your question
				<input bind:value={question} maxlength="4000" placeholder="What does this particle mean here?" disabled={busy} on:keydown={(event) => { if (event.key === 'Enter') void explain(); }} />
			</label>
		{/if}
		{#if error}<p role="alert">{error} <a href="https://docs.gamesentenceminer.com/docs/features/ai-features" target="_blank" rel="noreferrer">Setup guide</a></p>{/if}
		{#if result}<div class="result" aria-live="polite">{result}</div>{/if}
	</section>
</div>

<style>
	.ai-help { margin: -10px 15px 12px; font: 14px/1.5 system-ui, sans-serif; writing-mode: horizontal-tb; }
	button, select, input { color: inherit; background: var(--color-base-200, #222); border: 1px solid #666; border-radius: 5px; padding: 5px 9px; font: inherit; }
	button { cursor: pointer; }
	button:disabled { opacity: .55; cursor: wait; }
	section { border: 1px solid #666; border-radius: 7px; padding: 12px; max-width: 850px; }
	.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
	.close-button { border: 0; background: transparent; font-size: 20px; line-height: 1; padding: 0 4px; }
	.controls { display: flex; gap: 8px; flex-wrap: wrap; }
	label { display: block; margin-top: 10px; }
	input { display: block; width: 100%; box-sizing: border-box; }
	p { margin-top: 10px; }
	a { text-decoration: underline; }
	.result { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 12px; user-select: text; }
</style>
