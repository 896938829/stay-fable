import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { test } from "node:test";

import { startRedisBootstrapProbe } from "./smoke-api-runtime.mjs";

const waitForData = (socket, expected) =>
  new Promise((resolve, reject) => {
    let received = "";
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${JSON.stringify(expected)}`));
    }, 2_000);
    const onData = (chunk) => {
      received += chunk.toString("utf8");
      if (received.includes(expected)) {
        cleanup();
        resolve(received);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });

test("Redis bootstrap probe parses split and coalesced RESP commands", async () => {
  const probe = await startRedisBootstrapProbe();
  const address = new URL(probe.url);
  const socket = createConnection({
    host: address.hostname,
    port: Number(address.port),
  });
  socket.on("error", () => {});

  try {
    const pong = waitForData(socket, "+PONG\r\n");
    socket.write("*1\r");
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    socket.write("\n$4\r\nping\r\n");
    assert.match(await pong, /\+PONG\r\n/);

    const combined = waitForData(socket, "+OK\r\n+OK\r\n+PONG\r\n");
    socket.write(
      "*4\r\n$6\r\nclient\r\n$7\r\nsetinfo\r\n$8\r\nlib-name\r\n$7\r\nioredis\r\n" +
        "*1\r\n$4\r\ninfo\r\n" +
        "*1\r\n$4\r\nping\r\n",
    );
    assert.match(await combined, /\+OK\r\n\+OK\r\n\+PONG\r\n/);

    const quit = waitForData(socket, "+OK\r\n");
    socket.write("*1\r\n$4\r\nquit\r\n");
    assert.match(await quit, /\+OK\r\n/);
  } finally {
    socket.destroy();
    await probe.close();
  }
});
