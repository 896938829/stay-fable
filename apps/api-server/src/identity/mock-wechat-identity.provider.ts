import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { BusinessException } from "../common/http/business.exception.js";
import type { WechatIdentity, WechatIdentityProvider } from "./wechat-identity.provider.js";

@Injectable()
export class MockWechatIdentityProvider implements WechatIdentityProvider {
  exchange(code: string): Promise<WechatIdentity> {
    if (!code.startsWith("mock:") || code.length < 8 || code.length > 128) {
      return Promise.reject(
        new BusinessException(400, "AUTH_PROVIDER_REJECTED", "微信登录凭证无效"),
      );
    }

    return Promise.resolve({
      provider: "WECHAT",
      subject: `mock_${createHash("sha256").update(code).digest("hex")}`,
    });
  }
}
