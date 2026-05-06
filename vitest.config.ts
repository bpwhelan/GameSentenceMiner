import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['electron-src/**/*.test.ts', 'electron-src/**/*.test.tsx'],
        environment: 'node',
        setupFiles: ['electron-src/main/test/setup.ts'],
        clearMocks: true,
        restoreMocks: true,
        isolate: true,
        passWithNoTests: false,
    },
});
