<script lang="ts">
	import { mdiPlus } from '@mdi/js';
	import { replacements$ } from '../stores/stores';
	import type { ReplacementItem } from '../types';
	import Icon from './Icon.svelte';
	import ReplacementSettingsInput from './ReplacementSettingsInput.svelte';
	import ReplacementSettingsList from './ReplacementSettingsList.svelte';

	let inEditMode = false;

	let currentReplacement: ReplacementItem | undefined;

	$: hasReplacements = !!$replacements$.length;

	$: resetEditMode($replacements$);

	function resetEditMode(_replacements: ReplacementItem[]) {
		inEditMode = false;
	}
</script>

<details class="col-span-4 mb-2 cursor-pointer max-w-lg">
	<summary>Replacements</summary>
	<div class="mb-8">
		{#if inEditMode}
			<ReplacementSettingsInput
				{currentReplacement}
				on:close={() => {
					inEditMode = false;
					currentReplacement = undefined;
				}}
			/>
		{:else if hasReplacements}
			{#key $replacements$}
				<ReplacementSettingsList
					on:edit={({ detail }) => {
						currentReplacement = detail;
						inEditMode = true;
					}}
					on:applyReplacements
				/>
			{/key}
		{:else}
			<div class="flex justify-end my-2">
				<button title="Add replacement" class="ml-2 hover:text-primary" on:click={() => (inEditMode = true)}>
					<Icon path={mdiPlus} />
				</button>
			</div>
			<div>You have currently no replacements configured</div>
		{/if}
	</div>
</details>
