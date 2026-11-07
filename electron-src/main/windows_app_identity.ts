import type { AppDetailsOptions } from 'electron';
import { quoteWindowsArgument } from './windows_command_line.js';

export function getWindowsAppId(isPackaged: boolean): string {
    return `com.beangate.gamesentenceminer${isPackaged ? '' : '.dev'}`;
}

export function getWindowsAppDetails(options: {
    isPackaged: boolean;
    executable: string;
    appPath: string;
    iconPath: string;
}): AppDetailsOptions {
    const command = [options.executable];
    if (!options.isPackaged) command.push(options.appPath);
    return {
        appId: getWindowsAppId(options.isPackaged),
        appIconPath: options.iconPath,
        appIconIndex: 0,
        relaunchDisplayName: 'GameSentenceMiner',
        relaunchCommand: command.map(quoteWindowsArgument).join(' '),
    };
}
