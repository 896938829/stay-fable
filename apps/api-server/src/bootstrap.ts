import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module.js";
import { configureApplication } from "./application-configuration.js";

export const bootstrap = async (): Promise<INestApplication> => {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  app.flushLogs();
  configureApplication(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");

  return app;
};
