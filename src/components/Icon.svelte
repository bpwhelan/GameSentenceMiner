<script lang="ts">
	export let path: string;
	export let width = '1.5rem';
	export let height = '1.5rem';
	export let element: SVGElement | undefined = undefined;
	export { _class as class };

	let _class = '';
</script>

<svg
	style="width: {width}; height: {height};"
	viewBox="0 0 24 24"
	fill="currentColor"
	class={_class}
	bind:this={element}
	on:click
	on:keyup
>
	<path d={path} />
</svg>
