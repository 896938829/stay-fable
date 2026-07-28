import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export const isUnwrappedPath = (path: string): boolean =>
  path === "/health/live" ||
  path === "/health/ready" ||
  path === "/internal/openapi" ||
  path.startsWith("/internal/openapi/");

export interface RequestWithId extends Request {
  requestId: string;
}

export const requestContext = (request: Request, response: Response, next: NextFunction): void => {
  const incomingRequestId = request.header("x-request-id");
  const requestId =
    incomingRequestId !== undefined && REQUEST_ID_PATTERN.test(incomingRequestId)
      ? incomingRequestId
      : `req_${randomUUID().replaceAll("-", "")}`;

  (request as RequestWithId).requestId = requestId;
  response.setHeader("x-request-id", requestId);
  next();
};
