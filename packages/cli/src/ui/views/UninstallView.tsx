import { Box, Text } from "ink";
import { assertNever, type Host } from "oh-my-plumb-schema";
import { hostLabel, type Removal } from "../../lib/hosts.js";
import { Callout } from "../components/Callout.js";
import { palette } from "../theme.js";

export type UninstallRow = { host: Host } & Removal;

const whatHappened = (mechanism: Removal["mechanisms"][number]): string => {
  switch (mechanism) {
    case "package":
      return "package entry removed";
    case "shim":
      return "extension file removed";
    case "hooks":
      return "hooks removed";
    case "plugin":
      return "plugin removed";
    default:
      return assertNever(mechanism);
  }
};

/** What happened per host, including the ones with nothing to remove: silence there reads as a failed query. */
const line = ({ host, count, mechanisms }: UninstallRow): string =>
  count === 0
    ? `${hostLabel(host)}: nothing to remove`
    : `${hostLabel(host)}: ${mechanisms.map(whatHappened).join(", ")}`;

export function UninstallView({ rows }: { rows: UninstallRow[] }) {
  const touched = rows.filter((row) => row.count > 0);
  return (
    <Callout
      tone={touched.length === 0 ? "muted" : "ok"}
      title={
        touched.length === 0
          ? "No oh-my-plumb entries found"
          : `Removed oh-my-plumb from ${touched.map((row) => hostLabel(row.host)).join(", ")}. Your rubric files are untouched.`
      }
    >
      <Box flexDirection="column">
        {rows.map((row) => (
          <Text key={row.host} color={row.count > 0 ? palette.cloud : palette.ash}>
            {line(row)}
          </Text>
        ))}
      </Box>
    </Callout>
  );
}
