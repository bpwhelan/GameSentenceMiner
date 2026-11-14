/**
 * GSM owns the overlay windows, shortcuts and dictionary session.
 *
 * The standalone launcher remains available for overlay development, but normal
 * desktop launches use the main Electron process.
 */
export const USE_IN_PROCESS_OVERLAY = true;
