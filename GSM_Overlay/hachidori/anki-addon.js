// Pin the add-on independently so older extensions and vendored copies keep
// downloading the relay they were tested with.
// SPDX-License-Identifier: GPL-3.0-or-later

export const ANKI_ADDON_FILE_NAME = "hachidori-relay.ankiaddon";
export const ANKI_ADDON_VERSION = "0.0.3";
export const ANKI_ADDON_URL = `https://github.com/bee-san/hachidori-anki/releases/download/v${ANKI_ADDON_VERSION}/${ANKI_ADDON_FILE_NAME}`;

export async function fetchAnkiAddon(request = globalThis.fetch) {
  const response = await request(ANKI_ADDON_URL);
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}. Try again.`);
  return response.blob();
}
