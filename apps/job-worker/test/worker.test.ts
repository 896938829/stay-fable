import { describe, expect, it, vi } from "vitest";
import type { LoggerOptions } from "pino";

import { createSystemWorker } from "../src/worker.js";

describe("createSystemWorker", () => {
  it("creates a namespaced system worker with persistent Redis settings", async () => {
    const connection = {
      status: "wait",
      quit: vi.fn(() => Promise.resolve("OK")),
    };
    const listeners = new Map<string, (...arguments_: unknown[]) => void>();
    const worker = {
      close: vi.fn(() => Promise.resolve()),
      on: vi.fn((event: string, listener: (...arguments_: unknown[]) => void) => {
        listeners.set(event, listener);
        return worker;
      }),
    };
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
    };
    const createConnection = vi.fn(() => connection);
    let processJob: ((job: { id?: string; name: string }) => Promise<void>) | undefined;
    const createWorker = vi.fn(
      (_queueName: string, processor: (job: { id?: string; name: string }) => Promise<void>) => {
        processJob = processor;
        return worker;
      },
    );
    const createLogger = vi.fn((options: LoggerOptions) => {
      void options;
      return logger;
    });

    const resources = createSystemWorker(
      {
        NODE_ENV: "test",
        REDIS_URL: "redis://127.0.0.1:6379",
      },
      { createConnection, createLogger, createWorker },
    );

    expect(resources).toEqual({ connection, worker });
    expect(createConnection).toHaveBeenCalledWith(
      "redis://127.0.0.1:6379",
      expect.objectContaining({
        connectTimeout: 5_000,
        maxRetriesPerRequest: null,
      }),
    );
    expect(createLogger).toHaveBeenCalledWith({
      level: "info",
      redact: ["password", "token", "idCardNumber"],
    });
    expect(createWorker).toHaveBeenCalledWith(
      "system",
      expect.any(Function),
      expect.objectContaining({
        concurrency: 2,
        connection,
        prefix: "stay-fable:test",
      }),
    );

    await processJob?.({ id: "job-1", name: "refresh-listing" });

    expect(logger.info).toHaveBeenCalledWith(
      { jobId: "job-1", jobName: "refresh-listing" },
      "system job processed",
    );

    const error = new Error("failed");
    listeners.get("failed")?.({ id: "job-2", name: "sync-booking" }, error);
    expect(logger.error).toHaveBeenCalledWith({ jobId: "job-2", error }, "system job failed");
  });

  it("uses the configured log level", () => {
    const createLogger = vi.fn((options: LoggerOptions) => {
      void options;
      return { error: vi.fn(), info: vi.fn() };
    });
    const worker = {
      close: vi.fn(() => Promise.resolve()),
      on: vi.fn(() => worker),
    };

    createSystemWorker(
      {
        LOG_LEVEL: "debug",
        NODE_ENV: "development",
        REDIS_URL: "redis://127.0.0.1:6379",
      },
      {
        createConnection: vi.fn(() => ({
          status: "wait",
          quit: vi.fn(() => Promise.resolve("OK")),
        })),
        createLogger,
        createWorker: vi.fn(() => worker),
      },
    );

    expect(createLogger).toHaveBeenCalledWith(expect.objectContaining({ level: "debug" }));
  });
});
