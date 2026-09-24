<p align="center">
  <img src="assets/logo/oh-my-plumb-icon.svg" width="120" height="120" alt="oh-my-plumb logo: a faceted brass plumb bob hanging true over a level mark">
</p>

<h1 align="center">oh-my-plumb</h1>

<p align="center">
  <em>Coding agents break your rules from the very first edit. oh-my-plumb catches every one and makes your agent fix it</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenCode%20%C2%B7%20Pi%20%C2%B7%20Oh%20My%20Pi-111111?style=flat-square" alt="Works with Claude Code, Codex, OpenCode, Pi and Oh My Pi">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center">
  <strong>1 in 13 turns break a rule no linter can catch &middot; oh-my-plumb does  &middot; 0.4 to 1.3 s per check &middot; a tenth of a cent per turn</strong><br>
  <sub>Measured by replaying 93 real Claude Code sessions (1,256 edits, 147 turns) in two repos against their own AGENTS.md, for 22 cents. Jev flagged 39 edits and 15 turns; an independent reviewer confirmed 10 and 11. The turn-level catches (single-use abstractions, oversized files, duplicated logic) held up 11 times in 15. Method, per-rule table and what was wrong: <a href="benchmarks/replay/README.md">benchmarks/replay</a>.</sub>
</p>

---

```
npx oh-my-plumb login    # paste your TypeSafe key once
npx oh-my-plumb init     # hooks into every agent on this machine
```

Then start `claude`, `codex`, `opencode`, `pi` or `omp` as usual. That is the whole setup.

## What it does

Your AGENTS.md, CLAUDE.md and the rest of your project instructions are full of rules no linter can check. "Use Yup, don't validate by hand." "No helper with one caller." "Never let a raw error reach a user." "Don't add what wasn't asked for." Nothing can script those, so nothing enforces them. In 93 real sessions, the agent broke one on 1 turn in 13, from the first edit on.

https://github.com/user-attachments/assets/78c91eea-5533-4262-b8c9-de1be37ef202

<sub>40 seconds on pi, recreated from a real run: the scores and timings are the ones Jev logged.</sub>

oh-my-plumb enforces exactly those rules. On every edit (or turn) it asks [Jev](https://typesafe.ai), TypeSafe's decision model, one question per rule and gets a probability back. Jev sees the rule and the diff, never the conversation, so edit 200 is checked like edit 1. Break a rule and the agent is told which one and fixes it in the same turn.

- One call per edit, 0.4 to 1.3 s, a few thousandths of a cent.
- Rules a linter could check are handed to your linter instead.
- No built-in rules. No instruction files, nothing to enforce.
- Your key, your data. Nothing here talks to a server of ours.

## Not previously possible

Checking every edit against every rule was never worth doing with an ordinary LLM. A check is about 2,500 tokens. At typical model prices that is a cent or more, and a few seconds, per edit, and the answer comes back as prose you then have to parse and cannot fully trust. Two hundred edits a day made it a non-starter.

Jev changes the arithmetic. It is a decision model, so it answers a typed question with a calibrated probability and nothing else. There is no free text, so there is nothing to make up. It is up to 100x cheaper than a typical LLM and answers in about a second. That is what makes it reasonable to check every edit, every time.

## Three minutes to the first catch

1. Get a TypeSafe API key at [typesafe.ai](https://typesafe.ai), or use a Vercel AI Gateway key you already have.
2. Run `npx oh-my-plumb login` and paste it. It is stored once, in `~/.oh-my-plumb/.env`, owner-only. A `.env` at the repo root works too, as `TYPESAFE_AI_API_KEY=...`.
3. Run `npx oh-my-plumb init` in your repo.
4. Start your agent. Its first turn compiles your rules into `.oh-my-plumb/rubric.json` and tells you what it found.
5. Ask for something your rules forbid. An AGENTS.md that says "use Yup, never validate by hand" produces this the moment the agent writes a manual guard:

```
oh-my-plumb: This edit appears to break a rule from this repository's instructions.
- Rule "api-validation-uses-yup" from ~/.codex/AGENTS.md line 65: "When writing API endpoints, do NOT write input validations manually. Use Yup (with clear validation messages) + early return in the API handler". (0.86)
Repair apps/web/src/pages/api/logout.ts now, then continue with the task.
```

The agent repairs it before moving on. No human in the loop.

## Agents

| Agent       | Install                         | Where it lands                              |
| ----------- | ------------------------------- | ------------------------------------------- |
| Claude Code | `npx oh-my-plumb init claude`   | `~/.claude/settings.json`                   |
| Codex       | `npx oh-my-plumb init codex`    | `~/.codex/hooks.json`                       |
| OpenCode    | `npx oh-my-plumb init opencode` | `~/.config/opencode/plugins/oh-my-plumb.js` |
| Pi          | `npx oh-my-plumb init pi`       | `~/.pi/agent/extensions/oh-my-plumb.ts`     |
| Oh My Pi    | `npx oh-my-plumb init omp`      | `~/.omp/agent/extensions/oh-my-plumb.ts`    |

`init` with no name installs into every agent it finds. Add `--project` to install into the repo instead, so teammates get it with the checkout.

Codex only: start `codex`, type `/hooks`, and accept the four oh-my-plumb entries. Codex asks this once for any new hook. Codex edits through `apply_patch`; oh-my-plumb reads the patch and judges every file in it.

OpenCode only: there are no hook processes, so oh-my-plumb runs as a plugin. Both versions work: `init` reads `opencode --version` and installs the module that version loads, v1's or v2's. The v2 plugin was written against the `v2` branch at commit `0bc8b8dbeb9540842ae5a69bb5c9af3182999522` (September 2026).

Pi only: oh-my-plumb runs as an in-process extension. It reads each file before pi's `edit` or `write` runs, so the check sees the real diff. Same checks, same messages: an edit that breaks a rule gets the repair request appended to its tool result, and the turn check runs once, when pi is about to stop, asking for one more round if something is still broken. A `--project` install lands in `.pi/extensions/`, which pi loads only in a trusted project: accept pi's trust prompt, or pass `--approve` to `pi -p`.

Oh My Pi only: `omp` loads the same extension from its own directories, `~/.omp/agent/extensions/` or, with `--project`, `.omp/extensions/`. The turn check hooks omp's `session_stop` instead of pi's `agent_before_settle`.

## See what your codebase already breaks

```
oh-my-plumb audit src/
```

Every file is judged as if it had just been written. You get a table by rule and a list by file. On 33 API routes of a real Next.js app: 12 seconds, about a cent.

## Commands

| Command                         | What it does                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `oh-my-plumb login`             | store your TypeSafe key in `~/.oh-my-plumb/.env`                                   |
| `oh-my-plumb init [agent]`      | install the hooks (`claude`, `codex`, `opencode`, `pi`, `omp`, or every one found) |
| `oh-my-plumb audit [paths]`     | judge existing files, report by rule and by file                                   |
| `oh-my-plumb check [paths]`     | check uncommitted changes the way the hooks would                                  |
| `oh-my-plumb report`            | your rules, what fired, what never fires                                           |
| `oh-my-plumb replay <agent>`    | judge this repo's past sessions in any of the three agents                         |
| `oh-my-plumb compile`           | compile the rubric now instead of at the next session                              |
| `oh-my-plumb calibrate`         | score every rule against your recent git history and recorded tool calls           |
| `oh-my-plumb tune`              | rewrite the rules that never fire                                                  |
| `oh-my-plumb bench`             | latency and spend, measured on your machine                                        |
| `oh-my-plumb uninstall [agent]` | remove the hooks                                                                   |

`report`, `check`, `audit`, `bench` and `calibrate` take `--json`.

## The rubric is yours

`.oh-my-plumb/rubric.json` is a committed, readable file. Every verdict names a rule in it, and every rule quotes the line of your instruction file it came from. A wrong verdict is a rule you can rewrite.

- Each rule runs at one of two moments: `edit` after each edit, `turn` once at the end against the whole diff. "Did this add more than was asked" has no answer after edit 1 of 12.
- Each rule can carry a `scope` of globs, so an API route and a stylesheet get different questions.
- Verdicts are banded. 0.8 and above: the agent is told to repair. 0.5 to 0.8: you see a note, the agent does not. Below 0.5: nothing.
- A badly worded rule scores 0.4 on everything and never fires. `calibrate` finds those against twenty real hunks from your history and switches them off. `tune` has the agent rewrite them.
- An MCP server can send rules when it starts. To compile them too, list the server in the rubric: `"mcpInstructions": ["postgres"]`. The next compile reads what the server sends and turns it into rules about that server's tools. Nothing is read unless you list the server.

## Guard scripts

Some rules are exact. "Use `type`, not `interface`" is one: either the word is in the file or it is not. For those, you can ship a guard script instead of asking the model, and it wins three ways:

- Exact: the same file gets the same verdict every time, with no score to band.
- Local: the script runs inside the hook, so the diff never leaves your machine.
- Free: no tokens, no API call.

A guard is an executable script committed with your repo. The hook finds it at `<dir>/<name>/guard.mjs` (`guard.js` and `guard.sh` also work), searching `.pi/skills/`, then `skills/`, then `.claude/skills/`, and takes the first match. The hook runs the file directly, so it needs a shebang line and the executable bit. That works on macOS and Linux; on Windows the script cannot start, and the guard never runs. [`skills/no-interface`](skills/no-interface) is a working example. A rubric rule points at it with a `guard` check:

```json
{
  "id": "type-not-interface",
  "text": "Use `type`, not `interface`.",
  "source": { "path": "AGENTS.md" },
  "check": {
    "type": "guard",
    "skill": "no-interface",
    "scope": "{*.ts,*.tsx}",
    "text": "Use `type`, not `interface`."
  }
}
```

`scope` is the glob of files the guard watches. A check may carry a `command` (`["node", "./scripts/check.mjs"]`) instead of a `skill` when the script lives outside a skill. The command runs from the repo root, so a relative path resolves there.

A guard can also be a tool on an MCP server your agent already has configured: give the check a `server` and a `tool` instead (`"server": "postgres-inspector", "tool": "validate_migration"`). The hook starts the server the way your agent's MCP config does, calls the tool with `file_path` and `content`, and blocks when the result has `isError: true`. The same 2-second deadline and silent pass apply.

### The contract

On every in-scope edit the hook spawns the script once:

- The edited file's repo-relative path arrives in `FILE_PATH`, and its new contents arrive on stdin.
- The script prints one line of JSON and nothing after it: `{"isError": false}` to pass, or `{"isError": true, "content": "..."}` to block. The content is what the agent reads, so write it as an instruction.
- The script exits 0. A block is a verdict in the JSON, and the exit code carries nothing.
- The script gets 2 seconds, then the hook kills it and counts that as a pass.
- Every failure is a silent pass: a hang, a crash, a missing script or interpreter, no output, or output that is not the JSON line above. The edit goes through, the hook still exits 0, and the session keeps running.

## Cost, privacy, safety

- Changed lines go to TypeSafe under your key, with zero data retention requested on every call, and nowhere else.
- Key lookup order: the environment (`TYPESAFE_AI_API_KEY`), then `.env.local` and `.env` at the repo root, then `~/.oh-my-plumb/.env`. Never a flag, never logged. Set `AI_GATEWAY_API_KEY` instead of a TypeSafe key to go through your Vercel AI Gateway.
- A check on this repo's 56-rule rubric, about a dozen rules per edit, is 1,300 to 2,000 input tokens: $0.00006 to $0.00008, 0.4 to 1.3 s for Jev and 1.4 to 2.5 s for the whole hook including Node startup. A turn of 15 edits costs a tenth of a cent. Measured 2026-09-23, direct to TypeSafe. `oh-my-plumb bench` measures yours.
- The hooks cannot break your session. Every path exits 0, has a hard deadline, and prints only what the host expects.
- No key or no network: the edit goes through unchecked and the miss is logged in `.oh-my-plumb/events.jsonl`, where `report` counts it.

## How it hooks in

Four hooks per agent. Session start: hash the instruction files, ask the agent to compile if they changed. Turn start: snapshot the working tree with git. After each edit: run the edit-phase rules on that hunk. End of turn: diff the whole turn against the snapshot and run the turn-phase rules, plus the edit-phase rules for anything a shell command wrote.

Shell and MCP calls reach the hook only while your rubric has a tool-call rule, so a repo without one never pays for a hook on every command. `oh-my-plumb rubric validate` turns the Claude Code and Codex matchers on or off for a project install; pi and OpenCode check the rubric themselves.

## Uninstall

```
oh-my-plumb uninstall            # every agent it was installed into
oh-my-plumb uninstall codex      # one agent; add --project for a project-level install
```

Removes oh-my-plumb's own entries and nothing else. Rubric files and `~/.oh-my-plumb/.env` stay until you delete them.

## Layout

- `packages/schema`: the rubric, hook payloads, verdicts and events as zod schemas.
- `packages/cli`: the `oh-my-plumb` command, the hook script and the OpenCode plugin.
- `skills/oh-my-plumb-compile`: the procedure the agent follows to compile a rubric.
- `skills/no-interface`: an example guard script and the contract it follows.

## License

[MIT](LICENSE)
