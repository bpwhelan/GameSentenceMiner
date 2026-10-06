import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
    console.log('Skipping Windows game background hooks on this platform.');
    process.exit(0);
}
const source = path.join(root, 'native', 'game-background-hooks');
const stage = path.resolve(root, 'build', 'game-background-hooks');
// This generated package directory is never an injection source. Validate its
// absolute location before clearing old package output.
if (path.relative(root, stage) !== path.join('build', 'game-background-hooks')) throw new Error('Invalid package staging path');
rmSync(stage, { recursive: true, force: true });
for (const [arch, platform] of [['x64', 'x64'], ['x86', 'Win32']]) {
    const build = path.join(source, `build-${arch}`);
    const options = { cwd: root, stdio: 'inherit', windowsHide: true };
    execFileSync('cmake', ['-S', source, '-B', build, '-A', platform], options);
    execFileSync('cmake', ['--build', build, '--config', 'Release'], options);
    execFileSync('ctest', ['--test-dir', build, '-C', 'Release', '--output-on-failure'], options);
    const files = ['gsm-game-background-helper.exe', 'gsm-game-background.dll'];
    const hash = createHash('sha256');
    for (const file of files) hash.update(readFileSync(path.join(build, 'Release', file)));
    const buildId = hash.digest('hex').slice(0, 16);
    const output = path.join(source, 'bin', arch, buildId);
    const packaged = path.join(stage, 'bin', arch, buildId);
    mkdirSync(output, { recursive: true });
    mkdirSync(packaged, { recursive: true });
    for (const file of files) {
        const sourceFile = path.join(build, 'Release', file);
        const destination = path.join(output, file);
        // An unchanged DLL may be resident in a game. Avoid opening it for writing.
        if (!existsSync(destination) || !readFileSync(sourceFile).equals(readFileSync(destination))) {
            try { copyFileSync(sourceFile, destination); }
            catch (error) { throw new Error(`Could not replace ${destination}. Close games using this hook and build again.`, { cause: error }); }
        }
        copyFileSync(sourceFile, path.join(packaged, file));
    }
    const manifest = JSON.stringify({ buildId }, null, 2) + '\n';
    writeFileSync(path.join(source, 'bin', arch, 'current.json'), manifest);
    writeFileSync(path.join(stage, 'bin', arch, 'current.json'), manifest);
}
mkdirSync(path.join(stage, 'third_party', 'minhook'), { recursive: true });
copyFileSync(path.join(source, 'NOTICE.md'), path.join(stage, 'NOTICE.md'));
copyFileSync(path.join(source, 'third_party', 'minhook', 'LICENSE.txt'), path.join(stage, 'third_party', 'minhook', 'LICENSE.txt'));
