// SPDX-License-Identifier: GPL-3.0-or-later

export function formatBytes(bytes) {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  return bytes < 1_048_576
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function formatSeconds(seconds) {
  return seconds < 10 ? `${seconds.toFixed(1)} seconds` : `${Math.round(seconds)} seconds`;
}

export function installEntryState(entry) {
  switch (entry.phase) {
    case "downloading": {
      const received = formatBytes(entry.receivedBytes);
      if (entry.totalBytes === null) return { text: `Downloading… ${received}`, progress: { value: null } };
      const fraction = Math.min(1, entry.receivedBytes / entry.totalBytes);
      return { text: `Downloading… ${received} of ${formatBytes(entry.totalBytes)} (${Math.floor(fraction * 100)}%)`,
        progress: { value: fraction } };
    }
    case "installing": return { text: "Installing…", progress: { value: null } };
    case "installed": return { text: `Installed in ${formatSeconds(entry.seconds)}`, tone: "ok" };
    case "already-installed": return { text: "Already installed", tone: "ok" };
    case "failed": return { text: `Failed: ${entry.error}`, tone: "error" };
    default: return { text: "Waiting" };
  }
}

export function createDictionaryProgressList({
  document,
  ariaLabel,
  idPrefix = "dictionary-progress",
}) {
  const list = document.createElement("ul");
  list.className = "setup-dictionary-list";
  list.setAttribute("aria-label", ariaLabel);
  list.hidden = true;
  const rows = new Map();

  function setEntries(entries) {
    rows.clear();
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const key = String(entry.id);
      const row = document.createElement("li");
      row.className = "setup-dictionary";
      row.dataset.sourceId = key;

      const name = document.createElement("span");
      name.className = "setup-dictionary-name";
      name.id = entry.labelId ?? `${idPrefix}-${index}`;
      name.textContent = entry.name;

      const purpose = document.createElement("span");
      purpose.className = "setup-dictionary-purpose";
      purpose.textContent = entry.purpose ?? "";
      purpose.hidden = purpose.textContent === "";

      const status = document.createElement("span");
      status.className = "setup-dictionary-status";
      status.id = `${idPrefix}-status-${index}`;
      status.textContent = entry.status ?? "Waiting";

      const track = document.createElement("div");
      track.className = "track setup-track";
      track.hidden = true;
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-labelledby", name.id);
      track.setAttribute("aria-describedby", status.id);
      track.appendChild(document.createElement("div")).className = "track-fill";

      row.append(name, purpose, status, track);
      list.appendChild(row);
      rows.set(key, { row, status, track });
    });
    list.hidden = entries.length === 0;
  }

  function update(id, state) {
    const current = rows.get(String(id));
    if (!current) return;
    const { row, status, track } = current;
    if (status.textContent !== state.text) status.textContent = state.text;
    status.classList.toggle("is-ok", state.tone === "ok");
    status.classList.toggle("is-error", state.tone === "error");
    row.classList.toggle("is-active", Boolean(state.progress));
    track.hidden = !state.progress;
    if (!state.progress) return;

    const value = state.progress.value;
    const determinate = typeof value === "number";
    track.classList.toggle("is-determinate", determinate);
    if (determinate) {
      const percent = Math.floor(Math.min(1, Math.max(0, value)) * 100);
      track.removeAttribute("aria-valuetext");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(percent));
      track.style.setProperty("--progress", `${percent}%`);
    } else {
      track.removeAttribute("aria-valuenow");
      track.removeAttribute("aria-valuemin");
      track.removeAttribute("aria-valuemax");
      track.style.removeProperty("--progress");
      track.setAttribute("aria-valuetext", state.text);
    }
  }

  function clear() {
    setEntries([]);
  }

  return { element: list, setEntries, update, clear };
}
