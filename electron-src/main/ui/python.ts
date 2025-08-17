// python.ts
import { ipcMain, shell } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getOrInstallPython, reinstallPython } from '../python/python_downloader.js';
import { runPipInstall, closeGSM, restartGSM, checkAndInstallUV, pyProc } from '../main.js';
import { BASE_DIR, execFileAsync, PACKAGE_NAME } from '../util.js';

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
        const proc = spawn(pythonPath, ['-m', 'uv', 'pip', ...pipArgs], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: cwd || BASE_DIR,
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
    ipcMain.handle('python.installCudaPackage', async (_, cudaVersion: string) => {
        try {
            const pythonPath = await getOrInstallPython();
            await closeGSM();

            await new Promise((resolve) => setTimeout(resolve, 3000));

            if (pyProc) {
                pyProc.kill();
            }
            console.log(`Installing CUDA ${cudaVersion} package...`);
            let pipArgs: string[] = [];
            switch (cudaVersion) {
                case '12.6':
                    pipArgs = [
                        'install',
                        '--upgrade',
                        'torch',
                        'torchvision',
                        '--index-url',
                        'https://download.pytorch.org/whl/cu126',
                    ];
                    break;
                case '12.8':
                    pipArgs = [
                        'install',
                        '--upgrade',
                        'torch',
                        'torchvision',
                        '--index-url',
                        'https://download.pytorch.org/whl/cu128',
                    ];
                    break;
                case '12.9':
                    pipArgs = [
                        'install',
                        '--upgrade',
                        'torch',
                        'torchvision',
                        '--index-url',
                        'https://download.pytorch.org/whl/cu129',
                    ];
                    break;
                default:
                    throw new Error(`Unsupported CUDA version: ${cudaVersion}`);
            }
            await pipInstallWithLogging(pythonPath, pipArgs, `CUDA ${cudaVersion}`);
            // Preserve numpy 2.2.6
            await pipInstallWithLogging(pythonPath, ['install', 'numpy==2.2.6'], 'NUMPY');
            await restartGSM();
            return { success: true, message: `CUDA ${cudaVersion} installed successfully` };
        } catch (error: any) {
            console.error(`Failed to install CUDA ${cudaVersion}:`, error);
            return {
                success: false,
                message: `Failed to install CUDA ${cudaVersion}: ${
                    error?.message || 'Unknown error'
                }`,
            };
        }
    });

    // Repair GSM - Complete reinstall
    ipcMain.handle('python.repairGSM', async () => {
        try {
            console.log('Starting GSM repair - removing Python directory and reinstalling...');

            await closeGSM();

            await new Promise((resolve) => setTimeout(resolve, 3000));

            if (pyProc) {
                pyProc.kill();
            }

            // Remove the entire python directory
            const pythonDir = path.join(BASE_DIR, 'python');
            if (fs.existsSync(pythonDir)) {
                console.log('Removing existing Python directory...');
                try {
                    fs.rmSync(pythonDir, { recursive: true, force: true });
                } catch (err) {
                    console.warn('Initial removal failed, retrying in 2 seconds...');
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    fs.rmSync(pythonDir, { recursive: true, force: true });
                }
                // Wait a moment to ensure filesystem settles
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            // Reinstall Python
            // await reinstallPython();

            // Reinstall GameSentenceMiner package
            const pythonPath = await getOrInstallPython();
            await checkAndInstallUV(pythonPath);

            console.log('Reinstalling GameSentenceMiner package...');

            consoleProcess = spawn(
                pythonPath,
                ['-m', 'uv', 'pip', 'install', '--upgrade', '--force-reinstall', '--prerelease=allow', PACKAGE_NAME],
                {
                    stdio: 'inherit',
                    cwd: BASE_DIR,
                }
            );

            await new Promise<void>((resolve, reject) => {
                consoleProcess!.on('close', (code) => {
                    if (code === 0) {
                        console.log('GameSentenceMiner package reinstalled successfully.');
                        resolve();
                    } else {
                        reject(
                            new Error(`GameSentenceMiner installation exited with code ${code}`)
                        );
                    }
                });
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
            await closeGSM();

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
            await closeGSM();

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
                    cwd: BASE_DIR,
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
                    cwd: BASE_DIR,
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
