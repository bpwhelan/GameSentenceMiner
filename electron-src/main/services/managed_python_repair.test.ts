import { describe, expect, it } from 'vitest';

import { shouldAutoRebuildManagedPythonEnv } from './managed_python_repair.js';

describe('shouldAutoRebuildManagedPythonEnv', () => {
    it('detects broken managed venv errors', () => {
        expect(
            shouldAutoRebuildManagedPythonEnv(
                new Error(
                    'Failed to bootstrap pip via ensurepip: spawn C:\\Users\\Beangate\\AppData\\Roaming\\GameSentenceMiner\\python_venv\\Scripts\\python.exe ENOENT'
                )
            )
        ).toBe(true);

        expect(
            shouldAutoRebuildManagedPythonEnv(
                'Virtual environment Python not found at expected path: /tmp/python_venv/bin/python'
            )
        ).toBe(true);
    });

    it('does not rebuild for ordinary update/network failures', () => {
        expect(
            shouldAutoRebuildManagedPythonEnv(
                new Error('Failed to download release metadata: network timeout')
            )
        ).toBe(false);

        expect(
            shouldAutoRebuildManagedPythonEnv(
                'Sync failed, cleaning uv cache and retrying once.'
            )
        ).toBe(false);
    });
});
