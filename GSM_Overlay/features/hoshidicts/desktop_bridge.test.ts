import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageBroker } from "../../../electron-src/main/runtime/message_bus";

const require = createRequire(import.meta.url);
const {
  ADD_CUSTOM_ENTRY_TOPIC,
  createHoshidictsReaderPreferencesDelivery,
  createHoshidictsReaderPreferencesBridge,
  requestHoshidictsSettingsOpen,
  resolveDesktopBusConfig,
  SETTINGS_CLIENT_SEGMENT,
} = require("./desktop_bridge.js") as {
  ADD_CUSTOM_ENTRY_TOPIC: string;
  createHoshidictsReaderPreferencesDelivery: (
    deliver: (preferences: unknown) => void
  ) => {
    enqueue: (preferences: unknown) => boolean;
    markReady: () => boolean;
    markNotReady: () => void;
    clear: () => void;
  };
  createHoshidictsReaderPreferencesBridge: (options: {
    env: Record<string, string>;
    onPreferences: (preferences: unknown) => Promise<void>;
  }) => {
    destroy: () => void;
    requestAddCustomEntry: (
      entry: { term: string; reading: string; definition: string }
    ) => Promise<unknown>;
  };
  requestHoshidictsSettingsOpen: (options: {
    env: Record<string, string>;
    timeoutMs?: number;
  }) => Promise<unknown>;
  resolveDesktopBusConfig: (
    env: Record<string, string>
  ) => { port: number; token: string; clientId: string } | null;
  SETTINGS_CLIENT_SEGMENT: string;
};

const brokers: MessageBroker[] = [];
const bridges: Array<{ destroy: () => void }> = [];

afterEach(async () => {
  bridges.splice(0).forEach((bridge) => bridge.destroy());
  await Promise.all(brokers.splice(0).map(async (broker) => broker.stop()));
});

describe("Hoshidicts desktop bridge", () => {
  it("holds the latest reader preferences until the renderer is ready", () => {
    const delivered: unknown[] = [];
    const delivery = createHoshidictsReaderPreferencesDelivery((preferences) => {
      delivered.push(preferences);
    });

    expect(delivery.enqueue({ lookupMode: "shift", popupHideDelayMs: 300 }))
      .toBe(false);
    expect(delivery.enqueue({ lookupMode: "hover", popupHideDelayMs: 800 }))
      .toBe(false);
    expect(delivered).toEqual([]);

    expect(delivery.markReady()).toBe(true);
    expect(delivered).toEqual([
      { lookupMode: "hover", popupHideDelayMs: 800 },
    ]);
    expect(delivery.enqueue({ lookupMode: "shift", popupHideDelayMs: 500 }))
      .toBe(true);
    expect(delivered.at(-1)).toEqual({
      lookupMode: "shift",
      popupHideDelayMs: 500,
    });

    delivery.markNotReady();
    delivery.enqueue({ lookupMode: "hover", popupHideDelayMs: 900 });
    delivery.clear();
    expect(delivery.markReady()).toBe(false);
    expect(delivered).toHaveLength(2);
  });

  it("rejects missing or malformed authenticated bus settings", () => {
    expect(resolveDesktopBusConfig({})).toBeNull();
    expect(
      resolveDesktopBusConfig({
        GSM_BROKER_PORT: "99999",
        GSM_BROKER_TOKEN: "token",
        GSM_CLIENT_ID: "overlay",
      })
    ).toBeNull();
  });

  it("opens settings through unique authenticated requests to desktop main", async () => {
    const broker = new MessageBroker();
    brokers.push(broker);
    const connectInfo = await broker.start();
    const sources: string[] = [];
    broker.handle("hoshidicts.openSettings", (message) => {
      sources.push(message.src);
      return { opened: true };
    });

    const env = {
      GSM_BROKER_PORT: String(connectInfo.port),
      GSM_BROKER_TOKEN: connectInfo.token,
      GSM_CLIENT_ID: "overlay",
    };
    await expect(
      Promise.all([
        requestHoshidictsSettingsOpen({ env }),
        requestHoshidictsSettingsOpen({ env }),
      ])
    ).resolves.toEqual([{ opened: true }, { opened: true }]);
    expect(sources).toHaveLength(2);
    expect(new Set(sources).size).toBe(2);
    expect(
      sources.every((source) =>
        source.startsWith(`overlay${SETTINGS_CLIENT_SEGMENT}`)
      )
    ).toBe(true);
  });

  it("fails closed with an invalid token", async () => {
    const broker = new MessageBroker();
    brokers.push(broker);
    const connectInfo = await broker.start();

    await expect(
      requestHoshidictsSettingsOpen({
        env: {
          GSM_BROKER_PORT: String(connectInfo.port),
          GSM_BROKER_TOKEN: "wrong-token",
          GSM_CLIENT_ID: "overlay",
        },
        timeoutMs: 500,
      })
    ).rejects.toThrow();
  });

  it("applies reader preferences over a persistent authenticated client", async () => {
    const broker = new MessageBroker();
    brokers.push(broker);
    const connectInfo = await broker.start();
    const applied: unknown[] = [];
    bridges.push(
      createHoshidictsReaderPreferencesBridge({
        env: {
          GSM_BROKER_PORT: String(connectInfo.port),
          GSM_BROKER_TOKEN: connectInfo.token,
          GSM_CLIENT_ID: "overlay",
        },
        async onPreferences(preferences) {
          applied.push(preferences);
        },
      })
    );

    await vi.waitFor(() => {
      expect(broker.isClientConnected("overlay.hoshidicts-reader")).toBe(true);
    });
    await expect(
      broker.request(
        "overlay.hoshidicts-reader",
        "hoshidicts.readerPreferences",
        { lookupMode: "hover", popupHideDelayMs: 800 }
      )
    ).resolves.toEqual({ applied: true });
    expect(applied).toEqual([
      { lookupMode: "hover", popupHideDelayMs: 800 },
    ]);
  });

  it("adds custom entries through correlated requests from the exact reader client", async () => {
    const broker = new MessageBroker();
    brokers.push(broker);
    const connectInfo = await broker.start();
    const received: Array<{ src: string; data: unknown }> = [];
    broker.handle(ADD_CUSTOM_ENTRY_TOPIC, (message) => {
      received.push({ src: message.src, data: message.data });
      return { saved: true };
    });
    const bridge = createHoshidictsReaderPreferencesBridge({
      env: {
        GSM_BROKER_PORT: String(connectInfo.port),
        GSM_BROKER_TOKEN: connectInfo.token,
        GSM_CLIENT_ID: "overlay",
      },
      async onPreferences() {},
    });
    bridges.push(bridge);

    await vi.waitFor(() => {
      expect(broker.isClientConnected("overlay.hoshidicts-reader")).toBe(true);
    });
    const entry = {
      term: "螺旋丸",
      reading: "らせんがん",
      definition: "Rotating chakra sphere attack",
    };
    await expect(bridge.requestAddCustomEntry(entry)).resolves.toEqual({
      saved: true,
    });
    expect(received).toEqual([
      {
        src: "overlay.hoshidicts-reader",
        data: entry,
      },
    ]);
  });

  it("propagates desktop errors for custom-entry requests", async () => {
    const broker = new MessageBroker();
    brokers.push(broker);
    const connectInfo = await broker.start();
    broker.handle(ADD_CUSTOM_ENTRY_TOPIC, () => {
      throw new Error("Custom dictionary save was rejected.");
    });
    const bridge = createHoshidictsReaderPreferencesBridge({
      env: {
        GSM_BROKER_PORT: String(connectInfo.port),
        GSM_BROKER_TOKEN: connectInfo.token,
        GSM_CLIENT_ID: "overlay",
      },
      async onPreferences() {},
    });
    bridges.push(bridge);

    await vi.waitFor(() => {
      expect(broker.isClientConnected("overlay.hoshidicts-reader")).toBe(true);
    });
    await expect(bridge.requestAddCustomEntry({
      term: "error",
      reading: "えらー",
      definition: "failure",
    })).rejects.toThrow("Custom dictionary save was rejected.");
  });

  it("keeps a queued custom-entry save pending until desktop responds", async () => {
    const broker = new MessageBroker();
    brokers.push(broker);
    const connectInfo = await broker.start();
    let respond!: (value: { saved: true }) => void;
    let requestReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });
    broker.handle(ADD_CUSTOM_ENTRY_TOPIC, () => {
      requestReceived();
      return new Promise<{ saved: true }>((resolve) => {
        respond = resolve;
      });
    });
    const bridge = createHoshidictsReaderPreferencesBridge({
      env: {
        GSM_BROKER_PORT: String(connectInfo.port),
        GSM_BROKER_TOKEN: connectInfo.token,
        GSM_CLIENT_ID: "overlay",
      },
      async onPreferences() {},
    });
    bridges.push(bridge);

    await vi.waitFor(() => {
      expect(broker.isClientConnected("overlay.hoshidicts-reader")).toBe(true);
    });
    vi.useFakeTimers();
    try {
      const save = bridge.requestAddCustomEntry({
        term: "保留",
        reading: "ほりゅう",
        definition: "pending",
      });
      let settled = false;
      void save.then(
        () => { settled = true; },
        () => { settled = true; }
      );
      await received;
      await vi.advanceTimersByTimeAsync(31 * 60 * 1_000 + 1);
      expect(settled).toBe(false);

      respond({ saved: true });
      await expect(save).resolves.toEqual({ saved: true });

      const interruptedSave = bridge.requestAddCustomEntry({
        term: "中断",
        reading: "ちゅうだん",
        definition: "interrupted",
      });
      bridge.destroy();
      await expect(interruptedSave).rejects.toThrow(
        "Hoshidicts desktop bridge is closed."
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
