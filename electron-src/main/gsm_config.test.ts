import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_GSM_SINGLE_PORT,
    getConfiguredSinglePort,
    resolveSinglePortFromConfigData,
} from './gsm_config.js';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function writeTempConfig(data: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-config-test-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(data), 'utf8');
    return configPath;
}

describe('GSM config port helpers', () => {
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
