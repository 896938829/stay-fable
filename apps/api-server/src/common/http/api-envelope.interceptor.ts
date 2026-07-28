import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";

import type { RequestWithId } from "./request-context.js";

const isUnwrappedPath = (path: string): boolean =>
  path === "/health/live" ||
  path === "/health/ready" ||
  path === "/internal/openapi" ||
  path.startsWith("/internal/openapi/");

@Injectable()
export class ApiEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithId>();

    if (isUnwrappedPath(request.path)) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data: unknown) => ({
        data,
        request_id: request.requestId,
      })),
    );
  }
}
