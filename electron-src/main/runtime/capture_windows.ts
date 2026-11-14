import { desktopCapturer, type DesktopCapturerSource } from 'electron';

// The native host adds the owning process path to the capture identity. Keeping
// these together avoids a second window addon and mismatched enumeration races.
export type NativeCaptureSource = DesktopCapturerSource & { processPath?: string };

export async function listCaptureWindows(): Promise<Array<{ path: string; title: string }>> {
    const native = desktopCapturer as typeof desktopCapturer & { listWindows?: () => Promise<import('../../shared/capture.js').CaptureWindow[]> };
    if (native.listWindows) {
        return (await native.listWindows()).filter(source => source.processPath)
            .map(source => ({ path: source.processPath!, title: source.title }));
    }
    const sources: NativeCaptureSource[] = await desktopCapturer.getSources({
        types: ['window'], thumbnailSize: { width: 0, height: 0 },
    });
    return sources.filter(source => source.processPath).map(source => ({
        path: source.processPath!, title: source.name,
    }));
}
