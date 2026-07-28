import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
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
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<Response>();

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
