import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const LINUX_DESKTOP_NAME = 'com.beangate.gamesentenceminer.desktop';

export interface LinuxDesktopIdentity {
    appId: string;
    desktopName: string;
}

interface ResolveLinuxDesktopIdentityOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    executablePath?: string;
    argv0?: string;
    fileExists?: (candidate: string) => boolean;
}

function normalizeDesktopName(value: string | undefined): string | null {
    const name = path.basename(String(value || '').trim());
    if (!name || name === '.' || name === path.sep) {
        return null;
    }
    return name.endsWith('.desktop') ? name : `${name}.desktop`;
}

function desktopSearchDirectories(env: NodeJS.ProcessEnv): string[] {
    const home = String(env.HOME || '').trim() || os.homedir();
    const dataHome = String(env.XDG_DATA_HOME || '').trim() || path.join(home, '.local', 'share');
    const dataDirs = String(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
        .split(':')
        .map((entry) => entry.trim())
        .filter(Boolean);
    return [dataHome, ...dataDirs].map((directory) => path.join(directory, 'applications'));
}

function desktopEntryExists(
    desktopName: string,
    directories: string[],
    fileExists: (candidate: string) => boolean
): boolean {
    return directories.some((directory) => fileExists(path.join(directory, desktopName)));
}

export function resolveLinuxDesktopIdentity(
    options: ResolveLinuxDesktopIdentityOptions = {}
): LinuxDesktopIdentity | null {
    const platform = options.platform ?? process.platform;
    if (platform !== 'linux') {
        return null;
    }

    const env = options.env ?? process.env;
    const fileExists = options.fileExists ?? fs.existsSync;
    const directories = desktopSearchDirectories(env);
    const explicit = normalizeDesktopName(
        env.GSM_DESKTOP_NAME || env.GSM_INPUT_SERVER_APP_ID
    );
    const executableNames = [
        env.APPIMAGE,
        options.executablePath ?? process.execPath,
        options.argv0 ?? process.argv[0],
    ]
        .map(normalizeDesktopName)
        .filter((name): name is string => Boolean(name));
    const candidates = [
        explicit,
        LINUX_DESKTOP_NAME,
        ...executableNames,
    ].filter((name, index, names): name is string => Boolean(name) && names.indexOf(name) === index);

    const desktopName =
        candidates.find((candidate) => desktopEntryExists(candidate, directories, fileExists)) ??
        explicit ??
        LINUX_DESKTOP_NAME;
    return {
        appId: desktopName.slice(0, -'.desktop'.length),
        desktopName,
    };
}

export function configureLinuxDesktopIdentity(
    app: object,
    options: ResolveLinuxDesktopIdentityOptions = {}
): LinuxDesktopIdentity | null {
    const identity = resolveLinuxDesktopIdentity(options);
    if (!identity) {
        return null;
    }

    const env = options.env ?? process.env;
    env.CHROME_DESKTOP = identity.desktopName;
    env.GSM_INPUT_SERVER_APP_ID = identity.appId;

    // Electron 42 reads CHROME_DESKTOP but does not expose setDesktopName.
    // Use the API when available on newer releases while preserving the
    // environment-variable fallback for the currently supported runtime.
    const setDesktopName = Reflect.get(app, 'setDesktopName');
    if (typeof setDesktopName === 'function') {
        setDesktopName.call(app, identity.desktopName);
    }
    return identity;
}
