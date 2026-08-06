import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import { MessageBroker } from "../../../electron-src/main/runtime/message_bus";

const require = createRequire(import.meta.url);
const {
  requestHoshidictsSettingsOpen,
  resolveDesktopBusConfig,
  SETTINGS_CLIENT_SEGMENT,
} = require("./desktop_bridge.js") as {
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

afterEach(async () => {
  await Promise.all(brokers.splice(0).map(async (broker) => broker.stop()));
});

describe("Hoshidicts desktop bridge", () => {
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
});
