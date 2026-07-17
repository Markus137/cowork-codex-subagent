# Default team role bindings

These are bootstrap defaults and documentation, not runtime state. Runtime
selectors live in the user-level role store and are read/written only through
`orchestration_get_roles` and `orchestration_set_role`.

| Logical role | Current binding | Runtime | Responsibility |
|---|---|---|---|
| Fable | `fable` | Claude Cowork | Intake, one-way handoff, mechanical GitHub polling and result delivery; never a Codex call target |
| SOL | `gpt-5.6-sol` | Codex CLI through this plugin's host MCP | Sole run owner; manages Terra and the remote GitHub transaction through GitHub MCP |
| Terra | `gpt-5.6-terra` | Codex collaboration subagent | Read-only repository inspection, analysis, and V1/V2 drafting through GitHub MCP; no mutations |

## Binding rules

- Treat bindings as runtime selectors, not identities embedded in prompts or
  code paths.
- Pass SOL's exact selector to the host worker's fixed Codex CLI `--model` argument.
- Tell SOL to spawn Terra using Terra's exact binding where the Codex
  collaboration runtime supports explicit model selection. If it does not,
  preserve the logical Terra role and report the runtime-selected model.
- Never change Fable's, SOL's, and Terra's selectors together unless the user
  explicitly requests every change.
- The Fable binding is logical intake state only. Codex must never use it as a
  model selector, MCP target, reviewer, fallback, or subagent.
- A binding change never weakens `NO_CLAUDE_MCP`, `NO_FABLE_CALL`, or
  `NO_CLAUDE_COMMAND` and never enables the global Stop review gate. These
  invariants also prohibit CLI/package-manager wrappers, Anthropic APIs/SDKs,
  network escalation, and permission escalation as alternative call routes.
- SOL→Terra is the only productive hierarchy, but Terra is read-only and
  supplies inspection, analysis, and V1/V2 drafts. After accepting V2, SOL
  alone performs GitHub mutations and final proof reads in the main thread.
  For implementations this includes the bounded run-bound explanation inside
  every necessary commit message and the exact final PR-head proof, adding no
  extra GitHub write.
  The hierarchy is valid only when the runtime exposes collaboration; otherwise
  the run fails closed instead of silently becoming single-agent.
- SOL and Terra use the configured GitHub MCP for repository reads. SOL alone
  uses it for writes. They do not
  clone, create local worktrees, or run local Git. GitHub Automatic reviews and
  the one exact final `@codex review` comment supply the independent quality
  gate on the remote pull request.

## Prompt form for role changes

Examples:

- `Ändere die Rolle von Fable zum bestätigten Selector opus.`
- `Binde SOL ab jetzt an gpt-5.7-sol.`
- `Nutze für Terra künftig gpt-5.7-terra.`

Call `orchestration_set_role` for the one requested selector. Confirm only that
it was stored. Runtime availability is validated by the next actual handoff;
do not claim a display name such as "Claude Opus 5" is a valid selector unless
the relevant runtime has confirmed and supplied its concrete selector. No
plugin rebuild is needed.
