// Export the same compiled desktop palettes and semantic colors for native Qt.
// Qt cannot interpret CSS variables, color-mix(), or OKLCH colors at runtime.

function splitArguments(value) {
    let depth = 0;
    let start = 0;
    const parts = [];
    for (let i = 0; i < value.length; i++) {
        if (value[i] === '(') depth++;
        if (value[i] === ')') depth--;
        if (value[i] === ',' && depth === 0) {
            parts.push(value.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(value.slice(start).trim());
    return parts;
}

function resolveColor(value, variables) {
    value = value.trim();
    if (value === 'white') return [255, 255, 255];
    if (value === 'black') return [0, 0, 0];
    if (/^#[\da-f]{6}$/i.test(value)) {
        return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
    }
    if (value.startsWith('var(')) {
        const key = value.slice(4, -1).trim();
        if (!variables[key]) throw new Error(`Missing desktop theme variable: ${key}`);
        return resolveColor(variables[key], variables);
    }
    if (value.startsWith('color-mix(')) {
        const [space, ...parts] = splitArguments(value.slice(10, -1));
        if (space !== 'in srgb' || parts.length !== 2) throw new Error(`Unsupported theme mix: ${value}`);
        const stops = parts.map((part) => {
            const match = part.match(/^(.*?)\s+([\d.]+)%$/);
            return { color: resolveColor(match ? match[1] : part, variables), weight: match ? Number(match[2]) / 100 : null };
        });
        const weight = stops[0].weight ?? (stops[1].weight === null ? 0.5 : 1 - stops[1].weight);
        if (stops[1].weight !== null && Math.abs(weight + stops[1].weight - 1) > 0.000001) {
            throw new Error(`Unsupported non-opaque theme mix: ${value}`);
        }
        return stops[0].color.map((channel, i) => channel * weight + stops[1].color[i] * (1 - weight));
    }
    const oklch = value.match(/^oklch\(([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\)$/);
    if (oklch) {
        const lightness = Number(oklch[1]) / (oklch[2] ? 100 : 1);
        const chroma = Number(oklch[3]);
        const hue = Number(oklch[4]) * Math.PI / 180;
        const a = chroma * Math.cos(hue);
        const b = chroma * Math.sin(hue);
        // OKLab -> linear sRGB, then encode and clip to Qt's sRGB gamut.
        const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
        const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
        const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
        return [
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
        ].map((channel) => {
            const encoded = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
            return Math.max(0, Math.min(255, encoded * 255));
        });
    }
    throw new Error(`Unsupported desktop theme color: ${value}`);
}

function declarations(css) {
    return Object.fromEntries([...css.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

export function buildQtThemePalettes(css) {
    const semantic = Object.fromEntries(Object.entries(declarations(css)).filter(([key]) =>
        /^--gsm-(?:surface|border|text|on-accent|accent|success|warning|danger)/.test(key),
    ));
    const palettes = {};
    for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const ids = [...block[1].matchAll(/\[data-theme=["']?([\w-]+)["']?\]/g)].map((m) => m[1]);
        if (!ids.length) continue;
        const variables = { ...declarations(block[2]), ...semantic };
        if (!variables['--color-base-100']) continue;
        const colors = Object.fromEntries(Object.keys(semantic).map((key) => [
            key.slice(6),
            '#' + resolveColor(variables[key], variables).map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join(''),
        ]));
        for (const id of ids) palettes[id] = { id, scheme: variables['color-scheme'], ...colors };
    }
    if (!palettes['gsm-dark']) throw new Error('The compiled desktop theme is missing gsm-dark.');
    return Object.fromEntries(Object.entries(palettes).sort(([a], [b]) => a.localeCompare(b)));
}
