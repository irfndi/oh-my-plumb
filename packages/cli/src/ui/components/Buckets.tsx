import { Box, Text } from "ink";
import type { Rule } from "oh-my-plumb-schema";
import { bucketCounts } from "../../lib/rubricFile.js";
import { glyph, palette } from "../theme.js";

/** One line: how many rules, and how each one is enforced. */
export function Buckets({ rules }: { rules: readonly Rule[] }) {
  const c = bucketCounts(rules);
  const part = (n: number, label: string, color: string) => (
    <>
      <Text color={palette.mist}> {glyph.dotSep} </Text>
      <Text color={n > 0 ? color : palette.ash} bold={n > 0}>
        {n}
      </Text>
      <Text color={n > 0 ? palette.cloud : palette.ash}> {label}</Text>
    </>
  );
  return (
    <Box>
      <Text color={palette.cloud} bold>
        {c.total}
      </Text>
      <Text color={palette.cloud}> rules</Text>
      {part(c.model, "checked by Jev", palette.indigo)}
      {part(c.lint, "for your linter", palette.sage)}
      {part(c.deferred, "deferred", palette.ceramicWarm)}
      {part(c.unenforceable, "unenforceable", palette.ash)}
    </Box>
  );
}
