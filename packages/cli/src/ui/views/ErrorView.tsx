import { Text } from "ink";
import { isPlumbError, type PlumbErrorCode } from "oh-my-plumb-schema";
import { Callout } from "../components/Callout.js";
import { palette } from "../theme.js";

/** Our own sentence for each failure; the machine's detail sits under it, dimmed. */
const TITLES: Record<PlumbErrorCode, string> = {
  NO_API_KEY: "No API key, so nothing can be checked",
  NO_INSTRUCTION_FILES: "No instruction files here, so there is nothing to compile",
  RUBRIC_INVALID: "The rubric could not be read",
  RUBRIC_MISSING: "No rubric yet",
  SETTINGS_INVALID: "The settings file could not be changed",
  GIT_UNAVAILABLE: "Git history is not readable here",
  CLAUDE_UNAVAILABLE: "Claude Code did not finish the turn",
  HOST_UNKNOWN: "That is not an agent oh-my-plumb knows",
  HOST_NOT_FOUND: "No supported agent was found on this machine",
  HOST_UNSUPPORTED: "Replay is not available for this agent yet",
  CHECK_TIMEOUT: "Jev did not answer in time",
  CHECK_FAILED: "Jev refused the check",
};

export function ErrorView({ error }: { error: unknown }) {
  const detail = error instanceof Error ? error.message : String(error);
  if (!isPlumbError(error)) return <Callout tone="bad" title={detail} />;
  return (
    <Callout tone="bad" title={TITLES[error.code]}>
      <Text color={palette.mist} wrap="wrap">
        {detail}
      </Text>
      <Text color={palette.ash}>{error.code}</Text>
    </Callout>
  );
}
