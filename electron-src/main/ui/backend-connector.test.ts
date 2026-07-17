import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const requireModule = createRequire(import.meta.url);
const BackendConnector = requireModule("../../../GSM_Overlay/backend_connector.js");

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
  }
}

describe("BackendConnector reliable delivery", () => {
  it("resends an unconfirmed config write after reconnect and stops after its confirmation", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const WebSocketFactory = class extends FakeWebSocket {
      constructor() {
        super();
        sockets.push(this);
      }
    };
    Object.assign(WebSocketFactory, { OPEN: FakeWebSocket.OPEN, CONNECTING: FakeWebSocket.CONNECTING });

    const connector = new BackendConnector(null, () => null, { WebSocket: WebSocketFactory });
    connector.connect("ws://localhost/ws/overlay");
    sockets[0].readyState = FakeWebSocket.OPEN;
    sockets[0].emit("open");

    connector.sendReliable(
      {
        type: "set-gsm-overlay-config",
        request_id: "ocr-setting-1",
        key: "periodic",
        value: true,
      },
      { id: "ocr-setting-1", coalesceKey: "gsm-overlay:periodic" }
    );
    expect(sockets[0].sent).toHaveLength(1);

    sockets[0].emit("close");
    vi.advanceTimersByTime(5000);
    sockets[1].readyState = FakeWebSocket.OPEN;
    sockets[1].emit("open");
    expect(sockets[1].sent).toHaveLength(1);

    sockets[1].emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "gsm-overlay-config-updated",
          request_id: "ocr-setting-1",
          settings: { periodic: true },
        })
      )
    );
    sockets[1].emit("close");
    vi.advanceTimersByTime(5000);
    sockets[2].readyState = FakeWebSocket.OPEN;
    sockets[2].emit("open");
    expect(sockets[2].sent).toHaveLength(0);

    vi.useRealTimers();
  });

  it("forwards backend config echoes to the main-process message handler", () => {
    const sockets: FakeWebSocket[] = [];
    const WebSocketFactory = class extends FakeWebSocket {
      constructor() {
        super();
        sockets.push(this);
      }
    };
    Object.assign(WebSocketFactory, { OPEN: FakeWebSocket.OPEN, CONNECTING: FakeWebSocket.CONNECTING });
    const received: unknown[] = [];
    const connector = new BackendConnector(null, () => null, {
      WebSocket: WebSocketFactory,
      onMessage: (message: unknown) => received.push(message),
    });

    connector.connect("ws://localhost/ws/overlay");
    sockets[0].emit(
      "message",
      Buffer.from(JSON.stringify({ type: "gsm-overlay-config-updated", settings: { periodic: true } }))
    );

    expect(received).toEqual([
      { type: "gsm-overlay-config-updated", settings: { periodic: true } },
    ]);
  });
});
