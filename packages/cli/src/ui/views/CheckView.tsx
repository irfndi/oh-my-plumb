import { Box, Text } from "ink";
import type { Verdict } from "oh-my-plumb-schema";
import { Header } from "../components/Header.js";
import { Section } from "../components/Section.js";
import { Verdicts } from "../components/Verdicts.js";
import { ms, usd } from "../../lib/ui.js";
import { glyph, palette } from "../theme.js";

export type CheckSection = {
  phase: "edit" | "turn";
  files: string[];
  modelRules: number;
  calls: number;
  latencyMs: number;
  verdicts: Verdict[];
};

export type CheckData = { root: string; sections: CheckSection[]; spendUsd: number; all: boolean };

export function CheckView({ data }: { data: CheckData }) {
  const acts = data.sections.flatMap((s) => s.verdicts).filter((v) => v.band === "act").length;
  const flags = data.sections.flatMap((s) => s.verdicts).filter((v) => v.band === "flag").length;
  return (
    <Box flexDirection="column">
      <Header command="check" where={data.root} />
      {data.sections.map((s, i) => (
        <Section
          key={i}
          title={
            s.phase === "edit"
              ? (s.files[0] ?? "")
              : `turn ${glyph.dotSep} ${s.files.length} ${s.files.length === 1 ? "file" : "files"}`
          }
          aside={`${s.modelRules} rules ${glyph.dotSep} ${s.calls} ${s.calls === 1 ? "call" : "calls"} ${glyph.dotSep} ${ms(s.latencyMs)}`}
        >
          <Verdicts verdicts={s.verdicts} all={data.all} />
        </Section>
      ))}
      <Box>
        <Text color={acts > 0 ? palette.rose : palette.sage} bold>
          {acts > 0 ? `${glyph.cross} ${acts} to repair` : `${glyph.check} nothing to repair`}
        </Text>
        {flags > 0 ? (
          <Text color={palette.amber}>
            {" "}
            {glyph.dot} {flags} uncertain
          </Text>
        ) : null}
        <Text color={palette.ash}>
          {" "}
          {glyph.dotSep} about {usd(data.spendUsd)}
        </Text>
      </Box>
    </Box>
  );
}
