import { z } from "zod";

const usesProtocol = (url: string, protocols: readonly string[]) => {
  try {
    return protocols.includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

const runtimeEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().refine((url) => usesProtocol(url, ["postgres:", "postgresql:"]), {
    message: "DATABASE_URL must use postgres: or postgresql: protocol",
  }),
  REDIS_URL: z.url().refine((url) => usesProtocol(url, ["redis:", "rediss:"]), {
    message: "REDIS_URL must use redis: or rediss: protocol",
  }),
});

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

export const parseRuntimeEnvironment = (environment: unknown): RuntimeEnvironment => {
  const parsedEnvironment = runtimeEnvironmentSchema.parse(environment);
  const databaseUrl = new URL(parsedEnvironment.DATABASE_URL);
  const redisUrl = new URL(parsedEnvironment.REDIS_URL);
  const sslModes = databaseUrl.searchParams.getAll("sslmode");

  if (
    parsedEnvironment.NODE_ENV === "production" &&
    (sslModes.length !== 1 || sslModes[0] !== "require")
  ) {
    throw new Error("Production DATABASE_URL must require TLS");
  }

  if (parsedEnvironment.NODE_ENV === "production" && redisUrl.protocol !== "rediss:") {
    throw new Error("Production REDIS_URL must use rediss: protocol");
  }

  return parsedEnvironment;
};
