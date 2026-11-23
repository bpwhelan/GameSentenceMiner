import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_GSM_SINGLE_PORT,
    getConfiguredSinglePort,
    getConfiguredTargetLanguage,
    getLegacyNotificationFeatures,
    resolveSinglePortFromConfigData,
} from './gsm_config.js';

const tempDirs: string[] = [];

describe('notification profile switches', () => {
    it('reads the active profile for the one-time notification migration', () => {
        const configPath = writeTempConfig({ current_profile: 'Game', configs: {
            Default: { features: { notify_on_update: true } }, Game: { features: { notify_on_update: false } },
        } });
        expect(getLegacyNotificationFeatures(configPath)).toEqual({ notify_on_update: false });
        fs.writeFileSync(configPath, JSON.stringify({ features: { notify_on_audio_generated: false } }));
        expect(getLegacyNotificationFeatures(configPath)).toEqual({ notify_on_audio_generated: false });
    });
    it('handles missing and malformed legacy configurations', () => {
        const configPath = writeTempConfig({ configs: { Default: { features: [] } } });
        expect(getLegacyNotificationFeatures(configPath)).toEqual({});
        fs.writeFileSync(configPath, '{');
        expect(getLegacyNotificationFeatures(configPath)).toEqual({});
    });
});

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('GSM target language', () => {
    it('reads the current profile and picks up language changes without restarting', () => {
        const configPath = writeTempConfig({
            current_profile: 'Korean',
            configs: {
                Default: { general: { target_language: 'ja' } },
                Korean: { general: { target_language: 'ko' } },
            },
        });
        expect(getConfiguredTargetLanguage(configPath)).toBe('ko');
        fs.writeFileSync(configPath, JSON.stringify({ general: { target_language: 'zh-Hant' } }));
        expect(getConfiguredTargetLanguage(configPath)).toBe('zh-hant');
    });

    it('uses the GSM default for missing, malformed, and older configurations', () => {
        expect(getConfiguredTargetLanguage(writeTempConfig({}))).toBe('ja');
        expect(getConfiguredTargetLanguage(writeTempConfig({ general: { target_language: 42 } }))).toBe('ja');
        expect(getConfiguredTargetLanguage(writeTempConfig({ general: { target_language: ' ' } }))).toBe('ja');
        const configPath = writeTempConfig({});
        fs.writeFileSync(configPath, '{');
        expect(getConfiguredTargetLanguage(configPath)).toBe('ja');
        expect(getConfiguredTargetLanguage(path.join(os.tmpdir(), 'missing-gsm-config.json'))).toBe('ja');
    });
});

function writeTempConfig(data: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-config-test-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(data), 'utf8');
    return configPath;
}

describe('GSM config port helpers', () => {
    it('resolves the retired Text Feed port to the unified port', () => {
        for (const general of [{ single_port: 55000 }, { texthooker_port: '55000' }]) {
            expect(resolveSinglePortFromConfigData({ general })).toBe(7275);
        }
    });
    it('reads single_port from the current profile', () => {
        expect(
            resolveSinglePortFromConfigData({
                current_profile: 'Custom',
                configs: {
                    Default: { general: { single_port: 7275 } },
                    Custom: { general: { single_port: 6001 } },
                },
            })
        ).toBe(6001);
    });

    it('falls back to the legacy texthooker_port when single_port is missing', () => {
        expect(
            resolveSinglePortFromConfigData({
                current_profile: 'Default',
                configs: {
                    Default: { general: { texthooker_port: 6002 } },
                },
            })
        ).toBe(6002);
    });

    it('returns the default port for invalid or missing config files', () => {
        expect(getConfiguredSinglePort(path.join(os.tmpdir(), 'missing-gsm-config.json'))).toBe(
            DEFAULT_GSM_SINGLE_PORT
        );

        const configPath = writeTempConfig({
            current_profile: 'Default',
            configs: {
                Default: { general: { single_port: 0 } },
            },
        });
        expect(getConfiguredSinglePort(configPath)).toBe(DEFAULT_GSM_SINGLE_PORT);
    });
});
