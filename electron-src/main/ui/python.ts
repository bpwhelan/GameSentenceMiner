// python.ts
import { ipcMain, shell, dialog } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import { getOrInstallPython, reinstallPython } from '../python/python_downloader.js';
import { runPipInstall, closeAllPythonProcesses, restartGSM, checkAndInstallUV, pyProc } from '../main.js';
import { FeatureFlags } from '../main.js';
import { BASE_DIR, execFileAsync, PACKAGE_NAME, getSanitizedPythonEnv, getGSMBaseDir } from '../util.js';
import {
    getLockFile,
    getInstalledPackageVersion,
    getLockProjectVersion,
    resolveRequestedExtras,
    stagedSyncAndInstallWithRollback,
    syncLockedEnvironment,
} from '../services/python_ops.js';
import { getPythonExtras, setPythonExtraEnabled, setPythonExtras } from '../store.js';

let consoleProcess: ChildProcess | null = null;

/**
 * Reusable pip install function with console logging.
 * @param pythonPath Path to python executable
 * @param pipArgs Array of arguments for pip (e.g. ['install', 'numpy'])
 * @param logLabel Label for console output
 * @param cwd Optional working directory
 */
export async function pipInstallWithLogging(
    pythonPath: string,
    pipArgs: string[],
    logLabel: string = 'PIP',
    cwd?: string
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const proc = spawn(pythonPath, ['-m', 'uv', 'pip', '--no-progress', ...pipArgs], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: cwd || BASE_DIR,
            env: getSanitizedPythonEnv()
        });
        if (proc.stdout) {
            proc.stdout.on('data', (data) => {
                console.log(`[${logLabel}]: ${data.toString().trim()}`);
            });
        }
        if (proc.stderr) {
            proc.stderr.on('data', (data) => {
                console.log(`[${logLabel}]: ${data.toString().trim()}`);
            });
        }
        proc.on('close', (code) => {
            if (code === 0) {
                console.log(`${logLabel} install finished successfully.`);
                resolve();
            } else {
                reject(new Error(`${logLabel} install exited with code ${code}`));
            }
        });
    });
}

export function registerPythonIPC() {
    // Install CUDA packages
    ipcMain.handle('python.installCudaPackage', async () => {
        if (FeatureFlags.DISABLE_GPU_INSTALLS) {
            await dialog.showMessageBox({
                type: 'info',
                title: 'GPU install disabled',
                message: 'GPU installation is currently disabled in this build. (Likely needs more testing)',
                buttons: ['OK']
            });
            return { success: false, message: 'GPU install disabled' };
        }
        try {
            const pythonPath = await getOrInstallPython();
            await closeAllPythonProcesses();

            // Wait for processes to fully close
            await new Promise((resolve) => setTimeout(resolve, 3000));

            console.log('Enabling strict GPU extra and syncing lockfile...');
            setPythonExtraEnabled('gpu', true);
            const installedVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
            const lockInfo = await getLockFile(installedVersion, false);
            if (!lockInfo.hasLockfile) {
                throw new Error('No strict uv.lock artifacts available for GPU sync.');
            }
            const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
                lockInfo,
                getPythonExtras()
            );
            if (ignoredExtras.length > 0) {
                setPythonExtras(selectedExtras);
                console.warn(
                    `Dropped unsupported extras (${ignoredExtras.join(', ')}). Allowed extras: ${
                        allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
                    }.`
                );
            }
            if (!selectedExtras.includes('gpu')) {
                throw new Error(
                    'The "gpu" extra is not available for this backend release lock. Update backend/lock artifacts before enabling GPU support.'
                );
            }
            await checkAndInstallUV(pythonPath);
            await syncLockedEnvironment(
                pythonPath,
                lockInfo.projectPath,
                selectedExtras,
                false
            );

            console.log('CUDA installation complete, restarting GSM...');
            // Give a moment for file system to settle
            await new Promise((resolve) => setTimeout(resolve, 1000));
            
            // Import and call ensureAndRunGSM directly
            const { ensureAndRunGSM } = await import('../main.js');
            await ensureAndRunGSM(pythonPath);
            
            return { success: true, message: 'CUDA GPU support installed successfully' };
        } catch (error: any) {
            console.error('Failed to install CUDA GPU support:', error);
            return {
                success: false,
                message: `Failed to install CUDA GPU support: ${
                    error?.message || 'Unknown error'
                }`,
            };
        }
    });

    // Uninstall CUDA packages
    ipcMain.handle('python.uninstallCudaPackage', async () => {
        if (FeatureFlags.DISABLE_GPU_INSTALLS) {
            await dialog.showMessageBox({
                type: 'info',
                title: 'GPU uninstall disabled',
                message: 'GPU uninstallation is currently disabled in this build. (Likely needs more testing)',
                buttons: ['OK']
            });
            return { success: false, message: 'GPU uninstall disabled' };
        }
        try {
            const pythonPath = await getOrInstallPython();
            await closeAllPythonProcesses();

            await new Promise((resolve) => setTimeout(resolve, 3000));

            console.log('Disabling strict GPU extra and syncing lockfile...');
            setPythonExtraEnabled('gpu', false);
            const installedVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
            const lockInfo = await getLockFile(installedVersion, false);
            if (!lockInfo.hasLockfile) {
                throw new Error('No strict uv.lock artifacts available for GPU sync.');
            }
            const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
                lockInfo,
                getPythonExtras()
            );
            if (ignoredExtras.length > 0) {
                setPythonExtras(selectedExtras);
                console.warn(
                    `Dropped unsupported extras (${ignoredExtras.join(', ')}). Allowed extras: ${
                        allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
                    }.`
                );
            }
            await checkAndInstallUV(pythonPath);
            await syncLockedEnvironment(
                pythonPath,
                lockInfo.projectPath,
                selectedExtras,
                false
            );

            console.log('CUDA uninstallation complete, restarting GSM...');
            await new Promise((resolve) => setTimeout(resolve, 1000));
            
            const { ensureAndRunGSM } = await import('../main.js');
            await ensureAndRunGSM(pythonPath);
            
            return { success: true, message: 'CUDA GPU support uninstalled successfully' };
        } catch (error: any) {
            console.error('Failed to uninstall CUDA GPU support:', error);
            return {
                success: false,
                message: `Failed to uninstall CUDA GPU support: ${
                    error?.message || 'Unknown error'
                }`,
            };
        }
    });

    // Reset Dependencies (uv sync)
    ipcMain.handle('python.resetDependencies', async () => {
        try {
            const pythonPath = await getOrInstallPython();
            await closeAllPythonProcesses();

            await new Promise((resolve) => setTimeout(resolve, 3000));

            if (pyProc) {
                pyProc.kill();
            }

            console.log('Resetting Python dependencies (strict uv lock sync)...');
            const installedVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
            const lockInfo = await getLockFile(installedVersion, false);
            if (!lockInfo.hasLockfile) {
                throw new Error('Strict reset requires uv.lock + pyproject artifacts.');
            }
            if (lockInfo.matchesRequestedVersion === false) {
                throw new Error(
                    `Strict reset requires lock artifacts matching backend version ${installedVersion ?? 'unknown'}.`
                );
            }
            const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
                lockInfo,
                getPythonExtras()
            );
            if (ignoredExtras.length > 0) {
                setPythonExtras(selectedExtras);
                console.warn(
                    `Dropped unsupported extras (${ignoredExtras.join(', ')}). Allowed extras: ${
                        allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
                    }.`
                );
            }
            await checkAndInstallUV(pythonPath);
            await syncLockedEnvironment(
                pythonPath,
                lockInfo.projectPath,
                selectedExtras,
                false
            );
            console.log('Python dependencies reset successfully.');

            console.log('Restarting GSM...');
            const { ensureAndRunGSM } = await import('../main.js');
            await ensureAndRunGSM(pythonPath);

            return { success: true, message: 'Python dependencies reset successfully' };
        } catch (error: any) {
            console.error('Failed to reset dependencies:', error);
            return {
                success: false,
                message: `Failed to reset dependencies: ${error?.message || 'Unknown error'}`,
            };
        }
    });

    // Repair GSM - Complete reinstall
    ipcMain.handle('python.repairGSM', async () => {
        try {
            console.log('Starting strict GSM repair...');

            await closeAllPythonProcesses();

            await new Promise((resolve) => setTimeout(resolve, 3000));

            if (pyProc) {
                pyProc.kill();
            }

            const pythonPath = await getOrInstallPython();
            await checkAndInstallUV(pythonPath);
            const installedVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
            const lockInfo = await getLockFile(installedVersion, false);
            if (!lockInfo.hasLockfile) {
                throw new Error('Strict repair requires uv.lock + pyproject artifacts.');
            }
            if (lockInfo.matchesRequestedVersion === false) {
                throw new Error(
                    `Strict repair requires lock artifacts matching backend version ${installedVersion ?? 'unknown'}.`
                );
            }
            const projectVersion = getLockProjectVersion(lockInfo) ?? installedVersion;
            if (!projectVersion) {
                throw new Error('Unable to determine backend version for strict repair.');
            }
            const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
                lockInfo,
                getPythonExtras()
            );
            if (ignoredExtras.length > 0) {
                setPythonExtras(selectedExtras);
                console.warn(
                    `Dropped unsupported extras (${ignoredExtras.join(', ')}). Allowed extras: ${
                        allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
                    }.`
                );
            }
            await stagedSyncAndInstallWithRollback({
                pythonPath,
                projectPath: lockInfo.projectPath,
                packageSpecifier: `${PACKAGE_NAME}==${projectVersion}`,
                extras: selectedExtras,
            });

            await restartGSM();
            return { success: true, message: 'GSM repaired successfully' };
        } catch (error: any) {
            console.error('Failed to repair GSM:', error);
            return {
                success: false,
                message: `Failed to repair GSM: ${error?.message || 'Unknown error'}`,
            };
        }
    });

    // Install custom package
    ipcMain.handle('python.installCustomPackage', async (_, packageName: string) => {
        try {
            const pythonPath = await getOrInstallPython();
            await closeAllPythonProcesses();

            await new Promise((resolve) => setTimeout(resolve, 3000));
            if (pyProc) {
                pyProc.kill();
            }
            console.log(`Installing custom package: ${packageName}`);
            await pipInstallWithLogging(
                pythonPath,
                ['install', '--upgrade', packageName],
                `Custom Package: ${packageName}`
            );
            await restartGSM();
            return { success: true, message: `Package ${packageName} installed successfully` };
        } catch (error: any) {
            console.error(`Failed to install package ${packageName}:`, error);
            return {
                success: false,
                message: `Failed to install package: ${error?.message || 'Unknown error'}`,
            };
        }
    });

    // Get list of installed packages
    ipcMain.handle('python.getInstalledPackages', async () => {
        try {
            const pythonPath = await getOrInstallPython();
            const result = await execFileAsync(pythonPath, [
                '-m',
                'uv',
                '--no-progress',
                'pip',
                'list',
                '--format=json',
            ]);
            console.log(result);
            return { success: true, packages: JSON.parse(result.stdout) };
        } catch (error) {
            console.error('Failed to get installed packages:', error);
            return { success: false, message: 'Failed to get installed packages', packages: [] };
        }
    });

    // Open CUDA guide
    ipcMain.handle('python.openCudaGuide', async () => {
        shell.openExternal('https://pytorch.org/get-started/locally/');
    });

    // Get Python environment info
    ipcMain.handle('python.getPythonInfo', async () => {
        try {
            const pythonPath = await getOrInstallPython();
            const versionResult = await execFileAsync(pythonPath, ['--version']);
            const pipVersionResult = await execFileAsync(pythonPath, ['-m', 'pip', '--version']);

            return {
                success: true,
                pythonPath,
                pythonVersion: versionResult.stdout.trim(),
                pipVersion: pipVersionResult.stdout.trim(),
            };
        } catch (error) {
            console.error('Failed to get Python info:', error);
            return { success: false, message: 'Failed to get Python info' };
        }
    });

    // Clean Python cache and temporary files
    ipcMain.handle('python.cleanCache', async () => {
        try {
            const pythonPath = await getOrInstallPython();
            console.log('Cleaning Python cache...');

            // Clean pip cache
            await execFileAsync(pythonPath, ['-m', 'uv', 'cache', 'clean']);

            return { success: true, message: 'Python cache cleaned successfully' };
        } catch (error: any) {
            console.error('Failed to clean cache:', error);
            return {
                success: false,
                message: `Failed to clean cache: ${error?.message || 'Unknown error'}`,
            };
        }
    });

    // Reinstall a specific package
    ipcMain.handle('python.reinstallPackage', async (_, packageName: string) => {
        try {
            const pythonPath = await getOrInstallPython();
            await closeAllPythonProcesses();

            await new Promise((resolve) => setTimeout(resolve, 3000));

            if (pyProc) {
                pyProc.kill();
            }

            console.log(`Reinstalling package: ${packageName}`);

            consoleProcess = spawn(
                pythonPath,
                ['-m', 'uv', 'pip', 'uninstall', '-y', packageName],
                {
                    stdio: 'inherit',
                    cwd: getGSMBaseDir(),
                    env: getSanitizedPythonEnv()
                }
            );

            await new Promise<void>((resolve, reject) => {
                consoleProcess!.on('close', (code) => {
                    if (code === 0) {
                        console.log(`Package ${packageName} uninstalled.`);
                        resolve();
                    } else {
                        // Continue even if uninstall fails
                        resolve();
                    }
                });
            });

            // Reinstall the package
            consoleProcess = spawn(
                pythonPath,
                ['-m', 'uv', 'pip', 'install', '--upgrade', '--force-reinstall', packageName],
                {
                    stdio: 'inherit',
                    cwd: getGSMBaseDir(),
                    env: getSanitizedPythonEnv()
                }
            );

            await new Promise<void>((resolve, reject) => {
                consoleProcess!.on('close', (code) => {
                    if (code === 0) {
                        console.log(`Package ${packageName} reinstalled successfully.`);
                        resolve();
                    } else {
                        reject(new Error(`Package reinstallation exited with code ${code}`));
                    }
                });
            });

            await restartGSM();
            return { success: true, message: `Package ${packageName} reinstalled successfully` };
        } catch (error: any) {
            console.error(`Failed to reinstall package ${packageName}:`, error);
            return {
                success: false,
                message: `Failed to reinstall package: ${error?.message || 'Unknown error'}`,
            };
        }
    });

    // Kill console process if running
    ipcMain.handle('python.killConsoleProcess', async () => {
        if (consoleProcess && !consoleProcess.killed) {
            consoleProcess.kill();
            consoleProcess = null;
            return { success: true };
        }
        return { success: false, message: 'No console process running' };
    });
}
