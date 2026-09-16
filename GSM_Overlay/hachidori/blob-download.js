// SPDX-License-Identifier: GPL-3.0-or-later
export function downloadBlob(document, blob, filename) {
  const window = document.defaultView;
  const url = window.URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } catch (error) {
    window.URL.revokeObjectURL(url);
    throw error;
  }
  window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
}
