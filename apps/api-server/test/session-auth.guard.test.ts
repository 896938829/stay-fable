/* eslint-disable @typescript-eslint/unbound-method */
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { SessionService } from "../src/identity/session.service.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";

const contextFor = (authorization?: string) => {
  const request: { headers: { authorization?: string }; user?: unknown } = {
    headers: authorization === undefined ? {} : { authorization },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
};

describe("SessionAuthGuard", () => {
  it("accepts strict Bearer syntax and attaches the current user", async () => {
    const sessions = {
      resolveAccess: vi.fn(() => Promise.resolve({ userId: "user-id" })),
    } as unknown as SessionService;
    const guard = new SessionAuthGuard(sessions);
    const { context, request } = contextFor("Bearer opaque-token");

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(sessions.resolveAccess).toHaveBeenCalledWith("opaque-token");
    expect(request.user).toEqual({ id: "user-id" });
  });

  it.each([
    undefined,
    "",
    "Bearer",
    "Bearer ",
    "bearer token",
    " Bearer token",
    "Bearer token extra",
  ])("rejects malformed authorization header %s", async (authorization) => {
    const sessions = {
      resolveAccess: vi.fn(),
    } as unknown as SessionService;
    const guard = new SessionAuthGuard(sessions);
    const { context } = contextFor(authorization);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
      status: 401,
    });
    expect(sessions.resolveAccess).not.toHaveBeenCalled();
  });
});
