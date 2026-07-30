import { type Job, Worker, type WorkerOptions } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import pino, { type LoggerOptions } from "pino";

import { createBookingExpirySweeper } from "./booking-expiry.sweeper.js";
import { parseWorkerConfig } from "./config.js";
import { createDatabasePool, type DatabasePool } from "./database.js";

export interface RedisResource {
  readonly status: string;
  quit(): Promise<unknown>;
}

export interface QueueWorkerResource {
  close(): Promise<void>;
  on(event: "failed", listener: (job: Job | undefined, error: Error) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface BookingExpirySweeperResource {
  start(): void;
  stop(): Promise<void>;
}

export interface WorkerLogger {
  error(bindings: object, message: string): void;
  info(bindings: object, message: string): void;
}

interface SystemWorkerOptions {
  concurrency: number;
  connection: RedisResource;
  prefix: string;
}

interface WorkerDependencies {
  createConnection(url: string, options: RedisOptions): RedisResource;
  createLogger(options: LoggerOptions): WorkerLogger;
  createPool(databaseUrl: string): DatabasePool;
  createSweeper(
    pool: DatabasePool,
    pollMilliseconds: number,
    logger: WorkerLogger,
  ): BookingExpirySweeperResource;
  createWorker(
    queueName: string,
    processor: (job: Job) => Promise<void>,
    options: SystemWorkerOptions,
  ): QueueWorkerResource;
}

interface WorkerOverrides extends Partial<WorkerDependencies> {
  logger?: WorkerLogger;
}

const readLogLevel = (environment: Record<string, unknown>): string => {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(environment, "LOG_LEVEL");
    return descriptor !== undefined &&
      Object.hasOwn(descriptor, "value") &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : "info";
  } catch {
    return "info";
  }
};

export const createWorkerLoggerOptions = (environment: Record<string, unknown>): LoggerOptions => ({
  level: readLogLevel(environment),
  redact: ["password", "token", "idCardNumber"],
  serializers: {
    error: pino.stdSerializers.err,
  },
});

export const createWorkerLogger = (
  environment: Record<string, unknown> = process.env,
): WorkerLogger => pino(createWorkerLoggerOptions(environment));

const defaultDependencies: WorkerDependencies = {
  createConnection: (url, options) => new Redis(url, options),
  createLogger: (options) => pino(options),
  createPool: (databaseUrl) => createDatabasePool(databaseUrl),
  createSweeper: (pool, pollMilliseconds, logger) =>
    createBookingExpirySweeper(pool, pollMilliseconds, logger),
  createWorker: (queueName, processor, options) =>
    new Worker(queueName, processor, {
      ...options,
      connection: options.connection as Redis,
    } satisfies WorkerOptions),
};

export interface SystemWorkerResources {
  connection: RedisResource;
  pool: DatabasePool;
  sweeper: BookingExpirySweeperResource;
  worker: QueueWorkerResource;
}

const cleanupAfterInitializationFailure = async (
  resources: Partial<SystemWorkerResources>,
  logger: WorkerLogger,
): Promise<void> => {
  const cleanup = async (
    operation: (() => Promise<unknown>) | undefined,
    message: string,
  ): Promise<void> => {
    if (operation === undefined) {
      return;
    }
    try {
      await operation();
    } catch {
      logger.error({}, message);
    }
  };

  await cleanup(
    resources.sweeper === undefined ? undefined : () => resources.sweeper!.stop(),
    "sweeper cleanup failed",
  );
  await cleanup(
    resources.worker === undefined ? undefined : () => resources.worker!.close(),
    "worker cleanup failed",
  );
  await cleanup(
    resources.connection === undefined ? undefined : () => resources.connection!.quit(),
    "redis cleanup failed",
  );
  await cleanup(
    resources.pool === undefined ? undefined : () => resources.pool!.end(),
    "database cleanup failed",
  );
};

export const createSystemWorker = async (
  environment: Record<string, unknown> = process.env,
  overrides: WorkerOverrides = {},
): Promise<SystemWorkerResources> => {
  const config = parseWorkerConfig(environment);
  const logger =
    overrides.logger ??
    (overrides.createLogger ?? defaultDependencies.createLogger)(
      createWorkerLoggerOptions(environment),
    );
  const resources: Partial<SystemWorkerResources> = {};
  try {
    resources.pool = (overrides.createPool ?? defaultDependencies.createPool)(config.databaseUrl);
    resources.connection = (overrides.createConnection ?? defaultDependencies.createConnection)(
      config.redisUrl,
      {
        connectTimeout: 5_000,
        maxRetriesPerRequest: null,
      },
    );
    resources.worker = (overrides.createWorker ?? defaultDependencies.createWorker)(
      "system",
      (job) => {
        logger.info({ jobId: job.id, jobName: job.name }, "system job processed");
        return Promise.resolve();
      },
      {
        concurrency: 2,
        connection: resources.connection,
        prefix: config.queuePrefix,
      },
    );
    resources.sweeper = (overrides.createSweeper ?? defaultDependencies.createSweeper)(
      resources.pool,
      config.bookingExpiryPollMs,
      logger,
    );
    resources.sweeper.start();

    resources.worker.on("failed", (job, error) => {
      logger.error({ jobId: job?.id, error }, "system job failed");
    });
    resources.worker.on("error", (error) => {
      logger.error({ error }, "system worker error");
    });
  } catch {
    await cleanupAfterInitializationFailure(resources, logger);
    throw new Error("Job worker resource initialization failed");
  }

  return resources as SystemWorkerResources;
};
