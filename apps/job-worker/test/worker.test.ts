import pino, { type LoggerOptions } from "pino";
import { describe, expect, it, vi } from "vitest";

import { createDatabasePool } from "../src/database.js";
import { createSystemWorker, createWorkerLoggerOptions } from "../src/worker.js";

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

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
    const pool = {
      connect: vi.fn(),
      end: vi.fn(() => Promise.resolve()),
    };
    const sweeper = {
      start: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    };
    const createPool = vi.fn(() => pool);
    const createSweeper = vi.fn(() => sweeper);
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

    const resources = await createSystemWorker(
      {
        NODE_ENV: "test",
        REDIS_URL: "redis://127.0.0.1:6379",
        DATABASE_URL: "postgresql://worker:secret@127.0.0.1:5432/stay_fable",
      },
      { createConnection, createLogger, createPool, createSweeper, createWorker },
    );

    expect(resources).toEqual({ connection, pool, sweeper, worker });
    expect(createPool).toHaveBeenCalledWith("postgresql://worker:secret@127.0.0.1:5432/stay_fable");
    expect(createSweeper).toHaveBeenCalledWith(pool, 5_000, logger);
    expect(sweeper.start).toHaveBeenCalledOnce();
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
      serializers: {
        error: pino.stdSerializers.err,
      },
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

    const operationalError = new Error("redis disconnected");
    listeners.get("error")?.(operationalError);
    expect(logger.error).toHaveBeenCalledWith({ error: operationalError }, "system worker error");
  });

  it("serializes errors with their message and stack", () => {
    const serializeError = createWorkerLoggerOptions({}).serializers?.error;
    const serializedError: unknown = serializeError?.(new Error("serialized failure"));

    expect(serializedError).toMatchObject({
      message: "serialized failure",
    });
    expect(typeof (serializedError as { stack?: unknown }).stack).toBe("string");
  });

  it("uses the configured log level", async () => {
    const createLogger = vi.fn((options: LoggerOptions) => {
      void options;
      return { error: vi.fn(), info: vi.fn() };
    });
    const worker = {
      close: vi.fn(() => Promise.resolve()),
      on: vi.fn(() => worker),
    };

    await createSystemWorker(
      {
        LOG_LEVEL: "debug",
        NODE_ENV: "development",
        REDIS_URL: "redis://127.0.0.1:6379",
        DATABASE_URL: "postgresql://localhost/stay_fable",
      },
      {
        createConnection: vi.fn(() => ({
          status: "wait",
          quit: vi.fn(() => Promise.resolve("OK")),
        })),
        createLogger,
        createPool: vi.fn(() => ({
          connect: vi.fn(),
          end: vi.fn(() => Promise.resolve()),
        })),
        createSweeper: vi.fn(() => ({
          start: vi.fn(),
          stop: vi.fn(() => Promise.resolve()),
        })),
        createWorker: vi.fn(() => worker),
      },
    );

    expect(createLogger).toHaveBeenCalledWith(expect.objectContaining({ level: "debug" }));
  });

  it("does not invoke a hostile LOG_LEVEL accessor", async () => {
    const logLevelGetter = vi.fn(() => {
      throw new Error("log-level-secret");
    });
    const environment = Object.defineProperty(
      {
        NODE_ENV: "test",
        REDIS_URL: "redis://127.0.0.1:6379",
        DATABASE_URL: "postgresql://localhost/stay_fable",
      },
      "LOG_LEVEL",
      { enumerable: true, get: logLevelGetter },
    );
    const worker = {
      close: vi.fn(() => Promise.resolve()),
      on: vi.fn(() => worker),
    };

    await createSystemWorker(environment, {
      createConnection: vi.fn(() => ({
        status: "ready",
        quit: vi.fn(() => Promise.resolve("OK")),
      })),
      createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn() })),
      createPool: vi.fn(() => ({
        connect: vi.fn(),
        end: vi.fn(() => Promise.resolve()),
      })),
      createSweeper: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(() => Promise.resolve()),
      })),
      createWorker: vi.fn(() => worker),
    });

    expect(logLevelGetter).not.toHaveBeenCalled();
  });

  it("creates the default pool with only the configured connection string", () => {
    const pool = {
      connect: vi.fn(),
      end: vi.fn(() => Promise.resolve()),
    };
    const factory = vi.fn(() => pool);

    expect(createDatabasePool("postgresql://worker:secret@database/stay_fable", factory)).toBe(
      pool,
    );
    expect(factory).toHaveBeenCalledWith({
      connectionString: "postgresql://worker:secret@database/stay_fable",
    });
  });

  it.each(["connection", "worker", "sweeper", "start", "listeners"] as const)(
    "cleans every previously-created resource when %s initialization fails",
    async (failurePoint) => {
      const calls: string[] = [];
      const pool = {
        connect: vi.fn(),
        end: vi.fn(() => {
          calls.push("pool");
          return Promise.resolve();
        }),
      };
      const connection = {
        status: "ready",
        quit: vi.fn(() => {
          calls.push("connection");
          return Promise.resolve("OK");
        }),
      };
      const worker = {
        close: vi.fn(() => {
          calls.push("worker");
          return Promise.resolve();
        }),
        on: vi.fn(() => {
          if (failurePoint === "listeners") {
            throw new Error("listener-secret");
          }
          return worker;
        }),
      };
      const sweeper = {
        start: vi.fn(() => {
          if (failurePoint === "start") {
            throw new Error("start-secret");
          }
        }),
        stop: vi.fn(() => Promise.resolve()),
      };

      await expect(
        createSystemWorker(
          {
            NODE_ENV: "test",
            REDIS_URL: "redis://127.0.0.1:6379",
            DATABASE_URL: "postgresql://worker:secret@127.0.0.1/stay_fable",
          },
          {
            logger: { error: vi.fn(), info: vi.fn() },
            createPool: vi.fn(() => pool),
            createConnection: vi.fn(() => {
              if (failurePoint === "connection") {
                throw new Error("connection-secret");
              }
              return connection;
            }),
            createWorker: vi.fn(() => {
              if (failurePoint === "worker") {
                throw new Error("worker-secret");
              }
              return worker;
            }),
            createSweeper: vi.fn(() => {
              if (failurePoint === "sweeper") {
                throw new Error("sweeper-secret");
              }
              return sweeper;
            }),
          },
        ),
      ).rejects.toThrow("Job worker resource initialization failed");

      expect(pool.end).toHaveBeenCalledOnce();
      expect(connection.quit).toHaveBeenCalledTimes(failurePoint === "connection" ? 0 : 1);
      expect(worker.close).toHaveBeenCalledTimes(
        failurePoint === "sweeper" || failurePoint === "start" || failurePoint === "listeners"
          ? 1
          : 0,
      );
      expect(calls.at(-1)).toBe("pool");
      expect(calls.join(",")).not.toContain("secret");
    },
  );

  it("awaits failed initialization cleanup in strict order and continues after cleanup errors", async () => {
    const stopGate = createDeferred<void>();
    const closeGate = createDeferred<void>();
    const quitGate = createDeferred<string>();
    const endGate = createDeferred<void>();
    const calls: string[] = [];
    const logger = { error: vi.fn(), info: vi.fn() };
    const pool = {
      connect: vi.fn(),
      end: vi.fn(() => {
        calls.push("pool");
        return endGate.promise;
      }),
    };
    const connection = {
      status: "ready",
      quit: vi.fn(() => {
        calls.push("connection");
        return quitGate.promise;
      }),
    };
    const worker = {
      close: vi.fn(() => {
        calls.push("worker");
        return closeGate.promise;
      }),
      on: vi.fn(() => worker),
    };
    const sweeper = {
      start: vi.fn(() => {
        throw new Error("initialization-secret");
      }),
      stop: vi.fn(() => {
        calls.push("sweeper");
        return stopGate.promise;
      }),
    };

    const initialization = Promise.resolve().then(() =>
      createSystemWorker(
        {
          NODE_ENV: "test",
          REDIS_URL: "redis://127.0.0.1:6379",
          DATABASE_URL: "postgresql://dbuser:database-secret@127.0.0.1/stay_fable",
        },
        {
          logger,
          createPool: vi.fn(() => pool),
          createConnection: vi.fn(() => connection),
          createWorker: vi.fn(() => worker),
          createSweeper: vi.fn(() => sweeper),
        },
      ),
    );
    const outcome = initialization.then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.waitFor(() => {
      expect(sweeper.stop).toHaveBeenCalledOnce();
    });
    expect(worker.close).not.toHaveBeenCalled();

    stopGate.reject(new Error("cleanup-secret"));
    await vi.waitFor(() => {
      expect(worker.close).toHaveBeenCalledOnce();
    });
    expect(connection.quit).not.toHaveBeenCalled();

    closeGate.resolve(undefined);
    await vi.waitFor(() => {
      expect(connection.quit).toHaveBeenCalledOnce();
    });
    expect(pool.end).not.toHaveBeenCalled();

    quitGate.resolve("OK");
    await vi.waitFor(() => {
      expect(pool.end).toHaveBeenCalledOnce();
    });
    endGate.resolve(undefined);

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Job worker resource initialization failed");
    expect(calls).toEqual(["sweeper", "worker", "connection", "pool"]);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret");
  });
});
