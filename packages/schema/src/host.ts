import { z } from "zod";

/** The coding agents oh-my-plumb can hook into. Adding one here fails every consumer that has not handled it. */
export const hostSchema = z.enum(["claude", "codex", "opencode"]);
export type Host = z.infer<typeof hostSchema>;
export const HOSTS: readonly Host[] = hostSchema.options;
