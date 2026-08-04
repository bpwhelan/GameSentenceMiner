import { EventEmitter } from "node:events";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const modulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/hoshidicts_dictionary_backend.js",
);

const dictionary = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Fixture",
  displayTitle: "Fixture",
  path: "/store/dictionaries/fixture",
  types: ["term"],
  priority: 0,
};

class FakeClient extends EventEmitter {
  start = vi.fn(async () => ({
    hostVersion: "0.1.0",
    capabilities: ["term", "styles", "media"],
  }));
  stop = vi.fn(async () => {});
  request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "catalog.configure") {
      return { generation: params.generation, loaded: 1, styles: 0 };
    }
    if (method === "styles.list") {
      return { catalogGeneration: 7, styles: [] };
    }
    if (method === "lookup.term") {
      return {
        catalogGeneration: 7,
        requestGeneration: params.requestGeneration,
        matchedLength: 1,
        elapsedMs: 1,
        results: [
          {
            matched: "猫",
            deinflected: "猫",
            process: [],
            preprocessorSteps: 0,
            term: {
              expression: "猫",
              reading: "ねこ",
              rules: "n",
              glossaries: [
                {
                  dictionary: dictionary.id,
                  glossary: "cat",
                  definitionTags: "",
                  termTags: "",
                },
              ],
              frequencies: [],
              pitches: [],
            },
          },
        ],
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
}

class FakePopup {
  showLoading = vi.fn();
  showResults = vi.fn(() => true);
  showState = vi.fn();
  setDictionaryStyles = vi.fn();
  setMiningReadiness = vi.fn();
  setMineDispatcher = vi.fn();
  setMineSuccessHandler = vi.fn();
  dismiss = vi.fn();
  command = vi.fn(async () => ({ status: "handled" }));
  setLookupDispatcher = vi.fn();
}

describe("HoshiDicts dictionary backend", () => {
  it("exposes mining only after Python reports a valid Anki mapping", async () => {
    const { HoshiDictsDictionaryBackend } = await import(modulePath);
    const client = new FakeClient();
    const popup = new FakePopup();
    const miningClient = {
      refreshReadiness: vi.fn(async () => ({
        ready: true,
        status: "ready",
        message: "Ready",
        missing: [],
      })),
      mine: vi.fn(),
    };
    const backend = new HoshiDictsDictionaryBackend({
      client,
      popup,
      miningClient,
    });

    expect(backend.capabilities.has("mine")).toBe(false);
    await backend.start({
      catalog: { generation: 7, dictionaries: [dictionary] },
    });
    await backend.refreshMiningReadiness();

    expect(backend.capabilities.has("mine")).toBe(true);
    expect(backend.getSnapshot().miningReadiness).toMatchObject({
      ready: true,
      status: "ready",
    });
    expect(popup.setMiningReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ ready: true }),
    );
  });

  it("starts the host, configures an ID-based catalog, and renders lookup results", async () => {
    const { HoshiDictsDictionaryBackend } = await import(modulePath);
    const client = new FakeClient();
    const popup = new FakePopup();
    let generation = 3;
    const backend = new HoshiDictsDictionaryBackend({
      client,
      popup,
      getGeneration: () => generation,
    });
    const opened: Array<Record<string, unknown>> = [];
    backend.on("popup-opened", (event: Record<string, unknown>) =>
      opened.push(event),
    );

    await backend.start({
      catalog: {
        generation: 7,
        dictionaries: [dictionary],
      },
    });
    const result = await backend.lookup({
      generation,
      text: "猫",
      anchor: { x: 20, y: 30, height: 18 },
      sourceSentence: "猫です。",
    });

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      "catalog.configure",
      {
        generation: 7,
        dictionaries: [
          {
            id: dictionary.id,
            title: dictionary.title,
            path: dictionary.path,
            types: dictionary.types,
            priority: 0,
          },
        ],
      },
      expect.any(Object),
    );
    expect(popup.showResults).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            expression: "猫",
          }),
        ],
      }),
      expect.objectContaining({
        generation,
        sourceSentence: "猫です。",
      }),
    );
    expect(result).toMatchObject({ status: "results", count: 1 });
    expect(opened).toEqual([
      expect.objectContaining({
        backendId: "hoshidicts",
        generation,
      }),
    ]);
  });

  it("does not paint a response after its controller generation is stale", async () => {
    const { HoshiDictsDictionaryBackend } = await import(modulePath);
    const client = new FakeClient();
    const popup = new FakePopup();
    let generation = 8;
    let resolveLookup!: (value: any) => void;
    const pending = new Promise((resolve) => {
      resolveLookup = resolve;
    });
    client.request.mockImplementation(async (method, params) => {
      if (method === "catalog.configure") {
        return { generation: 7, loaded: 1, styles: 0 };
      }
      if (method === "styles.list") {
        return { catalogGeneration: 7, styles: [] };
      }
      return await pending;
    });
    const backend = new HoshiDictsDictionaryBackend({
      client,
      popup,
      getGeneration: () => generation,
    });
    await backend.start({
      catalog: { generation: 7, dictionaries: [dictionary] },
    });

    const lookup = backend.lookup({
      generation,
      text: "古い",
      anchor: { x: 1, y: 2 },
    });
    generation = 9;
    resolveLookup({
      catalogGeneration: 7,
      requestGeneration: 8,
      matchedLength: 0,
      elapsedMs: 1,
      results: [],
    });

    await expect(lookup).resolves.toMatchObject({ status: "stale" });
    expect(popup.showResults).not.toHaveBeenCalled();
    expect(popup.showState).not.toHaveBeenCalledWith(
      "empty",
      expect.anything(),
    );
  });

  it("locks popup interaction as soon as the loading surface becomes visible", async () => {
    const { HoshiDictsDictionaryBackend } = await import(modulePath);
    const client = new FakeClient();
    const popup = new FakePopup();
    let resolveLookup!: (value: any) => void;
    const pendingLookup = new Promise((resolve) => {
      resolveLookup = resolve;
    });
    const backend = new HoshiDictsDictionaryBackend({
      client,
      popup,
      getGeneration: () => 12,
    });
    await backend.start({
      catalog: { generation: 7, dictionaries: [dictionary] },
    });
    client.request.mockImplementation(async (method, params) => {
      if (method === "lookup.term") {
        return await pendingLookup;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const opened: Array<Record<string, unknown>> = [];
    backend.on("popup-opened", (event: Record<string, unknown>) => {
      opened.push(event);
    });

    const lookup = backend.lookup({
      generation: 12,
      text: "猫",
      anchor: { x: 20, y: 30, height: 18 },
    });

    expect(popup.showLoading).toHaveBeenCalled();
    expect(opened).toEqual([
      expect.objectContaining({
        popupId: "hoshidicts-popup",
        generation: 12,
        reason: "lookup-loading",
      }),
    ]);

    resolveLookup({
      catalogGeneration: 7,
      requestGeneration: 12,
      matchedLength: 0,
      elapsedMs: 1,
      results: [],
    });
    await lookup;
  });

  it("keeps a host-failure surface interaction-locked until it is dismissed", async () => {
    const { HoshiDictsDictionaryBackend } = await import(modulePath);
    const client = new FakeClient();
    const popup = new FakePopup();
    const backend = new HoshiDictsDictionaryBackend({
      client,
      popup,
      getGeneration: () => 15,
    });
    const opened: Array<Record<string, unknown>> = [];
    backend.on("popup-opened", (event: Record<string, unknown>) => {
      opened.push(event);
    });
    await backend.start({
      catalog: { generation: 7, dictionaries: [dictionary] },
    });

    client.emit("exit", { code: "HOST_EXITED" });

    expect(popup.showState).toHaveBeenCalledWith(
      "host-unavailable",
      expect.objectContaining({
        generation: 15,
        errorCode: "HOST_EXITED",
      }),
    );
    expect(opened).toEqual([
      expect.objectContaining({
        generation: 15,
        reason: "host-exited",
      }),
    ]);
  });

  it("keeps Hoshi stopped and closes its popup after backend shutdown", async () => {
    const { HoshiDictsDictionaryBackend } = await import(modulePath);
    const client = new FakeClient();
    const popup = new FakePopup();
    const backend = new HoshiDictsDictionaryBackend({ client, popup });
    await backend.start({
      catalog: { generation: 7, dictionaries: [dictionary] },
    });

    await backend.stop({ reason: "backend-switch" });

    expect(popup.dismiss).toHaveBeenCalledWith("backend-switch");
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(backend.started).toBe(false);
  });
});
