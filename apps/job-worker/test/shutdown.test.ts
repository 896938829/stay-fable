import { describe, expect, it, vi } from "vitest";

import { createGracefulShutdown, registerShutdownHandlers } from "../src/shutdown.js";

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

  it("structured-logs signal shutdown failures and sets a nonzero exit status", async () => {
    const listeners = new Map<string, () => void>();
    const runtime = {
      exitCode: undefined as number | undefined,
      once: vi.fn((signal: string, listener: () => void) => {
        listeners.set(signal, listener);
        return runtime;
      }),
    };
    const logger = { error: vi.fn() };
    const shutdownError = new Error("shutdown failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    registerShutdownHandlers(
      {
        connection: {
          status: "end",
          quit: vi.fn(() => Promise.resolve("OK")),
        },
        worker: {
          close: vi.fn(() => Promise.reject(shutdownError)),
        },
      },
      logger,
      runtime,
    );
    listeners.get("SIGTERM")?.();
    await vi.waitFor(() => {
      expect(runtime.exitCode).toBe(1);
    });

    expect(logger.error).toHaveBeenCalledWith(
      { error: shutdownError },
      "job worker shutdown failed",
    );
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
