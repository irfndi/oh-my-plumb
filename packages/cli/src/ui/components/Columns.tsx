import { Box, Text, useStdout } from "ink";
import { palette, truncate } from "../theme.js";

export type Column = {
  key: string;
  label: string;
  /** Fixed width, or omitted for the one column that takes what is left. */
  width?: number;
  align?: "left" | "right";
  keep?: "head" | "tail";
};

export type Cell = { text: string; color?: string; bold?: boolean; dim?: boolean };
export type Row = Record<string, Cell>;

type ColumnsProps = { columns: Column[]; rows: Row[]; indent?: number };

const GAP = 2;
const MIN_FLEX = 10;

/**
 * A table that fits the terminal. Fixed columns keep their width whatever
 * happens, the flexible one takes what is left, and every cell is cut with an
 * ellipsis rather than wrapped, so a row is always one line.
 */
export function Columns({ columns, rows, indent = 0 }: ColumnsProps) {
  const { stdout } = useStdout();
  const available = Math.max(60, (stdout?.columns ?? 100) - indent - 1);
  const fixed = columns.reduce((sum, c) => sum + (c.width ?? 0), 0) + GAP * (columns.length - 1);
  const flexWidth = Math.max(MIN_FLEX, available - fixed);
  const widthOf = (c: Column): number => c.width ?? flexWidth;
  const cell = (c: Column, content: Cell, header: boolean, last: boolean) => (
    <Box
      key={c.key}
      width={widthOf(c)}
      flexShrink={0}
      marginRight={last ? 0 : GAP}
      justifyContent={c.align === "right" ? "flex-end" : "flex-start"}
    >
      <Text
        color={header ? palette.ash : (content.color ?? palette.cloud)}
        bold={content.bold}
        dimColor={content.dim}
        wrap="truncate"
      >
        {truncate(content.text, widthOf(c), c.keep ?? "head")}
      </Text>
    </Box>
  );
  return (
    <Box flexDirection="column">
      <Box>{columns.map((c, i) => cell(c, { text: c.label }, true, i === columns.length - 1))}</Box>
      {rows.map((row, r) => (
        <Box key={r}>
          {columns.map((c, i) =>
            cell(c, row[c.key] ?? { text: "" }, false, i === columns.length - 1),
          )}
        </Box>
      ))}
    </Box>
  );
}
