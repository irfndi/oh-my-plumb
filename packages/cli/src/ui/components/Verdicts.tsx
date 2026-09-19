import { Box, Text } from "ink";
import type { Verdict } from "oh-my-plumb-schema";
import { glyph, meter, palette } from "../theme.js";

const bandColor = (band: Verdict["band"]): string =>
  band === "act" ? palette.rose : band === "flag" ? palette.amber : palette.mist;

type VerdictsProps = { verdicts: readonly Verdict[]; all?: boolean };

/** Verdicts as meters, loudest first. Clear ones fold into one quiet line unless asked for. */
export function Verdicts({ verdicts, all = false }: VerdictsProps) {
  const sorted = [...verdicts].sort((a, b) => b.probability - a.probability);
  const shown = all ? sorted : sorted.filter((v) => v.band !== "clear");
  const hidden = sorted.length - shown.length;
  return (
    <Box flexDirection="column">
      {shown.map((v) => (
        <Box key={v.ruleId}>
          <Text color={bandColor(v.band)}>{meter(v.probability)}</Text>
          <Text color={bandColor(v.band)} bold={v.band === "act"}>
            {" "}
            {v.probability.toFixed(2)}
          </Text>
          <Text color={v.band === "clear" ? palette.mist : palette.cloud} bold={v.band === "act"}>
            {"  "}
            {v.ruleId}
          </Text>
          {v.answer ? <Text color={palette.ash}> {v.answer}</Text> : null}
        </Box>
      ))}
      {hidden > 0 ? (
        <Text color={palette.ash}>
          {glyph.check} {hidden} {hidden === 1 ? "rule" : "rules"} clear
        </Text>
      ) : shown.length === 0 ? (
        <Text color={palette.sage}>{glyph.check} nothing to report</Text>
      ) : null}
    </Box>
  );
}
