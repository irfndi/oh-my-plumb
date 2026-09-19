# oh-my-plumb — Validated Plan (draft, 2026-09-19)

Source: `abide` upstream (`coldteadotai/abide`, MIT, TS/pnpm monorepo:
`packages/schema` contract, `packages/cli` command+hooks+opencode plugin,
`skills/abide-compile`). Workspace starts as a full rename of that tree;
all paths below use the NEW names (`oh-my-plumb`, `.oh-my-plumb`,
`OH_MY_PLUMB_HOME_DIR`, `PlumbError`, `oh-my-plumb-schema`).

Research: 3 read-only scouts over pristine `/tmp/abide-upstream` + Pi
official docs (`pi.dev/docs/latest/extensions`). No code edited by scouts.

## 1. Verdict per pillar

| Plan pillar                          | abide today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Verdict                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 auto-detect (`init` → rules.yaml) | `init` discovers instruction files only (`sources.ts`: `ROOT_NAMES=[AGENTS.md,CLAUDE.md,.cursorrules]`, nested walk ≤6, `CONTRIBUTING.md`, global `~/.claude/CLAUDE.md ~/.codex/AGENTS.md ~/.config/opencode/AGENTS.md`); counts sources, hook self-test, installs hosts. NO manifest/linter scan, NO MCP config scan, NO skills scan.                                                                                                                                                                                                                             | PARTIAL — instruction ingestion exists; manifest+MCP+skills scanner is new work in `commands/init.ts` + new `lib/detect.ts`.                                                                                  |
| P2 unskippable hooks                 | Claude/Codex: 4 file-based hooks (`settings.ts hookSpecs`: SessionStart, UserPromptSubmit, PostToolUse, Stop → `node dist/oh-my-plumb-hook.js <name>`, stdin/stdout JSON). OpenCode: in-process plugin shim (`opencode/oh-my-plumb.mjs` + `opencodePlugin.ts`, marker-guarded install). Pi: `tool_result` event EXISTS, can return partial patch (`content/details/isError/usage`), middleware-chained.                                                                                                                                                            | FEASIBLE with corrections (§2).                                                                                                                                                                               |
| P3 tiered pipeline                   | Tier1 NOT executed today: `lint` rules recorded (`how/pattern/overlaps`) and reported, never run (`SKILL.md` Step 3.1, `checkRunner.ts runsInPhase` filters `check.type==model` only). Tier3 Jev EXISTS: bands act≥0.8/flag≥0.5 (`rubric.ts DEFAULT_THRESHOLDS`), edit vs turn (`rule.when`), timeouts EDIT 8s/TURN 15s, hook budgets 8/18/28s (`oh-my-plumb-hook.ts`, `hookRunner.ts` never-throw deadline, exit 0). Cost $0.042/M input, output free; replay ≈$0.09–0.13/40–55 sessions. Tier2 MCP-guard MISSING: no JSON-RPC dispatch, no `$FILE_PATH` routing. | KEEP Tier3 as-is; BUILD Tier1 executor + Tier2 validator; `rules.yaml` ↔ `rubric.json` via thin ADAPTER, not merge/replace (rubric=code-diff schema with scope/when/calibration; rules.yaml=op-tier routing). |
| P4 self-repair                       | Repair loop EXISTS: `reason.ts repairReason` (names rule id + source line + quote + probability + "Repair … now"), `output.ts emit` block→`{decision:block,reason}` on hook stdout (Claude/Codex), `event.result.content` mutation ONLY in opencode plugin. Caps: `MAX_BLOCKS_PER_RULE_PER_TURN=2`, `MAX_STOP_CHECKS_PER_TURN=2`, all paths exit 0.                                                                                                                                                                                                                | FEASIBLE — plan's injection model must be rewritten per-host (no `event.result.content` outside opencode plugin).                                                                                             |

## 2. Plan corrections (must-fix before build)

1. **Pi hook sketch is wrong.** Real API (`pi.dev/docs/latest/extensions`, Tool Events):
   `pi.on("tool_result", …)` returns a partial patch (`{content, details, isError, usage}`),
   does NOT assign `event.result = …`. `content` is content-blocks, not a string append.
   Tool filter `["edit","write","apply_patch"]` mixes harnesses: Pi built-ins are
   `bash/read/write/edit`; `apply_patch` is Codex-shaped. Gate per host.
2. **`ctx.callMcpTool` does NOT exist.** ExtensionContext = `ui/mode/hasUI/cwd/
sessionManager/modelRegistry/scopedModels/signal/isIdle/abort/getSystemPrompt/
compact/…` — no MCP call. Tier2 must dispatch MCP itself (spawn local
   validator / direct MCP client in the extension), not via ctx.
3. **Import path wrong.** Plan uses `@oh-my-pi/pi-coding-agent`; real packages are
   `@earendil-works/pi-coding-agent` (+ forks e.g. `@mariozechner/pi-coding-agent`).
   OMP branding vs pi upstream must be resolved at build time (alias or peer).
4. **Extension paths.** Pi auto-discovers `~/.pi/agent/extensions/*.ts` and
   `.pi/extensions/*.ts` (jiti-loaded TS, no compile). Plan's
   `~/.omp/agent/extensions/oh-my-plumb.ts` must be validated against the OMP
   layout; support BOTH locations.
5. **4th host shape (mirrors opencode).** `schema/src/host.ts`: add `"pi"` to
   `hostSchema` (assertNever consumers fail by design = checklist). `hosts.ts`:
   new `installTarget` branch (global + project plugin paths), `installHost`
   branch (write pi extension file, marker-guarded like `OPENCODE_PLUGIN_MARKER`),
   `uninstallHost` branch. New `lib/piPlugin.ts` copying `opencodePlugin.ts`
   shim pattern (installed file re-exports shipped extension → upgrade w/o reinstall).
   The pi extension fabricates `common/postToolUseInput`-shaped payloads and
   spawns `dist/oh-my-plumb-hook.js` (same as `opencode/oh-my-plumb.mjs` does).
6. **Tier2 cheapest prototype.** PostToolUse branch matching `mcp__*` tool input,
   route by method/`$FILE_PATH` to a LOCAL synchronous validator (dry-run
   EXPLAIN / no-DDL check for migrations), block/flag synchronously, log only.
   No model call, no `checkRunner` change, fits ~200ms. `postgres-inspector
validate_migration` via MCP JSON-RPC is Phase 3, not MVP.
7. **Tier1 executor.** Run the repo's own linter (biome/eslint/tsc/cargo/ruff
   detected by P1 scanner) inside PostToolUse with <50ms budget for cached
   single-file checks; Jev path stays seconds-scale and must never gate Tier1.
8. **`.oh-my-plumb/rubric.json` stays the Tier3 store.** `rules.yaml` (plan §3)
   maps tiers→triggers→actions; the adapter selects the rubric subset per tier.
   Keep both files; do not merge schemas.
9. **Stray `.env`.** Workspace root `.env` containing `TYPESAFE_API_KEY`
   appeared 12:05 from an unknown source (not upstream; upstream gitignores
   `.env`). Left untouched, gitignored. Owner must confirm or rotate; NEVER commit.

## 3. Execution order (post-rename)

1. Verify rename: `grep -rni coldtea` → 0; `grep -rni abide` → 0 outside
   `pnpm-lock.yaml`/binary assets; `git init && git add -A && git commit`
   (fresh history; fork link already cut — `.git` removed at copy).
2. Baseline: `pnpm install && pnpm -r run build && pnpm -r run typecheck && pnpm -r run test`
   unmodified (ordered pnpm first: `vp run -r build` runs workspace builds in
   parallel and fails with `TS2307 oh-my-plumb-schema` when cli compiles before
   schema `dist` exists; sequential `vp run -F oh-my-plumb-schema build` then
   `vp run -F oh-my-plumb build` passes). THEN vite-plus migration
   (`vp migrate --no-interactive` from root; vp 0.3.3 bundles vite 8.3.0,
   vitest 4.1.11 = repo's vitest 4.1.11 ✓, oxlint/oxfmt/tsdown;
   replaces prettier+tsc-scripts+vitest-direct).
   Validate: `vp install && vp check && vp test && vp run -r build`
   (bare `vp build` has no root target; `vp run -r build` is the gate).
3. Phase 1 DONE: 4th host `pi` + Tier1 overlaps fast-path + per-host repair returns.
   Shipped: `packages/schema/src/host.ts`, `packages/cli/src/lib/{hosts,piPlugin}.ts`,
   `packages/cli/pi/oh-my-plumb.ts`, per-file fast-verdict partition in `postToolUse.ts`.
4. Phase 2 DONE: `oh-my-plumb init` scanners → `.oh-my-plumb/rules.yaml` synthesizer
   (`lib/detect.ts`: manifests incl. `vite.config.ts`, `.pi/.claude` MCP scan,
   skill dirs + guard-like `package.json` scripts; `routesFor` tier adapter).
5. Phase 3 DONE (local + spawned guards; MCP JSON-RPC client deferred): `lib/guards.ts`
   (`routesForFile` trigger routing, `parseGuardOutput`, `resolveSkillGuard`,
   `runGuard` 2s deadline silent-pass), Tier2 local migration guard in `lib/tier2.ts`,
   external MCP/skill dispatch in `postToolUse.ts`, Tier-2 route lines in `init` rules.yaml.
6. Phase 4 DONE (docs + help; OMP layout validation deferred to installed-OMP check):
   README agents table + Pi section, `init [agent]` help text, Jev adapter unchanged
   (`jev-latest`, `lib/jev.ts`, `lib/band.ts` thresholds act 0.8 / flag 0.5).

## 4. Risks

- Pi/OMP API drift (rebrand divergence: `@earendil-works` vs OMP paths) — pin
  against installed OMP build, not docs alone.
- `tool_result` content-block shape — string-append repair text must be wrapped
  as text blocks per host or tests fail.
- Infinite repair loops — keep caps (2 blocks/rule/turn, 2 stop checks) + exit-0.
- Prompt injection via rule text/diffs — repairReason quotes ≤220 chars, one
  sentence per violation; never whole files.
- Tier2 latency — synchronous local validators only in-hook; network/MCP calls
  go async or Phase 3.
- Key handling — env → `.env.local`/`.env` → `~/.oh-my-plumb/.env`, owner-only;
  never flags, never logged (`credentials.ts` pattern).
