import { Box, Text } from "ink";
import type { CalibrationVerdict } from "oh-my-plumb-schema";
import { Callout } from "../components/Callout.js";
import { Columns } from "../components/Columns.js";
import { Header } from "../components/Header.js";
import { Section } from "../components/Section.js";
import { usd } from "../../lib/ui.js";
import { glyph, meter, palette } from "../theme.js";

export type CalibrateRow = {
  id: string;
  when: string;
  states: number;
  median: number;
  min: number;
  max: number;
  fired: number;
  verdict: CalibrationVerdict;
};
export type CalibrateData = {
  root: string;
  file: string;
  hunks: number;
  commits: number;
  calls: number;
  spendUsd: number;
  rows: CalibrateRow[];
  weak: string[];
  noisy: string[];
};

const verdictColor = (v: CalibrationVerdict): string =>
  v === "decisive"
    ? palette.sage
    : v === "weak"
      ? palette.amber
      : v === "noisy"
        ? palette.rose
        : palette.ash;

export function CalibrateView({ data }: { data: CalibrateData }) {
  return (
    <Box flexDirection="column">
      <Header
        command="calibrate"
        where={data.root}
        note={`${data.rows.length} rules ${glyph.dotSep} ${data.hunks} hunks and ${data.commits} commits from git history`}
      />
      <Section
        title="Rules"
        aside={`${data.calls} calls ${glyph.dotSep} about ${usd(data.spendUsd)}`}
      >
        <Columns
          indent={2}
          columns={[
            { key: "id", label: "rule", width: 34 },
            { key: "when", label: "when", width: 4 },
            { key: "states", label: "states", width: 6, align: "right" },
            { key: "median", label: "median", width: 12 },
            { key: "range", label: "min  max", width: 11 },
            { key: "fired", label: "fired", width: 5, align: "right" },
            { key: "verdict", label: "verdict" },
          ]}
          rows={data.rows.map((r) => ({
            id: { text: r.id, color: palette.cloud },
            when: { text: r.when, color: r.when === "turn" ? palette.plum : palette.mist },
            states: { text: String(r.states), color: palette.mist },
            median: {
              text: `${meter(r.median, 6)} ${r.median.toFixed(2)}`,
              color: verdictColor(r.verdict),
            },
            range: { text: `${r.min.toFixed(2)} ${r.max.toFixed(2)}`, color: palette.ash },
            fired: { text: String(r.fired), color: r.fired > 0 ? palette.rose : palette.ash },
            verdict: {
              text: r.verdict,
              color: verdictColor(r.verdict),
              bold: r.verdict !== "decisive" && r.verdict !== "skipped",
            },
          }))}
        />
      </Section>
      {data.weak.length > 0 ? (
        <Callout
          tone="warn"
          title={`${data.weak.length} ${data.weak.length === 1 ? "rule" : "rules"} never answered near 0 or near 1 and will not run`}
        >
          <Text color={palette.cloud}>{data.weak.join(", ")}</Text>
          <Text color={palette.mist}>
            Likely badly worded. Run oh-my-plumb tune to rewrite them.
          </Text>
        </Callout>
      ) : null}
      {data.noisy.length > 0 ? (
        <Callout
          tone="bad"
          title={`${data.noisy.length} ${data.noisy.length === 1 ? "rule fired" : "rules fired"} on most historic hunks and will not run`}
        >
          <Text color={palette.cloud}>{data.noisy.join(", ")}</Text>
          <Text color={palette.mist}>Too broad. Narrow the scope or the wording.</Text>
        </Callout>
      ) : null}
      {data.weak.length + data.noisy.length === 0 ? (
        <Text color={palette.sage}>
          {glyph.check} Every rule is decisive on this repository's history.
        </Text>
      ) : null}
      <Text color={palette.ash}>wrote {data.file}</Text>
    </Box>
  );
}
