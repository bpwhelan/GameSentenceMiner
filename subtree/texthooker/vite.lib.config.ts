import { svelte } from '@sveltejs/vite-plugin-svelte';
import { setDefaultResultOrder } from 'dns';
import { defineConfig } from 'vite';

const nodeVersion = Number.parseInt(process.versions.node.match(/^(\d+)\./)?.[1] || '17', 10);

if (nodeVersion < 17) {
	setDefaultResultOrder('verbatim');
}

export default defineConfig({
	plugins: [svelte()],
	base: '',
	build: {
		emptyOutDir: true,
		lib: { name: 'texthooker', entry: './src/main.ts', formats: ['iife'] },
		outDir: './texthooker-ui',
	},
	server: {
		port: 5174,
	},
});
