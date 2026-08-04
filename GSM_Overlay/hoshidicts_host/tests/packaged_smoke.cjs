"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  HoshiDictsClient,
} = require(path.resolve(__dirname, "../../hoshidicts_client.js"));

async function main() {
  const sourceExecutable = process.argv[2];
  const fixtureZip = process.argv[3];
  if (!sourceExecutable || !fixtureZip) {
    throw new Error("usage: packaged_smoke.cjs HOST FIXTURE_ZIP");
  }

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "GSM Hoshi \u65e5\u672c\u8a9e path with spaces-"),
  );
  const executableName =
    process.platform === "win32"
      ? "gsm_hoshidicts_host.exe"
      : "gsm_hoshidicts_host";
  const executablePath = path.join(temporaryRoot, executableName);
  const jobDirectory = path.join(temporaryRoot, "import \u8f9e\u66f8 job");
  const sourceZip = path.join(jobDirectory, "source.zip");
  const outputPath = path.join(jobDirectory, "index");
  let client = null;

  try {
    fs.copyFileSync(path.resolve(sourceExecutable), executablePath);
    if (process.platform !== "win32") {
      fs.chmodSync(executablePath, 0o755);
    }
    fs.mkdirSync(jobDirectory, { recursive: true });
    fs.copyFileSync(path.resolve(fixtureZip), sourceZip);

    client = new HoshiDictsClient({
      executablePath,
      clientVersion: "packaged-artifact-smoke",
    });
    const hello = await client.start();
    assert.ok(hello.capabilities.includes("import"));
    assert.ok(hello.capabilities.includes("probe"));

    const imported = await client.request("dictionary.import", {
      jobId: "packaged-artifact-smoke",
      zipPath: sourceZip,
      outputPath,
      lowRam: true,
    });
    assert.equal(imported.title, "GSM Hoshi Fixture");
    assert.equal(path.resolve(imported.outputPath), path.resolve(outputPath));

    const probe = await client.request("dictionary.probe", {
      path: outputPath,
      types: imported.types,
      probeTerm: imported.probeTerm,
      probeKanji: imported.probeKanji,
    });
    assert.deepEqual(probe, {
      loaded: true,
      termProbeMatched: true,
      kanjiProbeMatched: true,
    });

    const configured = await client.request("catalog.configure", {
      generation: 1,
      dictionaries: [
        {
          id: "packaged-fixture",
          title: imported.title,
          path: outputPath,
          types: imported.types,
          priority: 0,
        },
      ],
    });
    assert.equal(configured.loaded, 1);

    const lookup = await client.request("lookup.term", {
      catalogGeneration: 1,
      requestGeneration: 1,
      text: "\u98df\u3079\u307e\u3057\u305f",
      scanLength: 16,
      maxResults: 16,
    });
    assert.ok(lookup.results.length > 0);
    assert.equal(lookup.results[0].term.expression, "\u98df\u3079\u308b");
  } finally {
    await client?.shutdown().catch(() => client?.forceKill());
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  console.log("[hoshidicts-packaged-smoke] import and lookup passed");
}

main().catch((error) => {
  console.error(
    `[hoshidicts-packaged-smoke] ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
