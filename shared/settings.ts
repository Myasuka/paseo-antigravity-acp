import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_READ_ONLY_ROOTS = [
  "~/.agents/skills",
  "~/.codex/skills",
  "~/.claude/skills",
  "~/.gemini/antigravity-cli/builtin/skills",
] as const;

export const antigravitySettings = defineSettings({
  id: "policy",
  scope: "host",
  version: 1,
  schema: z.object({
    agyPath: z.string().trim().max(1024).default(""),
    readOnlyRoots: z.array(z.string().trim().min(1).max(1024)).max(64).default([]),
    progressUpdates: z.boolean().default(true),
    backgroundTimeoutMinutes: z.number().int().min(1).max(1440).default(60),
  }),
});

export type AntigravitySettingsValues = z.output<typeof antigravitySettings.schema>;
