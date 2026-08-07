import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageBroker } from "../../../electron-src/main/runtime/message_bus";

const require = createRequire(import.meta.url);
const {
  createHoshidictsReaderPreferencesDelivery,
  createHoshidictsReaderPreferencesBridge,
  requestHoshidictsSettingsOpen,
  resolveDesktopBusConfig,
  SETTINGS_CLIENT_SEGMENT,
} = require("./desktop_bridge.js") as {
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
  }) => { destroy: () => void };
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
});
