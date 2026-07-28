import process from "node:process";

import { bootstrap } from "../apps/api-server/dist/bootstrap.js";

const app = await bootstrap();

// Windows cannot deliver POSIX SIGTERM to another process. The smoke parent
// requests the equivalent Nest close path over IPC. POSIX hosts send the
// operating-system signal directly and exercise the registered shutdown hook.
process.on("message", async (message) => {
  if (message?.type === "SIGTERM") {
    await app.close();
    process.disconnect();
  }
});
