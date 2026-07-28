import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import { CLOCK } from "../src/common/clock/clock.js";
import { DatabaseModule } from "../src/database/database.module.js";
import { DatabaseService } from "../src/database/database.service.js";
import { IdentityModule } from "../src/identity/identity.module.js";
import {
  unsupportedWechatIdentityProviderError,
  WECHAT_IDENTITY_PROVIDER,
} from "../src/identity/wechat-identity.provider.js";
import { RedisModule } from "../src/infrastructure/redis/redis.module.js";

describe("Identity module dependency boundaries", () => {
  it("exports one DatabaseService provider for health and identity consumers", async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://localhost:5432/stay_fable";
    process.env.REDIS_URL = "redis://localhost:6379";
    const { AppModule } = await import("../src/app.module.js");
    expect(Reflect.getMetadata("providers", DatabaseModule)).toEqual([DatabaseService]);
    expect(Reflect.getMetadata("exports", DatabaseModule)).toEqual([DatabaseService]);
    expect(Reflect.getMetadata("imports", IdentityModule)).toEqual([DatabaseModule, RedisModule]);
    expect(Reflect.getMetadata("imports", AppModule)).toEqual(
      expect.arrayContaining([DatabaseModule, RedisModule, IdentityModule]),
    );
    expect(Reflect.getMetadata("providers", AppModule)).not.toContain(DatabaseService);
  });

  it("registers clock and config-selected identity provider tokens", () => {
    const providers = Reflect.getMetadata("providers", IdentityModule) as Array<
      | symbol
      | {
          provide?: symbol;
          inject?: unknown[];
          useFactory?: (config: Pick<ConfigService, "getOrThrow">) => unknown;
        }
    >;
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: CLOCK }),
        expect.objectContaining({
          provide: WECHAT_IDENTITY_PROVIDER,
          inject: [ConfigService],
        }),
      ]),
    );
    const identityProvider = providers.find(
      (provider) => typeof provider === "object" && provider.provide === WECHAT_IDENTITY_PROVIDER,
    );
    expect(
      identityProvider &&
        typeof identityProvider === "object" &&
        identityProvider.useFactory?.({ getOrThrow: () => "mock" }),
    ).toBeDefined();
    expect(() => {
      if (
        identityProvider &&
        typeof identityProvider === "object" &&
        identityProvider.useFactory !== undefined
      ) {
        identityProvider.useFactory({ getOrThrow: () => "code2session" });
      }
    }).toThrow(unsupportedWechatIdentityProviderError);
  });
});
