// python.ts
import { ipcMain, shell, dialog } from 'electron';
import { getOrInstallPython } from '../python/python_downloader.js';
import { closeAllPythonProcesses, restartGSM, checkAndInstallUV } from '../main.js';
import { FeatureFlags } from '../main.js';
import {pythonCall} from '../runtime/native_python_install.js';
import {
    resolveRequestedExtras,
    syncLockedEnvironment,
} from '../services/python_ops.js';
import { installSessionManager } from '../services/install_session_state.js';
import { getPythonExtras, setPythonExtras } from '../store.js';
import { bus } from '../runtime/bus_client.js';
import { changeGpuRuntime } from '../services/gpu_install.js';
import { GPU_INSTALL_PROGRESS_CHANNEL } from '../../shared/gpu.js';

type ManualInstallOrigin = 'repair' | 'reset_dependencies';

function updateInstallStage(
    stageId: 'prepare' | 'uv' | 'python' | 'venv' | 'verify_runtime' | 'lock_sync' | 'gsm_package' | 'backend_boot' | 'obs' | 'ffmpeg' | 'oneocr' | 'finalize',
    status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed',
    progressKind: 'bytes' | 'estimated' | 'indeterminate',
    progress: number | null,
    message: string,
    error?: string | null
): void {
    installSessionManager.updateStage({
        stageId,
        status,
        progressKind,
        progress,
        message,
        error: error ?? null,
    });
}

function startManualInstallSession(origin: ManualInstallOrigin, retryHandler: () => Promise<void>): void {
    installSessionManager.ensureSession(origin, retryHandler);
    updateInstallStage('prepare', 'completed', 'estimated', 1, 'Manual dependency workflow prepared.');
}

export async function runPythonMaintenance(origin: ManualInstallOrigin): Promise<void> {
    await closeAllPythonProcesses();
    const result = await pythonCall<{pythonPath:string}>('maintain', {mode:origin, extras:getPythonExtras()});
    const {ensureAndRunGSM} = await import('../main.js');
    await new Promise<void>((resolve,reject) => {
        void ensureAndRunGSM(result.pythonPath,1,{origin,onSpawn:resolve}).catch(reject);
    });
}

async function installCustomPackage(requirement: string, reinstall=false): Promise<{success:boolean;message:string}> {
    try {
        await closeAllPythonProcesses();
        const pythonPath=await getOrInstallPython();
        const result=await pythonCall<{success:boolean;message:string}>('packageInstall',{pythonPath,requirement,reinstall});
        await restartGSM();
        return result;
    } catch(error) { return {success:false,message:error instanceof Error?error.message:String(error)}; }
}

export function registerPythonIPC() {
    // Install CUDA packages
    ipcMain.handle('python.installCudaPackage', async (_event, options: { bundledLibraries?: boolean } = {}) => {
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

            console.log('Enabling GPU extra and syncing lockfile...');
            const requestedExtras = [...getPythonExtras(), 'gpu', ...(options.bundledLibraries === true ? ['gpu-libs'] : [])];
            const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
                requestedExtras
            );
            if (ignoredExtras.length > 0) {
                console.warn(
                    `Dropped unsupported extras (${ignoredExtras.join(', ')}). Allowed extras: ${
                        allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
                    }.`
                );
            }
            if (!selectedExtras.includes('gpu')) {
                throw new Error(
                    'The "gpu" extra is not available in the bundled lockfile. Update the app before enabling GPU support.'
                );
            }
            const { ensureAndRunGSM } = await import('../main.js');
            await changeGpuRuntime({
                stop: () => closeAllPythonProcesses(),
                apply: async () => {
                    await checkAndInstallUV(pythonPath);
                    await syncLockedEnvironment(pythonPath, selectedExtras, false);
                    setPythonExtras(selectedExtras);
                },
                launch: (onSpawn) => ensureAndRunGSM(pythonPath, 1, { onSpawn }),
                bus,
                onPhase: (phase) => {
                    if (!_event.sender.isDestroyed()) _event.sender.send(GPU_INSTALL_PROGRESS_CHANNEL, { phase });
                },
            });
            
            return { success: true, message: 'GPU inference runtime installed and verified successfully' };
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
    ipcMain.handle('python.uninstallCudaPackage', async (event) => {
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

            console.log('Disabling GPU extra and syncing lockfile...');
            const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
                getPythonExtras().filter((extra) => extra !== 'gpu' && extra !== 'gpu-libs')
            );
            if (ignoredExtras.length > 0) {
                console.warn(
                    `Dropped unsupported extras (${ignoredExtras.join(', ')}). Allowed extras: ${
                        allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
                    }.`
                );
            }
            const { ensureAndRunGSM } = await import('../main.js');
            await changeGpuRuntime({
                stop: () => closeAllPythonProcesses(),
                apply: async () => {
                    await checkAndInstallUV(pythonPath);
                    await syncLockedEnvironment(pythonPath, selectedExtras, false);
                    setPythonExtras(selectedExtras);
                },
                launch: (onSpawn) => ensureAndRunGSM(pythonPath, 1, { onSpawn }),
                bus,
                onPhase: (phase) => {
                    if (!event.sender.isDestroyed()) event.sender.send(GPU_INSTALL_PROGRESS_CHANNEL, { phase });
                },
            });
            
            return { success: true, message: 'CPU ONNX Runtime restored successfully' };
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

    for (const [channel,origin] of [['python.resetDependencies','reset_dependencies'],['python.repairGSM','repair']] as const) {
        ipcMain.handle(channel, async () => {
            const execute=()=>runPythonMaintenance(origin);
            try {
                startManualInstallSession(origin,execute);
                await execute();
                return {success:true,message:origin==='repair'?'GSM repaired successfully':'Python dependencies reset successfully'};
            } catch(error) {
                const message=error instanceof Error?error.message:String(error);
                installSessionManager.finishActive('failed','Python maintenance failed.',message);
                return {success:false,message};
            }
        });
    }
    ipcMain.handle('python.installCustomPackage',(_event,requirement:string)=>installCustomPackage(requirement));
    ipcMain.handle('python.reinstallPackage',(_event,requirement:string)=>installCustomPackage(requirement,true));

    // Open CUDA guide
    ipcMain.handle('python.openCudaGuide', async () => {
        shell.openExternal('https://pytorch.org/get-started/locally/');
    });

}
