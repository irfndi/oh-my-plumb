import { Box, Text } from "ink";
import { Callout } from "../components/Callout.js";
import { palette } from "../theme.js";

/** A rubric that will not parse blocks the compile: naming each one is the whole message. */
export function CompileBlockedView({ problems }: { problems: { message: string }[] }) {
  return (
    <Callout tone="bad" title="Fix the rubric first">
      <Box flexDirection="column">
        {problems.map((problem) => (
          <Text key={problem.message} color={palette.mist} wrap="wrap">
            {problem.message}
          </Text>
        ))}
      </Box>
    </Callout>
  );
}
