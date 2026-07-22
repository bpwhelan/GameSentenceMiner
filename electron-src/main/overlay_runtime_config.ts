/**
 * Experimental overlay host mode.
 *
 * Keep this as a code flag until the in-process lifecycle has had enough real-world
 * testing. Set it to false to restore the existing separate Electron process without
 * changing any launch call sites.
 */
export const USE_IN_PROCESS_OVERLAY = false;
