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
    /** Only GSM's own themes are translated; daisyUI ids carry a `label`. */
    labelKey?: string;
    label?: string;
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

/**
 * GSM's own themes are named in the locale files; daisyUI's are its own product
 * names, which read the same in every language, so they are title-cased from the
 * id rather than carrying 35 identical keys per locale.
 */
const TRANSLATED_THEME_IDS = new Set([
    'gsm-dark',
    'catppuccin-mocha',
    'solarized-dark',
    'solarized-light',
    'high-contrast',
]);

/** `solarized-dark` is labelled by `settings.themeCatalog.names.solarizedDark`. */
function themeLabelKey(id: string): string {
    const name = id.replace(/-([a-z])/gu, (_, letter: string) =>
        letter.toUpperCase()
    );
    return `settings.themeCatalog.names.${name}`;
}

/** `lo-fi` becomes `Lo Fi`. */
function titleCase(id: string): string {
    return id.replace(/(^|-)([a-z])/gu, (_, separator: string, letter: string) =>
        `${separator ? ' ' : ''}${letter.toUpperCase()}`
    );
}

/** `id` keeps its literal type so callers can narrow to a specific theme. */
export const GSM_THEME_DEFINITIONS: readonly (Omit<GsmThemeDefinition, 'id'> & {
    id: GsmThemeId;
})[] = GSM_THEME_GROUP_DEFINITIONS.flatMap(({ id: category }) =>
    GSM_THEME_IDS_BY_CATEGORY[category].map((id) =>
        TRANSLATED_THEME_IDS.has(id)
            ? { id, category, labelKey: themeLabelKey(id) }
            : { id, category, label: titleCase(id) }
    )
);

export const GSM_THEME_IDS: readonly GsmThemeId[] = GSM_THEME_DEFINITIONS.map(
    (theme) => theme.id,
);

export const DEFAULT_GSM_THEME: GsmThemeId = 'gsm-dark';

const GSM_THEME_ID_SET = new Set<string>(GSM_THEME_IDS);

export function isGsmTheme(value: unknown): value is GsmThemeId {
    return typeof value === 'string' && GSM_THEME_ID_SET.has(value);
}
