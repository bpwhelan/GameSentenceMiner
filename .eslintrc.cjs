module.exports = {
	root: true,
	extends: ['plugin:@typescript-eslint/recommended', 'eslint:recommended', 'prettier', 'prettier/@typescript-eslint'],
	plugins: ['svelte3', '@typescript-eslint'],
	overrides: [{ files: ['*.svelte'], processor: 'svelte3/svelte3' }],
	parserOptions: {
		sourceType: 'module',
		ecmaVersion: 2020,
	},
	env: {
		browser: true,
		es2017: true,
		node: true,
	},
	parser: '@typescript-eslint/parser',
	settings: {
		'svelte3/typescript': () => require('typescript'),
	},
};
