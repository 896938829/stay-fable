import { describe, expect, it, vi } from "vitest";

import { createGracefulShutdown } from "../src/shutdown.js";

describe("createGracefulShutdown", () => {
  it("closes the worker before quitting Redis and coalesces repeated signals", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      connection: {
        status: "ready",
        quit: vi.fn(() => {
          calls.push("connection");
          return Promise.resolve("OK");
        }),
      },
      worker: {
        close: vi.fn(() => {
          calls.push("worker");
          return Promise.resolve();
        }),
      },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(calls).toEqual(["worker", "connection"]);
  });

  it("does not quit an already-ended Redis connection", async () => {
    const quit = vi.fn(() => Promise.resolve("OK"));
    const shutdown = createGracefulShutdown({
      connection: { status: "end", quit },
      worker: { close: vi.fn(() => Promise.resolve()) },
    });

    await shutdown();

    expect(quit).not.toHaveBeenCalled();
  });

  it("still closes Redis when worker shutdown fails", async () => {
    const quit = vi.fn(() => Promise.resolve("OK"));
    const shutdown = createGracefulShutdown({
      connection: { status: "ready", quit },
      worker: {
        close: vi.fn(() => Promise.reject(new Error("worker close failed"))),
      },
    });

    await expect(shutdown()).rejects.toThrow("worker close failed");
    expect(quit).toHaveBeenCalledOnce();
  });
});
