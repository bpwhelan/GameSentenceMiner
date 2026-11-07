export type SeasonalEvent = 'halloween';

/** Seasonal effects follow the user's local calendar and never change saved preferences. */
export function getSeasonalEvent(disabled: boolean, date = new Date()): SeasonalEvent | null {
    if (disabled || !Number.isFinite(date.getTime())) return null;
    // Launch-year extension: Oct 24–Nov 7, 2026. Thereafter: Oct 15–Nov 1.
    // Both end dates are inclusive in the user's local calendar.
    const launchYear = date.getFullYear() === 2026;
    const month = date.getMonth();
    const day = date.getDate();
    const inWindow = (month === 9 && day >= (launchYear ? 24 : 15))
        || (month === 10 && day <= (launchYear ? 7 : 1));
    return inWindow ? 'halloween' : null;
}

export function resolveSeasonalIconStyle(style: string, event: SeasonalEvent | null): string {
    return style === 'gsm' && event === 'halloween' ? 'gsm-halloween' : style;
}
