export const say = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

export const warn = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const table = (rows: readonly (readonly string[])[]): string => {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows
    .map((row) =>
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "),
    )
    .join("\n");
};

export const ms = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
export const usd = (n: number): string => (n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`);

export const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const a = sorted[mid];
  const b = sorted[mid - 1];
  if (a === undefined) return undefined;
  return sorted.length % 2 === 1 || b === undefined ? a : (a + b) / 2;
};

export const percentile = (values: readonly number[], p: number): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
