// import {
//     app,
//     BrowserWindow,
//     dialog,
//     ipcMain,
//     Menu,
//     MenuItem,
//     shell,
//     Tray,
//     Notification,
// } from 'electron';
// import * as path from 'path';
// import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
// import { getOrInstallPython } from './python/python_downloader.js';
// import {
//     APP_NAME,
//     BASE_DIR,
//     execFileAsync,
//     getAssetsDir,
//     getGSMBaseDir,
//     isConnected,
//     isDev,
//     isWindows,
//     PACKAGE_NAME,
// } from './util.js';
// import electronUpdater, { type AppUpdater } from 'electron-updater';
// import { fileURLToPath } from 'node:url';

// import log from 'electron-log/main.js';
// import {
//     getAutoUpdateElectron,
//     getAutoUpdateGSMApp,
//     getCustomPythonPackage,
//     getLaunchSteamOnStart,
//     getLaunchVNOnStart,
//     getLaunchYuzuGameOnStart,
//     getPullPreReleases,
//     getStartConsoleMinimized,
//     setPythonPath,
//     setWindowName,
// } from './store.js';
// import { launchYuzuGameID, openYuzuWindow, registerYuzuIPC } from './ui/yuzu.js';
// import { launchVNWorkflow, openVNWindow, registerVNIPC } from './ui/vn.js';
// import { launchSteamGameID, openSteamWindow, registerSteamIPC } from './ui/steam.js';
// import { webSocketManager } from './communication/websocket.js';
// import { getOBSConnection, openOBSWindow, registerOBSIPC, setOBSScene } from './ui/obs.js';
// import { registerSettingsIPC, window_transparency_process } from './ui/settings.js';
// import { registerOCRUtilsIPC, startOCR } from './ui/ocr.js';
// import * as fs from 'node:fs';
// import archiver from 'archiver';
// import { registerFrontPageIPC } from './ui/front.js';
// import { registerPythonIPC } from './ui/python.js';
// import { execFile } from 'node:child_process';
// declare function checkForUpdates(): Promise<{ updateAvailable: boolean; latestVersion: string }>;
// declare function closeGSM(): Promise<void>;
// declare function checkAndInstallUV(pythonPath: string): Promise<void>;
// declare function runCommand(cmd: string, args: string[], a: boolean, b: boolean): Promise<any>;
// declare function ensureAndRunGSM(pythonPath: string): Promise<void>;
// // --- End of assumed imports ---

// /**
//  * A module-level promise that tracks any ongoing Python update process.
//  * This is the key to coordinating the two updaters without race conditions.
//  */
// let gsmUpdatePromise: Promise<void> = Promise.resolve();

// /**
//  * Checks for and handles updates for the main Electron application.
//  */
// async function autoUpdate(): Promise<void> {
//     const autoUpdater = getAutoUpdater();

//     autoUpdater.on('update-downloaded', async () => {
//         log.info('App update downloaded. Waiting for Python backend tasks...');
//         // Await the tracker promise to ensure any Python update is finished before restarting.
//         await gsmUpdatePromise;

//         const updateFilePath = path.join(BASE_DIR, 'update_python.flag');
//         fs.writeFileSync(updateFilePath, '');
//         autoUpdater.quitAndInstall();
//     });

//     autoUpdater.on('error', (err: any) => {
//         log.error('Auto-update error: ' + err.message);
//     });

//     try {
//         const result = await autoUpdater.checkForUpdates();

//         if (result !== null && result.updateInfo.version !== app.getVersion()) {
//             const dialogResult = await dialog.showMessageBox({
//                 type: 'question',
//                 title: 'Update Available',
//                 message: `A new version (${result.updateInfo.version}) is available. Download and install it now?`,
//                 buttons: ['Yes', 'No'],
//             });

//             if (dialogResult.response === 0) { // "Yes"
//                 await autoUpdater.downloadUpdate();
//             } else {
//                 log.info('User declined the application update.');
//             }
//         } else {
//             log.info('Application is up to date.');
//         }
//     } catch (err) {
//         log.error('Failed to check for application updates: ' + (err as Error).message);
//     }
// }

// /**
//  * The internal implementation of the Python update logic.
//  */
// async function _updateGSMInternal(shouldRestart: boolean, force: boolean): Promise<void> {
//     isUpdating = true;
//     try {
//         const { updateAvailable, latestVersion } = await checkForUpdates();
//         if (updateAvailable || force) {
//             if (pyProc) {
//                 await closeGSM();
//                 await new Promise((resolve) => setTimeout(resolve, 3000));
//             }
//             log.info(`Updating Python backend to ${latestVersion}...`);

//             await checkAndInstallUV(pythonPath);

//             try {
//                 await runCommand(pythonPath, ['-m', 'uv', 'pip', 'install', '--upgrade', '--prerelease=allow', PACKAGE_NAME], true, true);
//             } catch (err) {
//                 log.error('Failed to install Python package, retrying. Error:', err);
//                 await runCommand(pythonPath, ['-m', 'uv', 'pip', 'install', '--upgrade', '--prerelease=allow', PACKAGE_NAME], true, true);
//             }

//             log.info('Python backend update completed successfully.');
//             new Notification({
//                 title: 'Update Successful',
//                 body: `${APP_NAME} backend has been updated.`,
//                 timeoutType: 'default',
//             }).show();

//             if (shouldRestart) {
//                 await ensureAndRunGSM(pythonPath);
//                 log.info('Python backend restarted after update!');
//             }
//         } else {
//             log.info('Python backend is already up-to-date.');
//         }
//     } catch (error) {
//         log.error('An error occurred during the Python update process:', error);
//     } finally {
//         isUpdating = false;
//     }
// }

// /**
//  * Manages the update process for the Python backend.
//  */
// async function updateGSM(shouldRestart: boolean, force: boolean): Promise<void> {
//     gsmUpdatePromise = _updateGSMInternal(shouldRestart, force);
//     await gsmUpdatePromise;
// }

// /**
//  * The main entry point to run all update checks in the correct order.
//  * Updates the Python backend first, then checks for app updates.
//  */
// export async function runUpdateChecks(shouldRestart: boolean = false, force: boolean = false): Promise<void> {
//     log.info("Starting update checks...");

//     await updateGSM(shouldRestart, force);
    
//     await autoUpdate();

//     log.info("Update checks finished.");
// }