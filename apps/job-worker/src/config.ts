import { z } from "zod";

const workerEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  REDIS_URL: z
    .string()
    .url()
    .refine((redisUrl) => ["redis:", "rediss:"].includes(new URL(redisUrl).protocol), {
      message: "REDIS_URL must use redis: or rediss: protocol",
    }),
});

export const parseWorkerConfig = (environment: Record<string, unknown>) => {
  const parsed = workerEnvironmentSchema.parse(environment);

  if (parsed.NODE_ENV === "production" && new URL(parsed.REDIS_URL).protocol !== "rediss:") {
    throw new Error("Production REDIS_URL must use rediss: protocol");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    redisUrl: parsed.REDIS_URL,
    queuePrefix: `stay-fable:${parsed.NODE_ENV}`,
  } as const;
};
