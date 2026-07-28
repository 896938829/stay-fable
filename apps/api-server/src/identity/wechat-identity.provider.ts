export const WECHAT_IDENTITY_PROVIDER = Symbol("WECHAT_IDENTITY_PROVIDER");

export interface WechatIdentity {
  provider: "WECHAT";
  subject: string;
}

export interface WechatIdentityProvider {
  exchange(code: string): Promise<WechatIdentity>;
}

export const unsupportedWechatIdentityProviderError =
  "IDENTITY_PROVIDER must be configured as mock until WeChat code2session is implemented";
