import { createGracefulShutdown } from "./shutdown.js";
import { createSystemWorker } from "./worker.js";

const resources = createSystemWorker();
const shutdown = createGracefulShutdown(resources);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch((error: unknown) => {
      console.error("Job worker shutdown failed", error);
      process.exitCode = 1;
    });
  });
}
