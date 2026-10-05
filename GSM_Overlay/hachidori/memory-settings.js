// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Advanced → Memory, and the "In memory" line of each Library row's
// Details. Both read the engine's hd_memory reply (docs/memory.md); nothing
// polls: the page asks on a section visit, a dictionary-state change, or a new
// engine generation, and a busy or unreachable engine renders a dash.
// Advanced also shows the extension total the offscreen document measures
// (hd_memory_total): it arrives on its own, often seconds later, so it never
// holds the engine line, and an unsupported browser renders a dash.
import { formatBytes } from "./dictionary-progress.js";

const UNAVAILABLE = "\u2014";

export function createMemorySettings({ document, readMemory, readExtensionTotal, numberFormat = new Intl.NumberFormat() }) {
  const total = document.getElementById("memory-total");
  const extensionTotal = document.getElementById("memory-extension-total");
  let latest = null;
  let inFlight = null;
  let totalInFlight = null;

  function renderTotal() {
    if (latest === null) {
      total.textContent = `Engine memory: ${UNAVAILABLE}`;
      return;
    }
    const count = latest.dictionaries.length;
    const subject = count === 1 ? "1 dictionary" : `${numberFormat.format(count)} dictionaries`;
    total.textContent = `Engine memory: ${formatBytes(latest.heapBytes)} across ${subject}`;
  }

  function renderRow(row) {
    const target = row.querySelector(".dict-memory");
    if (!target) return;
    const entry = latest?.dictionaries.find((item) => item.id === row.dataset.dictionaryId);
    const share = typeof entry?.bytes === "number" ? `\u2248 ${formatBytes(entry.bytes)}` : UNAVAILABLE;
    // A paged package keeps only its index in memory: the default on OPFS or Low
    // memory mode, and one that did not fit otherwise.
    target.textContent = `In memory: ${share}${entry?.paged === true ? " (entries read from disk)" : ""}`;
  }

  function renderRows() {
    for (const row of document.querySelectorAll(".dict-row[data-dictionary-id]")) renderRow(row);
  }

  async function refresh() {
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      let reply = null;
      try {
        reply = await readMemory();
      } catch {
        reply = null;
      }
      latest = reply?.ok === true && Array.isArray(reply.dictionaries) && Number.isFinite(reply.heapBytes) ? reply : null;
      renderTotal();
      renderRows();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function refreshExtensionTotal() {
    if (totalInFlight !== null) return totalInFlight;
    totalInFlight = (async () => {
      let reply = null;
      try {
        reply = await readExtensionTotal();
      } catch {
        reply = null;
      }
      if (reply?.ok !== true || !Number.isFinite(reply.bytes)) {
        extensionTotal.textContent = `Extension total: ${UNAVAILABLE}`;
        return;
      }
      // What the engine line cannot show: JavaScript, the IDBFS mirror, workers.
      const outside = Number.isFinite(reply.heapBytes) ? Math.max(0, reply.bytes - reply.heapBytes) : null;
      extensionTotal.textContent = `Extension total: ${formatBytes(reply.bytes)}`
        + (outside === null ? "" : ` (${formatBytes(outside)} outside the engine heap)`);
    })().finally(() => { totalInFlight = null; });
    return totalInFlight;
  }

  renderTotal();
  return { refresh, refreshExtensionTotal, renderRow, renderRows };
}
