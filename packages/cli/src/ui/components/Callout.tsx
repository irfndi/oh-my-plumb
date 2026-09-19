import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { glyph, toneColor, type Tone } from "../theme.js";

type CalloutProps = { tone: Tone; title: string; children?: ReactNode };

/** Something the reader should act on, boxed so it is not lost in a table. */
export function Callout({ tone, title, children }: CalloutProps) {
  const color = toneColor[tone];
  const mark = tone === "ok" ? glyph.check : tone === "bad" ? glyph.cross : glyph.dot;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
      alignSelf="flex-start"
    >
      <Text color={color} bold>
        {mark} {title}
      </Text>
      {children ? <Box flexDirection="column">{children}</Box> : null}
    </Box>
  );
}
