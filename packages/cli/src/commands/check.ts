import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PlumbError, toolCallSchema, type ToolCall } from "oh-my-plumb-schema";
import { loudestVerdicts, runCheck, runToolCallCheck } from "../lib/checkRunner.js";
import { EDIT_CHECK_TIMEOUT_MS, TURN_CHECK_TIMEOUT_MS } from "../lib/constants.js";
import { hasApiKey, NO_KEY_HINT } from "../lib/credentials.js";
import { boundState } from "../lib/diff.js";
import { splitDiff, workingTreeDiff } from "../lib/git.js";
import { loadRubric } from "../lib/loadRubric.js";
import { findRepoRoot } from "../lib/paths.js";
import { readRegularText } from "../lib/regularFile.js";
import { toolCallReason } from "../lib/reason.js";
import { say } from "../lib/ui.js";
import { Header } from "../ui/components/Header.js";
import { showLive } from "../ui/render.js";
import { CheckView, type CheckData, type CheckSection } from "../ui/views/CheckView.js";

/** A recorded tool call from a file: JSON, zod-parsed, with a named failure when it is neither. */
export const readToolCall = (file: string): ToolCall => {
  const raw = readRegularText(file);
  if (raw === undefined)
    throw new PlumbError("CHECK_INPUT_INVALID", `${file} is missing or not a regular file`);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PlumbError("CHECK_INPUT_INVALID", `${file} is not JSON`);
  }
  const parsed = toolCallSchema.safeParse(json);
  if (!parsed.success)
    throw new PlumbError(
      "CHECK_INPUT_INVALID",
      `${file}: ${parsed.error.issues[0]?.message ?? "is not a recorded tool call"}`,
    );
  return parsed.data;
};

/** Checks uncommitted changes (or a patch file) the way the hooks would, and shows every verdict. */
export const runCheckCommand = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      diff: { type: "string" },
      "tool-call": { type: "string" },
      task: { type: "string" },
      phase: { type: "string", default: "all" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const root = findRepoRoot(process.cwd());
  const loaded = loadRubric(root);
  if (loaded.rules.length === 0)
    throw new PlumbError(
      "RUBRIC_MISSING",
      "no rubric here or in ~/.oh-my-plumb; run oh-my-plumb compile first",
    );

  if (values["tool-call"] !== undefined && (values.diff !== undefined || positionals.length > 0))
    throw new PlumbError(
      "CHECK_INPUT_INVALID",
      "--tool-call replaces the diff; pass one or the other",
    );
  const call = values["tool-call"] === undefined ? undefined : readToolCall(values["tool-call"]);

  if (!hasApiKey(root)) throw new PlumbError("NO_API_KEY", NO_KEY_HINT);

  const files =
    call === undefined
      ? splitDiff(
          values.diff === undefined
            ? workingTreeDiff(root, positionals)
            : readFileSync(values.diff, "utf8"),
        )
      : [];
  const phase = values.phase;

  const run = async (progress: (label: string) => void): Promise<CheckData> => {
    const sections: CheckSection[] = [];
    let spendUsd = 0;
    if (call !== undefined) {
      for (const p of ["edit", "turn"] as const) {
        if (phase !== "all" && phase !== p) continue;
        progress(`checking the call to ${call.tool}`);
        const out = await runToolCallCheck({
          phase: p,
          call,
          task: values.task,
          rules: loaded.rules,
          thresholds: loaded.thresholds,
          timeoutMs: p === "edit" ? EDIT_CHECK_TIMEOUT_MS : TURN_CHECK_TIMEOUT_MS,
          retries: 2,
        });
        spendUsd += out.usage.costUsd ?? 0;
        sections.push({
          phase: p,
          files: [call.tool],
          modelRules: out.modelRules.length,
          calls: out.calls,
          latencyMs: out.modelLatencyMs,
          verdicts: out.verdicts,
        });
      }
      const byId = new Map(loaded.rules.map((r) => [r.id, r]));
      const violations = loudestVerdicts(sections.flatMap((s) => s.verdicts))
        .filter((v) => v.band === "act")
        .flatMap((verdict) => {
          const rule = byId.get(verdict.ruleId);
          return rule === undefined ? [] : [{ rule, verdict }];
        });
      const reason = violations.length === 0 ? undefined : toolCallReason(violations, call.tool);
      return {
        root,
        sections,
        spendUsd,
        all: values.all,
        ...(reason === undefined ? {} : { reason }),
      };
    }
    if (files.length === 0) return { root, sections, spendUsd, all: values.all };
    if (phase === "all" || phase === "edit") {
      for (const f of files) {
        progress(`checking ${f.file}`);
        const out = await runCheck({
          phase: "edit",
          fileDiffs: [{ file: f.file, text: boundState(f.text).text }],
          task: values.task,
          rules: loaded.rules,
          thresholds: loaded.thresholds,
          timeoutMs: EDIT_CHECK_TIMEOUT_MS,
          retries: 2,
        });
        spendUsd += out.usage.costUsd ?? 0;
        sections.push({
          phase: "edit",
          files: [f.file],
          modelRules: out.modelRules.length,
          calls: out.calls,
          latencyMs: out.modelLatencyMs,
          verdicts: out.verdicts,
        });
      }
    }
    if (phase === "all" || phase === "turn") {
      progress(
        `checking the whole change, ${files.length} ${files.length === 1 ? "file" : "files"}`,
      );
      const out = await runCheck({
        phase: "turn",
        fileDiffs: files.map((f) => ({ file: f.file, text: boundState(f.text, 8_000).text })),
        task: values.task,
        rules: loaded.rules,
        thresholds: loaded.thresholds,
        timeoutMs: TURN_CHECK_TIMEOUT_MS,
        retries: 2,
      });
      spendUsd += out.usage.costUsd ?? 0;
      sections.push({
        phase: "turn",
        files: files.map((f) => f.file),
        modelRules: out.modelRules.length,
        calls: out.calls,
        latencyMs: out.modelLatencyMs,
        verdicts: out.verdicts,
      });
    }
    return { root, sections, spendUsd, all: values.all };
  };

  if (values.json) {
    const data = await run(() => {});
    say(JSON.stringify(data));
    return data.sections.some((s) => s.verdicts.some((v) => v.band === "act")) ? 1 : 0;
  }
  return showLive<CheckData>({
    header: Header({
      command: "check",
      where: root,
      note:
        call === undefined && files.length === 0 ? "nothing to check: no changed lines" : undefined,
    }),
    run,
    done: (data) => CheckView({ data }),
    code: (data) => (data.sections.some((s) => s.verdicts.some((v) => v.band === "act")) ? 1 : 0),
  });
};
