const { spawn } = require('node:child_process');
const path = require('node:path');
const { ensureDevElectron } = require('./electron-dev-runtime.cjs');

async function launchElectron({ exitOnClose = false, args = process.argv.slice(2), env = process.env } = {}) {
    const executable = await ensureDevElectron();
    const child = spawn(executable, ['.', ...args], {
        cwd: path.resolve(__dirname, '..'), stdio: 'inherit', env,
    });
    let childClosed = false;
    // Preserve Electron CLI signal forwarding for Ctrl+C and watcher restarts.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
        process.on(signal, () => { if (!childClosed) child.kill(signal); });
    }
    child.once('error', (error) => {
        console.error('Could not start GSM:', error);
        process.exit(1);
    });
    child.once('exit', (code, signal) => {
        childClosed = true;
        if (signal) {
            process.exit(1);
            return;
        }
        // A normal window close should end nodemon/concurrently in watch mode.
        process.exit(exitOnClose && code === 0 ? 1 : (code ?? 1));
    });
}

module.exports = { launchElectron };
if (require.main === module) {
    launchElectron().catch((error) => { console.error(error); process.exit(1); });
}
