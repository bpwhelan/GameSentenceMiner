export const SETTINGS_BACKUP_CATEGORY_IDS = [
    'database',
    'python-settings',
    'desktop-settings',
    'overlay-settings',
    'scene-config',
    'ocr-configs',
    'obs-config',
    'text-hook-settings',
    'window-layouts',
    'plugins',
    'agent-scripts',
    'user-scripts',
    'yomitan',
] as const;

export type SettingsBackupCategoryId = (typeof SETTINGS_BACKUP_CATEGORY_IDS)[number];

const SETTINGS_BACKUP_CATEGORY_ID_SET = new Set<string>(SETTINGS_BACKUP_CATEGORY_IDS);

export function isSettingsBackupCategoryId(value: unknown): value is SettingsBackupCategoryId {
    return typeof value === 'string' && SETTINGS_BACKUP_CATEGORY_ID_SET.has(value);
}

export function normalizeSettingsBackupCategories(
    value: unknown,
    defaultToAll = true,
): SettingsBackupCategoryId[] {
    if (!Array.isArray(value)) {
        return defaultToAll ? [...SETTINGS_BACKUP_CATEGORY_IDS] : [];
    }

    const selected = new Set(value.filter(isSettingsBackupCategoryId));
    return SETTINGS_BACKUP_CATEGORY_IDS.filter((category) => selected.has(category));
}
