import { type INestApplication, RequestMethod, ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";

export const configureApplication = (
  app: INestApplication,
  nodeEnvironment = process.env.NODE_ENV,
): void => {
  app.use(helmet());
  app.enableShutdownHooks();
  app.setGlobalPrefix("api/v1", {
    exclude: [
      { path: "health/live", method: RequestMethod.GET },
      { path: "health/ready", method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );

  if (nodeEnvironment !== "production") {
    const openApiConfig = new DocumentBuilder()
      .setTitle("Stay Fable API")
      .setVersion("0.0.0")
      .build();
    const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
    SwaggerModule.setup("internal/openapi", app, openApiDocument);
  }
};
