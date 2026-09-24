import type { Rule, RuleStatus } from "oh-my-plumb-schema";
import { assertNever } from "oh-my-plumb-schema";
import { Columns, type Cell, type Column, type Row } from "./Columns.js";
import { glyph, meter, palette, scopeLabel } from "../theme.js";

export type RuleStats = { checks: number; fired: number; flagged: number };

const statusCell = (status: RuleStatus): Cell => {
  switch (status) {
    case "active":
      return { text: `${glyph.dot} active`, color: palette.sage };
    case "weak":
      return { text: `${glyph.dot} weak`, color: palette.amber, bold: true };
    case "noisy":
      return { text: `${glyph.dot} noisy`, color: palette.rose, bold: true };
    case "disabled":
      return { text: `${glyph.ring} off`, color: palette.ash };
    default:
      return assertNever(status);
  }
};

/** A guard's trigger is its check.scope; every other rule scopes with rule.scope. */
const scopeCell = (rule: Rule): Cell => {
  const scope = rule.check.type === "guard" ? [rule.check.scope] : rule.scope;
  return { text: scopeLabel(scope), color: scope ? palette.mist : palette.ash };
};

const checkCell = (rule: Rule): Cell => {
  switch (rule.check.type) {
    case "lint":
      return { text: "linter", color: palette.sage };
    case "model":
      return { text: `jev ${rule.check.question.type}`, color: palette.indigo };
    case "guard":
      return { text: "guard", color: palette.plum };
    case "deferred":
      return { text: "deferred", color: palette.ceramicWarm };
    case "unenforceable":
      return { text: "unenforceable", color: palette.ash };
    default:
      return assertNever(rule.check);
  }
};

const whenCell = (rule: Rule): Cell => {
  if (rule.check.type === "model")
    return { text: rule.when ?? "", color: rule.when === "turn" ? palette.plum : palette.mist };
  return { text: "", color: palette.ash };
};

const calibrationCell = (rule: Rule): Cell => {
  const c = rule.calibration;
  if (!c || c.verdict === "skipped") return { text: c ? "skipped" : "", color: palette.ash };
  const color =
    c.verdict === "decisive" ? palette.mist : c.verdict === "weak" ? palette.amber : palette.rose;
  return { text: `${meter(c.median, 6)} ${c.median.toFixed(2)}`, color };
};

type RuleTableProps = {
  rules: readonly Rule[];
  stats?: ReadonlyMap<string, RuleStats>;
  /** Only rules oh-my-plumb checks: the model ones. */
  runnableOnly?: boolean;
};

export function RuleTable({ rules, stats, runnableOnly = false }: RuleTableProps) {
  const shown = runnableOnly ? rules.filter((r) => r.check.type === "model") : rules;
  const columns: Column[] = [
    { key: "id", label: "rule", width: 30 },
    { key: "check", label: "check", width: 12 },
    { key: "when", label: "when", width: 4 },
    { key: "status", label: "status", width: 9 },
    ...(stats
      ? [{ key: "fired", label: "fired / checks", width: 14, align: "right" as const }]
      : []),
    { key: "cal", label: "calibration", width: 12 },
    { key: "scope", label: "scope" },
  ];
  const rows: Row[] = shown.map((rule) => {
    const s = stats?.get(rule.id);
    return {
      id: {
        text: rule.id,
        color: rule.status === "active" ? palette.cloud : palette.mist,
        bold: rule.status === "active",
      },
      check: checkCell(rule),
      when: whenCell(rule),
      status: statusCell(rule.status),
      fired: s
        ? {
            text: `${s.fired} / ${s.checks}`,
            color: s.fired > 0 ? palette.rose : s.checks > 0 ? palette.mist : palette.ash,
          }
        : { text: "", color: palette.ash },
      cal: calibrationCell(rule),
      scope: scopeCell(rule),
    };
  });
  return <Columns columns={columns} rows={rows} indent={2} />;
}
