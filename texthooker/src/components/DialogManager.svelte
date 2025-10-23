<script lang="ts">
	import { onDestroy } from 'svelte';
	import { dialogOpen$, openDialog$ } from '../stores/stores';
	import Dialog from './Dialog.svelte';

	let props: any;
	let dialogPropsQueue: any[] = [];

	const sub = openDialog$.subscribe((d) => {
		if (
			!d ||
			((d.message.includes('Lost Connection to') || d.message.includes('Unable to connect to')) &&
				(props?.message === d.message || dialogPropsQueue.find((dialog) => dialog.message === d.message)))
		) {
			return;
		}

		dialogPropsQueue.unshift(d);

		if (!props) {
			handleDialog();
		}
	});

	function handleDialog() {
		props = dialogPropsQueue.pop();

		$dialogOpen$ = !!props;
	}

	onDestroy(() => sub?.unsubscribe());
</script>

{#if props}
	<Dialog {...props} on:close={handleDialog} />
{/if}
