import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  type LoggerService,
} from "@nestjs/common";
import type { Response } from "express";

import { BusinessException } from "./business.exception.js";
import { isUnwrappedPath, type RequestWithId } from "./request-context.js";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  request_id: string;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService = new Logger(ApiExceptionFilter.name)) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<Response>();

    if (!(exception instanceof HttpException)) {
      const error =
        exception instanceof Error
          ? {
              name: exception.name,
              message: exception.message,
              stack: exception.stack,
            }
          : {
              name: "UnknownException",
              message: String(exception),
              stack: undefined,
            };

      this.logger.error({
        request_id: request.requestId,
        error,
      });
    }

    if (isUnwrappedPath(request.path)) {
      if (exception instanceof HttpException) {
        response.status(exception.getStatus()).json(exception.getResponse());
        return;
      }

      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: "Internal server error",
      });
      return;
    }

    if (exception instanceof BusinessException) {
      const body: ErrorBody = {
        error: {
          code: exception.code,
          message: exception.message,
        },
        request_id: request.requestId,
      };

      if (exception.details !== undefined) {
        body.error.details = exception.details;
      }

      response.status(exception.getStatus()).json(body);
      return;
    }

    if (
      exception instanceof HttpException &&
      exception.getStatus() === 400 &&
      request.method === "POST" &&
      (request.path === "/api/v1/quotes" || request.path === "/api/v1/bookings")
    ) {
      const bookingRequest = request.path === "/api/v1/bookings";
      response.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: bookingRequest ? "BOOKING_REQUEST_INVALID" : "QUOTE_REQUEST_INVALID",
          message: bookingRequest ? "下单请求无效" : "报价请求无效，请检查入住信息",
        },
        request_id: request.requestId,
      } satisfies ErrorBody);
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        error: {
          code: HttpStatus[exception.getStatus()] ?? "HTTP_ERROR",
          message: "请求处理失败",
        },
        request_id: request.requestId,
      } satisfies ErrorBody);
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "服务暂时不可用",
      },
      request_id: request.requestId,
    } satisfies ErrorBody);
  }
}
