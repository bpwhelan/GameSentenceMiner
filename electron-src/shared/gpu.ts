export type GpuEngine = 'meiki' | 'firered' | 'whisper';
export type GpuReason = 'ready' | 'driver' | 'cuda' | 'cudnn' | 'onnx' | 'whisper' | 'platform';
export type GpuInstallPhase = 'stopping' | 'installing' | 'starting';
export const GPU_INSTALL_PROGRESS_CHANNEL = 'settings-gpu-install-progress';
export interface GpuLibrary {
    available: boolean;
    path: string;
    source: 'system' | 'python' | null;
    error: string;
}
export interface GpuStatus {
    settings: Record<GpuEngine, boolean>;
    diagnostics: {
        platform: string;
        driver: { available: boolean; name: string };
        libraries: Record<string, GpuLibrary>;
        onnx: { available: boolean; version: string };
        whisper: { available: boolean; version: string };
    };
    availability: Record<GpuEngine, GpuReason>;
    runtime: Record<GpuEngine, Array<{ device: 'cpu' | 'cuda'; enabled: boolean; error: string; pid: number }>>;
}
