import { Box, Text } from "ink";
import { glyph, palette } from "../theme.js";

export type Step = { ok: boolean; text: string; detail?: string };

/** What happened, one line per step, so a person can see where an install stopped. */
export function Checklist({ steps }: { steps: readonly Step[] }) {
  return (
    <Box flexDirection="column">
      {steps.map((step, i) => (
        <Box key={i} flexDirection="column">
          <Box>
            <Text color={step.ok ? palette.sage : palette.rose}>
              {step.ok ? glyph.check : glyph.cross}
            </Text>
            <Text color={palette.cloud}> {step.text}</Text>
          </Box>
          {step.detail ? (
            <Box paddingLeft={2}>
              <Text color={palette.ash} wrap="truncate-end">
                {step.detail}
              </Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
