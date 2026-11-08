# The state machines oh-my-plumb runs on

Every hook is a function of state that lives on disk, in a session, or at the
provider. This file names those machines, the states they move through, the
invariants the rest of the code assumes, and the invalid states and transitions
this codebase can actually reach — with the evidence for each.

Two rules of reading:

- **Transition = one line of code.** Every table row names the function that
  writes the state, so a row can be checked against the source without guessing.
- **Evidence is a reproduction, not an opinion.** Each finding below carries
  either a command that showed it or a file and line that state it outright.
  Findings marked **confirmed** were reproduced on this machine.

Scope: `packages/cli/src` and `packages/schema/src` at `6679565`.

---

## Index

| #   | Machine                    | Owner                                                       | Kinds of state                          |
| --- | -------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| M1  | Hook lifecycle             | `lib/hookRunner.ts`, `hooks/*`                              | explicit (`HookOutput`)                 |
| M2  | Turn state on disk         | `lib/session.ts`                                            | explicit (files, `wx` first-write-wins) |
| M3  | Turn diff completeness     | `hooks/stop.ts`, `lib/git.ts`                               | explicit (`TurnDiff`, `BaselineStatus`) |
| M4  | Edit coverage chain        | `lib/coverage.ts`                                           | derived                                 |
| M5  | Block / stop budget        | `lib/constants.ts`, `hooks/*`                               | explicit (counter files)                |
| M6  | API-key trust              | `lib/keyState.ts`, `lib/keyProbe.ts`                        | explicit (`key-check.json`)             |
| M7  | Credential resolution      | `lib/credentials.ts`                                        | explicit (`Credentials`)                |
| M8  | Rubric load                | `lib/loadRubric.ts`, `lib/rubricFile.ts`                    | explicit (`LoadedRules`)                |
| M9  | Rubric freshness / compile | `hooks/sessionStart.ts`, `lib/sources.ts`                   | explicit (`Staleness`)                  |
| M10 | Rule selection             | `lib/checkRunner.ts`, `lib/scope.ts`, `lib/skillScope.ts`   | derived                                 |
| M11 | Verdict banding            | `lib/band.ts`, `lib/precondition.ts`, `lib/tier1.ts`        | derived                                 |
| M12 | Guard execution            | `lib/guards.ts`, `lib/mcp.ts`                               | explicit per call                       |
| M13 | Event log                  | `lib/events.ts`                                             | append-only + trim                      |
| M14 | Update notice              | `lib/updateCheck.ts`                                        | explicit (`update-check.json`)          |
| M15 | Hook installation          | `lib/settings.ts`, `lib/hosts.ts`                           | explicit (host config files)            |
| M16 | Host plugin session        | `pi/oh-my-plumb.ts`, `opencode/*.js`, `opencode/shared.mjs` | explicit (in-memory `sessions`)         |

The root cause of that table is the same for nearly every bug found here: a
machine whose state is written by one path and read by another, where one of
the two never runs on some hosts or some turns, and both sides are quiet when
the other is missing.

---

## M1 · Hook lifecycle

The contract from `AGENTS.md`: a hook exits 0, bounds its own time, and writes
nothing but the JSON the host expects.

```text
            ┌──────────────┐
            │  invoked     │
            └──────┬───────┘
       argv name   │   argv name unknown
        known      │   ───────────────► exit 0, nothing printed
                   ▼
            ┌──────────────┐  budget spent   ┌───────────────��──┐
            │  reading     │ ──────────────► │ silent, exit 0   │
            └──────┬───────┘                 └──────────────────┘
                   │ stdin parsed (or not: raw = undefined)
                   ▼
            ┌──────────────┐  throws          ┌──────────────────┐
            │  handling    │ ──────────────► │ debug(stderr) +  │
            └──────┬───────┘                 │ silent, exit 0   │
                   │                         └──────────────────┘
                   ▼
            ┌──────────────┐
            │  emitting    │──► stdout: one JSON record, then exit 0
            └──────────────┘
```

| From     | Event                      | To                                                | Written by                       |
| -------- | -------------------------- | ------------------------------------------------- | -------------------------------- |
| invoked  | known argv name            | reading                                           | `src/oh-my-plumb-hook.ts` switch |
| invoked  | unknown argv name          | (terminal) exit 0                                 | same switch, `default`           |
| reading  | stdin JSON parsed          | handling                                          | `runHook`                        |
| reading  | stdin not JSON             | handling with `raw = undefined`                   | `runHook` (`debug`)              |
| reading  | budget spent               | (terminal) silent                                 | `runHook` `setTimeout`           |
| handling | handler resolves           | emitting                                          | `runHook`                        |
| handling | handler throws             | (terminal) silent                                 | `runHook` catch                  |
| emitting | `silent`                   | (terminal) exit 0                                 | `emit`                           |
| emitting | `session-context`          | (terminal) `hookSpecificOutput.additionalContext` | `emit`                           |
| emitting | `block` on `PreToolUse`    | (terminal) `permissionDecision: "deny"`           | `emit`                           |
| emitting | `block` on any other event | (terminal) `decision: "block"`                    | `emit`                           |
| emitting | `notice`                   | (terminal) `systemMessage`                        | `emit`                           |

Invariants:

1. `process.exitCode` is set to 0 before anything else can fail.
2. Exactly one JSON record reaches stdout, or none.
3. The deadline exits the process rather than resolving, so no open handle
   keeps a timed-out hook alive.
4. A hook never throws across the boundary; `finish` is idempotent.

Reachable invalid transitions: none found. The budget here (8–28 s) is a
_hard_ wall, not a soft one, and it is what makes every later finding a
degraded check rather than a broken agent. Two of those budgets are however
spent on **unbounded computation** (F4) and **unbounded I/O** (M8), which turns
"bounded" into "silent skip" more often than the numbers suggest.

---

## M2 · Turn state on disk

`~/.oh-my-plumb/sessions/<session>/<turn>/` holds one directory per turn, where
`turn = prompt_id ?? turn_id ?? "turn"` (`schema/hooks.ts turnIdOf`, `session.ts
turnDir`). Two hooks for parallel tool calls run at the same time, so nothing
here is read-modify-write: files are created with `wx` and a counter is the
number of files carrying its prefix.

```text
   (no directory)
        │  any record writer: recordFileStart, recordToolCall, markBaseline,
        ▼  writePrompt, recordChecked, recordBlockedFile, incrementStopChecks
   ┌─────────┐   stop: no act verdict            ┌──────────────┐
   │  open   │ ────────────────────────────────► │   cleared    │
   └────┬────┘   clearTurn(dir)                   └──────────────┘
        │  stop: act verdict → block
        ▼
   ┌─────────┐   next turn-start with no turn id  ┌──────────────┐
   │ blocked │ ─────────────────────────────────► │   cleared    │
   └─────────┘   clearTurn(dir)                    └──────────────┘
```

| File                        | State it carries                        | Writer                     | Reader                           |
| --------------------------- | --------------------------------------- | -------------------------- | -------------------------------- |
| `files/<sha>.json`          | start-of-turn content of an edited file | `recordFileStart`          | `readFileStarts` (Stop fallback) |
| `tool-calls/call.NNNNNN`    | one call: `order, name, summary, args`  | `recordToolCall`           | `readToolCalls`                  |
| `baseline`                  | git tree at turn start                  | `writeBaseline`            | `readBaseline`                   |
| `baseline-status`           | `pending`, `ok`, `failed`               | `markBaseline`             | `readBaselineStatus`             |
| `checked/<sha>.json`        | before/after blob ids of a judged edit  | `recordChecked`            | `readChecked` (Stop coverage)    |
| `blocked/<sha>`             | file an act verdict blocked             | `recordBlockedFile`        | `readBlockedFiles`               |
| `blocks/<sha>.N`            | how often a rule blocked a file         | `incrementBlock`           | `blockCount`                     |
| `stops/stop.N`              | how many Stop checks ran                | `incrementStopChecks`      | `stopCheckCount`                 |
| `unknown/unknown-payload.N` | drift payloads logged this turn         | `incrementUnknownPayloads` | `unknownPayloadCount`            |
| `prompt`                    | the user's prompt                       | `writePrompt`              | `readPrompt`                     |
| `index`                     | scratch git index for snapshots         | `snapshotTree` (git)       | `snapshotTree`                   |

Invariants:

1. Every write is a create, never an update: `createOnce` returns `false` on an
   existing file and the caller counts on that (`recordFileStart` keeps the
   first record, `writePrompt` keeps the first prompt).
2. Counters are monotone within a turn; `increment` retries past a racing
   sibling up to 32 times.
3. Every reader tolerates a missing, torn or unparsable record and returns
   `[]`, `undefined` or a default. Nothing in this module throws.
4. File contents are owner-only (`0o600`, dir `0o700`), because a start-of-turn
   snapshot holds whatever the agent edited.

Reachable invalid states:

- **F3 (high) — a session with no turn id reuses one directory, and the
  `pending` flag from the previous turn survives.** `turn-start` calls
  `clearTurn` only when `turnId === undefined`, before `markBaseline(dir,
"pending")`; every other hook writes into the same directory when the host
  sends no `prompt_id`/`turn_id`. Pi sends none for `agent_before_settle`
  (only `prompt_idOf(ctx)`), and `promptIdOf` returns `undefined` whenever the
  session has no user entry yet. See F3.
- **Counters never reset inside a turn.** `blocks/<sha>.N`, `stops/stop.N` and
  `tool-calls/call.NNNNNN` accrue for the life of the directory. That is the
  design (a per-turn budget), but it means "turn" and "directory" are the same
  thing, which is exactly what F3 breaks.
- **`tool-calls/call.NNNNNN` caps at `MAX_TOOL_CALLS_PER_TURN = 50`.** Past 50
  the 51st call is silently dropped (`recordToolCall` returns). This is a
  _bounded log_, not a _complete log_, and M11 reads it as complete. See F2.

---

## M3 · Turn diff completeness

`turnDiff` in `hooks/stop.ts` is the only path that can produce a "complete"
diff, and `BaselineStatus` is how turn-start tells Stop whether it may trust
git.

```text
   turn-start                              Stop
   ──────────                              ────
   markBaseline("pending")
        │
        ├── isGitRepo? no ──────────────► no baseline, no status
        │                                  → per-file fallback (start snapshots)
        │
        ├── snapshotTree ok ──► writeBaseline ──► markBaseline("ok")
        │                                        → git diff baseline..now
        │
        └── snapshotTree fails ──► markBaseline("failed")
                                   → TurnDiff { kind: "incomplete" }
                                   → silent skip, event kind "skip"
```

| From      | Event                              | To                    | Code                                      |
| --------- | ---------------------------------- | --------------------- | ----------------------------------------- |
| no status | `markBaseline("pending")`          | pending               | `handleTurnStart` before snapshotting     |
| pending   | snapshot ok                        | ok                    | `writeBaseline` then `markBaseline("ok")` |
| pending   | snapshot failed                    | failed                | `markBaseline("failed")`                  |
| pending   | hook died mid-snapshot             | pending (left behind) | nothing; Stop reads pending as failed     |
| ok        | `snapshotTree` at Stop ok          | complete (git)        | `turnDiff`                                |
| ok        | `snapshotTree` at Stop fails       | incomplete            | `turnDiff`                                |
| ok        | no baseline, `readFileStarts` only | complete (files)      | `turnDiff` fallback                       |
| any       | `readBaseline` tampered to non-hex | falls back to files   | `readBaseline` returns `undefined`        |

Invariants:

1. `pending` is written **before** the attempt, so a hook that dies leaves a
   state Stop already treats as failure. Absence of a status is never read as
   success.
2. A diff is all-or-nothing: one file that could not be diffed in time makes
   the whole turn `incomplete` rather than judged in part.
3. `startIds` is `undefined` when git could not answer in time, and `undefined`
   makes every file uncovered — the safe direction.

Reachable invalid states: none found beyond F3's cross-turn `pending`, which is
a property of M2 rather than of this machine.

---

## M4 · Edit coverage chain

Stop re-judges an edit-phase rule on a file only when the judged edits _chain_
from turn-start content to what is on disk now (`lib/coverage.ts`).

```text
 startId ──► [before=A after=B] ──► [before=B after=C] ──► createBlobId(disk)
```

| From    | Event                                          | To                   | Code                             |
| ------- | ---------------------------------------------- | -------------------- | -------------------------------- |
| start   | an unused record whose `before` equals current | advance, drop record | `editsCoverFile`                 |
| start   | no record matches                              | **not covered**      | `editsCoverFile` returns `false` |
| current | equals `createBlobId(disk)`                    | **covered**          | loop exit                        |
| any     | file is blocked this turn                      | forced not covered   | `covered()` in `handleStop`      |
| any     | `startIds === undefined`                       | forced not covered   | same                             |

Invariants:

1. A file changed by a shell, or changed while the judge was looking, breaks the
   chain and is re-judged. The chain is deliberately conservative.
2. `createBlobId` is git's blob id, so a disk read, a tree object and a payload
   compare equal (`schema/ids.ts`).

Reachable invalid states: none. Note the asymmetry it creates with M5: the
coverage machine is conservative (re-judge when unsure), while the budget
machine is permissive (block less when over budget).

---

## M5 · Block / stop budget

Two independent ceilings, both counted on disk:

- `MAX_BLOCKS_PER_RULE_PER_TURN = 2` — after a rule blocks one file twice in a
  turn it only flags (`actingHere` filter in `hooks/postToolUse.ts`).
- `MAX_STOP_CHECKS_PER_TURN = 2` — after two Stop checks in a turn, Stop is
  silent.

| From | Event                        | To               | Code                                                      |
| ---- | ---------------------------- | ---------------- | --------------------------------------------------------- |
| 0    | act verdict on a file        | 1, block         | `incrementBlock`                                          |
| 1    | act verdict on the same file | 2, block         | `incrementBlock`                                          |
| 2    | act verdict on the same file | 2, **flag only** | filter drops it from `actingHere`                         |
| any  | next turn                    | 0                | `clearTurn` on turn-start without a turn id only — see F3 |

Invariants:

1. A tool-call rule has **no** per-turn cap, because the call has not run yet
   and letting it through after a few denials would run it (`toolCallCheck.ts`).
   Edit rules are capped because the edit already happened.
2. The budget is per (rule, file) pair, so a rule cannot be silenced by another
   rule's blocks.

Reachable invalid transitions:

- **F3 (high)** — two prompts that share a directory share these counters, so
  the second prompt inherits a spent budget: its edits are flagged, never
  blocked, and its Stop is silent. The agent is unenforced for the rest of the
  session while every surface still reports "checks are on".

---

## M6 · API-key trust

`key-check.json` in `~/.oh-my-plumb/` holds one row, tied to the key's
fingerprint.

```text
                    ┌──────────┐  noteAuthFailure (1,2 of 3)   ┌───────────┐
   (no row) ───────►│  clean   │ ─────────────────────────────►│  failing  │
                    └────┬─────┘  Auth-failure rows never     └─────┬─────┘
        probeIsDue=true  │        choose this edge; see below      │
        "unknown" probe  │                                        │ 3rd auth failure, or
                         │                                        │ probe 401/403
                         │        ┌─────────────┐                 ▼
                         └───────►│  rejected   │◄────────────────┘
              noteKeyAccepted     └──────┬──────┘   noteKeyRejected
              (probe 200/404/5xx)       │
                                        │ noteKeyAccepted (probe OK)
                                        │ noteKeyWorked (a call worked)
                                        ▼
                                   ┌──────────┐
                                   │  clean   │
                                   └──────────┘
```

| From    | Event                      | To                                | Writer                        |
| ------- | -------------------------- | --------------------------------- | ----------------------------- |
| no row  | any read                   | `probeIsDue = true`, not rejected | `probeIsDue`, `isKeyRejected` |
| clean   | `noteAuthFailure` (1..3)   | clean → rejected at 3             | `keyState.ts`                 |
| failing | `noteAuthFailure` (3)      | rejected                          | same                          |
| any     | probe 401/403              | rejected, `checkedAt = now`       | `noteKeyRejected`             |
| any     | probe 2xx/4xx-non-auth/5xx | clean, `checkedAt = now`          | `noteKeyAccepted`             |
| any     | a real check answers       | clean, `failures = 0`             | `noteKeyWorked`               |
| any     | key replaced               | the old row no longer matches     | fingerprint mismatch          |
| any     | `claimRejectedWarning`     | `warnedSession = session`         | one warning per session       |

Invariants:

1. Rows are keyed by fingerprint, so a replaced key starts clean without
   deleting anything.
2. Only an auth refusal (401/403) is read as a bad key; an outage or a moved
   route is `unknown`, and `unknown` never writes.
3. A refused key is not dialled again: `checkWithModel` throws `AUTH_FAILED`
   from the latch before constructing a model (`jev.ts`).
4. `probeIsDue` is `checkedAt + 24h`, and `checkedAt` only moves on a probe
   answer, so a latched key is re-probed about once a day.

Reachable invalid states:

- **`failures` is unreachable-by-construction below the latch.** `carry()`
  preserves `failures`, and `noteKeyAccepted`/`noteKeyWorked` zero it, so the
  only way to reach `failures = 3` is three `noteAuthFailure` calls. Each of
  those needs a 401 from a real check, and the first `AUTH_FAILED` latches at 3. This is sound; noted only because the state is named "failing" above and is
  never observable from outside `keyState.ts`.
- **A probe that answers `unknown` leaves `checkedAt` untouched**, so the next
  session probes again immediately. Intended (the probe is cheap and read-only),
  but it does mean an unreachable provider costs one 2.5 s probe per session
  start, inside the 8 s session-start budget.
- No way found to reach `rejected` without a provider answer or three real 401s.

---

## M7 · Credential resolution

```text
   findCredentials(root)                    resolveCredentials(root)
   ─────────────────────                    ───────────────────────
   env  → .env.local → .env → ~/.oh-my-plumb/.env     (cached once per process)
                    │
                    ▼
   credentials()  ── env only, never a file, never root
```

| Kind       | Detected by           | Used by                                   |
| ---------- | --------------------- | ----------------------------------------- |
| `typesafe` | `TYPESAFE_AI_API_KEY` | `jev.ts` → `api.typesafe.ai`              |
| `gateway`  | `AI_GATEWAY_API_KEY`  | `jev.ts` → Vercel AI Gateway              |
| `none`     | neither               | every command guard, every hook pre-check |

Invariants:

1. `resolveCredentials` caches on first call and never re-reads. A key written
   mid-process is not picked up — deliberate, since each hook is a fresh process.
2. A key is never a flag and never logged; `login` reads it without echo.

Reachable invalid state:

- **F5 (medium, latent) — two resolution paths disagree.** `credentials()` reads
  only `process.env`; `resolveCredentials()` reads the env _and_ the three files.
  Every hook calls `hasApiKey(root)` (which goes through `resolveCredentials`)
  before reaching `checkWithModel`, so `credentials()` is warm by then and the
  bug is masked **today**. It is one call-site away from firing: any future code
  that calls `checkWithModel` first would throw `NO_API_KEY` for a key that
  exists in `.env`, and `init` would already have reported the key as found.

**Fixed.** `credentials()` is deleted; `checkWithModel` resolves the way every
guard already did, so a key in a `.env` is found on any path. The reproduction
below is what the tree did before, and the second run is now the only behaviour:

Reproduction of the latent mismatch:

```text
$ node --input-type=module -e '… credentials() alone with only .env present …'
credentials() called alone, no prior resolve: none
$ node --input-type=module -e '… resolveCredentials(dir) then credentials() …'
hasApiKey-like resolveCredentials: typesafe | credentials() in jev: typesafe
```

---

## M8 · Rubric load

`loadRubric` merges the project rubric and the global one, project winning on an
id clash, and reports `off` when either says `enabled: false`.

```text
   rubric.json missing ──► (undefined)          ┐
   rubric.json unparsable ──► problems[] + (undefined) ┤ merged with the other scope
   rubric.json invalid  ──► problems[] + (undefined) ┘
   rubric.json ok       ──► Rubric
                │
                ├── enabled === false ──► rules = [] , off = "project" | "global"
                └── otherwise         ──► mergeRules(project, global)
```

| From              | Event            | To                               | Effect                                                               |
| ----------------- | ---------------- | -------------------------------- | -------------------------------------------------------------------- |
| missing + missing | any hook         | `rules = []`, no `off`           | silent, indistinguishable from "nothing to check"                    |
| invalid           | any hook         | that scope ignored, `problems[]` | `debug` only; the session-start notice is the only place it surfaces |
| ok                | `enabled: false` | `rules = []`, `off` set          | session start explains it; every hook silently stands down           |
| ok + ok           | id clash         | project rule wins                | `mergeRules`                                                         |

Invariants:

1. A scope that cannot be read never takes the other scope down with it.
2. `off` outranks everything: a stood-down rubric loads zero rules, so no hook
   spends anything.

Reachable invalid states:

- **F6 (medium) — a project rubric that is `off` also stands down the _global_
  rubric, and vice versa.** `off === "project" ? … : global?.enabled === false`
  collapses both scopes into `rules: []`. A user who runs `oh-my-plumb disable
--project` in one repository therefore silences the machine-wide rubric in
  that repository too. Defensible as "this project opted out", but it is not
  what `enable --project`'s message says, and nothing in `report` shows the
  global rules as suppressed rather than absent.

---

## M9 · Rubric freshness / compile

```text
   (no rubric) ──► missing ──┐
   sources changed ──► stale ─┤──► planCompile ──► targets[] ──► session-context
   sources equal   ──► fresh ─┘                        │
   rubric invalid ──► invalid ──► notice, no target     └──► (none) ──► silent
```

| From    | Event             | To                                | Code          |
| ------- | ----------------- | --------------------------------- | ------------- |
| missing | any session start | compile target                    | `planCompile` |
| fresh   | any session start | no target, silent                 | same          |
| stale   | any session start | compile target                    | same          |
| invalid | any session start | `invalid[]` notice, **no** target | same          |
| fresh   | `rubric validate` | shas refilled, matchers synced    | `runRubric`   |
| stale   | `rubric validate` | same                              | same          |

Invariants:

1. Staleness is a hash comparison, never a timestamp: `checkStaleness` compares
   `sha256` per source and reports `changed`, `removed`, `unhashed`, `added`
   separately so the compile prompt can name what moved.
2. `required: false` sources (personal overrides, skills, CONTRIBUTING) are
   listed but never make a teammate stale.
3. A source with no stored sha counts as `unhashed`, not `fresh`.

Reachable invalid states:

- **A guard rule's `check.scope` is not a source and never stales.** Editing the
  instruction line a guard came from, without changing that file's bytes,
  leaves a guard pointing at the old rule text. Latent, and by design (the rule
  text is copied into `check.text`).
- **`mcpWhenDue` starts opted-in MCP servers inside the 8 s session-start
  budget** (`GUARD_TIMEOUT_MS` = 2 s each, run in parallel). Three slow servers
  and the session-start hook is killed at its deadline — silently, and the
  compile context never arrives. Same shape as F4, but bounded and rarer; not
  filed.

---

## M10 · Rule selection

```text
   rule.status === "active"?
        │ no ──► never selected
        │ yes
        ▼
   rule.check.type === "model"?
        │ no ──► only code/guard rules reach their own runners
        │ yes
        ▼
   rule.target === target (diff | toolCall) AND rule.when === phase?
        │ no ──► never selected
        │ yes
        ▼
   scope applies to ≥1 file (diff) / to the tool (toolCall)?
        │ no ──► never selected
        │ yes
        ▼
   rule sourced from a SKILL.md?
        │ yes ──► only if the turn's log names that skill folder
        ▼
   selected
```

| State                            | Meaning                                  | Code                                                   |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| selected, judged                 | a model call is made                     | `runCheck`, `runToolCallCheck`, `runTurnToolCallCheck` |
| selected, settled                | a precondition decided it                | `settlePreconditions`                                  |
| not selected, out of phase       | another hook's business                  | `runsInPhase`                                          |
| not selected, out of scope       | would cost tokens for nothing            | `ruleAppliesTo`                                        |
| not selected, skill not loaded   | a skill's rules bind only a loading turn | `filterToLoadedSkills`                                 |
| not selected, `status != active` | calibrated away                          | `runsInPhase`                                          |

Invariants:

1. `judgesDiff` classifies every `target` with an exhaustive switch, so adding a
   target fails the build until every pipeline handles it.
2. A diff rule never sees a call, and a call rule never sees a diff.
3. Scope is checked twice: once to select, once again in `groupByScope`, so a
   rule can never be handed a file outside its scope.

Reachable invalid states:

- **F1 (high) — a `diff`-target rule carrying a `precondition` is selected into
  the turn tool-call check with an empty log, and settles at `act`.** See F1.
- **A skill's rules and the SKILL.md read are matched by _summary text_, not by
  path.** `filterToLoadedSkills` looks for the skill's folder name as a whole
  word anywhere in any call's summary. A `Bash` call whose command happens to
  contain the skill's name enables that skill's rules for the turn — and a
  `read` of the SKILL.md is only forwarded to the log by the Pi plugin, not by
  the Claude/Codex hooks (whose `PostToolUse` matcher does not include `Read`).
  Filed as F7 (low).

---

## M11 · Verdict banding

Every judge answer becomes one number in `[0,1]`, then one band.

```text
   question type ──► violationProbability ──► probability
                                                  │
                    ┌─────────────────────────────┼──────────────────────────┐
                    ▼                             ▼                          ▼
              ≥ thresholds.act            ≥ thresholds.flag            below
                  "act"                       "flag"                   "clear"
```

Preconditions bypass the judge entirely and produce only `act` or `clear`:

| Rule shape                  | `changes` unmet                   | `ran` matched | `ran` unmatched | otherwise |
| --------------------------- | --------------------------------- | ------------- | --------------- | --------- |
| `precondition.changes` only | `clear` (`precondition: "unmet"`) | —             | —               | judge     |
| `precondition.ran` only     | —                                 | `clear`       | `act`           | judge     |
| both                        | `clear`                           | `clear`       | `act`           | judge     |

Invariants:

1. Defaults are `act = 0.8`, `flag = 0.5`; `thresholdsSchema` refuses `flag >= act`.
2. A settled verdict is **recorded**, not dropped, so `report` can tell "asked
   and passed" from "never in play" (`precondition: "unmet"`).
3. A settled verdict never claims `flag`; only a judge is allowed to be unsure
   (`preconditionFuzz.test.ts` asserts this over 200 generated cases).

Reachable invalid states:

- **F2 (high) — `ran` reads a log that stops at 50 entries, so a gate that ran
  after call 50 settles at `act`.** See F2.
- **`SettlePrecondition` trusts a precondition on the wrong target.** See F1.

---

## M12 · Guard execution

```text
   route ──► runGuard (command)        ──┐
          ├─► runGuard (skill script)  ──┤ 2 s deadline, silent pass on any failure
          ├─► runMcpGuard (MCP tool)   ──┤
          └─► runCodeCheck (inline js) ──┘ 500 ms CPU deadline, fresh vm realm
                                             │
                          { isError: true }  │  anything else
                                    ▼        ▼
                                  block     silent pass
```

| From           | Event                                         | To                  | Code                                                           |
| -------------- | --------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| route resolved | command spawns, exits 0 with `{isError:true}` | hit                 | `runGuard`                                                     |
| route resolved | no output / bad JSON / non-zero / timeout     | silent pass         | `runGuard`                                                     |
| route resolved | skill file missing at run time                | silent pass         | `resolveSkillGuard` was `undefined` at build time, so no route |
| MCP route      | any protocol failure                          | silent pass         | `mcpSession`                                                   |
| code route     | returns `{isError:true}`                      | hit                 | `runCodeCheck`                                                 |
| code route     | throws, times out, or returns anything else   | silent pass         | `runCodeCheck`                                                 |
| code route     | leaves a rejected promise                     | silent pass + debug | drain in `runCodeCheck`                                        |

Invariants:

1. A guard never breaks the agent: every failure is a silent pass with a
   `debug` line, never a throw.
2. The code sandbox is `Object.create(null)` **and** the file text is passed as
   source, not as a sandbox property, so `globalThis.constructor.constructor`
   has no host object to climb.
3. `node:vm` is a fence, not a wall; the rubric author is trusted.

Reachable invalid state:

- **F4 (high) — the guard deadline cannot interrupt synchronous CPU, and the
  rule text is attacker-adjacent input.** `vm.runInNewContext` is bounded by
  `CODE_CHECK_TIMEOUT_MS`, but `runGuard`'s `setTimeout` only fires between
  macrotasks and the child is killed with `SIGKILL` — fine. The unbounded one
  is `precondition.ran.pattern` and `check.pattern`, compiled from the rubric by
  Node's own engine, with no deadline at all. See F4.

---

## M13 · Event log

`<repo>/.oh-my-plumb/events.jsonl`, one `eventSchema` record per line.

| Event kind        | Written by                                   | Phase           |
| ----------------- | -------------------------------------------- | --------------- |
| `check`           | `handleEdit`, `handleToolCall`, `handleStop` | `edit` / `turn` |
| `skip`            | no key, diff too large, turn diff incomplete | `edit` / `turn` |
| `error`           | a check threw                                | `edit` / `turn` |
| `compile-needed`  | session start                                | —               |
| `unknown_payload` | a payload the schema rejected                | —               |

| From                          | Event                    | To                                                              | Code                               |
| ----------------------------- | ------------------------ | --------------------------------------------------------------- | ---------------------------------- |
| size ≤ `EVENTS_LOG_MAX_BYTES` | session start            | untouched                                                       | `trimEvents`                       |
| size > cap                    | session start            | newest cap-sized window, schema-valid lines only, atomic rename | `trimEvents`                       |
| any                           | a check appends mid-trim | line lost                                                       | commented: telemetry, safe to lose |
| any                           | a torn line at read      | skipped                                                         | `readEvents`                       |

Invariants:

1. The log never takes a hook down: every writer is wrapped.
2. Trimming keeps the newest window, so `report` and `tune` see recent checks.
3. A payload's _input and output_ never reach the log; only `kind`, `at`,
   `sessionId` and the tool's name (`appendUnknownPayload`).

Reachable invalid state: none found. `trimEvents` reads a tail window and then
drops the first (possibly partial) line, which is correct only if at least one
newline exists in the window — a log over the cap with no newline (one giant
line) is left alone rather than truncated. Bounded, and not filed.

---

## M14 · Update notice

```text
   update-check.json ──► older than 24 h? ──► npm view ──► write {checkedAt, latest}
                                    │ no                        │
                                    └───────────────────────────┴──► newerThan(running)?
                                                                          │ yes      │ no
                                                                          ▼          ▼
                                                                       notice     silent
```

| From                 | Event         | To                                   | Code                                     |
| -------------------- | ------------- | ------------------------------------ | ---------------------------------------- |
| no state             | session start | check, write                         | `updateNotice`                           |
| state < 24 h         | session start | reuse                                | same                                     |
| state ≥ 24 h         | session start | check, write                         | same                                     |
| running `"unknown"`  | any           | silent                               | `updateNotice`                           |
| registry unreachable | any           | write `latest = running` (no notice) | `latestFromRegistry` returns `undefined` |

Invariants:

1. A failed registry read writes `latest = running`, so a failed check never
   produces a "there is an update" notice.
2. Version comparison is numeric-prefix per segment, so `0.3.10 > 0.3.9`.

Reachable invalid state: `numericPrefix` reads `0` from any segment without
leading digits, so `"1.0.0-beta"` compares as `1.0.0`. Pre-release ordering is
not modelled; the package publishes plain semver, so this is unused, not wrong.

---

## M15 · Hook installation

```text
   uninstalled ──► init ──► installed ──► rubric gains a toolCall rule
                      ▲          │              │
                      │          │              ▼
                      │          │        matchers widened (PreToolUse added)
                      │          │        rubric loses it ──► PreToolUse removed
                      └──────────┴── uninstall
```

| From      | Event                         | To                                | Code                   |
| --------- | ----------------------------- | --------------------------------- | ---------------------- |
| installed | `installHooks`                | ours rewritten whole, others kept | `settings.ts`          |
| installed | rubric gains a tool-call rule | `PreToolUse` + wider matcher      | `syncToolCallMatchers` |
| installed | rubric loses the last one     | `PreToolUse` dropped              | same                   |
| installed | `uninstall`                   | ours removed, others kept         | `uninstallHooks`       |
| any       | settings JSON invalid         | `SETTINGS_INVALID` thrown         | `readSettings`         |

Invariants:

1. Only entries whose command contains `oh-my-plumb-hook.js` are ever touched.
2. A group shared with another hook keeps theirs.
3. `syncToolCallMatchers` only touches files that already carry our hooks.

Reachable invalid state:

- **F7 (low) — the installed matcher decides what a hook ever sees.** The
  Claude/Codex `PostToolUse` matcher is
  `Edit|Write|MultiEdit|apply_patch|Bash|mcp__.*|Skill` when tool-call rules
  exist. A `Read` of a `SKILL.md` is therefore never logged on those hosts, so a
  skill-scoped rule can only be "loaded" by side effect (its name appearing in
  another call's text). See F7.

---

## M16 · Host plugin session

Each plugin keeps an in-memory map keyed by session id, because the host gives
no turn boundary on every event.

```text
   no session ──► (seeded on the host's first event)
                       │
                       ├─ boundary changed ──► Stop for the *previous* turn ──► turn-start
                       └─ end ──► (dropped with the process)
```

| Host           | Session start | Turn start           | Turn end                   | `prompt_id` sent                       |
| -------------- | ------------- | -------------------- | -------------------------- | -------------------------------------- |
| Claude / Codex | hook          | hook                 | hook                       | from the payload                       |
| OpenCode v1/v2 | first request | synthesized `turn-N` | `session.context` boundary | synthesized                            |
| Pi             | hook          | **none**             | `agent_before_settle`      | `promptIdOf(ctx)` — can be `undefined` |
| Oh My Pi       | hook          | **none**             | `session_stop`             | `promptIdOf(ctx)` — can be `undefined` |

Invariants:

1. Nothing in a plugin may throw into the host, with one deliberate exception:
   v2's `execute.before` throws to deny a call, which is the documented way.
2. A `note` that has nowhere to go (v2 has no log API on those hooks) is
   dropped; the flag band never blocks, which is the whole of its contract there.

Reachable invalid states:

- **F3** — the Pi/omp row is the one that leaves `prompt_id` undefined, and that
  is what makes M2's shared directory real for those hosts. `promptIdOf`'s own
  doc block says the shared directory makes "a turn rule read the previous
  prompt's calls as this turn's"; the mitigation is the user-entry id, and it
  is absent on the first run of a session.
- OpenCode's `s.turnId` starts `undefined` and is only assigned at the end of
  the first request, so the first `execute.before` of a session sends no
  `prompt_id` either. Same machine, same mutation.

---

## Findings

Ordered by impact. "Confirmed" means reproduced on this machine, and the
runnable lines are included so a reviewer can re-run them.

### F1 · A precondition on a `diff` rule settles the rule with no call and no judge — fixed, high

**Impact.** A rule compiled with `check.precondition.ran` but the default
`target: "diff"` can never be met, because the log it reads is never populated
for it: the diff pipeline calls `runCheck`, which never passes `turn`. Any turn
that changes an in-scope file therefore settles that rule at `act` and blocks —
for ever. The rubric author follows `skills/oh-my-plumb-compile` Step 4, which
tells them to "write a `precondition` whenever the rule has one", and nothing
stops them leaving `target` at its default.

**Evidence.**

```text
$ node --input-type=module -e '… rubricSchema.safeParse(rule with target defaulted,
    when:"turn", check.precondition.ran) …'
diff-target rule + precondition accepted by the schema: true
target: diff | precondition: {"ran":{"arg":["command"],"pattern":"\\bpnpm test\\b"}}
```

`lib/precondition.ts` returns `act` for an unmatched `ran` with no regard to
the rule's target:

```ts
if (precondition.ran !== undefined) {
  return callRan(state.log, precondition.ran)
    ? { ruleId: rule.id, probability: 0, band: "clear" }
    : { ruleId: rule.id, probability: 1, band: "act", … };
}
```

And `hooks/stop.ts` feeds the diff pipeline no `turn` at all:

```ts
runCheck({ phase: "turn", fileDiffs: bounded, task, rules: judged, … })
```

`ruleSchema.superRefine` already refuses `precondition` outside `when: "turn"`;
it does not refuse it on a `diff` target. That is the missing guard.

**Invalid state reached.** `(target=diff, precondition.ran set)` is a state the
type system permits, the schema permits, and `settlePrecondition` mishandles.

**Fixed.** `ruleSchema.superRefine` now asks for `target: "toolCall"` when a
model rule carries a precondition, so the impossible pair cannot be compiled
into a rubric. `precondition.test.ts` "refuses a precondition on a diff target"
fails without it.

---

### F2 · A turn's tool log stops at 50 calls, and `ran` reads it as complete — fixed, high

**Impact.** `recordToolCall` returns without writing once `order >
MAX_TOOL_CALLS_PER_TURN` (50). `readToolCalls` also slices to 50. A rule whose
`precondition.ran` names a gate the agent ran in call 51 — "run the tests
before you finish" in a long turn — settles at `act`: a false block from a
_deterministic_ test, which is the one place this product claims certainty.

**Evidence.** `lib/session.ts`:

```ts
const order = countWithPrefix(calls, "call.") + 1;
if (order > MAX_TOOL_CALLS_PER_TURN) return;
```

`lib/session.ts` again, on read:

```ts
return entries.sort((a, b) => a.order - b.order).slice(0, MAX_TOOL_CALLS_PER_TURN);
```

The cap is deliberate (`constants.ts`: "which tools ran, not every call a long
turn makes"), but it is documented as a _sampling_ limit and consumed as a
_completeness_ guarantee. A long turn is the normal case for the rules this
machine exists to serve.

**Invalid state reached.** `(ran rule, gate ran but not in the first 50 calls)`
settles `act` where the truth is `clear`.

**Fixed.** The 51st call now writes a `capped` marker beside the log, `Stop` passes
`logComplete: toolLogIsComplete(dir)`, and `settlePrecondition` returns
`undefined` (the judge decides) when the log was cut. A rule that read a
_sample_ as a _fact_ was the bug; the sample itself is fine for `report`.

---

### F3 · A session with no turn id reuses one turn directory, counters included — fixed on pi/omp, open in OpenCode v2, high

**Impact.** Pi and Oh My Pi never send `UserPromptSubmit`, and
`promptIdOf(ctx)` returns `undefined` until the session has a user entry.
Every hook then writes to `sessions/<session>/turn/`, the same directory for
every prompt in the session. Two consequences, both silent:

1. `blocks/<sha>.N` and `stops/stop.N` carry over. After the first prompt has
   spent its budget, later prompts are **flagged, never blocked**, and Stop is
   **silent** — enforcement is off for the rest of the session while the UI
   still says checks are on.
2. A `baseline-status: pending` left by a crashed turn-start makes every later
   Stop in that session return `incomplete` and skip.
3. Every turn's calls accumulate in one 50-entry log, so F2 fires sooner.

**Evidence.** `hooks/turnStart.ts`:

```ts
if (turnId === undefined) clearTurn(dir);
```

That is the only reset, and it runs only in `turn-start`, which Pi never
invokes. `lib/session.ts`'s own comment names the consequence for the log:
"with no id they share a directory per session, and a turn rule reads the
previous prompt's calls as this turn's".

**Invalid state reached.** `(turn directory carrying another turn's budget)`.

**Fixed for pi and omp.** The extension now files a run under
`promptIdOf(ctx) ?? run-N`, counted once per settled run, so two
prompts of one session can no longer share a directory.
`piExtension.test.ts` — "files each prompt of one session under its own turn
directory" — fails without it. OpenCode's first request of a session still sends
`prompt_id: undefined`, because `oh-my-plumb-v2.js` assigns `s.turnId` only at
the end of that request, so the same shape remains there.

---

### F4 · A rubric-supplied regular expression runs with no deadline — fixed, high

**Impact.** Two rubric fields are compiled and executed on the hook's main
thread with no bound: `check.precondition.ran.pattern`
(`lib/precondition.ts`, `new RegExp(ran.pattern)`) and `check.pattern`
(`lib/tier1.ts`, `toRegExp`). A catastrophically backtracking pattern turns
every edit in the repository into a hook that runs until the host's deadline,
which the product's own contract calls a bug report of the first order.

**Evidence.**

```text
$ node -e 'const re=/(a+)+$/; const s="a".repeat(30)+"b"; const t=Date.now(); re.test(s); …'
ms 244940
```

`precondition.test.ts` proves the pattern is consulted against real log text
("is only as precise as the pattern the rubric author wrote"), and
`preconditionSchema` validates only that the pattern _parses_:

```ts
.refine((m) => { try { new RegExp(m.pattern); return true; } catch { return false; } })
```

**Invalid state reached.** `(rubric rule whose pattern backtracks superlinearly)`.

Reachability note: the rubric is a committed file the repository author writes,
and the compile skill is what writes it. That makes this a supply-chain and
"agent wrote a bad pattern" risk rather than a remote-attacker one — but the
blast radius is the whole coding session, which is exactly what `AGENTS.md`
forbids.

---

### F5 · `credentials()` and `resolveCredentials()` disagree about `.env` — fixed, medium

**Impact.** `checkWithModel` uses `credentials()`, which reads `process.env`
only. `hasApiKey` and the session-start probe use `resolveCredentials`, which
reads the env and three files. Today every path to `checkWithModel` first calls
`hasApiKey`, which warms the cache, so the mismatch is invisible. Any new
caller — a command, a future MCP tool, a test — that reaches the model path
first throws `NO_API_KEY` for a key that `init` just reported as found.

**Evidence.** the two `node --input-type=module` runs in M7: `credentials()`
alone → `none`; `resolveCredentials(dir)` then `credentials()` → `typesafe`,
with `TYPESAFE_AI_API_KEY` present only in `<repo>/.env`.

**Invalid state reached.** `(key in a file, model path reached first)`.

---

### F6 · One scope's `disable` silences the other scope's rules — open, medium

**Impact.** `loadRubric` returns `rules: []` whenever _either_ rubric is
`enabled: false`, so `oh-my-plumb disable --project` in one repository also
stands down the machine-wide rubric there. The message the user gets names only
the scope they disabled.

**Evidence.** `lib/loadRubric.ts`:

```ts
return { project, global, rules: off === undefined ? mergeRules(project, global) : [], … };
```

`offNotice` then names one place, and `report` shows no rules at all rather than
showing the global ones as suppressed.

---

### F7 · A skill's rules are enabled by text, and the SKILL.md read is not logged on every host — open, low

**Impact.** `filterToLoadedSkills` enables a skill's rules when the skill's
folder name appears as a whole word in any call's summary. The intended signal
is the agent reading `<skill>/SKILL.md`; the Pi plugin forwards that `read` to
the log, but the Claude/Codex `PostToolUse` matcher
(`Edit|Write|MultiEdit|apply_patch|Bash|mcp__.*|Skill`) never sees `Read`. So on
those hosts a skill's rules are either enabled by coincidence (the name appears
in a shell command) or not at all.

**Evidence.** `lib/settings.ts` `hookSpecs` builds that matcher;
`lib/skillScope.ts` matches on `call.summary` only, with the comment "Only the
arguments name a skill: a skill called `bash` is not loaded by every bash call".

---

## Issues, grouped

The table says what each group is and what state it is in. A group is closed when
its fix is in this tree and a test fails without it; the tests named are the ones
that fail.

| Issue                                         | Findings              | State               | The change                                                                                                                                                  | The test that fails without it                                                                                                 |
| --------------------------------------------- | --------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **A · A settled precondition must be honest** | F1, F2                | **fixed**           | `rubricSchema` refuses a precondition on a non-`toolCall` target; the log writes a `capped` marker past 50 calls and `ran` then hands the rule to the judge | `precondition.test.ts` "refuses a precondition on a diff target"; `preconditionFuzz.test.ts` "a truncated log is not evidence" |
| **B · One turn, one directory**               | F3                    | **fixed on pi/omp** | The pi extension files a run under `promptIdOf(ctx) ?? run-N`, counted per settled run; OpenCode v2 still assigns its first turn id only after the request  | `piExtension.test.ts` "files each prompt of one session under its own turn directory"                                          |
| **C · No regex runs unbounded**               | F4                    | **fixed**           | `lib/pattern.ts` refuses the nested-quantifier shape and caps the input at 4 000 characters; `precondition.ts` and `tier1.ts` run through it                | `pattern.test.ts`: the 245-second pattern is refused, real spellings still run                                                 |
| **D · One credential resolver**               | F5 (fixed), F6 (open) | **half fixed**      | `credentials()` is deleted, so `checkWithModel` runs on `resolveCredentials`; F6 is untouched, `loadRubric` still collapses both scopes into `rules: []`    | `credentials.test.ts` (M7's second reproduction is now the only behaviour)                                                     |
| **E · A skill loads by its path**             | F7                    | open                | Match the log entry against the `SKILL.md` path rather than the folder name as free text                                                                    | `skillScope.test.ts`: a command containing the skill's name does not enable it                                                 |

---

## Merged and released

`2c8089d` (squash of [PR #81](https://github.com/irfndi/oh-my-plumb/pull/81))
carries F1–F5 on `master`. cli 0.3.7 and schema 0.3.5 published from `997d917`,
whose tree is byte-identical to the merge commit's, so the released artifact is
the reviewed one. F6 and F7 stay open on purpose: F6 needs a decision about what
`disable --project` means, F7 is a matcher change nobody has asked for yet.

### The slow gate, diagnosed

`npxInstall.test.ts` went red while the release was being cut, three full-suite
runs in a row. The first reading — "load made it flaky, raise the timeout" — was
half right and stopped one step short of the cause.

`init` under npx copies its runtime out of the npx cache so hooks survive the
cache being cleared (`copyOutOfNpx`). The test does that twice on purpose: once
to install, once to repair a trimmed copy. Measured here, one copy is
**12 394 files and 92.7 MB** through `cpSync(…, { dereference: true })`, about
8.6 s idle. Two of those, and a spawn budget of 60 s, is a test that passes on a
quiet machine and times out on a busy one.

The fixture was the larger half of it. It linked **every** package in the
workspace's `node_modules` into the fake npx cache — typescript, vite-plus,
oxlint, `@voidzero-dev` — because it read the directory instead of the package's
`dependencies`. An npm install never puts a devDependency beside the package, so
the fixture was not the layout its own comment claimed, and it copied **317 MB**
instead of 92.7 MB. Reading `dependencies` fixed that.

What is left is real and unfixed on purpose: `init` spends ~9 s copying a
dependency closure that includes `ink`, `react` and `ink-spinner`, which only the
interactive CLI uses and no hook ever loads. Pruning that is a change to the
"the copy must stand alone" invariant, which is the one thing keeping hooks alive
after an npx cache clear, so it belongs in its own change with its own test, not
in a release bump.

---

## Keeping this file true

Every row names a function. When one of those functions changes shape, the table
row changes with it, and the review question is the one this file exists to ask:
_does the read side still see a state the write side can produce?_

The three cheapest checks, in the order they catch the most:

1. `grep -n "clearTurn\|turnDir\|turnIdOf" packages/cli/src` — every F3-shaped bug
   is a writer and a reader disagreeing about where a turn lives.
2. `grep -n "new RegExp\|toRegExp\|picomatch" packages/cli/src` — every F4-shaped
   bug is a pattern from the rubric meeting an unbounded input.
3. `grep -n "slice(0, MAX_\|>= MAX_\|> MAX_" packages/cli/src` — every F2-shaped
   bug is a bounded store read as if it were complete.
