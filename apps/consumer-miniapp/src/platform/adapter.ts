export type SupportedPlatform = "weapp" | "alipay" | "tt";

export interface PlatformAdapter {
  readonly platform: SupportedPlatform;
  login(): Promise<{ code: string }>;
}

export function assertSupportedPlatform(platform: string): SupportedPlatform {
  if (platform !== "weapp" && platform !== "alipay" && platform !== "tt") {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return platform;
}
