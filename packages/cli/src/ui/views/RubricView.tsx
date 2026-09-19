import { Box, Text } from "ink";
import type { Rule } from "oh-my-plumb-schema";
import { Buckets } from "../components/Buckets.js";
import { Callout } from "../components/Callout.js";
import { Header } from "../components/Header.js";
import { RuleTable } from "../components/RuleTable.js";
import { Section } from "../components/Section.js";
import { glyph, palette } from "../theme.js";

export type RubricData =
  | { kind: "invalid"; root: string; file: string; issues: string[] }
  | {
      kind: "ok";
      root: string;
      file: string;
      rules: Rule[];
      missing: string[];
      orphaned: string[];
    };

export function RubricView({ data }: { data: RubricData }) {
  if (data.kind === "invalid") {
    return (
      <Box flexDirection="column">
        <Header command="rubric validate" where={data.root} />
        <Callout tone="bad" title={`${data.file} is not a valid rubric`}>
          {data.issues.map((issue) => (
            <Text key={issue} color={palette.cloud}>
              {glyph.dot} {issue}
            </Text>
          ))}
        </Callout>
      </Box>
    );
  }
  const stuck = data.rules.filter((r) => r.status === "weak" || r.status === "noisy");
  return (
    <Box flexDirection="column">
      <Header command="rubric validate" where={data.root} />
      <Text color={palette.sage}>
        {glyph.check} wrote {data.file} with source hashes
      </Text>
      {data.missing.length > 0 ? (
        <Callout tone="bad" title="Sources that could not be hashed. Fix the path.">
          <Text color={palette.cloud}>{data.missing.join(", ")}</Text>
        </Callout>
      ) : null}
      {data.orphaned.length > 0 ? (
        <Callout
          tone="bad"
          title='Rules whose source is not listed under "sources". Add it or fix the path.'
        >
          <Text color={palette.cloud}>{data.orphaned.join(", ")}</Text>
        </Callout>
      ) : null}
      <Box marginTop={1}>
        <Section title="Rules">
          <Buckets rules={data.rules} />
          <Box marginTop={1}>
            <RuleTable rules={data.rules} />
          </Box>
        </Section>
      </Box>
      {stuck.length > 0 ? (
        <Callout
          tone="warn"
          title={`${stuck.length} ${stuck.length === 1 ? "rule" : "rules"} will not run until rewritten`}
        >
          <Text color={palette.cloud}>
            {stuck
              .map(
                (r) =>
                  `${r.id} (${r.status}${r.calibration ? `, median ${r.calibration.median.toFixed(2)}` : ""})`,
              )
              .join(", ")}
          </Text>
          <Text color={palette.mist}>Run oh-my-plumb tune.</Text>
        </Callout>
      ) : null}
    </Box>
  );
}
