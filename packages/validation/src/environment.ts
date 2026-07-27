import { z } from "zod";

const runtimeEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
  })
  .superRefine((environment, context) => {
    if (
      environment.NODE_ENV === "production" &&
      new URL(environment.DATABASE_URL).searchParams.get("sslmode") !== "require"
    ) {
      context.addIssue({
        code: "custom",
        message: "Production DATABASE_URL must require TLS.",
        path: ["DATABASE_URL"],
      });
    }
  });

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

export const parseRuntimeEnvironment = (environment: unknown): RuntimeEnvironment =>
  runtimeEnvironmentSchema.parse(environment);
