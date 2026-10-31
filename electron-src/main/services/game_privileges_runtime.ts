import { ipcMain, type BrowserWindow } from 'electron';
import { GAME_PRIVILEGE_WARNING_CHANNEL, type GamePrivilegeWarning } from '../../shared/game_privileges.js';
import { GAME_PRIVILEGE_CHECK_INTERVAL_MS, gamePrivilegeMonitor, setGamePrivilegeWarningPublisher } from './game_privileges.js';

let timer: NodeJS.Timeout | undefined;
let refreshing = false;
let refreshCapture: (() => Promise<void>) | undefined;
let registered = false;
let generation = 0;
const notifiedGameSessions = new Set<string>();
let notificationId: string | null = null;
let closeNotification: (() => void) | undefined;

function clearNotification(): void {
    closeNotification?.();
    closeNotification = undefined;
    notificationId = null;
}

export function startGamePrivilegeChecks(deps: {
    getMainWindow: () => BrowserWindow | null;
    getCapture: () => Promise<{ exeName: string | null } | null>;
    restartAsAdmin: () => Promise<void>;
    notifyWarning: (warning: GamePrivilegeWarning, onClick: () => void) => () => void;
}): void {
    if (process.platform !== 'win32') return;
    const currentGeneration = ++generation;
    setGamePrivilegeWarningPublisher(warning => {
        const window = deps.getMainWindow();
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
            window.webContents.send(GAME_PRIVILEGE_WARNING_CHANNEL, warning);
        if (notificationId !== (warning?.id ?? null)) clearNotification();
        if (!warning || notifiedGameSessions.has(warning.id)) return;
        notifiedGameSessions.add(warning.id);
        notificationId = warning.id;
        try {
            closeNotification = deps.notifyWarning(warning, () => {
                if (gamePrivilegeMonitor.snapshot()?.id !== warning.id) return;
                const mainWindow = deps.getMainWindow();
                if (!mainWindow || mainWindow.isDestroyed()) return;
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            });
        } catch (error) {
            // The in-app warning remains available if Windows blocks notifications.
            console.warn('Could not show the game administrator notification:', error);
        }
    });
    if (!registered) {
        registered = true;
        const assertMainWindow = (event: Electron.IpcMainInvokeEvent) => {
            if (event.sender !== deps.getMainWindow()?.webContents) throw new Error('Only the GSM desktop can manage game privilege warnings.');
        };
        ipcMain.handle('game-privileges.getWarning', event => {
            assertMainWindow(event);
            return gamePrivilegeMonitor.snapshot();
        });
        ipcMain.handle('game-privileges.dismiss', (event, id: string) => {
            assertMainWindow(event);
            gamePrivilegeMonitor.dismiss(id);
        });
        ipcMain.handle('game-privileges.restartAsAdmin', async (event, id: string) => {
            assertMainWindow(event);
            if (gamePrivilegeMonitor.snapshot()?.id !== id) return;
            await deps.restartAsAdmin();
        });
    }
    refreshCapture = async () => {
        if (refreshing) return;
        refreshing = true;
        try {
            const capture = await deps.getCapture();
            if (currentGeneration !== generation) return;
            gamePrivilegeMonitor.setTarget('capture', capture?.exeName ? { exeName: capture.exeName } : null);
            await gamePrivilegeMonitor.check();
        } catch {
            // OBS can be unavailable while starting up or reconnecting.
        } finally { refreshing = false; }
    };
    if (!timer) {
        timer = setInterval(() => void refreshCapture?.(), GAME_PRIVILEGE_CHECK_INTERVAL_MS);
        timer.unref();
    }
    refreshGamePrivilegeCapture();
}

export function refreshGamePrivilegeCapture(): void { void refreshCapture?.(); }

export function stopGamePrivilegeChecks(): void {
    generation += 1;
    if (timer) clearInterval(timer);
    timer = undefined;
    refreshCapture = undefined;
    clearNotification();
    setGamePrivilegeWarningPublisher(() => {});
}
