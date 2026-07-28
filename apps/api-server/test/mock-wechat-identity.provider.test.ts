import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { BusinessException } from "../src/common/http/business.exception.js";
import { MockWechatIdentityProvider } from "../src/identity/mock-wechat-identity.provider.js";

describe("MockWechatIdentityProvider", () => {
  const provider = new MockWechatIdentityProvider();

  it("maps a valid mock code to a deterministic opaque subject", async () => {
    const code = "mock:user-a";

    await expect(provider.exchange(code)).resolves.toEqual({
      provider: "WECHAT",
      subject: `mock_${createHash("sha256").update(code).digest("hex")}`,
    });
  });

  it("uses the complete code when hashing", async () => {
    const first = await provider.exchange("mock:user-a");
    const second = await provider.exchange("mock:user-b");

    expect(first.subject).not.toBe(second.subject);
  });

  it.each(["wechat:user-a", "mock:a", `mock:${"x".repeat(124)}`])(
    "safely rejects unsupported code %s",
    async (code) => {
      const rejection = provider.exchange(code);

      await expect(rejection).rejects.toBeInstanceOf(BusinessException);
      await expect(rejection).rejects.toMatchObject({
        code: "AUTH_PROVIDER_REJECTED",
        message: "微信登录凭证无效",
        status: 400,
      });
    },
  );
});
