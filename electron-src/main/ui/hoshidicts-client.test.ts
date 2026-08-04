import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireModule = createRequire(import.meta.url);
const {
  HoshiDictsCancelledError,
  HoshiDictsClient,
  HoshiDictsHostError,
  HoshiDictsProtocolError,
  HoshiDictsTimeoutError,
  EXPECTED_HOSHIDICTS_COMMIT,
  resolveHoshiDictsExecutable,
} = requireModule("../../../GSM_Overlay/hoshidicts_client.js");

const SOURCE_COMMIT = "14ff793b1d5cdfdfba24518bbdedc064d17d699d";

type HostRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  writes: HostRequest[] = [];
  killed = false;
  exitCode: number | null = null;
  private input = "";

  constructor(
    private readonly handleRequest: (request: HostRequest, child: FakeChild) => void,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.input += chunk.toString();
        let newline = this.input.indexOf("\n");
        while (newline >= 0) {
          const line = this.input.slice(0, newline);
          this.input = this.input.slice(newline + 1);
          if (line) {
            const request = JSON.parse(line) as HostRequest;
            this.writes.push(request);
            this.handleRequest(request, this);
          }
          newline = this.input.indexOf("\n");
        }
        callback();
      },
    });
  }

  respond(request: HostRequest, result: unknown, chunks = 1) {
    const line = `${JSON.stringify({ id: request.id, ok: true, result })}\n`;
    if (chunks <= 1) {
      this.stdout.write(line);
      return;
    }
    const split = Math.ceil(line.length / chunks);
    for (let offset = 0; offset < line.length; offset += split) {
      this.stdout.write(line.slice(offset, offset + split));
    }
  }

  fail(request: HostRequest, code: string, message: string) {
    this.stdout.write(
      `${JSON.stringify({
        id: request.id,
        ok: false,
        error: { code, message },
      })}\n`,
    );
  }

  kill() {
    if (this.killed) {
      return true;
    }
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }

  crash(code = 17) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function helloResult(overrides: Record<string, unknown> = {}) {
  return {
    protocol: { major: 1, minor: 0 },
    hostVersion: "0.1.0",
    hoshidictsCommit: SOURCE_COMMIT,
    capabilities: ["term", "frequency", "pitch", "kanji", "styles", "media", "cancel"],
    ...overrides,
  };
}

function createHarness(
  handler: (request: HostRequest, child: FakeChild) => void = (request, child) => {
    if (request.method === "hello") {
      child.respond(request, helloResult(), 3);
    }
  },
  options: Record<string, unknown> = {},
) {
  const child = new FakeChild(handler);
  const spawn = vi.fn(() => child);
  const client = new HoshiDictsClient({
    executablePath: "/test/hoshidicts-host",
    spawn,
    clientVersion: "test",
    ...options,
  });
  return { child, client, spawn };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("HoshiDictsClient", () => {
  it("derives the required source commit from verified provenance", () => {
    expect(EXPECTED_HOSHIDICTS_COMMIT).toBe(SOURCE_COMMIT);
  });

  it("spawns without a shell, negotiates the protocol, and handles chunked replies", async () => {
    const { child, client, spawn } = createHarness((request, fake) => {
      if (request.method === "hello") {
        fake.respond(request, helloResult(), 4);
      } else if (request.method === "health") {
        fake.respond(request, { status: "ok", catalogGeneration: 0 }, 2);
      }
    });

    await expect(client.start()).resolves.toMatchObject({
      protocol: { major: 1, minor: 0 },
      hoshidictsCommit: SOURCE_COMMIT,
    });
    await expect(client.request("health")).resolves.toEqual({
      status: "ok",
      catalogGeneration: 0,
    });

    expect(spawn).toHaveBeenCalledWith(
      "/test/hoshidicts-host",
      [],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(child.writes.map((request) => request.id)).toEqual(["1", "2"]);
    client.forceKill();
  });

  it("surfaces stable host errors", async () => {
    const { client } = createHarness((request, child) => {
      if (request.method === "hello") {
        child.respond(request, helloResult());
      } else {
        child.fail(request, "STALE_CATALOG", "catalog generation does not match");
      }
    });
    await client.start();

    await expect(
      client.request("lookup.term", {
        catalogGeneration: 1,
        requestGeneration: 2,
        text: "猫",
      }),
    ).rejects.toMatchObject<HoshiDictsHostError>({
      name: "HoshiDictsHostError",
      code: "STALE_CATALOG",
    });
    client.forceKill();
  });

  it("cancels pending requests and ignores both late responses", async () => {
    let lookupRequest: HostRequest | null = null;
    const { child, client } = createHarness((request, fake) => {
      if (request.method === "hello") {
        fake.respond(request, helloResult());
      } else if (request.method === "lookup.term") {
        lookupRequest = request;
      } else if (request.method === "cancel") {
        fake.respond(request, { requestId: request.params.requestId, accepted: true });
      }
    });
    await client.start();

    const pending = client.request("lookup.term", { text: "猫" }) as Promise<unknown> & {
      requestId: string;
    };
    expect(client.cancel(pending.requestId)).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(HoshiDictsCancelledError);

    expect(lookupRequest).not.toBeNull();
    child.respond(lookupRequest!, { results: [] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.killed).toBe(false);
    client.forceKill();
  });

  it("times out requests and sends a cancellation command", async () => {
    const { child, client } = createHarness();
    await client.start();

    await expect(
      client.request("lookup.term", { text: "猫" }, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(HoshiDictsTimeoutError);
    expect(child.writes.some((request) => request.method === "cancel")).toBe(true);
    client.forceKill();
  });

  it("rejects every pending request when the host crashes", async () => {
    const { child, client } = createHarness();
    await client.start();

    const first = client.request("lookup.term", { text: "猫" });
    const second = client.request("styles.list", { catalogGeneration: 1 });
    child.crash();

    await expect(first).rejects.toMatchObject({ code: "HOST_EXITED" });
    await expect(second).rejects.toMatchObject({ code: "HOST_EXITED" });
  });

  it("kills a host that emits malformed or oversized protocol data", async () => {
    const malformed = createHarness();
    await malformed.client.start();
    const malformedRequest = malformed.client.request("health");
    malformed.child.stdout.write("not-json\n");
    await expect(malformedRequest).rejects.toBeInstanceOf(HoshiDictsProtocolError);
    expect(malformed.child.killed).toBe(true);

    const oversized = createHarness(undefined, {
      maxResponseLineBytes: 512,
      maxMediaResponseLineBytes: 1024,
    });
    await oversized.client.start();
    const oversizedRequest = oversized.client.request("health");
    oversized.child.stdout.write("x".repeat(1025));
    await expect(oversizedRequest).rejects.toBeInstanceOf(HoshiDictsProtocolError);
    expect(oversized.child.killed).toBe(true);
  });

  it("accepts bounded host events and captures bounded stderr", async () => {
    const { child, client } = createHarness(undefined, { maxStderrBytes: 8 });
    const events: unknown[] = [];
    client.on("host-event", (event: unknown) => events.push(event));
    await client.start();

    child.stdout.write('{"event":"import.progress","completed":1,"total":2}\n');
    child.stderr.write("1234567890");
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toEqual([
      { event: "import.progress", completed: 1, total: 2 },
    ]);
    expect(client.getStderr()).toBe("34567890");
    client.forceKill();
  });

  it("rejects an incompatible handshake", async () => {
    const { child, client } = createHarness((request, fake) => {
      fake.respond(request, helloResult({ protocol: { major: 2, minor: 0 } }));
    });

    await expect(client.start()).rejects.toBeInstanceOf(HoshiDictsProtocolError);
    expect(child.killed).toBe(true);
  });

  it("rejects a host built from an unexpected HoshiDicts source commit", async () => {
    const { child, client } = createHarness((request, fake) => {
      fake.respond(request, helloResult({ hoshidictsCommit: "unexpected" }));
    });

    await expect(client.start()).rejects.toThrowError(/unexpected HoshiDicts source commit/);
    expect(child.killed).toBe(true);
  });

  it("ignores delayed events from a replaced child process", async () => {
    const first = new FakeChild((request, child) => {
      child.respond(request, helloResult({ protocol: { major: 2, minor: 0 } }));
    });
    first.kill = () => {
      first.killed = true;
      return true;
    };
    const second = new FakeChild((request, child) => {
      if (request.method === "hello") {
        child.respond(request, helloResult());
      } else if (request.method === "health") {
        child.respond(request, { status: "ok" });
      }
    });
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new HoshiDictsClient({
      executablePath: "/test/hoshidicts-host",
      spawn,
      clientVersion: "test",
    });

    await expect(client.start()).rejects.toBeInstanceOf(HoshiDictsProtocolError);
    await expect(client.start()).resolves.toMatchObject({
      hoshidictsCommit: SOURCE_COMMIT,
    });

    first.stdout.write("not-json\n");
    first.emit("exit", 17, null);
    await expect(client.request("health")).resolves.toEqual({ status: "ok" });
    expect(second.killed).toBe(false);
    client.forceKill();
  });

  it("shuts down gracefully before using the force-kill fallback", async () => {
    const { child, client } = createHarness((request, fake) => {
      if (request.method === "hello") {
        fake.respond(request, helloResult());
      } else if (request.method === "shutdown") {
        fake.respond(request, { accepted: true });
        queueMicrotask(() => fake.crash(0));
      }
    });
    await client.start();

    await client.shutdown();

    expect(child.writes.at(-1)?.method).toBe("shutdown");
    expect(child.killed).toBe(false);
  });
});

describe("resolveHoshiDictsExecutable", () => {
  it("uses an explicit executable after validating it", () => {
    const statSync = vi.fn(() => ({
      isFile: () => true,
      mode: 0o755,
    }));

    expect(
      resolveHoshiDictsExecutable({
        platform: "linux",
        env: { GSM_HOSHIDICTS_HOST_PATH: "./custom-host" },
        statSync,
      }),
    ).toBe(path.resolve("./custom-host"));
  });

  it("rejects a missing explicit executable", () => {
    expect(() =>
      resolveHoshiDictsExecutable({
        platform: "linux",
        env: { GSM_HOSHIDICTS_HOST_PATH: "./missing-host" },
        statSync: () => {
          throw new Error("missing");
        },
      }),
    ).toThrowError(/does not point to an executable file/);
  });
});

const realHostCandidates = [
  process.env.GSM_HOSHIDICTS_HOST_PATH,
  path.resolve("build/hoshidicts-goal2/hoshidicts-host"),
  path.resolve("build/hoshidicts-provenance/hoshidicts-host"),
].filter((candidate): candidate is string => Boolean(candidate));
const realHostPath = realHostCandidates.find((candidate) => fs.existsSync(candidate));

it.skipIf(!realHostPath)("spawns and shuts down the real native host", async () => {
  const client = new HoshiDictsClient({
    executablePath: realHostPath,
    clientVersion: "vitest",
  });

  await expect(client.start()).resolves.toMatchObject({
    hoshidictsCommit: SOURCE_COMMIT,
  });
  await expect(client.request("health")).resolves.toMatchObject({
    status: "ok",
    catalogGeneration: 0,
  });
  await client.shutdown();
});
