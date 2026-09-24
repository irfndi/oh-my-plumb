import { preToolUseInputSchema, type HookOutput } from "oh-my-plumb-schema";
import { appendUnknownPayload } from "../lib/events.js";
import { handleToolCall } from "../lib/toolCallCheck.js";

/** A call judged before it runs: an act band stops it, a flag only annotates it, and a payload we cannot read passes, counted as unknown. */
export const handlePreToolUse = async (raw: unknown): Promise<HookOutput> => {
  const parsed = preToolUseInputSchema.safeParse(raw);
  if (!parsed.success) {
    appendUnknownPayload(raw);
    return { kind: "silent" };
  }
  return handleToolCall(parsed.data);
};
