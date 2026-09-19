import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { glyph, palette } from "../theme.js";

type SectionProps = { title: string; children: ReactNode; aside?: string };

/** A titled block with a thin teal rule down its left, so a long report scans in pieces. */
export function Section({ title, aside, children }: SectionProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={palette.teal}>{glyph.bar}</Text>
        <Text color={palette.cloud} bold>
          {" "}
          {title}
        </Text>
        {aside ? <Text color={palette.mist}> {aside}</Text> : null}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  );
}
