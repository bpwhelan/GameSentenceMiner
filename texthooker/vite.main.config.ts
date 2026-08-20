import { dirname, join } from 'path';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { setDefaultResultOrder } from 'dns';
import { cpSync } from 'fs';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const nodeVersion = Number.parseInt(process.versions.node.match(/^(\d+)\./)?.[1] || '17', 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (nodeVersion < 17) {
	setDefaultResultOrder('verbatim');
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		svelte(),
		viteSingleFile(),
		(() => {
			{
				return {
					name: 'copy-build-artifacts',
					writeBundle() {
						cpSync(join(__dirname, 'public', 'assets'), join(__dirname, 'docs', 'assets'), {
							recursive: true,
						});
						cpSync(
							join(__dirname, 'docs', 'index.html'),
							join(__dirname, '..', 'GameSentenceMiner', 'web', 'templates', 'index.html'),
						);
					},
				};
			}
		})(),
	],
	base: '/texthooker-ui',
	build: {
		copyPublicDir: false,
		emptyOutDir: true,
		outDir: './docs',
	},
	server: {
		port: 5174,
	},
});
