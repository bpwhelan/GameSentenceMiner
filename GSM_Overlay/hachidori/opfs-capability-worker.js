/*
 * Verifies the synchronous OPFS primitives required by WasmFS before the
 * offscreen document commits to the pthread runtime.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

// A dedicated worker receives only from its creator over its implicit
// MessagePort. MessageEvent.origin is always empty, so there is no origin value
// to validate; the channel check below validates the expected protocol.
globalThis.onmessage = async (event) => { // NOSONAR
  if (event.data?.channel !== "opfs-capability-probe") return;

  const suffix = `${Date.now()}-${globalThis.crypto.randomUUID()}`;
  const first = `.hdw-opfs-probe-${suffix}`;
  const second = `${first}-moved`;
  let root = null;
  let access = null;
  try {
    root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(first, { create: true });
    if (typeof handle.createSyncAccessHandle !== "function" || typeof handle.move !== "function") {
      throw new Error("OPFS synchronous access or file move is unavailable");
    }
    access = await handle.createSyncAccessHandle();
    access.write(new Uint8Array([0x48, 0x44, 0x57]), { at: 0 });
    access.flush();
    access.close();
    access = null;

    await handle.move(root, second);
    const moved = await root.getFileHandle(second);
    access = await moved.createSyncAccessHandle();
    if (access.getSize() !== 3) {
      throw new Error("an OPFS file did not survive move intact");
    }
    access.close();
    access = null;
    await root.removeEntry(second);
    globalThis.postMessage({ channel: "opfs-capability-result", ok: true });
  } catch (error) {
    try {
      access?.close();
    } catch {
      // The failed operation may already have closed it.
    }
    if (root !== null) {
      for (const name of [first, second]) {
        try {
          await root.removeEntry(name);
        } catch {
          // A probe path that was never created or already moved is absent.
        }
      }
    }
    globalThis.postMessage({ channel: "opfs-capability-result", ok: false, error: describe(error) });
  }
};
