import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  app.flushLogs();
  app.use(helmet());
  app.enableShutdownHooks();
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );

  if (process.env.NODE_ENV !== "production") {
    const openApiConfig = new DocumentBuilder()
      .setTitle("Stay Fable API")
      .setVersion("0.0.0")
      .build();
    const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
    SwaggerModule.setup("internal/openapi", app, openApiDocument);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
