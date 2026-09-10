import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    app: {
        getAppPath: () => 'C:\\test-gsm',
    },
}));

vi.mock('../data_dir.js', () => ({
    getBaseDir: () => 'C:\\test-gsm',
}));

describe('detached Agent host identity', () => {
    it('requires both the host mode flag and the persisted random token', async () => {
        const { __test } = await import('./detached_agent_client.js');
        const metadata = {
            version: 1,
            hostPid: 1234,
            port: 4321,
            token: 'expected-token',
            startedAt: 1,
        };

        expect(
            __test.matchesAgentHostCommandLine(
                'GameSentenceMiner.exe --gsm-agent-host --gsm-agent-host-token=expected-token',
                metadata,
            ),
        ).toBe(true);
        expect(
            __test.matchesAgentHostCommandLine(
                'GameSentenceMiner.exe --gsm-agent-host --gsm-agent-host-token=other-token',
                metadata,
            ),
        ).toBe(false);
        expect(
            __test.matchesAgentHostCommandLine(
                'GameSentenceMiner.exe --gsm-agent-host-token=expected-token',
                metadata,
            ),
        ).toBe(false);
    });
});
