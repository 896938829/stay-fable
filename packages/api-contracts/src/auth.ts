import { z } from "zod";

export const wechatLoginRequestSchema = z.object({
  code: z.string().min(8).max(128),
});

export const authSessionSchema = z.object({
  access_token: z.string().min(32),
  access_expires_in: z.number().int().positive(),
  refresh_token: z.string().min(32),
  refresh_expires_in: z.number().int().positive(),
  user: z.object({
    id: z.uuid(),
  }),
});

export const refreshSessionRequestSchema = z.object({
  refresh_token: z.string().min(32),
});

export type WechatLoginRequest = z.infer<typeof wechatLoginRequestSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type RefreshSessionRequest = z.infer<typeof refreshSessionRequestSchema>;
