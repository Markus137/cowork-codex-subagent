---
name: codex-orchestration
description: >
  Default orchestration policy for substantial work requested directly by the
  user in Claude Cowork when it targets a concrete GitHub repository or
  GitHub-backed project. Use automatically for repository-backed research,
  analysis, comparison, planning, implementation, document, content, review,
  or connector-assisted work, even when the user does not mention Codex,
  agents, delegation, SOL, or Terra. Also use for explicit Codex First,
  GitHub-only, Fable/SOL/Terra-loop, delegation, and role-change requests. Do
  not use for general fileless work without a target repository, a short
  follow-up question, installation explanation, status check, confirmation,
  greeting, or a clarification required before safe delegation.
version: 1.2.10
---

# GitHub-only Codex-First orchestration

Keep Fable deliberately small. Productive repository work happens remotely on
GitHub. The user never clones a repository, creates a local worktree, runs
local Git, or copies changes between apps.

Use this plugin's Cowork-native host MCP for the one-way Fable-to-Codex
handoff. Its MCP process runs on the Mac host and invokes the installed Codex
CLI through the existing ChatGPT login. It does not rely on a Cowork subagent,
Cowork's Linux shell, the official `codex:codex-rescue` agent, or a path inside
the official Claude Code plugin. SOL and Terra use only the GitHub MCP already
configured in Codex. Fable receives sanitized status and the passive Codex
result; Codex never starts, invokes, or messages Fable.

The one-way property is enforced architecturally by exposing no callback,
Claude/Fable handle, or credential to the host-job tool surface. The worker
also strips API/token/Claude/Anthropic environment variables, ignores user
Codex config, and stops on visible disallowed JSONL tool events. Do not present
the event guard as pre-execution or cryptographic proof: collaboration-agent
internals are not fully reflected in the top-level JSONL stream. Any returned
evidence of a boundary violation makes the run `blocked`.

Use GitHub Automatic reviews for the initial quality pass and one exact
standalone `@codex review` pull-request comment for the final pass. Never use a
local reviewer, GitHub Actions, an OpenAI API key, or an unbounded loop.

## Default delegation policy

Treat every substantial repository-backed task stated directly by the user as
a request to run this workflow. Do not wait for words such as "Codex",
"agent", "delegate", "SOL", or "Terra". The task qualifies when it targets a
concrete GitHub repository or project and includes researching or comparing
sources for that project, analyzing its evidence, planning its work, changing
or reviewing the repository, producing or editing an artifact in it, or any
multi-step implementation for it.

Keep Fable as the user-facing intake and transport layer only:

1. Capture the user's outcome, constraints, exclusions, acceptance checks,
   deliverables, and target repository. Ask only a clarification without which
   safe delegation would materially change the task. Use a repository already
   established in the project context; otherwise ask which target repository
   the user means. Never invent or request a dummy coordination repository.
2. When a concrete repository task needs supporting sources available only
   through a Cowork connector or browser, perform the minimum mechanical reads
   needed to assemble a bounded source pack. Preserve source text, title, URL
   or connector identifier, and access time. Do not synthesize, rank, infer,
   select a conclusion, or turn the pack into an answer. Put the source pack
   and its provenance into the structured task contract for SOL. If the source
   pack cannot fit the bounded contract, stop and ask the user to narrow the
   source scope.
3. Read the current roles and start exactly one host-side SOL job. SOL remains
   the senior manager, delegates substantive work to Terra, reviews Terra V1,
   requires one concrete revision, and reviews Terra V2.
4. Poll status, transport validator-accepted review findings unchanged through
   the single permitted resume, and present the passive final envelope. Fable
   may format or shorten the envelope for readability only when the original
   evidence and status remain available and unchanged.

Fable must not research beyond the mechanical source-pack collection above,
analyze, recommend, plan, draft the substantive artifact, implement, repair,
review, decide whether evidence is sufficient, or silently take over after a
blocked run. A request that can be answered by connector data still delegates:
when it supports a concrete repository task, Fable gathers only the necessary
source pack and SOL/Terra perform the interpretation. For a general fileless
research, analysis, planning, document, content, or connector request without
a concrete target repository, do not start the GitHub mutation job and do not
invent or request a dummy repository. Explain briefly that this installed flow
currently has no generic non-repository transport; do not take over the
substantive work as a fallback. Directly answer only short follow-up questions,
installation instructions, status or confirmation requests, greetings, and
safety-critical clarifications. If a supposedly short request develops
substantive repository-backed work, switch to this orchestration policy before
doing that work.

## Role selection

Call `orchestration_get_roles` before every handoff. Logical role names remain
stable while their returned runtime selectors are replaceable.
[roles.md](references/roles.md) documents defaults only.

When the user says, for example, "Ändere die Rolle von Fable zu XYZ", call
`orchestration_set_role` once with `role="Fable"` and the concrete runtime
selector as `binding`. Use a selector only when the user supplies it or the
runtime confirms it. Store only the requested role and do not claim that an
unverified model exists. No plugin rebuild is required.

## Required setup

Before the first productive run for a repository, confirm without exposing
credentials that:

1. `preflight_health` and `preflight_codex_roundtrip` pass with the existing
   ChatGPT Codex login; the official Claude Code plugin is not required;
2. Codex has a configured GitHub MCP with access to the target repository;
3. the repository is connected to Codex cloud and Code review plus Automatic
   reviews are enabled at <https://chatgpt.com/codex/settings/code-review>;
4. Automatic reviews are configured for the newly opened non-draft pull
   request, not for every correction push, so one initial automatic review is
   the expected signal; and
5. the GitHub connector can read authoritative Issues/Reaction metadata for
   the target repository, including the mechanical actor login, full timestamp,
   exact target type, target ID, and canonical target URL. If `Issues: Read` or
   equivalent authoritative reaction data is unavailable, reaction evidence is
   `blocked` or `incomplete`, never PASS. This plugin cannot create or broaden
   that GitHub permission.

The ChatGPT subscription path does not require an OpenAI API key. Do not ask
for one or switch to an API-key route. A local Codex preflight verifies the
host MCP-to-Codex bridge, but it never clones or reviews a repository and does
not replace the GitHub access checks above.

Historical initial-review observations were supplied on 2026-07-16 but were
not inspected by this plugin: `example-org/example-app` PR #286 was reported
to show Automatic review with a P1 and PR-level `+1` no-findings behavior;
PRs #291/#292 were reported to show canonical P2 findings with
`Reviewed commit: <10-hex-prefix>`. Treat those as reported initial-review
observations, not as evidence produced by this build and never as a guarantee
of current GitHub behavior. Their safety-relevant
implication is only that every canonical P0–P3 finding enters the bounded
correction/stop path and P2/P3 are never clean.

A separate observed final-review run on 2026-07-16 used
`example-org/web-template` PR #4 at head
`23652c4dac90ab4069dde1d3dcaeb6fc88d0a9da`. The exact trigger was issue
comment `4988770330` at `2026-07-16T06:11:06Z`; the later bot response was
issue comment `4988786178` at `2026-07-16T06:13:25Z` with body
`Codex Review: Didn't find any major issues. Can't wait for the next one!`,
then a blank line, then `**Reviewed commit:** \`23652c4dac\``. That observation
had zero review submissions, zero inline review comments, and zero final
reactions. The validator accepts this shape as clean only from its authoritative
identity, timing, exact PR/comment URLs, unchanged head, one matching reviewed-
commit marker, explicit empty `review_comments`, and absence of any priority
marker. It never trusts the reassuring sentence itself.
The bundled current regression reference for that supported event shape is
`test/fixtures/final-issue-comment-template-pr4.json`, captured from the same
2026-07-16 observation. It is a local fixture, not a promise that a changing
external GitHub/Codex service will keep emitting that shape.
The `example-app` reports above are historical background only and are
subordinate to this current bundled regression reference.

## Start exactly one repository job

1. Confirm the target GitHub repository, outcome, constraints, exclusions,
   acceptance checks, and required evidence. Do not implement in Fable.
2. Call `orchestration_codex_start` exactly once. The tool creates the
   non-secret run/job ID and reads SOL/Terra selectors internally.
3. Always supply `task_type`; the host rejects a missing value. Use
   `implementation` when the user requested a known concrete repository
   change. Use `audit` for inspect, review, verify, diagnose, or fix-if-found
   requests where no defect or change has yet been established. Never use an
   audit as a null-diff workaround for a known requested change.
4. Supply only the structured task contract. Fable cannot supply a model,
   executable, cwd, flags, environment, local path, callback, or shell command.
5. Give SOL the complete contract below. Fable must not create a bootstrap
   branch, placeholder commit, task file, local checkout, or pull request.
6. Poll `orchestration_codex_status` no more than once per minute and read
   `orchestration_codex_result` only for the same returned job ID. If the host
   bridge or GitHub MCP is unavailable, stop as `blocked`.
   Do not fall back to Fable, Claude, local Git, another MCP agent, GitHub
   Actions, an API key, or a second initial handoff.
   Treat `updated_at` as host-observed progress only: material GitHub milestones
   are `branch_created`, `commit_observed`, `pr_created`, and `pr_verified`;
   read-only same-repository GitHub activity is throttled to one refresh per
   minute. No refresh means no newly observed GitHub event, not proof that an
   approval is pending.

## Contract for SOL

The handoff must include:

- `run_id`, `hop=1`, `task_type`, target repository owner/name and default
  base branch;
- outcome, scope, exclusions, constraints, acceptance checks, and deliverables;
- current SOL and Terra selectors;
- `manager_cycles_max=3`: Terra V1, one mandatory SOL revision, and at most one
  review-triggered correction;
- `wall_clock_limit_minutes=45` by default; only an explicit integer from 15
  through 120 changes the fixed per-attempt host safety cap;
- `repository_transport=GITHUB_MCP_ONLY`;
- `allowed_agent_hierarchy=SOL>TERRA`;
- `NO_CLAUDE_MCP`, `NO_FABLE_CALL`, `NO_CLAUDE_COMMAND`, `NO_LOCAL_GIT`,
  `NO_GITHUB_ACTIONS`, and `NO_OPENAI_API_KEY`.

Instruct SOL to do all of the following:

1. Verify that the current Codex runtime exposes both a collaboration subagent
   capability and the configured GitHub MCP. If either capability is absent,
   return `blocked` without implementing. Never pretend that a single-agent
   run was SOL-to-Terra delegation.
2. Remain the sole manager. Delegate substantive read-only inspection,
   analysis, and drafting to a Terra subagent using the stored Terra selector
   when explicit model selection is supported. Terra must not perform GitHub
   mutations. If the runtime selects Terra's model itself, report the actual
   runtime selection.
3. Have Terra inspect the remote repository through read-only GitHub MCP and
   return V1/V2 content or an exact change plan to SOL. After accepting V2,
   SOL personally performs every GitHub mutation and final proof read in the
   main thread so the host collector can observe it. SOL creates the
   deterministic task branch `sol/<lowercase-run-id>`, writes the accepted delivery,
   re-fetches final evidence, creates the PR, and reads it back. Never delegate
   those operations to Terra. Never run `git`, clone, create a worktree, or use
   the user's local filesystem as a repository.
4. Review Terra V1 against the acceptance checks, send at least one concrete
   and testable revision request, then review Terra V2 and its remote evidence.
5. Only after SOL accepts V2, SOL personally creates the pull request directly
   with `draft=false`. Derive the lowercase SHA from the latest successful
   task-branch commit already known before the PR call. The entire PR body is
   exactly the standalone canonical line
   `COWORK_CODEX_GATE_V1 | run_id=<RUN_ID> | head_sha=<CREATED_40_HEX> | PENDING / DO NOT MERGE`,
   with no other text, blank line, punctuation, trailing whitespace, prefix,
   Markdown, or suffix. Historical read compatibility may accept the identical
   line with one terminal ASCII period, but new creation never emits it.
   Duplicate/mixed variants and all other changes fail. The create result and
   final read must preserve the same body byte-for-byte. Every implementation
   `create_file`, `update_file`, or low-level `create_commit` uses a bounded
   seven-line commit message: concise subject, blank line,
   `COWORK_CODEX_IMPLEMENTATION_V1 | run_id=<RUN_ID>`, then `Problem`,
   `Change`, `Rationale`, and scope-bearing `Verification`. SOL obtains the
   wording only from accepted Terra V2 and final remote proof. The host checks
   the message before mutation, records its returned SHA, and treats low-level
   `create_commit` as branch-effective only after successful `update_ref` with
   the exact task `branch_name`, that SHA, and `force=false`. PR creation and
   completion require the visible PR head to equal the last branch-effective
   explained commit. A no-op correction may reuse its validated private seed;
   a real correction must replace it with a freshly explained commit. No
   extra GitHub write or follow-up proof fetch is created. SOL explicitly
   reads that PR with `github.get_pr_info`, verifies that its returned body is
   byte-exactly the original marker-only line and that it is open and non-draft at
   the final head. Independently verify that it is open and non-draft, and return passively
   with `ready_for_quality_gate`, plus `repository`,
   `base_branch`, `task_branch`, `head_sha`, `pr_number`, `pr_url`, changed
   files, tests, evidence, and known risks. Never merge the pull request.
6. Never call Claude or Fable. The three `NO_*` call invariants prohibit a
   Claude-backed MCP, the `claude` executable or wrapper, Anthropic API/SDK/
   endpoint/proxy, and Fable as a model, reviewer, fallback, subagent, or
   message target. Never request broader permissions or network access to
   create such a route. Job result transport is passive return, not a call.

For `task_type=audit`, Terra must inspect the requested repository state and
draft one real audit deliverable for `.github/audits/<lowercase-run-id>.md`.
After SOL accepts V2, SOL must always commit one real audit deliverable
personally on the deterministic task branch and perform every final proof
read. When
no defect is mechanically established, do not change product files. Only
after a mechanically established defect may the audit also change in-scope
product files, and the report must document both defect and change. Never
invent a code delta or add a placeholder. The report
and result must bind the full 40-hex audited base SHA, audit scope, findings,
verification, and exact path/start-line/end-line/snippet evidence re-read from
that same SHA. The report must contain exactly one
`COWORK_CODEX_AUDIT_EVIDENCE_V1` machine block whose compact JSON is the sole
source for the final hydrated `audit_evidence`; the model envelope returns
`audit_evidence:null`. Hand-concatenated JSON is forbidden. The final order is
strict: SOL must fetch
every cited exact range at the audited SHA, self-fetch the complete report at
the exact final head SHA with no range, only then create the PR, fetch the PR
at that same final head, and only then return. No report or product mutation
may occur after the self-fetch. The
host reserves separate bounded report and ranged-evidence slots, so unrelated
exploratory full-file reads cannot displace this final proof, while exact
same-SHA content and ranges remain mandatory. For
`task_type=implementation`, a null diff is not delivery and
must return `blocked` with `reason_code=NULL_DIFF_NO_DELIVERY` and no PR.

The host explicitly allowlists only `github.get_pr_info` and the known
runtime-equivalent `github.fetch_pr` as final PR reads. A different similarly
named tool is not evidence. Both must return the PR body. On correction resume,
the PR head may change, but its historical PENDING marker must remain bound to
the original `prCertification.createdHeadSha`; it is never rewritten to the
new final head.

## Runtime GitHub-write approval

The host worker runs Codex read-only with `approval_policy="on-request"`,
`approvals_reviewer="auto_review"`, GitHub write tools set to approval mode
`writes`, `--strict-config`, and ignored user config. The automatic approval
reviewer is only the runtime safety reviewer for side-effecting GitHub MCP calls. It is not Fable,
SOL, Terra, a productive agent, an extra manager cycle, or the GitHub code
quality review.

The built-in guardian policy remains the baseline. A run-specific additional
policy narrows candidate writes to the exact repository, base, deterministic
task branch, scope, and non-draft PR. It denies merge, delete, force-push,
base-branch writes, closing/retargeting, workflow or repository administration,
secrets, releases, and unrelated repositories or branches. Never use `--yolo`,
danger-full-access, or a blanket full-access setting. A managed policy may
still deny a requested write; do not bypass it.

A write that is rejected, times out, or is aborted must fail closed with the
specific reason code `GITHUB_WRITE_APPROVAL_DENIED`,
`GITHUB_WRITE_APPROVAL_TIMEOUT`, or `GITHUB_WRITE_APPROVAL_ABORTED`.
Timeout classification takes precedence when a completed failure message also
contains denial language. The CLI stream exposes no separate stable in-flight
reviewer signal: while a tool call is active the host job remains `running`.
A terminal model envelope with `approval_pending` is invalid and fails closed;
the model must never fabricate it. A cancelled MCP call is never success.
When a validated non-complete worker envelope carries the same observed
approval-failure reason code, preserve that envelope and its SOL-to-Terra
evidence while deriving the outer terminal state from it. A missing, invalid,
or contradictory envelope fails closed without exposing it as the result.

If a task-branch commit is observed but no PR exists, the host returns an exact
`commit_without_pr` residue. When the committed file is the required audit
artifact, it returns `audit_artifact_committed_pr_missing` with repository,
base, branch, head, artifact path, canonical marker, and bounded manual recovery
instruction. Open one PR from that exact unchanged branch/head if authorized;
never auto-retry, mutate the branch, merge, delete, close, or clean up.

The measured `CFT-20260716-034901-8DA59548` run lasted 1771.481s. Terra's
GitHub work used 77.675s, followed by a 1605.934s reasoning/model gap with no
GitHub or approval event; SOL's final segment used 69.957s. PR creation
succeeded (10.053s outer, 1.4586s GitHub). Later paired runs established a
different ownership ambiguity: one Terra-owned PR call with additional body
text was denied because the reviewer treated the marker as the only permitted
body, while another Terra-owned call with additional text succeeded. The
workflow removes both ambiguities by assigning mutations to SOL's main thread
and requiring a body containing only the canonical marker. Do not exclude
alleged approval time from
the wall clock because the runtime exposes no separate stable pending signal.
This measured delay is model/reasoning timing evidence, not an approval-state
measurement or an approval to extend the job.

Source inspection confirms that the marker-only create-body contract applies
equally to implementation and audit tasks. The implementation explanation now
lives in the already necessary commit body while the PR body remains marker-
only. This adds no comment write, no comment-fetch proof, and no interaction
whose effect on Automatic review needs to be guessed.

Bug status is fixed in the contract: Bug 8 is an inconsistent approval-policy
interpretation, not a timeout; this workflow does not retry or bypass it and
instead removes the ambiguous extra PR-body text. Bug 10 stale status was fixed
in v1.2.3 through same-repository event-bound progress and
`updated_at`. Bug 11 was mitigated in v1.2.3 through the one-shot structured
45-minute default with explicit 15–120 minute bounds; progress does not reset
that fixed limit.

Version 1.2.9 resolves Bug 23 by binding a bounded implementation
explanation to the already necessary commit and its observed SHA, without
relaxing the marker-only PR body or adding another write. Version 1.2.8
introduced the now-replaced post-PR context-comment design. Version 1.2.7 closes Bugs 20–21 and removes the ambiguous Bug 8 PR-body input;
version 1.2.6 closed Bug 19 and version 1.2.5 closed Bugs 16–18. For an audit, the host retains the last
successfully completed report write and validates its single sentinel block,
strict schema, contract bindings, full report self-fetch, and cited same-SHA
ranges before `create_pull_request` is allowed to start. JSON parse failures
are distinct from schema and binding failures. Terminal publication unions
fresh host observations with already persisted branch/PR residues. Bug 6 is
therefore a reachable fail-closed regression: a parseable envelope whose audit
artifact or evidence does not match host proof returns
`AUDIT_EVIDENCE_UNVERIFIED` with a concrete validation path and preserves all
observed residues.

Range proof is byte-exact at the JavaScript-string/UTF-8 boundary. Never trim,
normalize Unicode, convert CR/LF forms, or add/remove a final newline in a
snippet. The pre-PR block uses the same strict audit-evidence normalization as
the final envelope, except that its `verification` must be the canonical
string and may not use the legacy compatibility array. Residues are always
bounded to branch plus one resource; a trusted PR supersedes every commit-
without-PR residue.

## Worker result envelope

The runtime prompt for both start and resume is generated from the frozen
`RESULT_ENVELOPE_SCHEMA` in `server/result-envelope.js`. That schema is the
single source for the validator's 18 top-level keys, every exact nested shape,
the public expected type, and the canonical type-shape example. SOL must return
JSON only, with no Markdown fence or surrounding prose, using exactly these
top-level fields:

- `run_id`, `status`, `reason_code`
- `repository`, `base_branch`, `task_branch`, `head_sha`, `pr_number`, `pr_url`
- `work_summary`, `resources_consulted`, `changes_or_artifacts`
- `audit_evidence`, `tests_and_verification`, `SOL_to_Terra_evidence`
- `finding_dispositions`, `risks_or_blockers`, `next_action`

For a new audit model response, `audit_evidence` is null. After host validation,
the public result is hydrated with exactly `audited_sha`, `scope`, `findings`,
`verification`, and `line_evidence` from the report block. `audited_sha` is a full 40-hex SHA;
`scope` and `findings` are arrays of non-empty strings; `verification` is
exactly one non-empty string, never an array or object; and `line_evidence` is
an array of `{path,start_line,end_line,snippet}` objects re-read from that SHA.
The report block must always emit the string form. A legacy non-null envelope
is accepted only when it exactly matches the independently verified block.
For compatibility with version 1.1.0 only, the host also accepts a legacy
verification array containing exactly one non-empty string and normalizes it;
it rejects every other array shape and never exposes the legacy array in a
result.

The generated runtime contract also states that `work_summary` and
`next_action` are each one non-empty string; `tests_and_verification` and
`risks_or_blockers` are arrays of non-empty strings; `resources_consulted` is
an array of exact `{resource,evidence}` string objects;
`changes_or_artifacts` is an array of exact `{artifact,kind,evidence}` string
objects; and `SOL_to_Terra_evidence` has exactly the four non-empty string
fields `sol_revision`, `sol_v2_review`, `terra_v1`, and `terra_v2`.

Codex authors and writes the GitHub audit report and its evidence block through
GitHub MCP. The host does not author, insert, replace, or rewrite that block.
`canonicalAuditBlock()` and `auditEvidenceBlock()` only serialize the expected
comparison shape used by validation and deterministic tests; the pre-PR host
gate parses and validates the model-authored report write.

Each `finding_dispositions` URL is a canonical same-repository/path blob URL.
Its SHA must be either the final PR `head_sha` or, for audits only, the
`audit_evidence.audited_sha`; every third SHA is rejected. A positive `line`
requires the exact `#L<line>` fragment, while null requires no fragment.

The host validates this envelope strictly and derives public status from it.
`complete` requires the exact repository/base/task branch, a full 40-hex head
SHA, a positive PR number, the canonical GitHub PR URL, and complete
SOL-to-Terra evidence. An audit additionally requires its exact deterministic
report artifact and structured same-SHA line evidence. Any invalid or
contradictory result fails closed; a restrictive inner state wins over an
outer process status. No PR or null delivery can never become
`ready_for_quality_gate`, and the job cannot be resumed from such a state.
An invalid result is never returned raw. Its public state uses
`phase=result_validation`, a sanitized validation rule, bounded host-observed
`partial_evidence`, and explicit `leftover_resources`. A PR residue includes
`kind`, repository, number, canonical URL, state, draft flag, and
`certification_status`. Terminal blocked, incomplete, and cancelled job-tool
responses are successful status reads with `isError=false`; invalid requests,
missing or unreadable jobs, and internal tool failures keep `isError=true`.
Automatic branch
deletion is not authorized.

## GitHub review state machine

Follow these states in order. GitHub is the shared mailbox. Fable may only
read state, post the single final trigger, forward one unchanged findings
package through the existing SOL job, post the exact final PASS certification
after an accepted clean gate, and assemble the result.

### `IMPLEMENTATION_PENDING`

Wait for the one host-side Codex job. Poll `orchestration_codex_status` no more
than once per minute, then read `orchestration_codex_result`. Accept
`ready_for_quality_gate` only when
the normalized outer and inner result are both `complete`, all PR identity
fields are present, and the pull request's current head equals the returned
`head_sha`. A non-null reason code, missing PR, draft PR, closed PR, changed
head, invalid envelope, or missing SOL-to-Terra evidence fails closed.

### `INITIAL_AUTO_REVIEW_PENDING`

Read the remote PR through GitHub browser/API no more than once per minute.
The implementation commit explanation is provenance, not quality-gate
evidence. Do not post an initial `@codex review` comment. Record `ready_at`, the full
40-hex `expected_head_sha`, all known PR commit SHAs, `pr_number`, and `pr_url`.
At every poll require the current head to equal the recorded SHA and require
zero synchronize, force-push, or other head-change events after `ready_at`.
A head that changes away and later returns still fails closed.

The only accepted actor login is `chatgpt-codex-connector[bot]`. Compare the
GitHub login after Unicode NFC, case-folding, and removal of an optional final
`[bot]` suffix only. Never use a display name, substring match, general
`codex` author, or another actor.

The initial review has exactly two valid event families. An `issue_comment` is
never valid initial evidence:

- a bot `+1` (`👍`) reaction directly on that exact pull request, created
  strictly after `ready_at`, with the head continuously unchanged. The event
  is usable only when authoritative GitHub Issues/Reaction data mechanically
  supplies the exact actor login, full timestamp, target type, target ID, and
  canonical target URL. Browser DOM, relative or minute-only labels, counters,
  and inference are not evidence. Missing `Issues: Read` or equivalent
  authoritative reaction data means `blocked`/`incomplete`, not PASS; or
- a later bot review submission containing one canonical plain
  `Reviewed commit: <hex-prefix>` line or a live Markdown bold label followed
  by a backticked hex prefix, plus zero or more associated inline comments
  linked by the exact `pull_request_review_id`. Every submission and comment
  must use the exact bot actor and be strictly after `ready_at`; inline comments
  may precede submission time because GitHub can create them while a review is
  pending. The prefix must be
  hexadecimal, at least 10 characters, prefix the recorded full head SHA, and
  match exactly one known PR commit SHA. Short, nonhex, wrong, malformed,
  duplicate, or ambiguous reviewed-commit material is rejected. A valid
  submission with `comments: []` is clean only when its body contains true
  absence of priority-like material. With comments present, each inline finding
  must contain exactly one consistent Codex `![P0 Badge]`–`![P3 Badge]` marker
  (or exact `- [P#]` form) and expose its URL, path, and line. The priority
  scanner distinguishes true absence from one canonical P0–P3 marker and from
  malformed, unknown (including P4+), or multiple material; every noncanonical
  status fails closed.

For every candidate event, call
`orchestration_validate_initial_review_evidence` with the recorded context and
raw GitHub reaction or review-bundle metadata. Do not concatenate submission
and comment bodies and do not supply or infer priorities; the validator parses
the commit marker from the submission and P0–P3 markers from associated inline
comments. Continue only when `accepted` is true. A valid zero-comment bundle
returns clean; a findings bundle returns the exact inline `body`, `url`, `path`,
and `line` to forward unchanged.
These are the immutable body, URL, path, and line; Fable must not reconstruct
them from the submission.

Every P0–P3 finding is actionable; P2/P3 must never be interpreted as clean.
No review, an unscoped or stale thumbs-up, unknown response, changed-away-and-
back head, or ambiguous actor/commit is not clean. Stop `incomplete` at the
wall-clock limit; never retry the trigger or substitute a local review.

### `OPTIONAL_CORRECTION`

If the initial review is clean, skip correction. If it contains P0–P3
findings, copy each actionable Codex finding byte-for-byte, including its
GitHub URL and path/line metadata, and forward that immutable block exactly
once through `orchestration_codex_resume` to the same SOL job and run ID. The
host bridge resumes the stored Codex session and rejects a second resume.
Fable must not rephrase, filter, rank, accept, reject, or fix it.

SOL verifies the findings, gives Terra at most one remote correction package,
runs focused checks, updates the same GitHub branch through GitHub MCP, and
returns the new `head_sha` plus dispositions. Before proceeding, mechanically
confirm the PR still uses the same repository, PR number, base, and task branch
and that its current head equals the new SHA. Any mismatch or second requested
correction stops `incomplete`.

### `FINAL_REVIEW_REQUESTED`

Record the full current `expected_head_sha` and known PR commit SHAs, then post
exactly one new standalone PR comment whose complete body is exactly:

```text
@codex review
```

Do not add a run ID, focus text, findings, punctuation, or another mention.
Store its `final_trigger_comment_id`, URL, and `created_at`. Never post it
twice. Poll GitHub no more than once per minute and require zero head-change
events after the trigger as well as exact current-head equality.

Final evidence has three accepted event families:

- for backward compatibility, a correctly identified bot `+1` reaction on
  the exact newly created issue-comment ID and canonical URL after its
  `created_at`; an unscoped PR thumbs-up is invalid and a temporary `eyes`
  reaction is ignored;
- a later exact bot review bundle with one valid unambiguous
  `Reviewed commit:` prefix for the recorded full SHA. Zero associated inline
  comments is clean only when the submission body has true priority-marker
  absence. Genuine associated inline comments carry canonical P0–P3 findings;
  or
- a later bot `issue_comment` is clean only when it has a positive unique
  response ID different from the trigger, its canonical issue-comment URL and
  exact PR number/URL match, actor and full timestamp are authoritative and
  strictly after the trigger, the head stayed continuously unchanged, its body
  contains exactly one valid reviewed-commit marker matching the expected
  head, `review_comments` is explicitly `[]`, and its body has true absence of
  priority-like material. Reassuring prose such as “Didn't find...” is never
  evidence. An issue-comment that looks like a finding is rejected because it
  lacks authoritative raw inline URL/path/line mapping; Fable must not
  synthesize that mapping.

Ignore stale reviews, earlier automatic reviews, temporary `eyes` reactions,
and wrong-head evidence. If the head changes away, even if it returns, stop
`incomplete`; do not retrigger. Malformed, unknown P4+, duplicate, ambiguous,
or multiple priority/commit markers fail closed.

Call `orchestration_validate_final_review_evidence` for every final candidate.
It receives only the recorded context and raw GitHub event metadata, performs
no network/repository access, and returns only `accepted`, `verdict`,
`priorities`, `findings`, and `reason`. Fable must not replace its decision.

Only when that validator accepts clean final evidence and Fable mechanically
confirms that the PR still has the unchanged recorded final head may Fable use
the GitHub connector to post exactly one certification comment. Its complete
body is exactly this single line after substituting the exact uppercase run ID
and lowercase final 40-hex head SHA:

```text
COWORK_CODEX_GATE_V1 | run_id=<RUN_ID> | head_sha=<FINAL_40_HEX> | PASS
```

If posting fails, stop `incomplete`. Blocked, cancelled, timed-out, ambiguous,
stale, changed-head, or findings outcomes receive no PASS. The historical PR
body remains PENDING; only this later run/head-bound Fable comment certifies
the clean gate. Codex, SOL, and Terra never post PASS. Nobody edits the PR body,
toggles draft, closes, merges, deletes, or treats PASS as a merge action.

### `STOPPED`

- Any validator-accepted clean final event with continuous head equality plus
  Fable's successfully posted exact same-head certification comment:
  `complete` / `PASS`.
- Any final P0–P3 finding: `incomplete`, preserve it unchanged, and stop.
- Timeout, missing/ambiguous signal, stale review, changed head, missing
  runtime capability, bridge failure, or GitHub failure: `incomplete` or
  `blocked`, and stop.

There is no second correction, second final trigger, third review, initial
manual review trigger, Stop-hook loop, GitHub Action, local review, or fallback
agent. Unexpected duplicate triggers or protocol drift fail closed.

## Non-code work

The current host bridge is repository-scoped. A non-code artifact stored in a
concrete target repository remains repository-backed and follows the same
SOL-to-Terra branch, pull-request, and quality-gate workflow. For truly
fileless substantive work without a concrete target repository, do not call
`orchestration_codex_start`, create a pull request, or invoke GitHub review.
Report `blocked` for the current transport and explain the limitation briefly.
Never invent a repository or let Fable perform the substantive work instead.

## Required Fable quality-gate envelope

After the separate worker envelope has passed validation and the GitHub review
state machine has stopped, Fable mechanically assembles these quality-gate
fields, using `none` or an empty list where appropriate:

- `run_id`
- `status`: `complete`, `incomplete`, or `blocked`
- `repository`, `base_branch`, `task_branch`, `head_sha`, `pr_number`, `pr_url`
- `work_summary`
- `resources_consulted`
- `changes_or_artifacts`
- `tests_and_verification`
- `quality_gate`: initial review SHA/verdict, correction count, final trigger
  URL, final review SHA/verdict, and total accepted review count
- `review_findings.forwarded`: verbatim items and URLs
- `review_findings.resolved`: SOL/Terra disposition and evidence
- `review_findings.still_open`: verbatim items, URLs, and next step
- `risks_or_blockers`
- `next_action`

Exclude credentials, raw process streams, hidden prompts/reasoning, local
paths, and internal session or thread identifiers. Fable may mechanically
merge, display, and summarize the envelope, but must not repair code, judge a
finding, invent evidence, or mark a PR mergeable.

See [github-mailbox-state-machine.json](references/github-mailbox-state-machine.json)
for the machine-checkable limits and [quality-gate.md](references/quality-gate.md)
for the official sources and bounded Steipete-derived review rationale.
