export const GSM_THEME_GROUP_DEFINITIONS = [
    {
        id: 'dark',
        labelKey: 'settings.themeCatalog.groups.dark',
    },
    {
        id: 'light',
        labelKey: 'settings.themeCatalog.groups.light',
    },
    {
        id: 'highContrast',
        labelKey: 'settings.themeCatalog.groups.highContrast',
    },
] as const;

export type GsmThemeCategory = (typeof GSM_THEME_GROUP_DEFINITIONS)[number]['id'];

export interface GsmThemeDefinition {
    id: string;
    category: GsmThemeCategory;
    labelKey: string;
}

/**
 * The themes offered by GSM itself. Keep palette definitions in the renderer's
 * styles.css in sync with the custom entries; DaisyUI supplies the built-ins.
 */
export const GSM_THEME_DEFINITIONS = [
    {
        id: 'gsm-dark',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.gsmDark',
    },
    {
        id: 'catppuccin-mocha',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.catppuccinMocha',
    },
    {
        id: 'solarized-dark',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.solarizedDark',
    },
    {
        id: 'dark',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.dark',
    },
    {
        id: 'synthwave',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.synthwave',
    },
    {
        id: 'halloween',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.halloween',
    },
    {
        id: 'forest',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.forest',
    },
    {
        id: 'aqua',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.aqua',
    },
    {
        id: 'black',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.black',
    },
    {
        id: 'luxury',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.luxury',
    },
    {
        id: 'dracula',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.dracula',
    },
    {
        id: 'business',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.business',
    },
    {
        id: 'night',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.night',
    },
    {
        id: 'coffee',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.coffee',
    },
    {
        id: 'dim',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.dim',
    },
    {
        id: 'sunset',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.sunset',
    },
    {
        id: 'abyss',
        category: 'dark',
        labelKey: 'settings.themeCatalog.names.abyss',
    },
    {
        id: 'solarized-light',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.solarizedLight',
    },
    {
        id: 'light',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.light',
    },
    {
        id: 'cupcake',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.cupcake',
    },
    {
        id: 'bumblebee',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.bumblebee',
    },
    {
        id: 'emerald',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.emerald',
    },
    {
        id: 'corporate',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.corporate',
    },
    {
        id: 'retro',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.retro',
    },
    {
        id: 'cyberpunk',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.cyberpunk',
    },
    {
        id: 'valentine',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.valentine',
    },
    {
        id: 'garden',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.garden',
    },
    {
        id: 'lofi',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.lofi',
    },
    {
        id: 'pastel',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.pastel',
    },
    {
        id: 'fantasy',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.fantasy',
    },
    {
        id: 'wireframe',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.wireframe',
    },
    {
        id: 'cmyk',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.cmyk',
    },
    {
        id: 'autumn',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.autumn',
    },
    {
        id: 'acid',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.acid',
    },
    {
        id: 'lemonade',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.lemonade',
    },
    {
        id: 'winter',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.winter',
    },
    {
        id: 'nord',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.nord',
    },
    {
        id: 'caramellatte',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.caramellatte',
    },
    {
        id: 'silk',
        category: 'light',
        labelKey: 'settings.themeCatalog.names.silk',
    },
    {
        id: 'high-contrast',
        category: 'highContrast',
        labelKey: 'settings.themeCatalog.names.highContrast',
    },
] as const satisfies readonly GsmThemeDefinition[];

export type GsmThemeId = (typeof GSM_THEME_DEFINITIONS)[number]['id'];

export const GSM_THEME_IDS: readonly GsmThemeId[] = GSM_THEME_DEFINITIONS.map(
    (theme) => theme.id,
);

export const DEFAULT_GSM_THEME: GsmThemeId = 'gsm-dark';

const GSM_THEME_ID_SET = new Set<string>(GSM_THEME_IDS);

export function isGsmTheme(value: unknown): value is GsmThemeId {
    return typeof value === 'string' && GSM_THEME_ID_SET.has(value);
}
