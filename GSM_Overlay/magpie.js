const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

// Magpie is windows only, disable this and just export no-ops on other platforms
if (process.platform !== 'win32') {
    module.exports = {
        setupMagpieIpc: () => { },
        getNativeWindowHandleString: () => '',
        magpieIsReallyScaling: () => Promise.resolve(false),
        magpieGetInfo: () => Promise.resolve({}),
        magpieMarkWindow: () => Promise.resolve(false),
        magpieUnmarkWindow: () => Promise.resolve(false),
        magpieRegisterScalingChangedMessage: () => Promise.resolve(-1),
    };
} else {
    // magpie.js is an init and config file for https://github.com/Blinue/Magpie

    // Prepare for Linux support of magpie
    // Default python path. On Windows we ship/expect a portable python in APPDATA.
    // On non-Windows platforms default to system python3 but allow override via GSM_PYTHON env var.
    const pythonPath = path.join(process.env.APPDATA || '', 'GameSentenceMiner', 'python', 'python.exe');

    let magpieScalingChangedWindowMessage = -1;

    /**
     * A helper function to run the Python interop script and get its JSON output.
     * @param {string[]} args - Command-line arguments to pass to the script.
     * @returns {Promise<any>} - A promise that resolves with the parsed JSON object.
     */
    function runPythonScript(args) {
        // Make sure the path to your script is correct.
        // Using path.join and __dirname makes it robust.
        const scriptPath = path.join(__dirname, 'magpie_compat.py');

        // Use the pythonPath variable defined earlier.
        const pyProcess = spawn(pythonPath, [scriptPath, ...args]);

        return new Promise((resolve, reject) => {
            let output = '';
            let errorOutput = '';

            pyProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            pyProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            pyProcess.on('close', (code) => {
                if (code !== 0) {
                    return reject(new Error(`Python script exited with code ${code}: ${errorOutput}`));
                }
                try {
                    resolve(JSON.parse(output));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON from Python script: ${e.message}`));
                }
            });
        });
    }


    /**
     * Sets up all IPC listeners for Magpie utilities.
     * @param {BrowserWindow} mainWindow The main Electron window.
     */
    function getNativeWindowHandleString(mainWindow) {
        const nativeHandle = mainWindow.getNativeWindowHandle();
        // On Windows this is a 32-bit signed int. On Linux (X11) it may be a 32-bit
        // unsigned Window handle or a 64-bit value on some builds. Read defensively.
        try {
            if (nativeHandle.length >= 8 && typeof nativeHandle.readBigUInt64LE === 'function') {
                return nativeHandle.readBigUInt64LE(0).toString();
            }
            // Fallback to unsigned 32-bit to avoid negative numbers
            return nativeHandle.readUInt32LE(0).toString();
        } catch (e) {
            // As a last resort, return the buffer as a hex string
            return '0x' + nativeHandle.toString('hex');
        }
    }

    async function magpieIsReallyScaling() {
        const result = await runPythonScript(['is_scaling']);
        return result.is_scaling;
    }

    // init magpie
    async function magpieGetInfo() {
        if (process.platform === 'linux') {
            return; // Magpie not (yet) supported on Linux
        }

        return runPythonScript(['get_info']);
    }

    async function magpieMarkWindow(handleString) {
        const result = await runPythonScript(['mark_window', handleString]);
        return result.success;
    }

    async function magpieUnmarkWindow(handleString) {
        const result = await runPythonScript(['unmark_window', handleString]);
        return result.success;
    }

    async function magpieRegisterScalingChangedMessage(mainWindow) {
        if (magpieScalingChangedWindowMessage === -1) {
            const result = await runPythonScript(['register_message']);
            magpieScalingChangedWindowMessage = result.message_id;

            // hookWindowMessage is a Windows-only BrowserWindow API. Only call it
            // if the function exists (i.e., on Windows builds).
            if (magpieScalingChangedWindowMessage > 0 && typeof mainWindow.hookWindowMessage === 'function') {
                mainWindow.hookWindowMessage(magpieScalingChangedWindowMessage, () => {
                    mainWindow.webContents.send('magpie:scaling-changed');
                });
            }
        }
        return magpieScalingChangedWindowMessage;
    }

    function setupMagpieIpc(mainWindow) {
        const handleString = getNativeWindowHandleString(mainWindow);

        ipcMain.handle('magpie:is-really-scaling', magpieIsReallyScaling);
        ipcMain.handle('magpie:get-info', magpieGetInfo);
        ipcMain.handle('magpie:mark-window', () => magpieMarkWindow(handleString));
        ipcMain.handle('magpie:unmark-window', () => magpieUnmarkWindow(handleString));
        ipcMain.handle('magpie:register-scaling-changed-message', () => magpieRegisterScalingChangedMessage(mainWindow));
    }

    module.exports = { setupMagpieIpc, getNativeWindowHandleString, magpieIsReallyScaling, magpieGetInfo, magpieMarkWindow, magpieUnmarkWindow, magpieRegisterScalingChangedMessage };
}