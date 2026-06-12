import * as fs from 'fs';
import * as path from 'path';
import { getBaseDir } from './data_dir.js';

export const DEFAULT_GSM_SINGLE_PORT = 7275;
const DEFAULT_GSM_BASE_DIR = getBaseDir();

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePort(value: unknown, fallback = DEFAULT_GSM_SINGLE_PORT): number {
    const port =
        typeof value === 'number'
            ? value
            : typeof value === 'string'
                ? Number(value.trim())
                : Number.NaN;

    if (!Number.isFinite(port) || port <= 0) {
        return fallback;
    }

    return Math.trunc(port);
}

function getProfileData(configData: JsonObject): JsonObject | null {
    const configs = configData.configs;
    if (!isJsonObject(configs)) {
        return configData;
    }

    const currentProfile =
        typeof configData.current_profile === 'string'
            ? configData.current_profile
            : 'Default';
    const currentProfileData = configs[currentProfile];
    if (isJsonObject(currentProfileData)) {
        return currentProfileData;
    }

    const defaultProfileData = configs.Default;
    if (isJsonObject(defaultProfileData)) {
        return defaultProfileData;
    }

    for (const profileData of Object.values(configs)) {
        if (isJsonObject(profileData)) {
            return profileData;
        }
    }

    return null;
}

export function resolveSinglePortFromConfigData(configData: unknown): number {
    if (!isJsonObject(configData)) {
        return DEFAULT_GSM_SINGLE_PORT;
    }

    const profileData = getProfileData(configData);
    if (!profileData || !isJsonObject(profileData.general)) {
        return DEFAULT_GSM_SINGLE_PORT;
    }

    if (Object.prototype.hasOwnProperty.call(profileData.general, 'single_port')) {
        return normalizePort(profileData.general.single_port);
    }

    return normalizePort(profileData.general.texthooker_port);
}

export interface GsmProfileList {
    profiles: string[];
    currentProfile: string;
    /** Map of profile name -> the OBS scene names associated with that profile. */
    profileScenes: Record<string, string[]>;
}

export function resolveGsmProfilesFromConfigData(configData: unknown): GsmProfileList {
    if (!isJsonObject(configData) || !isJsonObject(configData.configs)) {
        return { profiles: [], currentProfile: '', profileScenes: {} };
    }

    const profiles = Object.keys(configData.configs);
    const currentProfile =
        typeof configData.current_profile === 'string' &&
        profiles.includes(configData.current_profile)
            ? configData.current_profile
            : profiles[0] ?? '';

    const profileScenes: Record<string, string[]> = {};
    for (const [name, profileData] of Object.entries(configData.configs)) {
        const scenes = isJsonObject(profileData) ? profileData.scenes : undefined;
        profileScenes[name] = Array.isArray(scenes)
            ? scenes.filter((scene): scene is string => typeof scene === 'string')
            : [];
    }

    return { profiles, currentProfile, profileScenes };
}

export function getGsmProfileNames(
    configPath = path.join(DEFAULT_GSM_BASE_DIR, 'config.json')
): GsmProfileList {
    try {
        if (!fs.existsSync(configPath)) {
            return { profiles: [], currentProfile: '', profileScenes: {} };
        }

        const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
        return resolveGsmProfilesFromConfigData(JSON.parse(raw));
    } catch {
        return { profiles: [], currentProfile: '', profileScenes: {} };
    }
}

export function getConfiguredSinglePort(
    configPath = path.join(DEFAULT_GSM_BASE_DIR, 'config.json')
): number {
    try {
        if (!fs.existsSync(configPath)) {
            return DEFAULT_GSM_SINGLE_PORT;
        }

        const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
        return resolveSinglePortFromConfigData(JSON.parse(raw));
    } catch {
        return DEFAULT_GSM_SINGLE_PORT;
    }
}
