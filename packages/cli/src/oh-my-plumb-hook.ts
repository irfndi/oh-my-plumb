import { handlePostToolUse } from "./hooks/postToolUse.js";
import { handlePreToolUse } from "./hooks/preToolUse.js";
import { handleSessionStart } from "./hooks/sessionStart.js";
import { handleStop } from "./hooks/stop.js";
import { handleTurnStart } from "./hooks/turnStart.js";
import { runHook } from "./lib/hookRunner.js";

const name = process.argv[2];
switch (name) {
  case "session-start":
    await runHook("session-start", handleSessionStart, 8_000);
    break;
  case "turn-start":
    await runHook("turn-start", handleTurnStart, 8_000);
    break;
  case "pre-tool-use":
    await runHook("pre-tool-use", handlePreToolUse, 18_000);
    break;
  case "post-tool-use":
    await runHook("post-tool-use", handlePostToolUse, 18_000);
    break;
  case "stop":
    await runHook("stop", handleStop, 28_000);
    break;
  default:
    process.exit(0);
}
