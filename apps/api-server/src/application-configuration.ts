import { type INestApplication, Logger, RequestMethod, ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";

import { ApiEnvelopeInterceptor } from "./common/http/api-envelope.interceptor.js";
import { ApiExceptionFilter } from "./common/http/api-exception.filter.js";
import { requestContext } from "./common/http/request-context.js";

export const configureApplication = (
  app: INestApplication,
  nodeEnvironment = process.env.NODE_ENV,
): void => {
  app.use(requestContext);
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
  app.useGlobalInterceptors(new ApiEnvelopeInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter(new Logger(ApiExceptionFilter.name)));

  if (nodeEnvironment !== "production") {
    const openApiConfig = new DocumentBuilder()
      .setTitle("Stay Fable API")
      .setVersion("0.0.0")
      .build();
    const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
    SwaggerModule.setup("internal/openapi", app, openApiDocument);
  }
};
