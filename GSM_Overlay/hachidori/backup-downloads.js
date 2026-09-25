// Keep engine-owned backup URLs alive until Chrome finishes saving the file.
// Session storage survives service-worker restarts, but is not backup content.
// SPDX-License-Identifier: GPL-3.0-or-later
const KEY = "backupDownloads";
const TARGET = "hoshidicts-offscreen";

export function createBackupDownloads(chrome, relay) {
  let tail = Promise.resolve();
  const serialise = job => {
    const result = tail.then(job, job);
    tail = result.catch(() => {});
    return result;
  };
  const release = blobUrl => relay({ target: TARGET, type: "hd_backup_release", blobUrl });
  const read = async () => (await chrome.storage.session.get(KEY))[KEY] ?? {};

  async function finish(id) {
    const tracked = await read();
    if (!Object.hasOwn(tracked, id)) return;
    const [download] = await chrome.downloads.search({ id: Number(id) });
    if (download?.state === "in_progress") return;
    const reply = await release(tracked[id]);
    if (!reply?.ok) throw new Error(reply?.error || "Could not release the saved backup archive.");
    delete tracked[id];
    await chrome.storage.session.set({ [KEY]: tracked });
  }

  return {
    async download() {
      const exported = await relay({ target: TARGET, type: "hd_backup_export" });
      if (!exported?.ok) throw new Error(exported?.error || "Could not create a backup archive.");
      let id;
      try {
        id = await chrome.downloads.download({ url: exported.blobUrl, saveAs: true,
          filename: `hachidori-backup-${new Date().toISOString().slice(0, 10)}.zip`, conflictAction: "uniquify" });
      } catch (error) {
        await serialise(() => release(exported.blobUrl));
        throw error;
      }
      let warning = null;
      try {
        await serialise(async () => {
          await chrome.storage.session.set({ [KEY]: { ...await read(), [id]: exported.blobUrl } });
          // A small download can complete before its ownership record is written.
          await finish(id);
        });
      } catch (error) {
        warning = `Download started, but its temporary archive could not be tracked: ${error.message}`;
      }
      return { downloadId: id, warning };
    },
    changed(id) { return serialise(() => finish(id)); },
  };
}
