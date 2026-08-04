"use strict";

const path = require("node:path");

const {
  HoshiDictsClient,
} = require(path.resolve(__dirname, "../../hoshidicts_client.js"));

const EXPECTED_COMMIT = "14ff793b1d5cdfdfba24518bbdedc064d17d699d";

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

async function main() {
  const executablePath = process.argv[2];
  if (!executablePath) {
    throw new Error("native host path is required");
  }

  const handshakeSamples = [];
  for (let index = 0; index < 20; index += 1) {
    const client = new HoshiDictsClient({
      executablePath,
      clientVersion: "native-smoke",
    });
    const startedAt = performance.now();
    const hello = await client.start();
    handshakeSamples.push(performance.now() - startedAt);
    if (hello.hoshidictsCommit !== EXPECTED_COMMIT) {
      throw new Error("native host reported an unexpected HoshiDicts commit");
    }

    const health = await client.request("health");
    if (health.status !== "ok" || health.catalogGeneration !== 0) {
      throw new Error("native host health response is invalid");
    }
    await client.shutdown();
  }

  console.log(
    JSON.stringify({
      processHandshakeP50Ms: Number(percentile(handshakeSamples, 0.5).toFixed(3)),
      processHandshakeP95Ms: Number(percentile(handshakeSamples, 0.95).toFixed(3)),
    }),
  );
}

main().catch((error) => {
  console.error(
    `[hoshidicts-client-smoke] ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
