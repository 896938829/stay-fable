import { describe, expect, it, vi } from "vitest";

import { createGracefulShutdown, registerShutdownHandlers } from "../src/shutdown.js";

describe("createGracefulShutdown", () => {
  it("closes the worker before quitting Redis and coalesces repeated signals", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      sweeper: {
        stop: vi.fn(() => {
          calls.push("sweeper");
          return Promise.resolve();
        }),
      },
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
      pool: {
        end: vi.fn(() => {
          calls.push("pool");
          return Promise.resolve();
        }),
      },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(calls).toEqual(["sweeper", "worker", "connection", "pool"]);
  });

  it("invokes every shutdown step exactly once even when Redis is already ended", async () => {
    const quit = vi.fn(() => Promise.resolve("OK"));
    const shutdown = createGracefulShutdown({
      connection: { status: "end", quit },
      worker: { close: vi.fn(() => Promise.resolve()) },
      pool: { end: vi.fn(() => Promise.resolve()) },
      sweeper: { stop: vi.fn(() => Promise.resolve()) },
    });

    await shutdown();

    expect(quit).toHaveBeenCalledOnce();
  });

  it.each(["sweeper", "worker", "connection", "pool"] as const)(
    "continues through every resource after a %s shutdown failure",
    async (failurePoint) => {
      const calls: string[] = [];
      const operation = (name: string) =>
        vi.fn(() => {
          calls.push(name);
          return name === failurePoint
            ? Promise.reject(new Error(`${name}-secret`))
            : Promise.resolve();
        });
      const stop = operation("sweeper");
      const close = operation("worker");
      const quit = operation("connection");
      const end = operation("pool");
      const shutdown = createGracefulShutdown({
        sweeper: { stop },
        connection: { status: "ready", quit },
        worker: { close },
        pool: { end },
      });

      let thrown: unknown;
      try {
        await shutdown();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain("secret");
      expect(calls).toEqual(["sweeper", "worker", "connection", "pool"]);
      expect(stop).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(quit).toHaveBeenCalledOnce();
      expect(end).toHaveBeenCalledOnce();
    },
  );

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
    const stop = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.reject(shutdownError));
    const quit = vi.fn(() => Promise.resolve("OK"));
    const end = vi.fn(() => Promise.resolve());

    registerShutdownHandlers(
      {
        sweeper: { stop },
        connection: {
          status: "end",
          quit,
        },
        worker: { close },
        pool: { end },
      },
      logger,
      runtime,
    );
    listeners.get("SIGTERM")?.();
    listeners.get("SIGINT")?.();
    await vi.waitFor(() => {
      expect(runtime.exitCode).toBe(1);
    });

    expect(logger.error).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[1]).toBe("job worker shutdown failed");
    const bindings: unknown = logger.error.mock.calls[0]?.[0];
    if (typeof bindings !== "object" || bindings === null || !("error" in bindings)) {
      throw new Error("Shutdown log bindings did not contain an error");
    }
    expect(bindings.error).toBeInstanceOf(Error);
    expect((bindings.error as Error).message).not.toContain("secret");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
