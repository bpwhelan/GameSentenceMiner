export type OcrAreaKind = 'normal' | 'secondary' | 'excluded' | 'black-hole' | 'exclusive';

export const OCR_AREA_KINDS: OcrAreaKind[] = ['normal', 'secondary', 'excluded', 'black-hole', 'exclusive'];

export interface OcrAreaRectangle {
    coordinates: [number, number, number, number];
    is_excluded?: boolean;
    is_secondary?: boolean;
    is_exclusive?: boolean;
    is_black_hole?: boolean;
    [key: string]: unknown;
}

export interface OcrAreaConfig {
    coordinate_system?: string;
    rectangles?: unknown[];
    window_geometry?: { width?: number; height?: number } | null;
}

export interface OcrAreaSaveRequest {
    sceneId: string;
    sceneName: string;
    expectedRevision: string;
    rectangles: OcrAreaRectangle[];
}

export type OcrAreaSaveResult =
    | { success: true; config: OcrAreaConfig }
    | { success: false; error: 'sceneChanged' | 'conflict' | 'invalid' | 'failed' };

export function getOcrAreaRevision(config: OcrAreaConfig | null): string {
    return JSON.stringify([config?.coordinate_system ?? '', config?.rectangles ?? []]);
}

export function isOcrAreaRectangle(value: unknown): value is OcrAreaRectangle {
    if (!value || typeof value !== 'object') return false;
    const { coordinates } = value as OcrAreaRectangle;
    if (!Array.isArray(coordinates) || coordinates.length !== 4 ||
        !coordinates.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
    const [x, y, width, height] = coordinates;
    return x >= 0 && y >= 0 && width > 0 && height > 0 &&
        x + width <= 1 + 1e-9 && y + height <= 1 + 1e-9;
}

export function canEditOcrAreas(config: OcrAreaConfig | null): boolean {
    if (config?.rectangles !== undefined && !Array.isArray(config.rectangles)) return false;
    if (!config?.rectangles?.length) return true;
    return config.coordinate_system === 'percentage' && config.rectangles.every(isOcrAreaRectangle);
}

export function getOcrAreaKind(area: OcrAreaRectangle): OcrAreaKind {
    return area.is_excluded ? 'excluded' : area.is_black_hole ? 'black-hole' :
        area.is_exclusive ? 'exclusive' : area.is_secondary ? 'secondary' : 'normal';
}

export function makeOcrArea(coordinates: OcrAreaRectangle['coordinates'], kind: OcrAreaKind): OcrAreaRectangle {
    return {
        coordinates, monitor: { index: 0 },
        is_excluded: kind === 'excluded', is_secondary: kind === 'secondary',
        is_exclusive: kind === 'exclusive', is_black_hole: kind === 'black-hole'
    };
}
