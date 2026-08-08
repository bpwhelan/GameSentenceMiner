import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.main.config.ts', import.meta.url), 'utf8');

test('Svelte 5 entry point uses the mount API', () => {
	assert.match(mainSource, /import\s*{\s*mount\s*}\s*from\s*['"]svelte['"]/);
	assert.match(mainSource, /mount\(App,/);
	assert.doesNotMatch(mainSource, /new\s+App\s*\(/);
});

test('Tailwind 4 uses its Vite plugin and CSS entry points', () => {
	assert.match(viteConfig, /import\s+tailwindcss\s+from\s+['"]@tailwindcss\/vite['"]/);
	assert.match(viteConfig, /tailwindcss\(\)/);
	assert.match(appCss, /@import\s+['"]tailwindcss['"]/);
	assert.match(appCss, /@plugin\s+['"]daisyui['"]/);
	assert.doesNotMatch(appCss, /@tailwind\s/);
});
