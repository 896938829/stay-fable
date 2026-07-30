import type { DatabasePool } from "./database.js";
import type {
  BookingExpirySweeperResource,
  QueueWorkerResource,
  RedisResource,
  WorkerLogger,
} from "./worker.js";

interface ShutdownResources {
  connection: RedisResource;
  pool: Pick<DatabasePool, "end">;
  sweeper: Pick<BookingExpirySweeperResource, "stop">;
  worker: Pick<QueueWorkerResource, "close">;
}

const closeResources = async (resources: ShutdownResources): Promise<void> => {
  const errors: Error[] = [];
  const close = async (operation: () => Promise<unknown>, message: string): Promise<void> => {
    try {
      await operation();
    } catch {
      errors.push(new Error(message));
    }
  };

  await close(() => resources.sweeper.stop(), "Booking expiry sweeper shutdown failed");
  await close(() => resources.worker.close(), "Queue worker shutdown failed");
  await close(() => resources.connection.quit(), "Redis shutdown failed");
  await close(() => resources.pool.end(), "Database pool shutdown failed");

  if (errors.length === 1) {
    const [error] = errors;
    if (error !== undefined) {
      throw error;
    }
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Job worker resource shutdown failed");
  }
};

export const createGracefulShutdown = (resources: ShutdownResources): (() => Promise<void>) => {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= closeResources(resources);
    return shutdownPromise;
  };
};

interface ShutdownRuntime {
  exitCode: string | number | null | undefined;
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export const registerShutdownHandlers = (
  resources: ShutdownResources,
  logger: Pick<WorkerLogger, "error">,
  runtime: ShutdownRuntime = process,
): void => {
  const shutdown = createGracefulShutdown(resources);
  let handledShutdown: Promise<void> | undefined;
  const handleShutdown = (): void => {
    handledShutdown ??= shutdown().catch((error: unknown) => {
      logger.error(
        { error: error instanceof Error ? error : new Error("Job worker shutdown failed") },
        "job worker shutdown failed",
      );
      runtime.exitCode = 1;
    });
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    runtime.once(signal, () => {
      handleShutdown();
    });
  }
};
