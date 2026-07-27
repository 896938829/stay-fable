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
}

interface WorkerLogger {
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
  dependencies: WorkerDependencies = defaultDependencies,
): SystemWorkerResources => {
  const config = parseWorkerConfig(environment);
  const logger = dependencies.createLogger({
    level: typeof environment.LOG_LEVEL === "string" ? environment.LOG_LEVEL : "info",
    redact: {
      paths: ["password", "token", "idCardNumber"],
      censor: "[REDACTED]",
    },
  });
  const connection = dependencies.createConnection(config.redisUrl, {
    connectTimeout: 5_000,
    maxRetriesPerRequest: null,
  });
  const worker = dependencies.createWorker(
    "system",
    (job) => {
      logger.info({ jobId: job.id, jobName: job.name }, "Processing system job");
      return Promise.resolve();
    },
    {
      concurrency: 2,
      connection,
      prefix: config.queuePrefix,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error(
      {
        err: error,
        jobId: job?.id,
        jobName: job?.name,
      },
      "System job failed",
    );
  });

  return { connection, worker };
};
