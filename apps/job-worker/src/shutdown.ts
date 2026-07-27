import type { QueueWorkerResource, RedisResource } from "./worker.js";

interface ShutdownResources {
  connection: RedisResource;
  worker: Pick<QueueWorkerResource, "close">;
}

const asError = (error: unknown, message: string): Error =>
  error instanceof Error ? error : new Error(message, { cause: error });

const closeResources = async (resources: ShutdownResources): Promise<void> => {
  let workerError: unknown;

  try {
    await resources.worker.close();
  } catch (error) {
    workerError = error;
  }

  let connectionError: unknown;
  if (resources.connection.status !== "end") {
    try {
      await resources.connection.quit();
    } catch (error) {
      connectionError = error;
    }
  }

  if (workerError !== undefined && connectionError !== undefined) {
    throw new AggregateError(
      [
        asError(workerError, "Worker shutdown failed"),
        asError(connectionError, "Redis shutdown failed"),
      ],
      "Worker and Redis shutdown failed",
    );
  }

  if (workerError !== undefined) {
    throw asError(workerError, "Worker shutdown failed");
  }

  if (connectionError !== undefined) {
    throw asError(connectionError, "Redis shutdown failed");
  }
};

export const createGracefulShutdown = (resources: ShutdownResources): (() => Promise<void>) => {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= closeResources(resources);
    return shutdownPromise;
  };
};
