import { z } from "zod";

const boundedNonblankString = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0);

export const citySchema = z.object({
  id: z.uuid(),
  code: boundedNonblankString(32),
  name: boundedNonblankString(80),
});

export const resolveLocationRequestSchema = z.object({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
});

export const resolvedLocationSchema = z.object({
  city: citySchema,
  distance_meters: z.number().int().nonnegative(),
});

export type City = z.infer<typeof citySchema>;
export type ResolveLocationRequest = z.infer<typeof resolveLocationRequestSchema>;
export type ResolvedLocation = z.infer<typeof resolvedLocationSchema>;
