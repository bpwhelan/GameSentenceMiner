import { EventEmitter } from "node:events";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const controllerModulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/dictionary_popup_controller.js",
);
const managerModulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/dictionary_backend_manager.js",
);

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

class FakeBackend extends EventEmitter {
  id: string;
  capabilities = new Set([
    "lookup",
    "dismiss",
    "scroll",
    "select-action",
    "confirm-action",
    "next-entry",
    "previous-entry",
  ]);
  lookupCalls: Array<Record<string, unknown>> = [];
  commandCalls: Array<{ command: string; params: Record<string, unknown> }> = [];
  startCalls: Array<Record<string, unknown>> = [];
  stopCalls: Array<Record<string, unknown>> = [];
  configureCalls: Array<Record<string, unknown>> = [];
  lookupImpl: (request: Record<string, unknown>) => Promise<unknown>;
  startImpl: (context: Record<string, unknown>) => Promise<void>;

  constructor(id: string) {
    super();
    this.id = id;
    this.lookupImpl = async () => ({ status: "results", entries: [] });
    this.startImpl = async () => {};
  }

  async start(context: Record<string, unknown>) {
    this.startCalls.push(context);
    await this.startImpl(context);
  }

  async stop(context: Record<string, unknown>) {
    this.stopCalls.push(context);
  }

  async configure(context: Record<string, unknown>) {
    this.configureCalls.push(context);
  }

  async lookup(request: Record<string, unknown>) {
    this.lookupCalls.push(request);
    return await this.lookupImpl(request);
  }

  async command(command: string, params: Record<string, unknown>) {
    this.commandCalls.push({ command, params });
    return { status: "handled" };
  }
}

describe("DictionaryPopupController", () => {
  it("reference-counts nested popups and ignores stale close events", async () => {
    const { DictionaryPopupController } = await import(controllerModulePath);
    const backend = new FakeBackend("yomitan");
    const events: Array<Record<string, unknown>> = [];
    const controller = new DictionaryPopupController({
      publishPopupEvent: (event: Record<string, unknown>) => events.push(event),
    });

    controller.attachBackend(backend);
    const generation = controller.generation;
    backend.emit("popup-opened", { popupId: "parent", generation });
    backend.emit("popup-opened", { popupId: "parent", generation });
    backend.emit("popup-opened", { popupId: "child", generation });

    expect(controller.getSnapshot()).toMatchObject({
      backendId: "yomitan",
      active: true,
      popupCount: 2,
      popupIds: ["parent", "child"],
    });

    backend.emit("popup-closed", { popupId: "child", generation });
    expect(controller.getSnapshot()).toMatchObject({
      active: true,
      popupCount: 1,
      popupIds: ["parent"],
    });

    controller.invalidate("new-anchor");
    backend.emit("popup-closed", { popupId: "parent", generation });
    expect(controller.getSnapshot()).toMatchObject({
      active: false,
      popupCount: 0,
    });
    expect(events.at(-1)).toMatchObject({
      active: false,
      reason: "new-anchor",
    });
  });

  it("returns stale for an older lookup that finishes after a newer result", async () => {
    const { DictionaryPopupController } = await import(controllerModulePath);
    const backend = new FakeBackend("hoshidicts");
    const firstDeferred = deferred<unknown>();
    const secondDeferred = deferred<unknown>();
    let call = 0;
    backend.lookupImpl = async () =>
      await (call++ === 0 ? firstDeferred.promise : secondDeferred.promise);
    const controller = new DictionaryPopupController();
    controller.attachBackend(backend);

    const first = controller.lookup({
      text: "古い",
      anchor: { x: 10, y: 20 },
      anchorKey: "0:0",
    });
    const second = controller.lookup({
      text: "新しい",
      anchor: { x: 30, y: 40 },
      anchorKey: "0:1",
    });

    secondDeferred.resolve({ status: "results", entries: [{ id: "new" }] });
    await expect(second).resolves.toMatchObject({
      status: "applied",
      result: { status: "results" },
    });

    firstDeferred.resolve({ status: "results", entries: [{ id: "old" }] });
    await expect(first).resolves.toMatchObject({ status: "stale" });
    expect(controller.getSnapshot()).toMatchObject({
      anchorKey: "0:1",
      lifecycle: "results",
    });
  });

  it("invalidates lookup and popup state when dismissed", async () => {
    const { DictionaryPopupController } = await import(controllerModulePath);
    const backend = new FakeBackend("hoshidicts");
    const lookup = deferred<unknown>();
    backend.lookupImpl = async () => await lookup.promise;
    const controller = new DictionaryPopupController();
    controller.attachBackend(backend);

    const pending = controller.lookup({
      text: "猫",
      anchor: { x: 1, y: 2 },
      anchorKey: "cat",
    });
    const oldGeneration = controller.generation;
    backend.emit("popup-opened", {
      popupId: "hoshi-popup",
      generation: oldGeneration,
    });

    await controller.dismiss("cancel");
    expect(controller.generation).toBeGreaterThan(oldGeneration);
    expect(controller.getSnapshot()).toMatchObject({
      active: false,
      lifecycle: "idle",
    });
    expect(backend.commandCalls.at(-1)).toMatchObject({
      command: "dismiss",
    });

    backend.emit("popup-opened", {
      popupId: "late-popup",
      generation: oldGeneration,
    });
    lookup.resolve({ status: "results" });
    await expect(pending).resolves.toMatchObject({ status: "stale" });
    expect(controller.getSnapshot().active).toBe(false);
  });
});

describe("DictionaryBackendManager", () => {
  it("switches scanners transactionally and publishes ready state", async () => {
    const { DictionaryPopupController } = await import(controllerModulePath);
    const { DictionaryBackendManager } = await import(managerModulePath);
    const controller = new DictionaryPopupController();
    const yomitan = new FakeBackend("yomitan");
    const hoshi = new FakeBackend("hoshidicts");
    const statuses: Array<Record<string, unknown>> = [];
    const manager = new DictionaryBackendManager({
      controller,
      backends: [yomitan, hoshi],
    });
    manager.on("status", (status: Record<string, unknown>) => statuses.push(status));

    await manager.start("yomitan", { profileId: "default" });
    await manager.switchBackend("hoshidicts", { profileId: "default" });

    expect(yomitan.stopCalls).toHaveLength(1);
    expect(hoshi.startCalls).toHaveLength(1);
    expect(manager.getSnapshot()).toMatchObject({
      backendId: "hoshidicts",
      state: "ready",
      blocked: false,
    });
    expect(statuses.some((status) => status.state === "switching")).toBe(true);
    expect(statuses.at(-1)).toMatchObject({
      state: "ready",
      backendId: "hoshidicts",
    });
  });

  it("rolls back to the prior backend when startup fails", async () => {
    const { DictionaryPopupController } = await import(controllerModulePath);
    const { DictionaryBackendManager } = await import(managerModulePath);
    const controller = new DictionaryPopupController();
    const yomitan = new FakeBackend("yomitan");
    const hoshi = new FakeBackend("hoshidicts");
    hoshi.startImpl = async () => {
      throw Object.assign(new Error("missing host"), { code: "HOST_NOT_FOUND" });
    };
    const manager = new DictionaryBackendManager({
      controller,
      backends: [yomitan, hoshi],
    });

    await manager.start("yomitan");
    await expect(manager.switchBackend("hoshidicts")).rejects.toMatchObject({
      code: "HOST_NOT_FOUND",
    });

    expect(yomitan.startCalls).toHaveLength(2);
    expect(manager.getSnapshot()).toMatchObject({
      backendId: "yomitan",
      state: "ready",
      blocked: false,
      lastErrorCode: "HOST_NOT_FOUND",
    });
  });

  it("invalidates in-flight work on profile and catalog changes", async () => {
    const { DictionaryPopupController } = await import(controllerModulePath);
    const { DictionaryBackendManager } = await import(managerModulePath);
    const controller = new DictionaryPopupController();
    const hoshi = new FakeBackend("hoshidicts");
    const manager = new DictionaryBackendManager({
      controller,
      backends: [hoshi],
    });
    await manager.start("hoshidicts");
    const generation = controller.generation;

    await manager.updateProfile({ profileId: "game-a" });
    expect(controller.generation).toBeGreaterThan(generation);
    const profileGeneration = controller.generation;
    await manager.updateCatalog({ revision: 4 });
    expect(controller.generation).toBeGreaterThan(profileGeneration);
    expect(hoshi.configureCalls).toEqual([
      expect.objectContaining({ reason: "profile-change", profileId: "game-a" }),
      expect.objectContaining({ reason: "catalog-change", revision: 4 }),
    ]);
  });

  it("rejects lookup intents while a transition is blocked", async () => {
    const { DictionaryPopupController } = await import(controllerModulePath);
    const { DictionaryBackendManager } = await import(managerModulePath);
    const controller = new DictionaryPopupController();
    const yomitan = new FakeBackend("yomitan");
    const start = deferred<void>();
    const hoshi = new FakeBackend("hoshidicts");
    hoshi.startImpl = async () => await start.promise;
    const manager = new DictionaryBackendManager({
      controller,
      backends: [yomitan, hoshi],
    });
    await manager.start("yomitan");

    const switching = manager.switchBackend("hoshidicts");
    await vi.waitFor(() => {
      expect(manager.getSnapshot().blocked).toBe(true);
    });
    await expect(
      manager.lookup({ text: "猫", anchor: { x: 1, y: 1 } }),
    ).rejects.toMatchObject({ code: "LOOKUP_BLOCKED" });

    start.resolve();
    await switching;
  });
});
