/** Native window identity, independent of OBS selectors or any recording backend. */
export interface CaptureWindow {
    id: string;
    pid: number;
    title: string;
    processPath: string | null;
    windowClass: string;
    minimized: boolean;
    lastFocusedAt?: number;
}
