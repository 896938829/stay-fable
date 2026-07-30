import { validateDatabaseUrlPolicy } from "@stay-fable/validation";
import { z } from "zod";

const workerEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  REDIS_URL: z.string(),
  DATABASE_URL: z.string(),
  BOOKING_EXPIRY_POLL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
});

const workerEnvironmentKeys = [
  "NODE_ENV",
  "REDIS_URL",
  "DATABASE_URL",
  "BOOKING_EXPIRY_POLL_MS",
] as const;

const snapshotWorkerEnvironment = (
  environment: Record<string, unknown>,
): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = {};
  for (const key of workerEnvironmentKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(environment, key);
    if (descriptor === undefined) {
      continue;
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new Error("Invalid worker environment");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
};

export const parseWorkerConfig = (environment: Record<string, unknown>) => {
  let parsed: z.infer<typeof workerEnvironmentSchema>;
  try {
    parsed = workerEnvironmentSchema.parse(snapshotWorkerEnvironment(environment));
  } catch {
    throw new Error("Invalid worker environment");
  }

  let redisUrl: URL;
  try {
    redisUrl = new URL(parsed.REDIS_URL);
  } catch {
    throw new Error("REDIS_URL must use redis: or rediss: protocol");
  }
  if (!["redis:", "rediss:"].includes(redisUrl.protocol)) {
    throw new Error("REDIS_URL must use redis: or rediss: protocol");
  }
  if (parsed.NODE_ENV === "production" && redisUrl.protocol !== "rediss:") {
    throw new Error("Production REDIS_URL must use rediss: protocol");
  }
  validateDatabaseUrlPolicy(parsed.NODE_ENV, parsed.DATABASE_URL);

  return {
    bookingExpiryPollMs: parsed.BOOKING_EXPIRY_POLL_MS,
    databaseUrl: parsed.DATABASE_URL,
    nodeEnv: parsed.NODE_ENV,
    redisUrl: parsed.REDIS_URL,
    queuePrefix: `stay-fable:${parsed.NODE_ENV}`,
  } as const;
};
