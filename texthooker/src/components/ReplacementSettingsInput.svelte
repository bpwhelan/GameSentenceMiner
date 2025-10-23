<script lang="ts">
	import { mdiCancel, mdiFloppy, mdiInformation } from '@mdi/js';
	import { debounceTime, Subject, tap } from 'rxjs';
	import { createEventDispatcher } from 'svelte';
	import { replacements$ } from '../stores/stores';
	import type { ReplacementItem } from '../types';
	import { applyReplacements, reduceToEmptyString } from '../util';
	import Icon from './Icon.svelte';

	export let currentReplacement: ReplacementItem | undefined;

	const dispatch = createEventDispatcher<{ close: void }>();

	const applyPattern$ = new Subject<void>();
	const replacement: ReplacementItem = currentReplacement
		? JSON.parse(JSON.stringify(currentReplacement))
		: { pattern: '', replaces: '', flags: [], enabled: true };
	const flags = [
		{ label: 'global', value: 'g' },
		{ label: 'multiline', value: 'm' },
		{ label: 'insensitive', value: 'i' },
		{ label: 'unicode', value: 'u' },
	];

	const executePattern$ = applyPattern$.pipe(
		debounceTime(500),
		tap(() => {
			try {
				currentPatternError = '';

				if (!replacement.pattern || !currentTestValue) {
					return;
				}

				currentTestOutcome = applyReplacements(currentTestValue, [replacement]);
			} catch ({ message }) {
				currentPatternError = `Error: ${message}`;
			}
		}),
		reduceToEmptyString(),
	);

	let patternInput: HTMLInputElement;
	let currentTestValue = '';
	let currentTestOutcome = '';
	let currentPatternError = '';

	function onExecutePattern() {
		patternInput.setCustomValidity(currentPatternError);

		applyPattern$.next();
	}

	function onSave() {
		if (!currentReplacement && $replacements$.find((entry) => entry.pattern === replacement.pattern)) {
			patternInput.setCustomValidity('This pattern already exists');

			return patternInput.reportValidity();
		}

		if (currentReplacement) {
			$replacements$ = $replacements$.map((entry) => {
				if (entry.pattern === currentReplacement.pattern) {
					return replacement;
				}

				return entry;
			});
		} else {
			$replacements$ = [...$replacements$, replacement];
		}

		dispatch('close');
	}
</script>

{$executePattern$ ?? ''}
<div class="flex justify-end my-2">
	{#if replacement.pattern}
		<button title="Save" class="hover:text-primary" on:click={onSave}>
			<Icon path={mdiFloppy} />
		</button>
	{/if}
	<button title="Cancel" class="ml-2 hover:text-primary" on:click={() => dispatch('close')}>
		<Icon path={mdiCancel} />
	</button>
	<button
		title="Cancel"
		class="ml-2 hover:text-primary"
		on:click={() =>
			window.open(
				'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#description',
				'_blank',
			)}
	>
		<Icon path={mdiInformation} />
	</button>
</div>
<div>
	<input
		placeholder="text pattern"
		class="w-full my-2"
		bind:value={replacement.pattern}
		bind:this={patternInput}
		on:input={onExecutePattern}
	/>
	<input
		placeholder="replacement pattern"
		class="w-full my-2"
		bind:value={replacement.replaces}
		on:input={onExecutePattern}
	/>
	<div class="flex justify-between my-4">
		{#each flags as flag (flag.value)}
			<label>
				<input type="checkbox" value={flag.value} bind:group={replacement.flags} on:change={onExecutePattern} />
				{flag.label}
			</label>
		{/each}
	</div>
	<textarea
		name="test-value"
		placeholder="test value"
		class="w-full my-4"
		rows="3"
		bind:value={currentTestValue}
		on:input={onExecutePattern}
	/>
	<div class="whitespace-pre-wrap break-all">
		{@html currentPatternError || currentTestOutcome}
	</div>
</div>
