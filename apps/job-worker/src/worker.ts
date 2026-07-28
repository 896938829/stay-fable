import { type Job, Worker, type WorkerOptions } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import pino, { type LoggerOptions } from "pino";

import { parseWorkerConfig } from "./config.js";

export interface RedisResource {
  readonly status: string;
  quit(): Promise<unknown>;
}

export interface QueueWorkerResource {
  close(): Promise<void>;
  on(event: "failed", listener: (job: Job | undefined, error: Error) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
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
  createWorker(
    queueName: string,
    processor: (job: Job) => Promise<void>,
    options: SystemWorkerOptions,
  ): QueueWorkerResource;
}

interface WorkerOverrides extends Partial<WorkerDependencies> {
  logger?: WorkerLogger;
}

export const createWorkerLoggerOptions = (environment: Record<string, unknown>): LoggerOptions => ({
  level: typeof environment.LOG_LEVEL === "string" ? environment.LOG_LEVEL : "info",
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
  createWorker: (queueName, processor, options) =>
    new Worker(queueName, processor, {
      ...options,
      connection: options.connection as Redis,
    } satisfies WorkerOptions),
};

export interface SystemWorkerResources {
  connection: RedisResource;
  worker: QueueWorkerResource;
}

export const createSystemWorker = (
  environment: Record<string, unknown> = process.env,
  overrides: WorkerOverrides = {},
): SystemWorkerResources => {
  const config = parseWorkerConfig(environment);
  const logger =
    overrides.logger ??
    (overrides.createLogger ?? defaultDependencies.createLogger)(
      createWorkerLoggerOptions(environment),
    );
  const connection = (overrides.createConnection ?? defaultDependencies.createConnection)(
    config.redisUrl,
    {
      connectTimeout: 5_000,
      maxRetriesPerRequest: null,
    },
  );
  const worker = (overrides.createWorker ?? defaultDependencies.createWorker)(
    "system",
    (job) => {
      logger.info({ jobId: job.id, jobName: job.name }, "system job processed");
      return Promise.resolve();
    },
    {
      concurrency: 2,
      connection,
      prefix: config.queuePrefix,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "system job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "system worker error");
  });

  return { connection, worker };
};
