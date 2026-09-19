import { Box, Text } from "ink";
import { Columns } from "../components/Columns.js";
import { Header } from "../components/Header.js";
import { Section } from "../components/Section.js";
import { ms, usd } from "../../lib/ui.js";
import { glyph, palette } from "../theme.js";

export type BenchRow = { what: string; median: number; p90: number };
export type BenchData = {
  root: string;
  runs: number;
  activeModelRules: number;
  rows: BenchRow[];
  tokens: { small: number; large: number };
  cost: { small: number; large: number };
  perTurn: { latencyMs: number; costUsd: number };
  sessions: {
    count: number;
    medianChecks: number;
    medianLatencyMs: number;
    medianCostUsd: number;
  } | null;
};

export function BenchView({ data }: { data: BenchData }) {
  return (
    <Box flexDirection="column">
      <Header
        command="bench"
        where={data.root}
        note={`${data.activeModelRules} active model rules ${glyph.dotSep} ${data.runs} runs each`}
      />
      <Section title="Latency">
        <Columns
          indent={2}
          columns={[
            { key: "what", label: "" },
            { key: "median", label: "median", width: 8, align: "right" },
            { key: "p90", label: "p90", width: 8, align: "right" },
          ]}
          rows={data.rows.map((r) => ({
            what: { text: r.what, color: palette.cloud },
            median: { text: ms(r.median), color: palette.ceramic, bold: true },
            p90: { text: ms(r.p90), color: palette.mist },
          }))}
        />
      </Section>
      <Section title="Spend">
        <Text color={palette.cloud}>
          input tokens per edit <Text color={palette.ceramic}>{data.tokens.small}</Text> small{" "}
          <Text color={palette.ash}>{glyph.dotSep}</Text>{" "}
          <Text color={palette.ceramic}>{data.tokens.large}</Text> large
        </Text>
        <Text color={palette.cloud}>
          per edit <Text color={palette.ceramic}>{usd(data.cost.small)}</Text> small{" "}
          <Text color={palette.ash}>{glyph.dotSep}</Text>{" "}
          <Text color={palette.ceramic}>{usd(data.cost.large)}</Text> large
        </Text>
        <Box marginTop={1}>
          <Text color={palette.cloud}>
            A 15 edit turn here: about{" "}
            <Text color={palette.ceramic}>{ms(data.perTurn.latencyMs)}</Text> of waiting and{" "}
            <Text color={palette.ceramic}>{usd(data.perTurn.costUsd)}</Text>, before repairs.
          </Text>
        </Box>
      </Section>
      <Section
        title="Real sessions"
        aside={data.sessions ? `${data.sessions.count} recorded` : "none yet"}
      >
        {data.sessions ? (
          <Text color={palette.cloud}>
            median per session <Text color={palette.ceramic}>{data.sessions.medianChecks}</Text>{" "}
            checks <Text color={palette.ash}>{glyph.dotSep}</Text>{" "}
            <Text color={palette.ceramic}>{ms(data.sessions.medianLatencyMs)}</Text> of hook time{" "}
            <Text color={palette.ash}>{glyph.dotSep}</Text>{" "}
            <Text color={palette.ceramic}>{usd(data.sessions.medianCostUsd)}</Text>
          </Text>
        ) : (
          <Text color={palette.ash}>
            The figures above are measured; per-session numbers appear once the hooks have run here.
          </Text>
        )}
      </Section>
    </Box>
  );
}
