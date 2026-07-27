import { z } from "zod";

const runtimeEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
});

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

export const parseRuntimeEnvironment = (environment: unknown): RuntimeEnvironment => {
  const parsedEnvironment = runtimeEnvironmentSchema.parse(environment);

  if (
    parsedEnvironment.NODE_ENV === "production" &&
    new URL(parsedEnvironment.DATABASE_URL).searchParams.get("sslmode") !== "require"
  ) {
    throw new Error("Production DATABASE_URL must require TLS");
  }

  return parsedEnvironment;
};
