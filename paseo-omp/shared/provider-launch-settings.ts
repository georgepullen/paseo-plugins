import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_INHERITED_ENVIRONMENT_NAMES = 256;
export const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
export const DEFAULT_MAX_SESSIONS = 32;
// Every allowed session can open at once without reaching the 128 in-flight operations bound.
export const MAX_SESSIONS_UPPER_BOUND = 64;

export const providerLaunchSettingsSchema = z.object({
  inheritEnv: z.array(environmentNameSchema).max(MAX_INHERITED_ENVIRONMENT_NAMES).default([]),
  maxSessions: z.number().int().min(1).max(MAX_SESSIONS_UPPER_BOUND).default(DEFAULT_MAX_SESSIONS),
});

export type ProviderLaunchSettings = z.infer<typeof providerLaunchSettingsSchema>;

export const providerLaunchSettings = defineSettings({
  id: "provider-launch",
  scope: "host",
  version: 1,
  schema: providerLaunchSettingsSchema,
});
