# Cowork Codex Subagent

A Cowork/Claude Code plugin that lets Claude hand a repository task to OpenAI
Codex and drive it to a finished, non-draft GitHub pull request — safely,
without ever cloning the repo, running local Git, or exposing an API key.
(Version 1.2.11.)

Everything happens through GitHub as the shared mailbox: Claude (in the "Fable"
intake role) starts one bounded Codex run, polls GitHub for the branch, commit,
and PR, forwards a single findings package if the review flags something, posts
the final `@codex review` trigger, and — only after a clean gate — writes one
certification comment. Codex never calls back into Claude.

**Why "subagent"?** The name describes the practical shape, not a Cowork
`subagent_type`: Cowork delegates, Codex does the work, and the result comes
back passively. The obvious route — spawning Codex through the Agent tool as a
Cowork subagent — does not work: the official `codex:codex-rescue` subagent
spawns in Cowork with zero tools, so it cannot touch a repository. This plugin
takes the route that does work, a host-side MCP server that starts and drives
Codex over GitHub. The official path is unavailable; this one is not.

## Why you might want it

- **No local checkout.** No clone, worktree, or local Git. The whole
  transaction is remote GitHub plus your existing Codex CLI login.
- **Credential-safe by construction.** The host strips API-key, token, and
  Anthropic/OpenAI-routing environment variables before starting Codex, and
  never returns prompts, model output, tokens, thread IDs, PIDs, or host paths.
- **Bounded and fail-closed.** One start, at most one correction resume, one
  final review, a hard per-attempt wall-clock cap. Anything ambiguous stops
  incomplete instead of guessing.
- **Deterministic evidence.** Certification comes from validated GitHub
  metadata — never from reassuring prose in a review comment.
- **Fast, offline test suite.** 156 tests run in about a second with no
  network, no GitHub, and no Codex (see [Contributing](CONTRIBUTING.md)).

## Requirements

- **Claude Code / Cowork** with plugin support.
- **OpenAI Codex CLI** signed in with an existing ChatGPT/Codex subscription
  (no OpenAI API key is used). The default model tiers below ship with a recent
  Codex CLI.
- **Codex GitHub MCP** configured for your target repositories, with Code
  review and Automatic reviews enabled at
  <https://chatgpt.com/codex/settings/code-review>. Configure the automatic
  review for the newly opened non-draft pull request, not for every later push.

The separate official `openai/codex-plugin-cc` plugin may remain installed for
Claude Code terminal use, but its `codex:codex-rescue` subagent is not part of
this path.

## Install

Add the marketplace and install the plugin:

```text
/plugin marketplace add Markus137/cowork-codex-subagent
/plugin install cowork-codex-subagent@cowork-codex-subagent
```

Then reload and run the readiness check:

```text
/reload-plugins
Run the Codex preflight
```

The preflight resolves your local Codex executable, confirms the ChatGPT login
mode, and runs an optional deterministic read-only roundtrip. It never touches a
project repository — GitHub access and Code review setup are separate first-run
prerequisites.

## How a run flows

1. **Intake.** Claude confirms the task targets a concrete GitHub repository,
   collects the task contract, and supplies an explicit `task_type`:
   `implementation` for a requested change, or `audit` for inspect/review/
   diagnose/fix-if-found work until a defect is established.
2. **One start.** Claude reads the stored role bindings and calls
   `orchestration_codex_start` exactly once. The host launches your Codex CLI.
3. **SOL owns the run.** Codex's SOL role verifies collaboration subagents and
   the GitHub MCP are present (otherwise the run fails closed rather than faking
   a single-agent loop), delegates read-only inspection and drafting to the
   Terra role, then — as the only writer — creates the deterministic task branch
   `sol/<lowercase-run-id>`, commits, and opens a non-draft PR whose body is
   exactly one canonical marker line.
4. **Poll and certify.** Claude polls GitHub, runs the `@codex review` trigger,
   forwards at most one immutable findings package back through
   `orchestration_codex_resume` if the review flags something, and — only after
   clean, head-bound evidence — posts the final `PASS` certification comment. It
   never edits code or judges findings itself.

Full protocol detail lives in the bundled skills under
`skills/codex-orchestration/`.

## MCP tools

The local MCP server exposes eleven narrow tools:

| Tool | Purpose |
|---|---|
| `preflight_health` | Resolve the local Codex executable and login mode |
| `preflight_codex_roundtrip` | Optional deterministic read-only session check |
| `orchestration_get_roles` | Read the stored Fable/SOL/Terra selectors |
| `orchestration_set_role` | Change one stored role selector |
| `orchestration_codex_start` | Start one bounded Codex run |
| `orchestration_codex_status` | Sanitized progress snapshot |
| `orchestration_codex_result` | Final validated result envelope |
| `orchestration_codex_resume` | Forward one correction package (once) |
| `orchestration_codex_cancel` | Cancel the run |
| `orchestration_validate_initial_review_evidence` | Validate initial review metadata |
| `orchestration_validate_final_review_evidence` | Validate final gate metadata |

The job tools accept no executable, cwd, model, flags, environment, local path,
callback, or shell-command inputs. The two validators perform no network or
repository access — they only classify metadata Claude already read from GitHub.

## Roles and models

Three logical roles carry replaceable runtime selectors, stored per user in
`~/.config/cowork-codex-subagent/roles.json` (mode `0600`) and read or written
only through the two role tools:

| Role | Default selector | Runtime |
|---|---|---|
| Fable | `fable` | Claude/Cowork — intake and mechanical GitHub polling only; never a Codex call target |
| SOL | `gpt-5.6-sol` | Codex CLI — sole run owner and only writer |
| Terra | `gpt-5.6-terra` | Codex collaboration subagent — read-only inspection and drafting |

`gpt-5.6-sol` and `gpt-5.6-terra` are OpenAI's official Codex model tiers (the
GPT-5.6 Sol / Terra / Luna family, generally available since 2026-07-09). They
are not account-specific aliases, so the defaults work on any recent Codex CLI
login. The bindings are just selectors, though: to point SOL or Terra at a
different model, ask Claude to change the one selector — for example *"Bind SOL
to gpt-5.6-luna"* — which calls `orchestration_set_role` and updates the stored
value with no plugin rebuild. Changing Fable's binding never makes Fable
callable from Codex.

## Status snapshot

`orchestration_codex_status` returns only sanitized, GitHub-observed fields —
never raw tool arguments, model output, or internal identifiers:

```json
{
  "status": "running",
  "run_id": "CFT-20260716-061106-3F9AC21B",
  "phase": "implementation",
  "repository": "example-org/web-template",
  "created_at": "2026-07-16T06:11:06Z",
  "updated_at": "2026-07-16T06:12:31Z",
  "correction_resumes_used": 0,
  "wall_clock_limit_minutes": 45,
  "code": null,
  "validation_error": null,
  "partial_evidence": {
    "repository": "example-org/web-template",
    "base_branch": "main",
    "task_branch": "sol/cft-20260716-061106-3f9ac21b",
    "head_sha": "23652c4dac90ab4069dde1d3dcaeb6fc88d0a9da",
    "pr_number": 4,
    "pr_url": "https://github.com/example-org/web-template/pull/4",
    "last_completed_phase": "pr_created"
  },
  "leftover_resources": []
}
```

`wall_clock_limit_minutes` defaults to 45 and accepts only integers from 15
through 120. Progress advances only after a successful same-repository GitHub
event, so a stalled model is never made to look active.

## Certification and evidence

Certification is two exact, head-bound marker lines, never prose. When SOL
opens the PR, its body is exactly one standalone line:

```text
COWORK_CODEX_GATE_V1 | run_id=<RUN_ID> | head_sha=<CREATED_40_HEX> | PENDING / DO NOT MERGE
```

Only after accepted clean final evidence and a mechanically unchanged final
head does Claude post one GitHub-connector comment whose complete body is:

```text
COWORK_CODEX_GATE_V1 | run_id=<RUN_ID> | head_sha=<FINAL_40_HEX> | PASS
```

A post failure is incomplete; blocked, findings, timeout, stale, ambiguous, or
changed-head outcomes get no PASS, so the historical PR body stays PENDING.
Codex, SOL, and Terra never post PASS, and nobody edits the PR body,
toggles draft, closes, merges, or deletes anything — certification is not a merge.

Finding evidence is a raw two-part bundle, never flattened: the
review submission body holds the unique `Reviewed commit:` marker, and
separate inline comment bodies hold the canonical P0–P3 badges and link through
the exact `pull_request_review_id`. When there are findings, Claude forwards the
validator-returned immutable body, URL, path, and line byte-for-byte exactly
once.

For an `audit`, SOL commits a real `.github/audits/<run-id>.md` report with the
full audited SHA and exact same-SHA line evidence — it never fabricates a
product change. One deterministic machine block is the sole audit-evidence
source: `scope` and `findings` are string arrays,
`verification` is exactly one non-empty string, and each line-evidence item
carries a byte-exact snippet from the audited SHA. The model returns
`audit_evidence:null`; the host derives and validates the evidence itself from
the fetched exact-head report and exact-range reads. The legacy version-1.1.0
verification array containing exactly one non-empty string is normalized only
for comparison, and the public result never exposes the legacy array.

The public job state is derived from that validated envelope, so an
inner blocked/no-PR outcome cannot be stored as complete or resumed.

## Safety boundary

- Every implementation prompt carries `NO_CLAUDE_MCP`, `NO_FABLE_CALL`,
  `NO_CLAUDE_COMMAND`, `NO_LOCAL_GIT`, `NO_GITHUB_ACTIONS`, and
  `NO_OPENAI_API_KEY`. Claude/Fable is never a model, subagent, reviewer,
  fallback, MCP, command, API, SDK, endpoint, proxy, or message target.
- Terra is read-only; only SOL mutates, and only through GitHub MCP after
  accepting Terra's draft. There is no reverse callback, Claude/Fable handle, or
  caller-selectable command on the host worker.
- The host starts Codex with user config ignored, strips
  API/token/Claude/Anthropic environment variables, and fails closed on any
  observed shell, local file-change, web-search, unknown-tool, or non-GitHub MCP
  event.
- GitHub writes go through Codex's on-request automatic approval reviewer, a
  runtime safety control only — not Fable, SOL, Terra, an extra manager cycle,
  or the GitHub code review — restricted per run to the exact repository, base,
  task branch, scope, and non-draft PR. The plugin never enables `--yolo` or
  danger-full-access.

This is an architectural one-way boundary, not a claim of pre-execution or
cryptographic interception: Codex collaboration-subagent activity is not fully
visible in the top-level event stream. The defense is the absence of any reverse
Claude/Fable tool or credential, the isolated runtime surface, the fixed hard
prompt contract, and fail-closed handling of every visible disallowed event.

## Known limitations

- **Codex discovery is macOS-biased.** The host finds the Codex executable on
  `PATH` first; its only fallback when `codex` is not on `PATH` is the macOS
  ChatGPT desktop app bundle at
  `/Applications/ChatGPT.app/Contents/Resources/codex`. There is no Linux or
  Windows fallback path. On Linux or Windows — or on macOS without the ChatGPT
  app — `codex` must be resolvable on `PATH`, otherwise the preflight reports
  Codex unavailable.
- **The automatic-approval reviewer is non-deterministic.** In paired runs, the
  on-request automatic approval reviewer denied one PR write and allowed another
  for effectively equivalent input (the "Bug 8" observation in the
  [changelog](CHANGELOG.md)). The plugin does not retry or bypass that
  inconsistency. It removes the ambiguity instead — Terra is read-only, SOL owns
  every mutation in the main thread, and a new PR body is exactly the canonical
  marker — but it cannot make an external policy deterministic. Runs can still
  stop incomplete because of it.
- **No stable approval-pending signal.** Approval time cannot be subtracted from
  the wall clock, so a long model-reasoning gap and a long approval wait look
  the same from outside. The wall-clock cap is a hard per-attempt bound, not an
  SLA.
- **GitHub/Codex behavior is external and can change.** Bundled fixtures capture
  real observed shapes at a point in time and are regression references,
  not a guarantee about the live service. A reported final run observed on
  2026-07-16, not inspected by this plugin, is captured as
  `test/fixtures/final-issue-comment-template-pr4.json` and treated as clean
  only from its bound metadata, unique commit marker, and explicit empty
  `review_comments` — never from reassuring prose. The optional OpenAI Stop
  review gate stays disabled because it can create a long-running loop.
- **Recovery is deliberately manual.** A
  cancellation race can omit GitHub observations that complete after the host
  records cancellation. The bridge never auto-deletes; inspect the
  deterministic task branch explicitly before any cleanup decision. Likewise, if
  a commit or audit artifact exists but PR creation fails, status reports the
  exact resources and asks you to open one PR by hand.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The suite is dependency-free and runs
offline in under a second:

```bash
node --test
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Markus Streifinger.

## Changelog

Version-by-version bug history, measured run timings, and dated review
observations live in [CHANGELOG.md](CHANGELOG.md).

## Sources

- [Codex cloud](https://developers.openai.com/codex/cloud)
- [Codex code review in GitHub](https://developers.openai.com/codex/cloud/code-review)
- [Official Codex repository](https://github.com/openai/codex)
- [Official Claude/Codex plugin](https://github.com/openai/codex-plugin-cc)
- [Steipete's Codex review skill](https://github.com/steipete/agent-scripts/blob/main/skills/codex-review/SKILL.md)
