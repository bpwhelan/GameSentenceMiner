import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import afterPack, { verifyVocrBundle } from '../../scripts/verify-vocr-package.mjs';

const source = path.resolve('GameSentenceMiner/assets/vocr');
const temporary: string[] = [];
async function makeTemp() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-vocr-package-'));
    temporary.push(directory);
    return directory;
}
afterEach(async () => {
    await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('bundled faithful VOCR packaging', () => {
    it('ships intact graphs and notices and enforces verification on every Electron build', async () => {
        expect(await verifyVocrBundle(source)).toEqual({ graphs: 4, bytes: 16968508 });
        const configuration = JSON.parse(await fs.readFile('package.json', 'utf8'));
        expect(configuration.build.afterPack).toBe('scripts/verify-vocr-package.mjs');
        expect(configuration.build.extraFiles).toContainEqual({ from: 'GameSentenceMiner', to: 'resources/GameSentenceMiner' });
    });

    it.each(['missing', 'damaged', 'extra', 'attribution'])('rejects %s packaged assets', async failure => {
        const directory = await makeTemp();
        await fs.cp(source, directory, { recursive: true });
        if (failure === 'missing') await fs.unlink(path.join(directory, 'normal-faithful.onnx'));
        if (failure === 'damaged') await fs.writeFile(path.join(directory, 'normal-faithful.onnx'), 'broken');
        if (failure === 'extra') await fs.writeFile(path.join(directory, 'normal-fast.onnx'), 'unapproved');
        if (failure === 'attribution') await fs.unlink(path.join(directory, 'COPYING'));
        await expect(verifyVocrBundle(directory)).rejects.toThrow();
    });

    it.each(['win32', 'linux', 'darwin'])('checks the actual extraFiles destination on %s', async platform => {
        const appOutDir = await makeTemp();
        const contents = platform === 'darwin' ? path.join(appOutDir, 'GameSentenceMiner.app', 'Contents') : appOutDir;
        const target = path.join(contents, 'resources', 'GameSentenceMiner', 'assets', 'vocr');
        await fs.cp(source, target, { recursive: true });
        const context = { appOutDir, electronPlatformName: platform, packager: { appInfo: { productFilename: 'GameSentenceMiner' } } };
        await expect(afterPack(context)).resolves.toBeUndefined();
        await fs.unlink(path.join(target, 'textspot8-faithful.onnx'));
        await expect(afterPack(context)).rejects.toThrow();
    });
});
