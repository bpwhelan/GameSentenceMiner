import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['electron-src/main/**/*.test.ts'],
        environment: 'node',
        setupFiles: ['electron-src/main/test/setup.ts'],
        clearMocks: true,
        restoreMocks: true,
        isolate: true,
        passWithNoTests: false,
    },
});
