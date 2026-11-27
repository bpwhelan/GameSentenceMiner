import fs from 'node:fs';
import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
const {load}=createRequire(import.meta.url)('js-yaml');
const {GitHubProvider}=createRequire(import.meta.url)('electron-updater/out/providers/GitHubProvider');
const workflow=(name:string)=>load(fs.readFileSync('.github/workflows/'+name,'utf8'));
const native=workflow('native_desktop.yml');

describe('coordinated native release',()=>{
    it('publishes the manual preview by default and keeps portable ZIPs available on demand',()=>{
        const stable = workflow('release_exe.yml').jobs.release;
        const preview = workflow('dev_release_exe.yml');
        expect(stable.uses).toBe('./.github/workflows/native_desktop.yml');
        expect(stable.with.publish).toBe(true);
        expect(Object.keys(preview.on)).toEqual(['workflow_dispatch']);
        expect(preview.jobs.preview.uses).toBe(stable.uses);
        expect(preview.on.workflow_dispatch.inputs.portable_only.default).toBe(false);
        expect(preview.jobs.preview.with).toEqual({
            electron_beta: '${{ inputs.electron_beta }}',
            portable_preview: '${{ inputs.portable_only }}',
            prerelease: true,
            publish: '${{ !inputs.portable_only }}',
        });
        expect(preview.jobs.preview.secrets).toBe('inherit');
        expect(preview.concurrency.group).not.toContain('github.ref');
        expect(preview.permissions.contents).toBe('write');
        expect(workflow('release_exe.yml').permissions.contents).toBe('write');
        expect(workflow('dev_windows_unpacked.yml').permissions.contents).toBe('read');
        expect(native.permissions).toBeUndefined();
        expect(native.jobs.publish.permissions).toBeUndefined();
        expect(native.jobs.version.permissions.contents).toBe('read');
        expect(native.jobs.build.permissions.contents).toBe('read');
        expect(native.jobs.build.steps).toContainEqual(expect.objectContaining({
            if: 'inputs.portable_preview',
            uses: 'actions/upload-artifact@v4',
            with: expect.objectContaining({path: 'dist/native-preview/*.zip'}),
        }));
        expect(native.jobs.units.if).toBe('inputs.publish');
        expect(native.jobs.units.uses).toBe('./.github/workflows/desktop_verify.yml');
    });
    it('shares one renderer and keeps GUI smoke tests out of builds and unit checks', () => {
        const steps = native.jobs.build.steps as Array<{uses?:string;run?:string;with?:{name?:string}}>;
        const commands = steps.map(step => step.run || '').join('\n');
        expect(native.on.pull_request).toBeUndefined();
        expect(native.jobs.version.steps).toContainEqual(expect.objectContaining({uses:'./.github/actions/desktop-frontend'}));
        expect(steps.find(step => step.uses?.startsWith('actions/download-artifact@'))?.with?.name).toBe('desktop-web-resources');
        expect(commands).not.toMatch(/build:tauri|build-native-dev|npm run build(?:\s|$)/m);
        expect(commands).not.toMatch(/test-native-package|test-native-linux|check-native-desktop/);
        const smoke = workflow('desktop_smoke.yml');
        expect(Object.keys(smoke.on)).toEqual(['workflow_dispatch']);
        expect(smoke.jobs.smoke.steps).toContainEqual(expect.objectContaining({
            uses: 'actions/download-artifact@v4',
            with: expect.objectContaining({'run-id': '${{ inputs.run_id }}'}),
        }));
        const checks = workflow('desktop_verify.yml').jobs.test;
        expect(JSON.stringify(checks.steps)).not.toMatch(/build-native-dev|check-native-desktop|test-native-linux/);
        const cargoTests = checks.steps.flatMap((step:{run?:string}) => step.run?.match(/^cargo test\b[^\n]*/gm) || []);
        expect(cargoTests).toHaveLength(2);
        expect(cargoTests).toContainEqual(expect.stringContaining('--workspace --exclude gsm-agent'));
        expect(cargoTests).toContainEqual(expect.stringContaining('-p gsm-agent'));
    });
    it('exercises the final Windows installer before publishing an Electron beta',()=>{
        expect(native.jobs.migration.if).toBe('inputs.publish && (!inputs.prerelease || inputs.electron_beta)');
        expect(native.jobs.migration.needs).toContain('build');
        const steps = workflow('windows_release_migration.yml').jobs.upgrade.steps;
        expect(steps).toContainEqual(expect.objectContaining({
            uses: 'actions/download-artifact@v4', with: expect.objectContaining({name: 'native-release-win32-x64'}),
        }));
        expect(steps).toContainEqual(expect.objectContaining({run: 'node scripts/windows-handoff-test/exercise.mjs'}));
    });
    it('uses a dedicated preview tag and exports notes under the name the app reads',()=>{
        expect(native.jobs.version.steps.find((step:{id?:string})=>step.id === 'version').run).toContain('--preid preview');
        const notes = native.jobs.publish.steps.find((step:{run?:string})=>step.run?.includes('export-changelog-release-asset'));
        expect(notes.run).toContain('changelog-v${RELEASE_VERSION}.json');
    });
    it('keeps an Electron beta client on its own channel when a newer Tauri preview exists', async () => {
        const tags = ['v2026.11.1-preview.2', 'v2026.11.1-beta.1'];
        const feed = '<feed>' + tags.map(tag =>
            `<entry><title>${tag}</title><link href="https://github.com/bpwhelan/GameSentenceMiner/releases/tag/${tag}"/></entry>`
        ).join('') + '</feed>';
        const provider = new GitHubProvider(
            {owner: 'bpwhelan', repo: 'GameSentenceMiner'},
            {allowPrerelease: true, channel: 'beta'},
            {platform: 'win32', executor: {request: async ({path}: {path: string}) => {
                if (path.endsWith('/releases.atom')) return feed;
                expect(path).toBe('/bpwhelan/GameSentenceMiner/releases/download/v2026.11.1-beta.1/beta.yml');
                return 'version: 2026.11.1-beta.1';
            }}},
        );
        expect((await provider.getLatestVersion()).tag).toBe(tags[1]);
    });
    it('builds the input server from the same checkout on every target',()=>{
        const platforms = JSON.parse(fs.readFileSync('.github/desktop-platforms.json', 'utf8'));
        expect(native.jobs.build.strategy.matrix).toBe('${{ fromJSON(needs.version.outputs.matrix) }}');
        const selection = native.jobs.version.steps.find((step:{id?:string}) => step.id === 'platforms');
        expect(selection.env.PLATFORM).toContain("inputs.publish && 'all'");
        expect(platforms.map((entry:{platform:string})=>entry.platform)).toEqual(['win32-x64','linux-x64','darwin-arm64','darwin-x64']);
        const commands=native.jobs.build.steps.map((step:{run?:string})=>step.run||'').join('\n');
        expect(commands).toContain('npm run build:input-server');
        expect(commands).not.toContain('gh release download overlay-server');
    });
    it('publishes only after all platform builds and verification succeed',()=>{
        expect(native.jobs.publish.needs).toEqual(['version','units','build','migration']);
        expect(native.jobs.publish.if).toContain("needs.migration.result == 'success'");
        expect(native.jobs.publish.if).toContain("inputs.prerelease && !inputs.electron_beta && needs.migration.result == 'skipped'");
        const commands=native.jobs.publish.steps.map((step:{run?:string})=>step.run||'').join('\n');
        expect(commands.indexOf('merge-native-updates.mjs')).toBeLessThan(commands.indexOf('publish-native-assets.mjs'));
        expect(commands).toContain('export-changelog-release-asset.mjs');
    });
    it('signs previews on every OS and signs stable Windows updates after SignPath',()=>{
        const steps=native.jobs.build.steps as Array<{uses?:string;run?:string;if?:string}>;
        const previewSigning = steps.find(step => step.run === 'node scripts/build-native-desktop.mjs --signed');
        expect(previewSigning?.if).toBe("inputs.publish && (runner.os != 'Windows' || inputs.prerelease)");
        for (const step of steps.filter(step => step.uses?.startsWith('signpath/'))) {
            expect(step.if).toContain('!inputs.prerelease');
        }
        const signing=steps.findLastIndex(step=>step.uses?.startsWith('signpath/'));
        const manifest=steps.findIndex(step=>step.run?.includes('sign-native-assets.mjs'));
        expect(signing).toBeGreaterThan(-1);expect(manifest).toBeGreaterThan(signing);
    });
});
