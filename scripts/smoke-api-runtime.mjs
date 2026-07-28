import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";

const rootUrl = new URL("../", import.meta.url);

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function fetchWhenAvailable(url, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await globalThis.fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
  }
  throw new Error(`API did not become available within ${timeoutMilliseconds}ms`, {
    cause: lastError,
  });
}

function waitForExit(child, timeoutMilliseconds) {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new Error("API did not stop after SIGTERM")),
      timeoutMilliseconds,
    );
    child.once("exit", (code, signal) => {
      globalThis.clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const port = await reservePort();
const child = spawn(process.execPath, ["scripts/api-runtime-child.mjs"], {
  cwd: new URL(".", rootUrl),
  env: {
    ...process.env,
    DATABASE_URL:
      "postgresql://phase0_probe:local_placeholder@127.0.0.1:1/stay_fable?uselibpqcompat=true&sslmode=require",
    NODE_ENV: "production",
    PORT: String(port),
    REDIS_URL: "rediss://127.0.0.1:1",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  windowsHide: true,
});

let standardError = "";
child.stderr.on("data", (chunk) => {
  standardError += chunk.toString("utf8");
});

try {
  const liveBefore = await fetchWhenAvailable(`http://127.0.0.1:${port}/health/live`, 10_000);
  assert.equal(liveBefore.status, 200);
  assert.deepEqual(await liveBefore.json(), { status: "ok", service: "api-server" });

  const ready = await globalThis.fetch(`http://127.0.0.1:${port}/health/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    status: "unavailable",
    service: "api-server",
    checks: { database: "down", redis: "down" },
  });

  const liveAfter = await globalThis.fetch(`http://127.0.0.1:${port}/health/live`);
  assert.equal(liveAfter.status, 200);
  assert.deepEqual(await liveAfter.json(), { status: "ok", service: "api-server" });

  const exit = waitForExit(child, 5_000);
  if (process.platform === "win32") {
    child.send({ type: "SIGTERM" });
  } else {
    child.kill("SIGTERM");
  }
  const result = await exit;
  assert.ok(
    result.code === 0 || result.signal === "SIGTERM",
    `API shutdown was not clean: ${JSON.stringify(result)}`,
  );

  console.log("Built API smoke verified: live=200, ready=503/down, live-after=200, SIGTERM=clean.");
} catch (error) {
  if (standardError.length > 0) {
    console.error(standardError);
  }
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
}
