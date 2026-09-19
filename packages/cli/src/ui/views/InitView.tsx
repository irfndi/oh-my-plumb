import { Box, Text } from "ink";
import { assertNever } from "oh-my-plumb-schema";
import { Callout } from "../components/Callout.js";
import { Checklist, type Step } from "../components/Checklist.js";
import { Header } from "../components/Header.js";
import { palette, scopeLabel } from "../theme.js";

export type InitData =
  | { kind: "no-key"; root: string }
  | { kind: "no-sources"; root: string }
  | {
      kind: "installed";
      root: string;
      steps: Step[];
      hosts: string[];
      afterwards: string[];
      sources: { path: string; scope: string; global: boolean }[];
      rubric: { path: string; rules: number } | null;
    };

export function InitView({ data }: { data: InitData }) {
  switch (data.kind) {
    case "no-key":
      return (
        <Box flexDirection="column">
          <Header command="init" where={data.root} />
          <Callout tone="warn" title="No API key found, so oh-my-plumb has nothing to check with">
            <Text color={palette.cloud}>
              Get a TypeSafe key at typesafe.ai, then run{" "}
              <Text color={palette.ceramic}>oh-my-plumb login</Text> and paste it.
            </Text>
            <Text color={palette.mist}>
              Or put TYPESAFE_AI_API_KEY (or a Vercel AI_GATEWAY_API_KEY) in the environment or a
              .env at the repo root.
            </Text>
            <Text color={palette.ash}>Never a flag. It is never logged.</Text>
          </Callout>
        </Box>
      );
    case "no-sources":
      return (
        <Box flexDirection="column">
          <Header command="init" where={data.root} />
          <Callout tone="warn" title="Found 0 instruction files, so there are 0 rules">
            <Text color={palette.cloud}>
              Add an AGENTS.md and run oh-my-plumb init again. Oh-my-plumb ships no rules of its
              own.
            </Text>
          </Callout>
        </Box>
      );
    case "installed":
      return (
        <Box flexDirection="column">
          <Header command="init" where={data.root} />
          <Checklist steps={data.steps} />
          <Box flexDirection="column" marginTop={1}>
            <Text color={palette.mist}>Instruction files</Text>
            {data.sources.map((s) => (
              <Box key={s.path}>
                <Text color={palette.cloud}> {s.path}</Text>
                <Text color={palette.ash}>
                  {" "}
                  {s.global
                    ? "global, every repo"
                    : s.scope === "**/*"
                      ? "everywhere in this repo"
                      : `applies to ${scopeLabel([s.scope])}`}
                </Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            {data.rubric ? (
              <Callout tone="ok" title={`Rubric present: ${data.rubric.rules} rules`}>
                <Text color={palette.mist}>
                  {data.rubric.path}. It is rehashed at the start of every session.
                </Text>
              </Callout>
            ) : (
              <Callout tone="accent" title={`Next: start ${data.hosts.join(" or ")} in this repo`}>
                <Text color={palette.cloud}>
                  The first turn compiles the rubric, on your own subscription.
                </Text>
                <Text color={palette.mist}>
                  To compile right now instead:{" "}
                  <Text color={palette.ceramic}>oh-my-plumb compile</Text>
                </Text>
              </Callout>
            )}
          </Box>
          {data.afterwards.map((line) => (
            <Text key={line} color={palette.amber}>
              {line}
            </Text>
          ))}
          <Text color={palette.ash}>
            Later: oh-my-plumb report shows what fired, oh-my-plumb bench measures latency and spend
            here.
          </Text>
        </Box>
      );
    default:
      return assertNever(data);
  }
}
