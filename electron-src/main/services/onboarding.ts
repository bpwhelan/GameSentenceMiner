import { ipcMain } from 'electron';
import axios from 'axios';
import { store, getLocale } from '../store.js';
import { getConfiguredTargetLanguage, gsmBackendUrl } from '../gsm_config.js';
import { runOverlay, stopOverlay, waitForOverlayShutdown } from '../ui/front.js';
import { normalizeOnboardingProgress } from '../../shared/onboarding.js';

export function registerOnboardingIPC(): void {
    ipcMain.handle('settings.onboarding.sudachi', async (_event, payload: unknown) => {
        const response = await axios.post(gsmBackendUrl('/api/onboarding/sudachi'), payload, { timeout: 10000 });
        return response.data;
    });
    ipcMain.handle('settings.onboarding.get', () => ({
        progress: store.get('onboarding'),
        targetLanguage: getConfiguredTargetLanguage(),
        locale: getLocale(),
    }));
    ipcMain.handle('settings.onboarding.save', (_event, value: unknown) => {
        const progress = normalizeOnboardingProgress(value);
        store.set('onboarding', progress);
        if (progress.status === 'completed') store.set('setupWizardVersion', progress.version);
        return { success: true, progress };
    });
    ipcMain.handle('settings.onboarding.language', async (_event, language: unknown) => {
        if (typeof language !== 'string') throw new Error('Invalid learning language.');
        const response = await axios.post(gsmBackendUrl('/api/onboarding/language'), { language }, { timeout: 10000 });
        return response.data;
    });
    ipcMain.handle('settings.onboarding.dictionary', async (_event, payload: unknown) => {
        if (!await runOverlay()) throw new Error('The overlay could not start.');
        // Starting Electron and connecting its overlay socket can take a moment.
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await axios.post(gsmBackendUrl('/api/onboarding/dictionary'), payload, { timeout: 25000 });
                if (response.data?.restarting === true) {
                    stopOverlay();
                    await waitForOverlayShutdown();
                    if (!await runOverlay()) throw new Error('Could not restart the dictionary reader.');
                }
                return response.data;
            } catch (error) {
                if (attempt >= 15 || !axios.isAxiosError(error) || error.response?.data?.code !== 'overlay_starting') throw error;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    });
}
