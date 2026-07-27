import { z } from "zod";

const workerEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export interface WorkerConfig {
  nodeEnv: "development" | "test" | "production";
  redisUrl: string;
  queuePrefix: string;
}

export const parseWorkerConfig = (environment: Record<string, unknown>): WorkerConfig => {
  const parsed = workerEnvironmentSchema.parse(environment);

  return {
    nodeEnv: parsed.NODE_ENV,
    redisUrl: parsed.REDIS_URL,
    queuePrefix: `stay-fable:${parsed.NODE_ENV}`,
  };
};
