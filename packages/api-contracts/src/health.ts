import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
  checks: z.record(z.string(), z.enum(["up", "down"])).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
