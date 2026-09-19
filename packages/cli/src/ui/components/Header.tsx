import { Box, Text } from "ink";
import { glyph, palette } from "../theme.js";

type HeaderProps = {
  command: string;
  /** Where this ran, on its own line: a person switching between repos should not have to guess. */
  where?: string;
  note?: string;
};

export function Header({ command, where, note }: HeaderProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={palette.teal} bold>
          oh-my-plumb
        </Text>
        <Text color={palette.mist}> {glyph.dotSep} </Text>
        <Text color={palette.cloud} bold>
          {command}
        </Text>
      </Box>
      {where ? (
        <Text color={palette.ash} wrap="truncate-start">
          {where}
        </Text>
      ) : null}
      {note ? (
        <Text color={palette.mist} wrap="wrap">
          {note}
        </Text>
      ) : null}
    </Box>
  );
}
