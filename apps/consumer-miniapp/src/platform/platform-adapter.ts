export type SupportedPlatform = "weapp" | "alipay" | "tt";

export interface PlatformAdapter {
  readonly platform: SupportedPlatform;
  login(): Promise<{ code: string }>;
}

export function assertSupportedPlatform(value: string): SupportedPlatform {
  if (value === "weapp" || value === "alipay" || value === "tt") {
    return value;
  }

  throw new Error(`Unsupported platform: ${value}`);
}
