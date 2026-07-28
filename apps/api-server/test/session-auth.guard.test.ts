/* eslint-disable @typescript-eslint/unbound-method */
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../src/database/database.service.js";
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
      resolveAccess: vi.fn(() =>
        Promise.resolve({ userId: "user-id", familyId: "family-id", sessionVersion: 7 }),
      ),
    } as unknown as SessionService;
    const database = {
      user: {
        findUnique: vi.fn(() => Promise.resolve({ status: "ACTIVE", sessionVersion: 7 })),
      },
    } as unknown as DatabaseService;
    const guard = new SessionAuthGuard(sessions, database);
    const { context, request } = contextFor("Bearer opaque-token");

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(sessions.resolveAccess).toHaveBeenCalledWith("opaque-token");
    expect(database.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-id" },
      select: { status: true, sessionVersion: true },
    });
    expect(request.user).toEqual({ id: "user-id" });
  });

  it.each([
    null,
    { status: "DISABLED", sessionVersion: 8 },
    { status: "ACTIVE", sessionVersion: 8 },
  ])(
    "revokes the current family before rejecting a missing, disabled, or epoch-mismatched access user",
    async (user) => {
      const sessions = {
        resolveAccess: vi.fn(() =>
          Promise.resolve({ userId: "user-id", familyId: "family-id", sessionVersion: 7 }),
        ),
        revokeFamily: vi.fn(() => Promise.resolve()),
      } as unknown as SessionService;
      const database = {
        user: {
          findUnique: vi.fn(() => Promise.resolve(user)),
        },
      } as unknown as DatabaseService;
      const guard = new SessionAuthGuard(sessions, database);
      const { context, request } = contextFor("Bearer opaque-token");

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: "AUTH_USER_DISABLED",
        status: 403,
      });
      expect(sessions.revokeFamily).toHaveBeenCalledWith("family-id");
      expect(request.user).toBeUndefined();
    },
  );

  it("maps database lookup failures to a stable safe 503", async () => {
    const sessions = {
      resolveAccess: vi.fn(() =>
        Promise.resolve({ userId: "user-id", familyId: "family-id", sessionVersion: 7 }),
      ),
      revokeFamily: vi.fn(),
    } as unknown as SessionService;
    const database = {
      user: {
        findUnique: vi.fn(() => Promise.reject(new Error("postgres secret detail"))),
      },
    } as unknown as DatabaseService;
    const guard = new SessionAuthGuard(sessions, database);
    const { context } = contextFor("Bearer opaque-token");

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: "AUTH_SESSION_SERVICE_UNAVAILABLE",
      message: "登录服务暂时不可用，请稍后重试",
      status: 503,
    });
    expect(sessions.revokeFamily).not.toHaveBeenCalled();
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
    const guard = new SessionAuthGuard(sessions, {} as DatabaseService);
    const { context } = contextFor(authorization);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
      status: 401,
    });
    expect(sessions.resolveAccess).not.toHaveBeenCalled();
  });
});
