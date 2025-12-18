<script lang="ts">
	import { mdiClose } from '@mdi/js';
	import { notesOpen$, userNotes$ } from '../stores/stores';
	import { dummyFn } from '../util';
	import Icon from './Icon.svelte';

	function handleBlur(event: FocusEvent) {
		$userNotes$ = (event.target as HTMLTextAreaElement).value;
	}
</script>

<div class="flex justify-end p-4">
	<div
		class="flex cursor-pointer items-end md:items-center"
		on:click={() => ($notesOpen$ = false)}
		on:keyup={dummyFn}
	>
		<Icon path={mdiClose} />
	</div>
</div>
<textarea
	class="flex-1 overflow-auto ml-10 mr-2 mb-4 p-1 pb-2"
	style="resize: none;"
	value={$userNotes$}
	on:blur={handleBlur}
/>
