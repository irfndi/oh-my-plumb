import { Box, Text } from "ink";
import { Header } from "../components/Header.js";
import { palette } from "../theme.js";

const COMMANDS: [string, string][] = [
  ["login [--gateway]", "store your TypeSafe key in ~/.oh-my-plumb/.env, owner-only"],
  ["init [agent] [--project]", "hook into claude, codex, opencode, pi, or every one found here"],
  ["compile", "compile the rubric now, in a headless Claude Code turn"],
  ["tune [--global]", "rewrite rules that never fire, with their statistics attached"],
  ["rubric validate [--global]", "check .oh-my-plumb/rubric.json and fill in source hashes"],
  ["calibrate [--global]", "test every rule against this repo's recent history"],
  ["check [paths] [--all]", "check uncommitted changes the way the hooks would"],
  ["audit [paths] [--all]", "judge every file in scope as if just written; what breaks which rule"],
  ["report", "what is compiled, what fired, what never fires"],
  [
    "replay <agent>",
    "judge past claude, codex or opencode sessions in this repo as if oh-my-plumb had been installed (pi replay not yet supported)",
  ],
  ["bench [--runs N]", "latency and spend, measured on this machine"],
  ["uninstall [agent] [--project]", "remove the hooks from one agent, or all"],
];

export function HelpView() {
  return (
    <Box flexDirection="column">
      <Header
        command="help"
        note="Enforce your own AGENTS.md rules on every edit a coding agent makes."
      />
      {COMMANDS.map(([name, what]) => (
        <Box key={name}>
          <Box width={30}>
            <Text color={palette.cloud} bold>
              {name}
            </Text>
          </Box>
          <Text color={palette.mist}>{what}</Text>
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text color={palette.ash}>
          --json prints machine-readable output on report, check, audit, bench and calibrate.
        </Text>
        <Text color={palette.ash}>
          Key: oh-my-plumb login, or TYPESAFE_AI_API_KEY (or AI_GATEWAY_API_KEY) in the environment
          or a .env at the repo root.
        </Text>
      </Box>
    </Box>
  );
}
