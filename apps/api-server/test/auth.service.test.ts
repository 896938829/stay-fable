/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from "vitest";

import { BusinessException } from "../src/common/http/business.exception.js";
import type { DatabaseService } from "../src/database/database.service.js";
import { AuthService } from "../src/identity/auth.service.js";
import type { SessionService } from "../src/identity/session.service.js";
import type { WechatIdentityProvider } from "../src/identity/wechat-identity.provider.js";

interface HarnessUser {
  id: string;
  status: "ACTIVE" | "DISABLED";
}

const activeUser: HarnessUser = {
  id: "018f47b6-0f58-7f52-8a35-3f92a6f34762",
  status: "ACTIVE",
};
const session = {
  access_token: "a".repeat(32),
  access_expires_in: 120,
  refresh_token: "r".repeat(32),
  refresh_expires_in: 600,
  user: { id: activeUser.id },
};

const createHarness = (existingUser: HarnessUser | null = activeUser) => {
  const provider = {
    exchange: vi.fn(() =>
      Promise.resolve({
        provider: "WECHAT" as const,
        subject: "mock_subject",
      }),
    ),
  } satisfies WechatIdentityProvider;
  const transaction = {
    $queryRaw: vi.fn((query: unknown) => {
      void query;
      return Promise.resolve<Array<{ id: string; status: "ACTIVE" | "DISABLED" }>>([activeUser]);
    }),
    userIdentity: {
      findUnique: vi.fn(() =>
        Promise.resolve(existingUser === null ? null : { user: existingUser }),
      ),
    },
    user: {
      create: vi.fn(() => Promise.resolve(activeUser)),
    },
  };
  const database = {
    $transaction: vi.fn((callback: (tx: typeof transaction) => unknown) =>
      Promise.resolve(callback(transaction)),
    ),
    userIdentity: {
      findUnique: vi.fn(() => Promise.resolve({ user: activeUser })),
    },
    user: {
      findUnique: vi.fn(),
    },
  } as unknown as DatabaseService;
  const sessions = {
    issue: vi.fn(() => Promise.resolve(session)),
    inspectRefresh: vi.fn(() => Promise.resolve({ userId: activeUser.id, familyId: "family-id" })),
    revokeFamilyByRefresh: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(),
  } as unknown as SessionService;
  const service = new AuthService(provider, database, sessions);

  return { service, provider, database, transaction, sessions };
};

describe("AuthService", () => {
  it("reuses an active user found by provider and opaque subject", async () => {
    const { service, provider, transaction, sessions } = createHarness();

    await expect(service.login("mock:user-a")).resolves.toEqual(session);

    expect(provider.exchange).toHaveBeenCalledWith("mock:user-a");
    expect(transaction.userIdentity.findUnique).toHaveBeenCalledWith({
      where: {
        provider_providerSubject: {
          provider: "WECHAT",
          providerSubject: "mock_subject",
        },
      },
      select: { user: { select: { id: true, status: true } } },
    });
    expect(transaction.user.create).not.toHaveBeenCalled();
    expect(sessions.issue).toHaveBeenCalledWith(activeUser.id);
  });

  it("creates a user and identity together when the subject is new", async () => {
    const { service, transaction } = createHarness(null);

    await service.login("mock:user-a");

    expect(transaction.user.create).toHaveBeenCalledWith({
      data: {
        identities: {
          create: {
            provider: "WECHAT",
            providerSubject: "mock_subject",
          },
        },
      },
      select: { id: true, status: true },
    });
  });

  it("recovers a concurrent unique conflict by querying the winner", async () => {
    const { service, database, transaction } = createHarness(null);
    transaction.user.create.mockRejectedValueOnce({ code: "P2002" });

    await expect(service.login("mock:user-a")).resolves.toEqual(session);

    expect(transaction.userIdentity.findUnique).toHaveBeenCalledTimes(1);
    expect(
      (database as unknown as { userIdentity: { findUnique: ReturnType<typeof vi.fn> } })
        .userIdentity.findUnique,
    ).toHaveBeenCalledTimes(1);
  });

  it("rejects disabled users without issuing a session", async () => {
    const { service, sessions } = createHarness({ ...activeUser, status: "DISABLED" });

    await expect(service.login("mock:user-a")).rejects.toMatchObject({
      code: "AUTH_USER_DISABLED",
      message: "账号已被停用",
      status: 403,
    });
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it("inspects an enabled user before rotating the same family", async () => {
    const { service, sessions } = createHarness();
    vi.mocked(sessions.refresh).mockResolvedValueOnce(session);

    await expect(service.refresh("r".repeat(32))).resolves.toEqual(session);
    expect(sessions.inspectRefresh).toHaveBeenCalledWith("r".repeat(32));
    expect(sessions.refresh).toHaveBeenCalledWith("r".repeat(32), {
      userId: activeUser.id,
      familyId: "family-id",
    });
    expect(sessions.revokeFamilyByRefresh).not.toHaveBeenCalled();
  });

  it("holds a parameterized shared user-row lock while rotating an active family", async () => {
    const { service, transaction, sessions } = createHarness();
    vi.mocked(sessions.refresh).mockResolvedValueOnce(session);

    await expect(service.refresh("r".repeat(32))).resolves.toEqual(session);

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    const query = transaction.$queryRaw.mock.calls[0]?.[0] as
      { strings?: readonly string[]; values?: readonly unknown[] } | undefined;
    expect(query?.strings?.join("?").replaceAll(/\s+/g, " ").trim()).toBe(
      'SELECT id, status FROM "user" WHERE id = ?::uuid FOR SHARE',
    );
    expect(query?.values).toEqual([activeUser.id]);
    expect(transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessions.refresh).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("routes a rejected inspection through atomic rotation for replay revocation", async () => {
    const { service, database, sessions } = createHarness();
    const rejected = new BusinessException(401, "AUTH_REFRESH_REJECTED", "刷新凭证无效或已过期");
    vi.mocked(sessions.inspectRefresh).mockRejectedValueOnce(rejected);
    vi.mocked(sessions.refresh).mockRejectedValueOnce(rejected);

    await expect(service.refresh("r".repeat(32))).rejects.toMatchObject({
      code: "AUTH_REFRESH_REJECTED",
      status: 401,
    });

    expect(sessions.refresh).toHaveBeenCalledWith("r".repeat(32));
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it.each([null, { ...activeUser, status: "DISABLED" as const }])(
    "revokes the family before rejecting a missing or disabled user",
    async (databaseUser) => {
      const { service, transaction, sessions } = createHarness();
      transaction.$queryRaw.mockResolvedValueOnce(databaseUser === null ? [] : [databaseUser]);

      await expect(service.refresh("r".repeat(32))).rejects.toMatchObject({
        code: "AUTH_USER_DISABLED",
        message: "账号已被停用",
        status: 403,
      });
      expect(sessions.revokeFamilyByRefresh).toHaveBeenCalledWith("r".repeat(32));
      expect(sessions.refresh).not.toHaveBeenCalled();
    },
  );
});
