/** oh-my-plumb's palette, as a terminal can show it. Truecolor where available; chalk degrades the rest. */
export const palette = {
  teal: "#3da5a8",
  tealLight: "#58c4c8",
  sage: "#5cbd68",
  ceramic: "#d8c4a0",
  ceramicWarm: "#c4a46e",
  amber: "#d49a50",
  amberBright: "#e0ac62",
  rose: "#c9627d",
  plum: "#a468c2",
  indigo: "#6876d8",
  copper: "#b97b47",
  mist: "#8d96a3",
  ash: "#5a6370",
  cloud: "#cdd3dc",
  paper: "#f0ece6",
} as const;

export type Tone = "accent" | "ok" | "warn" | "bad" | "info" | "muted" | "text" | "highlight";

export const toneColor: Record<Tone, string> = {
  accent: palette.teal,
  ok: palette.sage,
  warn: palette.amber,
  bad: palette.rose,
  info: palette.indigo,
  muted: palette.mist,
  text: palette.cloud,
  highlight: palette.ceramic,
};

export const glyph = {
  dot: "●",
  ring: "○",
  check: "✓",
  cross: "✗",
  arrow: "→",
  bar: "▎",
  dotSep: "·",
  ellipsis: "…",
} as const;

/** Cuts a string to fit, keeping the tail readable when the head is the boring part. */
export const truncate = (value: string, max: number, keep: "head" | "tail" = "head"): string => {
  if (max <= 1) return value.slice(0, Math.max(0, max));
  if (value.length <= max) return value;
  return keep === "head"
    ? `${value.slice(0, max - 1)}${glyph.ellipsis}`
    : `${glyph.ellipsis}${value.slice(value.length - max + 1)}`;
};

/** A probability as a small bar: filled tenths, in the band's colour. */
export const meter = (probability: number, width = 10): string => {
  const filled = Math.round(Math.min(1, Math.max(0, probability)) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

/** Globs as a person reads them: a list of whole-tree extension globs becomes `ts, tsx`; anything else stays a glob. */
export const scopeLabel = (scope: readonly string[] | undefined): string => {
  if (scope === undefined) return "everywhere";
  const extensions = scope.map((g) => /^\*\*\/\*\.([A-Za-z0-9]+)$/.exec(g)?.[1]);
  if (extensions.every((e): e is string => e !== undefined)) return extensions.join(", ");
  return scope.join(", ");
};
