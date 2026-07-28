import { registerShutdownHandlers } from "./shutdown.js";
import { createSystemWorker, createWorkerLogger } from "./worker.js";

const logger = createWorkerLogger();
const resources = createSystemWorker(process.env, { logger });

registerShutdownHandlers(resources, logger);
