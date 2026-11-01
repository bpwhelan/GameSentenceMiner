const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');

/** Brand a private development runtime without changing npm's Electron install. */
async function ensureDevElectron(options = {}) {
    // The bare 'electron' specifier returns the API object inside Electron.
    // Resolve the npm entry explicitly so bootstrap and Node get the same path.
    const electronBinary = options.electronBinary ?? require(require.resolve('electron/index.js'));
    if ((options.platform ?? process.platform) !== 'win32') return electronBinary;

    const metadata = require('../package.json');
    const productName = options.productName ?? metadata.productName;
    const version = options.version ?? metadata.version;
    const iconPath = options.iconPath ?? path.join(repoRoot, 'electron-src', 'assets', 'gsm.ico');
    // Electron uses this filename to decide app.isPackaged. The friendly Windows
    // name comes from FileDescription, so preserve electron.exe for dev behavior.
    const executableName = 'electron.exe';
    const sourceDirectory = path.dirname(electronBinary);
    const runtimeDirectory = path.resolve(sourceDirectory, '..', 'gsm-dev-runtime');
    const executable = path.join(runtimeDirectory, executableName);
    const cacheFile = `${executable}.json`;
    const [sourceStat, icon, script] = await Promise.all([
        fs.stat(electronBinary), fs.readFile(iconPath), fs.readFile(__filename),
    ]);
    const fingerprint = createHash('sha256')
        .update(JSON.stringify({ electronBinary, size: sourceStat.size, mtime: sourceStat.mtimeMs, productName, version }))
        .update(icon).update(script).digest('hex');
    try {
        const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        const current = await fs.stat(executable);
        if (cached.fingerprint === fingerprint && cached.size === current.size && cached.mtime === current.mtimeMs) {
            return executable;
        }
    } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }

    const temporary = `${executable}.${randomUUID()}.tmp`;
    try {
        // The private executable needs matching DLLs, locales and default_app.asar.
        // Copy companions first and replace the executable only after branding.
        await fs.cp(sourceDirectory, runtimeDirectory, {
            recursive: true,
            filter: (source) => source !== electronBinary,
        });
        await fs.copyFile(electronBinary, temporary);
        // Use the same resource editor as our Windows release build.
        const { editWindowsResources } = require('app-builder-lib/out/util/resEdit.js');
        await editWindowsResources({
            file: temporary,
            iconPath,
            fileVersion: version,
            productVersion: version,
            versionStrings: {
                FileDescription: productName,
                ProductName: productName,
                InternalName: 'GameSentenceMiner',
                OriginalFilename: executableName,
            },
        });
        await fs.rename(temporary, executable);
        const current = await fs.stat(executable);
        await fs.writeFile(cacheFile, JSON.stringify({ fingerprint, size: current.size, mtime: current.mtimeMs }));
    } catch (error) {
        throw new Error(`Could not prepare the GSM development executable. Close the running dev app and try again. ${error.message}`, { cause: error });
    } finally {
        await fs.rm(temporary, { force: true });
    }
    return executable;
}

module.exports = { ensureDevElectron };
