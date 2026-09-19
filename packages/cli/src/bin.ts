#!/usr/bin/env node
import { runAudit } from "./commands/audit.js";
import { runBench } from "./commands/bench.js";
import { runCalibrate } from "./commands/calibrate.js";
import { runCheckCommand } from "./commands/check.js";
import { runCompile } from "./commands/compile.js";
import { runInit } from "./commands/init.js";
import { runLogin } from "./commands/login.js";
import { runReplay } from "./commands/replay.js";
import { runReport } from "./commands/report.js";
import { runRubric } from "./commands/rubric.js";
import { runUninstall } from "./commands/uninstall.js";
import { showError, showStatic } from "./ui/render.js";
import { HelpView } from "./ui/views/HelpView.js";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
});

const main = async (): Promise<number> => {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "login":
      return runLogin(rest);
    case "init":
      return runInit(rest);
    case "compile":
      return runCompile(rest, false);
    case "tune":
      return runCompile(rest, true);
    case "rubric":
      return runRubric(rest);
    case "calibrate":
      return runCalibrate(rest);
    case "check":
      return runCheckCommand(rest);
    case "audit":
      return runAudit(rest);
    case "report":
      return runReport(rest);
    case "replay":
      return runReplay(rest);
    case "bench":
      return runBench(rest);
    case "uninstall":
      return runUninstall(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      await showStatic(HelpView());
      return 0;
    default:
      await showError(new Error(`Unknown command "${command}". Try: oh-my-plumb help`));
      return 1;
  }
};

try {
  process.exitCode = await main();
} catch (error) {
  await showError(error);
  process.exitCode = 1;
}
