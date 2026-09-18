// Explicit complete backup/restore controls; the engine owns preparation tokens.
// SPDX-License-Identifier: GPL-3.0-or-later
import { formatAutomaticBackupAge } from "./backup-automatic.js";
import { downloadBlob } from "./blob-download.js";

export function createBackupSettingsController({
  document, send, download, listAutomatic = null, checkReady, setBusy, status, refresh,
  trackPreparation = () => {}, cancelPreparation = () => {},
}) {
  const element = id => document.getElementById(id);
  const window = document.defaultView;
  let busy = false, prepared = null;
  let preparingToken = null;
  let exportedUrl = null;
  let pageEpoch = 0;
  let automaticBackups = [];
  let automaticTimer = null;
  let automaticLoadEpoch = 0;

  function render() {
    element("backup-export").disabled = busy;
    element("backup-file").disabled = busy;
    element("backup-cancel").disabled = busy;
    element("backup-restore").disabled = busy || !prepared || !element("backup-confirm").checked;
    element("backup-confirm").disabled = busy;
    element("backup-preview").hidden = prepared === null;
    for (const button of element("automatic-backup-list").querySelectorAll("button")) {
      button.disabled = busy;
    }
  }

  async function run(message, operation, requireReady = true) {
    if (busy) return;
    try {
      if (requireReady) checkReady();
      busy = true;
      setBusy(true);
      render();
      status(message, "");
      await operation();
    } catch (error) {
      status(error.message || String(error), "error");
    } finally {
      busy = false;
      setBusy(false);
      render();
    }
  }

  async function cancelPrepared() {
    if (!prepared) return;
    const token = prepared.token;
    const reply = await send("hd_backup_cancel", { token });
    if (!reply.ok) throw new Error(reply.error || "Could not discard the prepared restore.");
    trackPreparation(token, false);
    prepared = null;
    element("backup-confirm").checked = false;
    render();
  }

  async function releaseExport() {
    if (!exportedUrl) return;
    const reply = await send("hd_backup_release", { blobUrl: exportedUrl });
    if (!reply?.ok) throw new Error(reply?.error || "Could not release the temporary backup archive. Try exporting again.");
    exportedUrl = null;
  }

  function renderAutomaticAges() {
    for (const row of element("automatic-backup-list").children) {
      const backup = automaticBackups.find(candidate => candidate.id === row.dataset.backupId);
      if (!backup) continue;
      const age = formatAutomaticBackupAge(backup.createdAt);
      row.querySelector(".automatic-backup-age").textContent = age;
      row.querySelector(".automatic-backup-restore").textContent = `Restore from ${age}`;
    }
  }

  function renderAutomaticBackups() {
    const rows = document.createDocumentFragment();
    for (const backup of automaticBackups) {
      const row = element("automatic-backup-template").content.firstElementChild.cloneNode(true);
      row.dataset.backupId = backup.id;
      row.querySelector(".automatic-backup-detail").textContent =
        `${backup.dictionaries.length} dictionaries · ${backup.customEntryCount} personal entries`;
      const created = row.querySelector(".automatic-backup-created");
      created.dateTime = backup.createdAt;
      created.textContent = new Date(backup.createdAt).toLocaleString();
      row.querySelector(".automatic-backup-restore").addEventListener("click", () => {
        const age = formatAutomaticBackupAge(backup.createdAt);
        void run("Checking the automatic backup and validating its dictionary files…", () =>
          prepareRestore("hd_backup_auto_prepare", { id: backup.id }, `Automatic backup from ${age}`));
      });
      rows.append(row);
    }
    element("automatic-backup-list").replaceChildren(rows);
    renderAutomaticAges();
    render();
  }

  async function loadAutomaticBackups() {
    if (!listAutomatic) return;
    const epoch = ++automaticLoadEpoch;
    try {
      const reply = await listAutomatic();
      if (epoch !== automaticLoadEpoch) return;
      if (!reply?.ok) throw new Error(reply?.error || "Could not read automatic backups.");
      automaticBackups = Array.isArray(reply.backups) ? reply.backups : [];
      renderAutomaticBackups();
      if (reply.corruptCount > 0) {
        const count = reply.corruptCount === 1 ? "One automatic backup is" : `${reply.corruptCount} automatic backups are`;
        element("automatic-backup-status").textContent =
          `${count} damaged. Any valid older backup remains available below.`;
      } else if (automaticBackups.length === 0) {
        element("automatic-backup-status").textContent =
          "No automatic backup has been created yet.";
      } else {
        element("automatic-backup-status").textContent = "";
      }
    } catch (error) {
      if (epoch !== automaticLoadEpoch) return;
      automaticBackups = [];
      renderAutomaticBackups();
      element("automatic-backup-status").textContent =
        error.message || String(error);
    }
  }

  function startAutomaticBackups() {
    if (!listAutomatic) return;
    void loadAutomaticBackups();
    if (automaticTimer === null) {
      automaticTimer = window.setInterval(renderAutomaticAges, 60_000);
    }
  }

  function showPrepared(reply, label) {
    prepared = reply;
    element("backup-confirm").checked = false;
    element("backup-file-name").textContent = label;
    const created = element("backup-created");
    created.dateTime = reply.createdAt;
    created.textContent = new Date(reply.createdAt).toLocaleString();
    element("backup-count").textContent = `${reply.dictionaries.length} dictionaries · ${reply.customEntryCount} personal entries`;
    const list = document.createDocumentFragment();
    for (const dictionary of reply.dictionaries) {
      const item = document.createElement("li");
      item.textContent = `${dictionary.title}${dictionary.enabled ? "" : " (disabled)"}`;
      list.append(item);
    }
    element("backup-dictionaries").replaceChildren(list);
    status(reply.warning || "Backup checked. Nothing has been replaced.", reply.warning ? "" : "ready");
    render();
    element("backup-preview-heading").focus();
  }

  async function prepareRestore(type, fields, label) {
    const epoch = pageEpoch;
    await cancelPrepared();
    if (epoch !== pageEpoch) return;
    const token = window.crypto.randomUUID();
    preparingToken = token;
    trackPreparation(token, true);
    let reply;
    try {
      reply = await send(type, { ...fields, token });
    } catch (error) {
      // The engine may have prepared successfully before its reply was lost.
      try {
        const cancelled = await send("hd_backup_cancel", { token });
        if (cancelled.ok) trackPreparation(token, false);
      } catch { /* Keep the original failure. */ }
      throw error;
    } finally {
      preparingToken = null;
    }
    if (!reply.ok) {
      trackPreparation(token, false);
      throw new Error(reply.error || "This backup could not be prepared.");
    }
    if (epoch !== pageEpoch) return;
    showPrepared(reply, label);
  }

  element("backup-export").addEventListener("click", () => {
    void run("Creating the backup archive…", async () => {
      if (!download) {
        await releaseExport();
        const exported = await send("hd_backup_export");
        if (!exported.ok) throw new Error(exported.error || "Could not create the backup.");
        exportedUrl = exported.blobUrl;
        let blob;
        // A failure here leaves exportedUrl set; the next export click retries the release.
        const response = await window.fetch(exported.blobUrl);
        if (!response.ok) throw new Error("Could not read the backup archive.");
        blob = await response.blob();
        await releaseExport();
        downloadBlob(document, blob, `hachidori-backup-${new Date().toISOString().slice(0, 10)}.zip`);
        status("Save requested. Choose where to save the backup in your app’s save dialog.", "ready", true);
        return;
      }
      const reply = await download();
      if (!reply.ok) throw new Error(reply.error || "Could not create the backup.");
      status(reply.warning || "Download started. Check Chrome’s downloads for progress.", reply.warning ? "" : "ready", true);
    });
  });

  element("backup-file").addEventListener("change", () => {
    const file = element("backup-file").files?.[0];
    element("backup-file").value = "";
    if (!file) return;
    void run("Checking the archive and preparing fresh dictionary files…", async () => {
      const blobUrl = window.URL.createObjectURL(file);
      try {
        await prepareRestore("hd_backup_prepare", { blobUrl }, file.name);
      } finally {
        window.URL.revokeObjectURL(blobUrl);
      }
    });
  });

  element("backup-confirm").addEventListener("change", render);
  element("backup-cancel").addEventListener("click", () => run("Discarding the prepared restore…", async () => {
    await cancelPrepared();
    status("Restore cancelled. Your data has not changed.", "");
    element("backup-file").focus();
  }, false));
  element("backup-restore").addEventListener("click", () => {
    if (!prepared || !element("backup-confirm").checked) return;
    void run("Restoring dictionaries and settings…", async () => {
      const token = prepared.token;
      // A restore attempt consumes its token, including an uncertain reply.
      prepared = null;
      trackPreparation(token, false);
      element("backup-confirm").checked = false;
      const reply = await send("hd_backup_restore", { token });
      if (!reply.ok) throw new Error(reply.error || "The restore could not be confirmed. Check the current library before trying again.");
      status(reply.warning || "Restored successfully.", reply.warning ? "" : "ready", true);
      try { await refresh(); }
      catch { status("Restored successfully. Reopen Settings to refresh this page.", "ready", true); }
      await loadAutomaticBackups();
    });
  });

  window.addEventListener("pagehide", () => {
    pageEpoch += 1;
    automaticLoadEpoch += 1;
    if (automaticTimer !== null) {
      window.clearInterval(automaticTimer);
      automaticTimer = null;
    }
    const token = preparingToken ?? prepared?.token;
    preparingToken = null;
    prepared = null;
    element("backup-confirm").checked = false;
    render();
    if (token) status("Restore cancelled. Choose the backup again to prepare it.", "");
    if (token) {
      // Port delivery is synchronous and its disconnect is a second cleanup
      // signal when an older Chrome drops this page's final runtime message.
      cancelPreparation(token);
      void send("hd_backup_cancel", { token })
        .then(reply => { if (reply.ok) trackPreparation(token, false); })
        .catch(() => {});
    }
    if (exportedUrl) {
      const blobUrl = exportedUrl;
      exportedUrl = null;
      void send("hd_backup_release", { blobUrl }).catch(() => {});
    }
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) startAutomaticBackups();
  });
  render();
  startAutomaticBackups();
  return { render, refreshAutomaticBackups: loadAutomaticBackups };
}
