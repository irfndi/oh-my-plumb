import { z } from "zod";

/** The coding agents oh-my-plumb can hook into. Adding one here fails every consumer that has not handled it. */
export const hostSchema = z.enum(["claude", "codex", "opencode", "pi", "omp"]);
export type Host = z.infer<typeof hostSchema>;
export const HOSTS: readonly Host[] = hostSchema.options;

const PI_SPEC = /^npm:oh-my-plumb(@.+)?$/;

export const piSettingsSchema = z
  .object({ packages: z.array(z.unknown()).optional() })
  .passthrough();
export const ompManifestSchema = z
  .object({
    dependencies: z.record(z.string(), z.unknown()).optional(),
    devDependencies: z.record(z.string(), z.unknown()).optional(),
    optionalDependencies: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const packageVersionSchema = z.object({ version: z.string() });

export const piListsPackage = (
  settings: unknown,
): { spec: string; pinned: boolean } | undefined => {
  const parsed = piSettingsSchema.safeParse(settings);
  if (!parsed.success) return undefined;
  const entry = z.union([z.string(), z.object({ source: z.string() }).passthrough()]);
  for (const raw of parsed.data.packages ?? []) {
    const source = entry.safeParse(raw);
    if (!source.success) continue;
    const spec = typeof source.data === "string" ? source.data : source.data.source;
    const match = PI_SPEC.exec(spec);
    if (match !== null) return { spec, pinned: match[1] !== undefined };
  }
  return undefined;
};

export const ompListsPlugin = (manifest: unknown): string | undefined => {
  const parsed = ompManifestSchema.safeParse(manifest);
  if (!parsed.success) return undefined;
  for (const section of [
    parsed.data.dependencies,
    parsed.data.devDependencies,
    parsed.data.optionalDependencies,
  ]) {
    const range = section?.["oh-my-plumb"];
    if (typeof range === "string") return range;
  }
  return undefined;
};
