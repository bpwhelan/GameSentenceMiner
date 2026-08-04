import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const modulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/hoshidicts_settings_service.js",
);
const settingsPath = path.resolve(process.cwd(), "GSM_Overlay/settings.html");

type IpcListener = (event: unknown, payload: any) => void;

function nextTick(delay = 0) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function makeSettingsState(overrides: Record<string, any> = {}) {
  const settings = {
    dictionaryBackend: "yomitan",
    hoshiDictionaryOrder: [],
    hoshiDictionaryEnabled: {},
    hoshiScanLength: 16,
    hoshiMaxResults: 16,
    hoshiRecursiveLookupEnabled: true,
    hoshiLowRamImport: true,
    ...(overrides.settings || {}),
  };
  return {
    settings,
    host: {
      available: true,
      status: "stopped",
      errorCode: null,
      ...(overrides.host || {}),
    },
    dictionaries: overrides.dictionaries || [],
    imports: overrides.imports || [],
    reindexRequired: overrides.reindexRequired || [],
    storage: {
      activeBytes: 0,
      dictionaryCount: 0,
      ...(overrides.storage || {}),
    },
    operationError: overrides.operationError || null,
  };
}

function loadSettingsPage(options: {
  state?: Record<string, any>;
  invoke?: (
    channel: string,
    payload: Record<string, unknown> | undefined,
  ) => Promise<any> | any;
} = {}) {
  const html = fs.readFileSync(settingsPath, "utf8");
  const listeners = new Map<string, IpcListener[]>();
  const invocations: Array<{
    channel: string;
    payload: Record<string, unknown> | undefined;
  }> = [];
  const state = options.state || makeSettingsState();
  const ipcRenderer = {
    send: vi.fn(),
    invoke: async (
      channel: string,
      payload?: Record<string, unknown>,
    ) => {
      invocations.push({ channel, payload });
      if (options.invoke) {
        const result = await options.invoke(channel, payload);
        if (result !== undefined) {
          return result;
        }
      }
      if (channel === "hoshidicts-get-state") {
        return state;
      }
      if (channel === "get-effective-platform") {
        return "win32";
      }
      return null;
    },
    on: (channel: string, listener: IpcListener) => {
      listeners.set(channel, [...(listeners.get(channel) || []), listener]);
    },
  };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    readyState = FakeWebSocket.CONNECTING;
    onopen?: () => void;
    onclose?: () => void;

    constructor() {
      setTimeout(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }

    send() {}

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  const dom = new JSDOM(html, {
    url: pathToFileURL(settingsPath).href,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window: any) {
      window.require = (moduleName: string) => {
        if (moduleName === "electron") {
          return { ipcRenderer };
        }
        throw new Error(`Unexpected require: ${moduleName}`);
      };
      window.process = { platform: "win32" };
      window.WebSocket = FakeWebSocket;
      window.setInterval = () => 0;
      window.clearInterval = () => {};
      window.console = {
        ...window.console,
        log: () => {},
        warn: () => {},
      };
      window.navigator.getGamepads = () => [];
      window.open = () => null;
    },
  });
  const ready = dom.window.document.readyState === "complete"
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        dom.window.addEventListener("load", () => resolve(), { once: true });
      });

  return {
    dom,
    ready,
    invocations,
    emit(channel: string, payload: any) {
      for (const listener of listeners.get(channel) || []) {
        listener(null, payload);
      }
    },
  };
}

const dictionaryA = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Terms",
  displayTitle: "Terms",
  types: ["term"],
  sizeBytes: 1024,
  health: "ready",
};
const dictionaryB = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Frequency",
  displayTitle: "Frequency",
  types: ["frequency"],
  sizeBytes: 2048,
  health: "ready",
};

function installedDictionaryState(
  overrides: Record<string, any> = {},
) {
  return makeSettingsState({
    settings: {
      dictionaryBackend: "hoshidicts",
      hoshiDictionaryOrder: [dictionaryA.id, dictionaryB.id],
      hoshiDictionaryEnabled: {
        [dictionaryA.id]: true,
        [dictionaryB.id]: false,
      },
      ...(overrides.settings || {}),
    },
    dictionaries: [dictionaryA, dictionaryB],
    storage: {
      activeBytes: 3072,
      dictionaryCount: 2,
    },
    ...overrides,
  });
}

class FakeStore {
  rootPath = "/test/hoshidicts";
  initialize = vi.fn(async () => ({
    manifest: {
      schemaVersion: 1,
      revision: 4,
      dictionaries: [],
    },
    cleanedJobIds: [],
  }));
  listDictionaries = vi.fn(async () => [
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Terms",
      displayTitle: "Terms",
      types: ["term"],
      formatRevision: 3,
      sourceSha256: "a".repeat(64),
      sourceFilename: "terms.zip",
      importedAt: "2026-08-04T00:00:00.000Z",
      hostVersion: "0.1.0",
      hoshidictsCommit: "b".repeat(40),
      relativePath:
        "dictionaries/11111111-1111-4111-8111-111111111111/current/import",
      sizeBytes: 1024,
      health: "ready",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Frequency",
      displayTitle: "Frequency",
      types: ["frequency"],
      formatRevision: 3,
      sourceSha256: "c".repeat(64),
      sourceFilename: "frequency.zip",
      importedAt: "2026-08-04T00:00:00.000Z",
      hostVersion: "0.1.0",
      hoshidictsCommit: "b".repeat(40),
      relativePath:
        "dictionaries/22222222-2222-4222-8222-222222222222/current/import",
      sizeBytes: 2048,
      health: "ready",
    },
  ]);
  getStorageUsage = vi.fn(async () => ({
    activeBytes: 3072,
    dictionaryCount: 2,
  }));
  buildCatalog = vi.fn(async (options: Record<string, any> = {}) => ({
    dictionaries:
      options.enabled?.["11111111-1111-4111-8111-111111111111"] === false
        ? []
        : [
            {
              id: "11111111-1111-4111-8111-111111111111",
              title: "Terms",
              displayTitle: "Terms",
              path: "/test/hoshidicts/terms",
              types: ["term"],
              priority: 0,
            },
          ],
    reindexRequired: [],
    manifestRevision: 4,
  }));
  removeDictionary = vi.fn(async (id: string) => ({ entry: { id } }));
}

class FakeImportManager extends EventEmitter {
  getActiveImports = vi.fn(() => []);
  importDictionary = vi.fn(async () => ({
    status: "imported",
    entry: {
      id: "33333333-3333-4333-8333-333333333333",
      title: "Imported",
      types: ["term"],
    },
  }));
  cancel = vi.fn(() => true);
}

describe("HoshiDicts settings normalization", () => {
  it("keeps Yomitan as the fallback and bounds Hoshi display settings", async () => {
    const {
      normalizeDictionaryBackend,
      normalizeHoshiProfileSettings,
    } = await import(modulePath);

    expect(normalizeDictionaryBackend(undefined)).toBe("yomitan");
    expect(normalizeDictionaryBackend("unknown")).toBe("yomitan");
    expect(normalizeDictionaryBackend("hoshidicts")).toBe("hoshidicts");

    expect(
      normalizeHoshiProfileSettings({
        dictionaryBackend: "invalid",
        hoshiDictionaryOrder: ["a", "a", 1, "b"],
        hoshiDictionaryEnabled: {
          a: true,
          b: false,
          ignored: "yes",
        },
        hoshiScanLength: 999,
        hoshiMaxResults: 0,
        hoshiRecursiveLookupEnabled: "yes",
        hoshiLowRamImport: false,
      }),
    ).toEqual({
      dictionaryBackend: "yomitan",
      hoshiDictionaryOrder: ["a", "b"],
      hoshiDictionaryEnabled: { a: true, b: false },
      hoshiScanLength: 64,
      hoshiMaxResults: 1,
      hoshiRecursiveLookupEnabled: true,
      hoshiLowRamImport: false,
    });
  });

  it("removes a deleted dictionary from top-level and profile settings", async () => {
    const { removeHoshiDictionaryReferences } = await import(modulePath);
    const id = "11111111-1111-4111-8111-111111111111";
    const settings = {
      hoshiDictionaryOrder: [id, "other"],
      hoshiDictionaryEnabled: { [id]: true, other: false },
      overlayProfileSettings: {
        Default: {
          hoshiDictionaryOrder: ["other", id],
          hoshiDictionaryEnabled: { [id]: true },
        },
        Game: {
          hoshiDictionaryOrder: [id],
          hoshiDictionaryEnabled: { [id]: false },
        },
      },
    };

    const changedProfiles = removeHoshiDictionaryReferences(settings, id);

    expect(changedProfiles).toEqual(["Default", "Game"]);
    expect(settings.hoshiDictionaryOrder).toEqual(["other"]);
    expect(settings.hoshiDictionaryEnabled).toEqual({ other: false });
    expect(settings.overlayProfileSettings.Default).toEqual({
      hoshiDictionaryOrder: ["other"],
      hoshiDictionaryEnabled: {},
    });
    expect(settings.overlayProfileSettings.Game).toEqual({
      hoshiDictionaryOrder: [],
      hoshiDictionaryEnabled: {},
    });
  });

  it("reports every profile reference before a global removal", async () => {
    const { findHoshiDictionaryReferences } = await import(modulePath);
    const id = dictionaryA.id;

    expect(
      findHoshiDictionaryReferences(
        {
          hoshiDictionaryOrder: [id],
          hoshiDictionaryEnabled: { [id]: true },
          overlayProfileSettings: {
            Default: {
              hoshiDictionaryOrder: [id],
              hoshiDictionaryEnabled: {},
            },
            Game: {
              hoshiDictionaryOrder: [],
              hoshiDictionaryEnabled: { [id]: false },
            },
            Unrelated: {
              hoshiDictionaryOrder: ["other"],
              hoshiDictionaryEnabled: { other: true },
            },
          },
        },
        id,
      ),
    ).toEqual(["Current settings", "Default", "Game"]);
  });
});

describe("HoshiDictsSettingsService", () => {
  it("does not create the store or start the host while checking default state", async () => {
    const { HoshiDictsSettingsService } = await import(modulePath);
    const store = new FakeStore();
    const importManager = new FakeImportManager();
    const createClient = vi.fn();
    const service = new HoshiDictsSettingsService({
      dataPath: "/test",
      store,
      importManager,
      createClient,
      storeExists: () => false,
      resolveExecutable: () => "/test/hoshidicts-host",
    });

    const state = await service.getState({
      dictionaryBackend: "yomitan",
    });

    expect(state.host).toMatchObject({
      available: true,
      status: "stopped",
    });
    expect(state.dictionaries).toEqual([]);
    expect(store.initialize).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("handshakes once and builds a generation-safe ordered catalog", async () => {
    const { HoshiDictsSettingsService } = await import(modulePath);
    const store = new FakeStore();
    const importManager = new FakeImportManager();
    const client = {
      start: vi.fn(async () => ({
        protocol: { major: 1, minor: 0 },
        hostVersion: "0.1.0",
        hoshidictsCommit: "b".repeat(40),
        capabilities: ["term", "import", "probe"],
      })),
      shutdown: vi.fn(async () => {}),
    };
    const service = new HoshiDictsSettingsService({
      dataPath: "/test",
      store,
      importManager,
      createClient: () => client,
      storeExists: () => true,
      resolveExecutable: () => "/test/hoshidicts-host",
    });
    const settings = {
      dictionaryBackend: "hoshidicts",
      hoshiDictionaryOrder: [
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
      ],
      hoshiDictionaryEnabled: {
        "11111111-1111-4111-8111-111111111111": true,
        "22222222-2222-4222-8222-222222222222": false,
      },
    };

    const first = await service.buildRuntime(settings);
    const second = await service.buildRuntime(settings);
    const changed = await service.buildRuntime({
      ...settings,
      hoshiDictionaryEnabled: {
        ...settings.hoshiDictionaryEnabled,
        "11111111-1111-4111-8111-111111111111": false,
      },
    });

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(store.buildCatalog).toHaveBeenCalledWith({
      order: settings.hoshiDictionaryOrder,
      enabled: settings.hoshiDictionaryEnabled,
      hostVersion: "0.1.0",
      hoshidictsCommit: "b".repeat(40),
    });
    expect(first.catalog).toMatchObject({
      generation: 5,
      dictionaries: [
        expect.objectContaining({
          id: "11111111-1111-4111-8111-111111111111",
        }),
      ],
    });
    expect(second.catalog.generation).toBe(5);
    expect(changed.catalog).toEqual({
      generation: 6,
      dictionaries: [],
    });
  });

  it("retains import progress for a settings window that is reopened", async () => {
    const { HoshiDictsSettingsService } = await import(modulePath);
    const store = new FakeStore();
    const importManager = new FakeImportManager();
    importManager.importDictionary = vi.fn(async () => {
      importManager.emit("progress", {
        jobId: "job-1",
        phase: "native-import",
        completed: 3,
        total: 10,
      });
      return {
        status: "imported",
        entry: {
          id: "33333333-3333-4333-8333-333333333333",
          title: "Imported",
          types: ["term"],
        },
      };
    });
    const service = new HoshiDictsSettingsService({
      dataPath: "/test",
      store,
      importManager,
      createClient: () => ({
        start: async () => ({
          protocol: { major: 1, minor: 0 },
          hostVersion: "0.1.0",
          hoshidictsCommit: "b".repeat(40),
          capabilities: ["term", "import", "probe"],
        }),
        shutdown: async () => {},
      }),
      storeExists: () => true,
      resolveExecutable: () => "/test/hoshidicts-host",
    });

    await service.importDictionary("/tmp/dictionary.zip");
    const state = await service.getState(
      { dictionaryBackend: "hoshidicts" },
      { initializeStore: true },
    );

    expect(state.imports).toContainEqual(
      expect.objectContaining({
        jobId: "job-1",
        phase: "complete",
        status: "imported",
      }),
    );
  });
});

describe("HoshiDicts overlay settings DOM", () => {
  it("keeps Yomitan selected by default and conditionally shows Hoshi controls", async () => {
    const page = loadSettingsPage();
    try {
      await page.ready;
      await nextTick();

      const yomitan = page.dom.window.document.getElementById(
        "dictionaryBackendYomitan",
      ) as HTMLInputElement;
      const hoshi = page.dom.window.document.getElementById(
        "dictionaryBackendHoshiDicts",
      ) as HTMLInputElement;
      const panel = page.dom.window.document.getElementById(
        "hoshiDictionaryControls",
      ) as HTMLElement;
      expect(yomitan.checked).toBe(true);
      expect(hoshi.checked).toBe(false);
      expect(panel.hidden).toBe(true);

      page.emit(
        "hoshidicts-state-updated",
        makeSettingsState({
          settings: { dictionaryBackend: "hoshidicts" },
        }),
      );
      expect(hoshi.checked).toBe(true);
      expect(panel.hidden).toBe(false);

      page.emit("hoshidicts-state-updated", makeSettingsState());
      expect(yomitan.checked).toBe(true);
      expect(panel.hidden).toBe(true);
    } finally {
      page.dom.window.close();
    }
  });

  it("commits a validated backend switch and rolls the control back on failure", async () => {
    const successfulState = makeSettingsState({
      settings: { dictionaryBackend: "hoshidicts" },
    });
    const successPage = loadSettingsPage({
      invoke: async (channel) => {
        if (channel === "hoshidicts-select-backend") {
          return {
            ok: true,
            backend: "hoshidicts",
            state: successfulState,
          };
        }
      },
    });
    try {
      await successPage.ready;
      await nextTick();
      const hoshi = successPage.dom.window.document.getElementById(
        "dictionaryBackendHoshiDicts",
      ) as HTMLInputElement;
      hoshi.checked = true;
      hoshi.dispatchEvent(
        new successPage.dom.window.Event("change", { bubbles: true }),
      );
      await nextTick();

      expect(
        successPage.invocations.find(
          (entry) => entry.channel === "hoshidicts-select-backend",
        )?.payload,
      ).toEqual({ backendId: "hoshidicts" });
      expect(hoshi.checked).toBe(true);
    } finally {
      successPage.dom.window.close();
    }

    const failurePage = loadSettingsPage({
      invoke: async (channel) => {
        if (channel === "hoshidicts-select-backend") {
          return {
            ok: false,
            backend: "yomitan",
            error: {
              code: "HOST_START_FAILED",
              message: "Unable to start the native host",
            },
          };
        }
      },
    });
    try {
      await failurePage.ready;
      await nextTick();
      const hoshi = failurePage.dom.window.document.getElementById(
        "dictionaryBackendHoshiDicts",
      ) as HTMLInputElement;
      const yomitan = failurePage.dom.window.document.getElementById(
        "dictionaryBackendYomitan",
      ) as HTMLInputElement;
      hoshi.checked = true;
      hoshi.dispatchEvent(
        new failurePage.dom.window.Event("change", { bubbles: true }),
      );
      await nextTick();

      expect(yomitan.checked).toBe(true);
      expect(
        failurePage.dom.window.document.getElementById(
          "hoshiOperationErrorMessage",
        )?.textContent,
      ).toContain("Unable to start");
      expect(
        failurePage.dom.window.document.getElementById(
          "hoshiOperationErrorCode",
        )?.textContent,
      ).toBe("HOST_START_FAILED");
    } finally {
      failurePage.dom.window.close();
    }
  });

  it("disables unavailable Hoshi selection with an actionable status", async () => {
    const page = loadSettingsPage({
      state: makeSettingsState({
        host: {
          available: false,
          status: "unavailable",
          errorCode: "HOST_NOT_FOUND",
        },
      }),
    });
    try {
      await page.ready;
      await nextTick();

      const hoshi = page.dom.window.document.getElementById(
        "dictionaryBackendHoshiDicts",
      ) as HTMLInputElement;
      const status = page.dom.window.document.getElementById("hoshiHostStatus");
      expect(hoshi.disabled).toBe(true);
      expect(status?.textContent).toContain("HOST_NOT_FOUND");
      expect(status?.textContent).toContain("Repair or reinstall");
    } finally {
      page.dom.window.close();
    }
  });

  it("restores active import progress whenever the settings window opens", async () => {
    const state = makeSettingsState({
      settings: { dictionaryBackend: "hoshidicts" },
      imports: [
        {
          jobId: "job-1",
          phase: "term-bank",
          status: "running",
          completed: 3,
          total: 10,
        },
      ],
    });

    for (let opening = 0; opening < 2; opening += 1) {
      const page = loadSettingsPage({ state });
      try {
        await page.ready;
        await nextTick();
        const progress = page.dom.window.document.querySelector(
          "#hoshiImportList progress",
        ) as HTMLProgressElement;
        expect(progress.value).toBe(3);
        expect(progress.max).toBe(10);
        expect(
          page.dom.window.document.querySelector(
            '[aria-label="Cancel import"]',
          ),
        ).not.toBeNull();
      } finally {
        page.dom.window.close();
      }
    }
  });

  it("wires enable, order, reimport, and global remove controls", async () => {
    const state = installedDictionaryState();
    const page = loadSettingsPage({
      state,
      invoke: async (channel) => {
        if (channel === "hoshidicts-update-profile-settings") {
          return { ok: true, state };
        }
        if (
          channel === "hoshidicts-reimport" ||
          channel === "hoshidicts-remove"
        ) {
          return { ok: true };
        }
      },
    });
    try {
      await page.ready;
      await nextTick();

      let firstRow = page.dom.window.document.querySelector(
        `[data-dictionary-id="${dictionaryA.id}"]`,
      ) as HTMLElement;
      const toggle = firstRow.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement;
      toggle.checked = false;
      toggle.dispatchEvent(
        new page.dom.window.Event("change", { bubbles: true }),
      );
      await nextTick();
      expect(
        page.invocations.find(
          (entry) =>
            entry.channel === "hoshidicts-update-profile-settings" &&
            (entry.payload?.hoshiDictionaryEnabled as Record<string, boolean>)?.[
              dictionaryA.id
            ] === false,
        ),
      ).toBeDefined();

      firstRow = page.dom.window.document.querySelector(
        `[data-dictionary-id="${dictionaryA.id}"]`,
      ) as HTMLElement;
      (firstRow.querySelector(
        '[aria-label="Move dictionary down"]',
      ) as HTMLButtonElement).click();
      await nextTick();
      expect(
        page.invocations.find(
          (entry) =>
            entry.channel === "hoshidicts-update-profile-settings" &&
            Array.isArray(entry.payload?.hoshiDictionaryOrder) &&
            entry.payload?.hoshiDictionaryOrder[0] === dictionaryB.id,
        ),
      ).toBeDefined();

      firstRow = page.dom.window.document.querySelector(
        `[data-dictionary-id="${dictionaryA.id}"]`,
      ) as HTMLElement;
      (firstRow.querySelector(
        '[aria-label="Reimport dictionary"]',
      ) as HTMLButtonElement).click();
      await nextTick();
      firstRow = page.dom.window.document.querySelector(
        `[data-dictionary-id="${dictionaryA.id}"]`,
      ) as HTMLElement;
      (firstRow.querySelector(
        '[aria-label="Remove dictionary globally"]',
      ) as HTMLButtonElement).click();
      await nextTick();

      expect(
        page.invocations.find(
          (entry) => entry.channel === "hoshidicts-reimport",
        )?.payload,
      ).toEqual({ dictionaryId: dictionaryA.id });
      expect(
        page.invocations.find(
          (entry) => entry.channel === "hoshidicts-remove",
        )?.payload,
      ).toEqual({ dictionaryId: dictionaryA.id });
    } finally {
      page.dom.window.close();
    }
  });

  it("resets profile values without invoking global dictionary removal", async () => {
    const initialState = installedDictionaryState();
    const resetState = installedDictionaryState({
      settings: {
        dictionaryBackend: "yomitan",
        hoshiDictionaryOrder: [],
        hoshiDictionaryEnabled: {},
      },
    });
    const page = loadSettingsPage({
      state: initialState,
      invoke: async (channel) => {
        if (channel === "hoshidicts-update-profile-settings") {
          return { ok: true, state: resetState };
        }
      },
    });
    try {
      await page.ready;
      await nextTick();
      (
        page.dom.window.document.getElementById(
          "resetDictionarySettings",
        ) as HTMLButtonElement
      ).click();
      await nextTick();

      const reset = page.invocations.find(
        (entry) => entry.channel === "hoshidicts-update-profile-settings",
      );
      expect(reset?.payload).toMatchObject({
        dictionaryBackend: "yomitan",
        hoshiDictionaryOrder: [],
        hoshiDictionaryEnabled: {},
        hoshiScanLength: 16,
        hoshiMaxResults: 16,
        hoshiRecursiveLookupEnabled: true,
        hoshiLowRamImport: true,
      });
      expect(
        page.invocations.some(
          (entry) => entry.channel === "hoshidicts-remove",
        ),
      ).toBe(false);
      expect(
        page.dom.window.document.querySelectorAll(
          "#hoshiDictionaryList .hoshi-dictionary-row",
        ),
      ).toHaveLength(2);
    } finally {
      page.dom.window.close();
    }
  });

  it("keeps controls keyboard-addressable and indexes Hoshi labels in search", async () => {
    const page = loadSettingsPage({ state: installedDictionaryState() });
    try {
      await page.ready;
      await nextTick();

      const hoshi = page.dom.window.document.getElementById(
        "dictionaryBackendHoshiDicts",
      ) as HTMLInputElement;
      expect(hoshi.closest("label")).not.toBeNull();
      expect(hoshi.tabIndex).toBe(0);
      const actionButtons = Array.from(
        page.dom.window.document.querySelectorAll(
          "#hoshiDictionaryList .hoshi-icon-button",
        ),
      ) as HTMLButtonElement[];
      expect(actionButtons.length).toBeGreaterThan(0);
      expect(
        actionButtons.every(
          (button) =>
            button.type === "button" &&
            Boolean(button.getAttribute("aria-label")),
        ),
      ).toBe(true);

      const search = page.dom.window.document.getElementById(
        "settingsSearchInput",
      ) as HTMLInputElement;
      search.value = "hoshidicts";
      search.dispatchEvent(
        new page.dom.window.Event("input", { bubbles: true }),
      );
      expect(
        page.dom.window.document.body.classList.contains("search-active"),
      ).toBe(true);
      expect(
        page.dom.window.document.getElementById("settingsSearchCount")
          ?.textContent,
      ).toMatch(/[1-9][0-9]* match/);
      expect(
        (
          page.dom.window.document.getElementById(
            "dictionarySettingsGroup",
          ) as HTMLElement
        ).style.display,
      ).toBe("block");
      expect(page.dom.window.document.body.textContent).toContain(
        "Mine Selected Dictionary Entry",
      );
    } finally {
      page.dom.window.close();
    }
  });
});
