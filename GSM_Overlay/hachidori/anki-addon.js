// The Hachidori Relay add-on for Anki, packaged in the browser from the files
// under anki-relay/, so Settings hands out the add-on matching this extension.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BlobWriter, TextReader, ZipWriter } from "./vendor/zip.js";

export const ANKI_ADDON_FILE_NAME = "hachidori-relay.ankiaddon";
export const ANKI_ADDON_FILES = ["manifest.json", "__init__.py", "server.py", "config.json", "config.md"];

// Stored, not deflated, with fixed dates: the same sources give the same bytes.
const ZIP_OPTIONS = { useWebWorkers: false, level: 0, extendedTimestamp: false, lastModDate: new Date(1980, 0, 1) };

// `read(name)` returns one source file's text. Anki shows `human_version` in
// its add-on list and keeps `mod` as the add-on's modification time.
export async function buildAnkiAddon(read, { version, now = Date.now() }) {
  /** @type {{add(name: string, reader: object): Promise<unknown>, close(): Promise<Blob>}} */
  const writer = new ZipWriter(new BlobWriter("application/zip"), ZIP_OPTIONS);
  for (const name of ANKI_ADDON_FILES) {
    let text = await read(name);
    if (name === "manifest.json") {
      text = `${JSON.stringify({ ...JSON.parse(text), human_version: version, mod: Math.floor(now / 1000) }, null, 2)}\n`;
    }
    await writer.add(name, new TextReader(text));
  }
  return writer.close();
}
