import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

function parseRespArray(buffer) {
  const readLine = (offset) => {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    return {
      value: buffer.subarray(offset, lineEnd).toString("utf8"),
      nextOffset: lineEnd + 2,
    };
  };

  const header = readLine(0);
  if (header === null) return null;
  if (!/^\*[1-8]$/.test(header.value)) {
    throw new Error("Redis probe received an invalid RESP array");
  }

  const argumentCount = Number(header.value.slice(1));
  const arguments_ = [];
  let offset = header.nextOffset;
  for (let index = 0; index < argumentCount; index += 1) {
    const bulkHeader = readLine(offset);
    if (bulkHeader === null) return null;
    if (!/^\$(?:0|[1-9]\d{0,3})$/.test(bulkHeader.value)) {
      throw new Error("Redis probe received an invalid RESP bulk string");
    }
    const length = Number(bulkHeader.value.slice(1));
    const valueEnd = bulkHeader.nextOffset + length;
    if (buffer.length < valueEnd + 2) return null;
    if (buffer[valueEnd] !== 13 || buffer[valueEnd + 1] !== 10) {
      throw new Error("Redis probe received an invalid RESP terminator");
    }
    arguments_.push(buffer.subarray(bulkHeader.nextOffset, valueEnd).toString("utf8"));
    offset = valueEnd + 2;
  }

  return { arguments_, bytesConsumed: offset };
}

function createRespCommandBuffer(onCommand) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > 8_192) {
      throw new Error("Redis probe request exceeded its bounded buffer");
    }
    while (buffered.length > 0) {
      const frame = parseRespArray(buffered);
      if (frame === null) return;
      buffered = buffered.subarray(frame.bytesConsumed);
      onCommand(frame.arguments_);
    }
  };
}

export async function startRedisBootstrapProbe() {
  const sockets = new Set();
  let connectionCount = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    connectionCount += 1;
    if (connectionCount > 1) {
      socket.destroy();
      return;
    }

    const acceptCommands = createRespCommandBuffer((arguments_) => {
      const command = arguments_[0]?.toUpperCase();
      if (
        command === "CLIENT" &&
        arguments_.length === 4 &&
        arguments_[1]?.toUpperCase() === "SETINFO"
      ) {
        socket.write("+OK\r\n");
      } else if (command === "INFO" && arguments_.length === 1) {
        socket.write("+OK\r\n");
      } else if (command === "PING" && arguments_.length === 1) {
        socket.write("+PONG\r\n");
      } else if (command === "QUIT" && arguments_.length === 1) {
        socket.end("+OK\r\n");
      } else {
        socket.end(`-ERR unsupported command ${command ?? "UNKNOWN"}\r\n`);
      }
    });
    socket.on("data", (chunk) => {
      try {
        acceptCommands(chunk);
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    url: `redis://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) => {
        const timeout = globalThis.setTimeout(
          () => reject(new Error("Redis probe did not close")),
          2_000,
        );
        server.close((error) => {
          globalThis.clearTimeout(timeout);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
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
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
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

export async function runSmoke() {
  const cleanupErrors = [];
  let child;
  let primaryError;
  let redisProbe;
  let standardError = "";

  try {
    const port = await reservePort();
    redisProbe = await startRedisBootstrapProbe();
    child = spawn(process.execPath, ["scripts/api-runtime-child.mjs"], {
      cwd: new URL(".", rootUrl),
      env: {
        ...process.env,
        DATABASE_URL:
          "postgresql://phase0_probe:local_placeholder@127.0.0.1:1/stay_fable?uselibpqcompat=true&sslmode=require",
        ENABLE_MOCK_PAYMENT: "false",
        IDENTITY_PROVIDER: "mock",
        NODE_ENV: "test",
        PORT: String(port),
        REDIS_URL: redisProbe.url,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    child.on("error", () => {});
    child.stderr.on("data", (chunk) => {
      standardError += chunk.toString("utf8");
    });

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

    console.log(
      "Built API smoke verified: live=200, ready=503/down, live-after=200, SIGTERM=clean.",
    );
  } catch (error) {
    primaryError = error;
    if (standardError.length > 0) {
      console.error(standardError);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = waitForExit(child, 5_000);
      child.kill();
      await exit.catch((error) => cleanupErrors.push(error));
    }
    if (redisProbe) {
      await redisProbe.close().catch((error) => cleanupErrors.push(error));
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "API smoke and cleanup failed");
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "API smoke cleanup failed");
  }
}

const isCommandLine =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isCommandLine) {
  runSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
