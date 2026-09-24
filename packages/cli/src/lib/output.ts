import { assertNever, type HookOutput } from "oh-my-plumb-schema";

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop";

const write = (payload: Record<string, unknown>, done: () => void): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`, () => done());
};

/** The only path to stdout. Everything else goes to stderr, which the host keeps out of the transcript. */
export const emit = (output: HookOutput, event: HookEventName, done: () => void): void => {
  switch (output.kind) {
    case "silent":
      done();
      return;
    case "session-context":
      write(
        {
          ...(output.systemMessage === undefined ? {} : { systemMessage: output.systemMessage }),
          hookSpecificOutput: { hookEventName: event, additionalContext: output.additionalContext },
        },
        done,
      );
      return;
    case "block":
      // Before a call runs, Claude and Codex both read the hook-specific deny;
      // after it runs, the legacy block shape carries the repair request.
      if (event === "PreToolUse") {
        write(
          {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: output.reason,
            },
            ...(output.systemMessage === undefined ? {} : { systemMessage: output.systemMessage }),
          },
          done,
        );
        return;
      }
      write(
        {
          decision: "block",
          reason: output.reason,
          ...(output.systemMessage === undefined ? {} : { systemMessage: output.systemMessage }),
        },
        done,
      );
      return;
    case "notice":
      write({ systemMessage: output.systemMessage }, done);
      return;
    default:
      return assertNever(output);
  }
};

export const debug = (message: string): void => {
  if (process.env.OH_MY_PLUMB_DEBUG) process.stderr.write(`oh-my-plumb: ${message}\n`);
};
