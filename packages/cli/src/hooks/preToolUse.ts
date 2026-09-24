import { preToolUseInputSchema, type HookOutput } from "oh-my-plumb-schema";
import { handleToolCall } from "../lib/toolCallCheck.js";

/** The same call the post-hook judges, judged before it runs: an act band stops it, a flag only annotates it, and anything unparseable passes silently. */
export const handlePreToolUse = async (raw: unknown): Promise<HookOutput> => {
  const parsed = preToolUseInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  return handleToolCall(parsed.data);
};
