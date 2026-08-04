import { EventEmitter } from "node:events";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const modulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/hoshidicts_mining.js",
);

class FakeIpcRenderer extends EventEmitter {
  sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];

  send(channel: string, payload: Record<string, unknown>) {
    this.sent.push({ channel, payload });
  }
}

describe("HoshiDicts mining client", () => {
  it("requests readiness and exposes the authoritative server response", async () => {
    const { HoshiDictsMiningClient } = await import(modulePath);
    const ipc = new FakeIpcRenderer();
    const client = new HoshiDictsMiningClient({
      ipcRenderer: ipc,
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      timeoutMs: 1000,
    });

    const pending = client.refreshReadiness();
    expect(ipc.sent).toEqual([
      {
        channel: "dictionary-mine-readiness-request",
        payload: {
          type: "dictionary-mine-readiness-request",
          backend: "hoshidicts",
          request_id: "11111111-1111-4111-8111-111111111111",
        },
      },
    ]);
    ipc.emit("dictionary-mine-readiness-result", {}, {
      type: "dictionary-mine-readiness-result",
      request_id: "11111111-1111-4111-8111-111111111111",
      backend: "hoshidicts",
      ready: true,
      status: "ready",
      message: "Ready",
      missing: [],
    });

    await expect(pending).resolves.toMatchObject({ ready: true });
    expect(client.getReadiness()).toMatchObject({ ready: true });
    client.destroy();
  });

  it("sends one typed selected-glossary request and waits for Anki confirmation", async () => {
    const { HoshiDictsMiningClient } = await import(modulePath);
    const ipc = new FakeIpcRenderer();
    const client = new HoshiDictsMiningClient({
      ipcRenderer: ipc,
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
      timeoutMs: 1000,
    });
    const lookup = {
      expression: "食べる",
      reading: "たべる",
      matched_text: "食べました",
      dictionary_id: "dict",
      dictionary_title: "Jitendex",
      glossary_id: "selected-glossary",
      glossary_text: "to eat",
      frequency: ["100"],
      pitch: [2],
    };

    const pending = client.mine({
      line_id: "line-7",
      source_sentence: "食べました。",
      lookup,
      media: [],
    });
    expect(ipc.sent[0]).toMatchObject({
      channel: "dictionary-mine-request",
      payload: {
        type: "dictionary-mine-request",
        request_id: "22222222-2222-4222-8222-222222222222",
        idempotency_key: "22222222-2222-4222-8222-222222222222",
        backend: "hoshidicts",
        line_id: "line-7",
        source_sentence: "食べました。",
        lookup,
      },
    });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    ipc.emit("dictionary-mine-result", {}, {
      type: "dictionary-mine-result",
      request_id: "22222222-2222-4222-8222-222222222222",
      status: "created",
      note_id: 42,
      warnings: [],
    });

    await expect(pending).resolves.toMatchObject({
      status: "created",
      note_id: 42,
    });
    client.destroy();
  });

  it("cleans up pending requests and IPC listeners on destroy", async () => {
    const { HoshiDictsMiningClient } = await import(modulePath);
    const ipc = new FakeIpcRenderer();
    const client = new HoshiDictsMiningClient({
      ipcRenderer: ipc,
      randomUUID: () => "33333333-3333-4333-8333-333333333333",
      timeoutMs: 1000,
    });
    const pending = client.refreshReadiness();

    client.destroy();

    await expect(pending).rejects.toMatchObject({
      code: "MINING_CLIENT_DESTROYED",
    });
    expect(ipc.listenerCount("dictionary-mine-result")).toBe(0);
    expect(ipc.listenerCount("dictionary-mine-readiness-result")).toBe(0);
  });
});
