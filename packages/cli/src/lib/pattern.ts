// shortcut: a shape screen plus a length cap, not a time bound; move to RE2 before trusting a rubric from anywhere untrusted.
export const MAX_REGEX_INPUT_CHARS = 4_000;

const NESTED_QUANTIFIER = /\([^()]*[*+{][^()]*\)\s*[*+{]/;

export type BoundedPattern =
  | { kind: "match"; test: (text: string) => boolean }
  | { kind: "refuse" };

const compiled = new Map<string, RegExp | undefined>();

const compile = (pattern: string): RegExp | undefined => {
  if (compiled.has(pattern)) return compiled.get(pattern);
  let re: RegExp | undefined;
  try {
    re = NESTED_QUANTIFIER.test(pattern) ? undefined : new RegExp(pattern);
  } catch {
    re = undefined;
  }
  compiled.set(pattern, re);
  return re;
};

export const boundedPattern = (pattern: string): BoundedPattern => {
  const re = compile(pattern);
  if (re === undefined) return { kind: "refuse" };
  return {
    kind: "match",
    test: (text) => text.length <= MAX_REGEX_INPUT_CHARS && re.test(text),
  };
};
