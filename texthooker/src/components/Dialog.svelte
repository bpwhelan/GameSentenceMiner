<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import Icon from './Icon.svelte';

	export let icon: string | undefined;
	export let message: string | undefined;
	export let type = 'info';
	export let showCancel = true;
	export let askForData = '';
	export let dataValue: string | number | undefined;
	export let callback: <T>(param: { canceled: boolean; data: T }) => void;

	const dispatch = createEventDispatcher<{ close: void }>();

	function handleChange(event: Event) {
		const target = event.target as HTMLInputElement;

		dataValue = target.value;
	}
</script>

<div class="fixed top-12 flex justify-center w-full z-30">
	<div class="alert shadow-lg max-w-xl" class:alert-info={type === 'info'} class:alert-error={type === 'error'}>
		<div>
			{#if icon}
				<Icon path={icon} />
			{/if}
			<span>
				{#if askForData}
					<div>
						{#if askForData === 'text'}
							<input
								type={askForData}
								class="input input-bordered h-8 ml-2"
								value={dataValue}
								on:change={handleChange}
							/>
						{/if}
					</div>
				{:else}
					{message}
				{/if}
			</span>
		</div>
		<div class="flex-none">
			{#if showCancel}
				<button
					class="btn btn-sm btn-ghost"
					on:click={() => {
						callback?.({ canceled: true, data: dataValue });
						dispatch('close');
					}}>Cancel</button
				>
			{/if}
			<button
				class="btn btn-sm btn-primary"
				on:click={() => {
					callback?.({ canceled: false, data: dataValue });
					dispatch('close');
				}}>Confirm</button
			>
		</div>
	</div>
</div>
