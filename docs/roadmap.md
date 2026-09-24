# oh-my-plumb — Roadmap (2026-09-23, statuses as of 2026-09-24)

Tracked by issue [#24](https://github.com/irfndi/oh-my-plumb/issues/24).

oh-my-plumb enforces the rules in your instruction files on every code edit. The rest of what people want their agent tooling to respect is on this list: which skills it uses, which MCP tools it calls and how, and what it runs in the shell. The principles do not change. Rules come only from the user, every verdict points at a rule a person can read, and a check that fails never breaks the agent.

Status is per issue: `open` until merged, `shipped` once the fix is in.

## Foundations: check tool calls

| Issue                                                                                                             | Status                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [#1 Rules that check a tool call, not a diff](https://github.com/irfndi/oh-my-plumb/issues/1)                     | shipped (merged as [PR #38](https://github.com/irfndi/oh-my-plumb/pull/38)) |
| [#3 Hook shell and MCP tools](https://github.com/irfndi/oh-my-plumb/issues/3)                                     | open                                                                        |
| [#2 Block a rule-breaking tool call before it runs](https://github.com/irfndi/oh-my-plumb/issues/2)               | open                                                                        |
| [#4 Compile tool-use rules instead of marking them unenforceable](https://github.com/irfndi/oh-my-plumb/issues/4) | shipped (merged as [PR #41](https://github.com/irfndi/oh-my-plumb/pull/41)) |
| [#5 Give the turn check the list of tools the agent called](https://github.com/irfndi/oh-my-plumb/issues/5)       | open                                                                        |
| [#6 Calibrate tool-call rules from past sessions](https://github.com/irfndi/oh-my-plumb/issues/6)                 | shipped (merged as [PR #42](https://github.com/irfndi/oh-my-plumb/pull/42)) |

## Skills

| Issue                                                                                                  | Status                                                                      |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [#7 Read SKILL.md files as rule sources](https://github.com/irfndi/oh-my-plumb/issues/7)               | open                                                                        |
| [#8 Rules that require a skill or tool to be used](https://github.com/irfndi/oh-my-plumb/issues/8)     | open                                                                        |
| [#9 Document and test the skill guard script contract](https://github.com/irfndi/oh-my-plumb/issues/9) | shipped (merged as [PR #43](https://github.com/irfndi/oh-my-plumb/pull/43)) |

## MCP

| Issue                                                                                                   | Status                                                                      |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [#10 Detect MCP servers from the files each host uses](https://github.com/irfndi/oh-my-plumb/issues/10) | shipped (merged as [PR #31](https://github.com/irfndi/oh-my-plumb/pull/31)) |
| [#11 Rules on MCP tool calls](https://github.com/irfndi/oh-my-plumb/issues/11)                          | open                                                                        |
| [#12 Talk to MCP guard servers over real JSON-RPC](https://github.com/irfndi/oh-my-plumb/issues/12)     | shipped (merged as [PR #39](https://github.com/irfndi/oh-my-plumb/pull/39)) |
| [#13 Read MCP server instructions as rule sources](https://github.com/irfndi/oh-my-plumb/issues/13)     | open                                                                        |

## Clean up the Tier 2 prototype first

| Issue                                                                                                      | Status                                                                      |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [#14 Tier 2 migration guard is a built-in rule](https://github.com/irfndi/oh-my-plumb/issues/14)           | shipped (merged as [PR #28](https://github.com/irfndi/oh-my-plumb/pull/28)) |
| [#15 Move Tier 2 routes into the committed rubric](https://github.com/irfndi/oh-my-plumb/issues/15)        | shipped (merged as [PR #40](https://github.com/irfndi/oh-my-plumb/pull/40)) |
| [#16 init writes a route to a script that does not exist](https://github.com/irfndi/oh-my-plumb/issues/16) | shipped (merged as [PR #36](https://github.com/irfndi/oh-my-plumb/pull/36)) |
| [#17 guards.ts parses guard output with type casts](https://github.com/irfndi/oh-my-plumb/issues/17)       | shipped (merged as [PR #25](https://github.com/irfndi/oh-my-plumb/pull/25)) |

## Sources, hosts, reliability

| Issue                                                                                                      | Status                                                                      |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [#18 Read more instruction files](https://github.com/irfndi/oh-my-plumb/issues/18)                         | shipped (merged as [PR #37](https://github.com/irfndi/oh-my-plumb/pull/37)) |
| [#19 End-to-end tests per host with real payloads](https://github.com/irfndi/oh-my-plumb/issues/19)        | shipped (merged as [PR #35](https://github.com/irfndi/oh-my-plumb/pull/35)) |
| [#20 Replay pi sessions](https://github.com/irfndi/oh-my-plumb/issues/20)                                  | shipped (merged as [PR #34](https://github.com/irfndi/oh-my-plumb/pull/34)) |
| [#21 Tell users a project pi install needs project trust](https://github.com/irfndi/oh-my-plumb/issues/21) | shipped (merged as [PR #32](https://github.com/irfndi/oh-my-plumb/pull/32)) |
| [#22 Warn when the key is under the wrong variable name](https://github.com/irfndi/oh-my-plumb/issues/22)  | shipped (merged as [PR #33](https://github.com/irfndi/oh-my-plumb/pull/33)) |
| [#23 Reconcile the README's latency numbers](https://github.com/irfndi/oh-my-plumb/issues/23)              | shipped (merged as [PR #30](https://github.com/irfndi/oh-my-plumb/pull/30)) |

## Suggested order

Land the PRs in this order:

1. Tier 2 cleanup (#14, #15, #16) and host end-to-end tests (#19) first. They fix trust in what exists.
2. Then the tool-call foundation (#1 through #6).
3. Then skills (#7 through #9) and MCP (#10 through #13) on top of it.

The remaining issues (#18, #20, #21, #22, #23) are independent and land whenever they are ready. Issue #24 tracks this roadmap and closes once the last item ships.
