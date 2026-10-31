import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import {
    getStatusTrayIconPath,
    getTrayBaseIconPath,
    getTrayTooltip,
    resolveTrayVisualState,
    resolveTrayStyleName,
} from './tray_icons.js';

describe('tray icon helpers', () => {
    it('defaults the tray style to gsm when no tray override is configured', () => {
        expect(resolveTrayStyleName('gsm_cute', 'gsm_jacked')).toBe('gsm');
    });

    it('uses the tray override style when configured', () => {
        expect(resolveTrayStyleName('gsm_cute[tray]', 'gsm_jacked')).toBe('gsm_cute');
    });

    it('uses the resolved random style for random tray icons', () => {
        expect(resolveTrayStyleName('random[tray]', 'gsm_jacked')).toBe('gsm_jacked');
    });

    it('builds the tray base icon path with the requested extension', () => {
        expect(
            getTrayBaseIconPath({
                assetsDir: 'C:\\repo\\assets',
                configuredIconStyle: 'random[tray]',
                resolvedRandomStyle: 'gsm_jacked',
                extension: 'ico',
            })
        ).toBe('C:\\repo\\assets\\gsm_jacked.ico');
    });

    it('builds hard-coded status icon paths from the gsm base name', () => {
        expect(
            getStatusTrayIconPath({
                assetsDir: 'C:\\repo\\assets',
                state: 'loading',
                extension: 'ico',
            })
        ).toBe('C:\\repo\\assets\\gsm-loading.ico');
        expect(
            getStatusTrayIconPath({
                assetsDir: 'C:\\repo\\assets',
                state: 'ready',
                extension: 'png',
            })
        ).toBe('C:\\repo\\assets\\gsm-ready.png');
    });

    it('uses the Halloween icon and keeps status badges when seasonal effects are active', () => {
        expect(getTrayBaseIconPath({
            assetsDir: 'assets', configuredIconStyle: 'gsm', resolvedRandomStyle: '',
            extension: 'ico', seasonalEvent: 'halloween',
        })).toBe(path.join('assets', 'gsm-halloween.ico'));
        expect(getTrayBaseIconPath({
            assetsDir: 'assets', configuredIconStyle: 'gsm_cute[tray]', resolvedRandomStyle: '',
            extension: 'png', seasonalEvent: 'halloween',
        })).toBe(path.join('assets', 'gsm_cute.png'));
        for (const state of ['loading', 'ready', 'paused'] as const) {
            expect(getStatusTrayIconPath({
                assetsDir: 'assets', state, extension: 'ico', seasonalEvent: 'halloween',
            })).toBe(path.join('assets', `gsm-halloween-${state}.ico`));
        }
    });

    it('prefers loading until python ipc and backend status are both ready', () => {
        expect(
            resolveTrayVisualState({
                pythonIpcConnected: false,
                backendStatusReady: false,
                readyIndicatorActive: false,
                textIntakePaused: false,
            })
        ).toBe('loading');
        expect(
            resolveTrayVisualState({
                pythonIpcConnected: true,
                backendStatusReady: false,
                readyIndicatorActive: true,
                textIntakePaused: true,
            })
        ).toBe('loading');
    });

    it('prefers paused over the temporary ready indicator once startup is complete', () => {
        expect(
            resolveTrayVisualState({
                pythonIpcConnected: true,
                backendStatusReady: true,
                readyIndicatorActive: true,
                textIntakePaused: true,
            })
        ).toBe('paused');
        expect(
            resolveTrayVisualState({
                pythonIpcConnected: true,
                backendStatusReady: true,
                readyIndicatorActive: true,
                textIntakePaused: false,
            })
        ).toBe('ready');
    });

    it('labels tray tooltips by visual state', () => {
        expect(getTrayTooltip('loading')).toBe('GameSentenceMiner (Starting up)');
        expect(getTrayTooltip('ready')).toBe('GameSentenceMiner (Ready)');
        expect(getTrayTooltip('paused')).toBe('GameSentenceMiner (Text Intake Paused)');
        expect(getTrayTooltip('normal')).toBe('GameSentenceMiner');
    });
});
