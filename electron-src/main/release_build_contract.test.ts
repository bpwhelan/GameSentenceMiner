import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { load } = require('js-yaml') as { load: (source: string) => unknown };

interface WorkflowStep {
    id?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
}

interface WorkflowJob {
    needs?: string[];
    if?: string;
    outputs?: Record<string, string>;
    steps: WorkflowStep[];
}

function readWorkflow(name: string): { jobs: Record<string, WorkflowJob> } {
    return load(fs.readFileSync(
        path.join(process.cwd(), '.github', 'workflows', name),
        'utf8',
    )) as { jobs: Record<string, WorkflowJob> };
}

const { jobs } = readWorkflow('release_exe.yml');

describe('stable release overlay server build contract', () => {
    it('resolves the overlay source tree from the release checkout', () => {
        const prepare = jobs['prepare-release'];
        const source = prepare.steps.find((step) => step.id === 'overlay_server_source');

        expect(prepare.outputs?.OVERLAY_SERVER_SOURCE_TREE).toBe(
            '${{ steps.overlay_server_source.outputs.OVERLAY_SERVER_SOURCE_TREE }}',
        );
        expect(source?.run).toContain('git rev-parse HEAD:GSM_Overlay/input_server');
    });

    it('uses the development release wait and artifact handoff, only when a build is needed', () => {
        const wait = jobs['wait-for-overlay-server'];
        const devWait = readWorkflow('dev_release_exe.yml').jobs['wait-for-overlay-server'];

        expect(wait).toBeDefined();
        expect(wait.needs).toContain('prepare-release');
        expect(wait.if).toBe("needs.prepare-release.outputs.should_build_any == 'true'");
        expect(wait.steps[0].env?.EXPECTED_SOURCE_TREE).toBe(
            '${{ needs.prepare-release.outputs.OVERLAY_SERVER_SOURCE_TREE }}',
        );
        expect(wait.steps[0].run).toBe(devWait.steps[0].run);
        expect(wait.steps[1].uses).toBe('actions/upload-artifact@v4');
        expect(wait.steps[1].with).toEqual({
            ...devWait.steps[1].with,
            name: 'overlay-server-binaries-${{ needs.prepare-release.outputs.OVERLAY_SERVER_SOURCE_TREE }}',
        });
    });

    it('waits before creating the public release', () => {
        expect(jobs['create-release'].needs).toContain('wait-for-overlay-server');
    });

    it.each([
        ['build-windows-unsigned', 'win32', 'gsm_overlay_server-win32.exe'],
        ['build-linux', 'linux', 'gsm_overlay_server-linux'],
        ['build-mac-arm64', 'darwin', 'gsm_overlay_server-darwin'],
    ])('%s only packages binaries from the successful wait job', (jobId, platform, binary) => {
        const job = jobs[jobId];
        const download = job.steps.find((step) => step.uses === 'actions/download-artifact@v4');
        const commands = job.steps.map((step) => step.run ?? '').join('\n');

        expect(job.needs).toContain('wait-for-overlay-server');
        // These jobs use always() to allow an existing release shell to be skipped.
        // They must still stop when the overlay wait fails, is cancelled, or is skipped.
        expect(job.if).toContain("needs.wait-for-overlay-server.result == 'success'");
        expect(download?.with).toEqual({
            name: 'overlay-server-binaries-${{ needs.prepare-release.outputs.OVERLAY_SERVER_SOURCE_TREE }}',
            path: 'overlay-server-binaries',
        });
        expect(commands).toContain(`overlay-server-binaries/${binary}`);
        expect(commands).toContain(`GSM_Overlay/input_server/bin/${platform}/gsm_overlay_server`);
        expect(commands).not.toContain('gh release download overlay-server');
    });
});
