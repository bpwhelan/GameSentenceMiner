import { describe, expect, it } from 'vitest';
import { getWindowsAppDetails, getWindowsAppId } from './windows_app_identity.js';
import { splitWindowsCommandLine } from './windows_command_line.js';

describe('Windows desktop identity', () => {
    it('retains the portable profile when relaunched from the taskbar', () => {
        const profileDir = 'D:\\GSM profiles\\日本語';
        const details = getWindowsAppDetails({
            isPackaged: true, executable: 'C:\\GSM.exe', appPath: 'C:\\GSM', iconPath: '', profileDir,
        });
        expect(splitWindowsCommandLine(details.relaunchCommand!)).toEqual(['C:\\GSM.exe', '-profile', profileDir]);
    });
    it('keeps development taskbar groups separate from installed GSM', () => {
        expect(getWindowsAppId(true)).toBe('com.beangate.gamesentenceminer');
        expect(getWindowsAppId(false)).toBe('com.beangate.gamesentenceminer.dev');
    });

    it.each([true, false])('sets the selected taskbar icon and a usable relaunch command (packaged: %s)', (isPackaged) => {
        const executable = 'C:\\GSM checkout\\GameSentenceMiner Dev.exe';
        const appPath = 'C:\\GSM checkout\\';
        const details = getWindowsAppDetails({
            isPackaged, executable, appPath, iconPath: 'C:\\icons\\gsm_cute.ico',
        });
        expect(details.appId).toBe(getWindowsAppId(isPackaged));
        expect(details.appIconPath).toBe('C:\\icons\\gsm_cute.ico');
        expect(details.relaunchDisplayName).toBe('GameSentenceMiner');
        expect(splitWindowsCommandLine(details.relaunchCommand!)).toEqual(
            isPackaged ? [executable] : [executable, appPath],
        );
    });
});
