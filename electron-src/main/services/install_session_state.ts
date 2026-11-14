import { InstallSessionManager } from './install_session.js';
import {createRequire} from 'node:module';
import path from 'node:path';
import {ipcMain} from 'electron';

const require = createRequire(import.meta.url);
export const installSessionManager = new InstallSessionManager((action, params = {}) =>
    require(path.join(process.env.GSM_APP_ROOT || process.cwd(), 'desktop-runtime/transport.cjs'))
        .callSync('install-session.call', {action, params}));
// Private native-to-service call; deliberately absent from renderer allowlists.
ipcMain.handle('install-session.executeRetry', (_event, claim) => installSessionManager.executeRetry(claim));
