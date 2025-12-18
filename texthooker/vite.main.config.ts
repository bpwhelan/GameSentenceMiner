import { dirname, join } from 'path';

import { svelte } from '@sveltejs/vite-plugin-svelte';
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
		svelte(),
		viteSingleFile(),
		(() => {
			{
				return {
					name: 'copy-header',
					writeBundle() {
						cpSync(join(__dirname, 'public', 'assets'), join(__dirname, 'docs', 'assets'), {
							recursive: true,
						});
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
