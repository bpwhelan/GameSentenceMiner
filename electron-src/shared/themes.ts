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
 * The themes offered by GSM itself, in picker order. Keep palette definitions in
 * the renderer's styles.css in sync with the custom entries; DaisyUI supplies the
 * built-ins.
 */
const GSM_THEME_IDS_BY_CATEGORY = {
    dark: [
        'gsm-dark',
        'catppuccin-mocha',
        'solarized-dark',
        'dark',
        'synthwave',
        'halloween',
        'forest',
        'aqua',
        'black',
        'luxury',
        'dracula',
        'business',
        'night',
        'coffee',
        'dim',
        'sunset',
        'abyss',
    ],
    light: [
        'solarized-light',
        'light',
        'cupcake',
        'bumblebee',
        'emerald',
        'corporate',
        'retro',
        'cyberpunk',
        'valentine',
        'garden',
        'lofi',
        'pastel',
        'fantasy',
        'wireframe',
        'cmyk',
        'autumn',
        'acid',
        'lemonade',
        'winter',
        'nord',
        'caramellatte',
        'silk',
    ],
    highContrast: ['high-contrast'],
} as const satisfies Record<GsmThemeCategory, readonly string[]>;

export type GsmThemeId =
    (typeof GSM_THEME_IDS_BY_CATEGORY)[GsmThemeCategory][number];

/** `solarized-dark` is labelled by `settings.themeCatalog.names.solarizedDark`. */
function themeLabelKey(id: string): string {
    const name = id.replace(/-([a-z])/gu, (_, letter: string) =>
        letter.toUpperCase()
    );
    return `settings.themeCatalog.names.${name}`;
}

/** `id` keeps its literal type so callers can narrow to a specific theme. */
export const GSM_THEME_DEFINITIONS: readonly (Omit<GsmThemeDefinition, 'id'> & {
    id: GsmThemeId;
})[] = GSM_THEME_GROUP_DEFINITIONS.flatMap(({ id: category }) =>
    GSM_THEME_IDS_BY_CATEGORY[category].map((id) => ({
        id,
        category,
        labelKey: themeLabelKey(id),
    }))
);

export const GSM_THEME_IDS: readonly GsmThemeId[] = GSM_THEME_DEFINITIONS.map(
    (theme) => theme.id,
);

export const DEFAULT_GSM_THEME: GsmThemeId = 'gsm-dark';

const GSM_THEME_ID_SET = new Set<string>(GSM_THEME_IDS);

export function isGsmTheme(value: unknown): value is GsmThemeId {
    return typeof value === 'string' && GSM_THEME_ID_SET.has(value);
}
