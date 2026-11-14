import fs from 'node:fs';
import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
const {load}=createRequire(import.meta.url)('js-yaml');
const workflow=(name:string)=>load(fs.readFileSync('.github/workflows/'+name,'utf8'));
const native=workflow('native_desktop.yml');

describe('coordinated native release',()=>{
    it('uses one build pipeline for stable and preview releases',()=>{
        for(const file of ['release_exe.yml','dev_release_exe.yml']) {
            expect(workflow(file).jobs.release.uses).toBe('./.github/workflows/native_desktop.yml');
            expect(workflow(file).jobs.release.with.publish).toBe(true);
        }
    });
    it('builds the input server from the same checkout on every target',()=>{
        expect(native.jobs.build.strategy.matrix.include.map((entry:{platform:string})=>entry.platform)).toEqual(['win32-x64','linux-x64','darwin-arm64','darwin-x64']);
        const commands=native.jobs.build.steps.map((step:{run?:string})=>step.run||'').join('\n');
        expect(commands).toContain('npm run build:input-server');
        expect(commands).not.toContain('gh release download overlay-server');
    });
    it('publishes only after all platform builds and verification succeed',()=>{
        expect(native.jobs.publish.needs).toEqual(['version','build']);
        expect(native.jobs.publish.if).toBe('inputs.publish');
        const commands=native.jobs.publish.steps.map((step:{run?:string})=>step.run||'').join('\n');
        expect(commands.indexOf('merge-native-updates.mjs')).toBeLessThan(commands.indexOf('publish-native-assets.mjs'));
        expect(commands).toContain('export-changelog-release-asset.mjs');
    });
    it('signs updater metadata after Windows code signing',()=>{
        const steps=native.jobs.build.steps as Array<{uses?:string;run?:string}>;
        const signing=steps.findLastIndex(step=>step.uses?.startsWith('signpath/'));
        const manifest=steps.findIndex(step=>step.run?.includes('sign-native-assets.mjs'));
        expect(signing).toBeGreaterThan(-1);expect(manifest).toBeGreaterThan(signing);
    });
});
