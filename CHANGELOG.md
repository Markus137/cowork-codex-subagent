# Changelog

This file preserves the development history of Cowork Codex Preflight — the
version-by-version bug work, the measured run timings, and the dated review
observations that shaped the current design. It was extracted from earlier
revisions of the README so that history is kept without turning the README into
a change log. Newest first.

Repository names in the recorded observations below are neutral placeholders
(`example-org/web-template`, `example-org/example-app`); the observations
themselves are otherwise unchanged.

## 1.3.3

Prevents a successfully applied correction resume from losing its usable result
to an empty `finding_dispositions[].disposition` value. The validator correctly
rejected that value fail-closed, but the generated result-envelope example used
an empty findings list and therefore never showed the disposition example held
by the schema.

**Red-test reproduction.** A sanitized replay fixture models the observed
correction-resume envelope with `finding_dispositions[0].disposition` set to an
empty string. The regression test proves that validation reports the exact
`finding_dispositions[0].disposition` path with `value_out_of_range`, exercises
the worker's `blocked` / `result_validation` / null-result outcome, and requires
the generated resume prompt to state non-empty disposition semantics with
concrete examples. That prompt assertion fails against `1.3.2`.

**Prompt-contract fix.** The programmatic result-envelope contract now states
that each disposition must be a non-empty string and gives `fixed`, `rejected`,
and `not_applicable` examples. Both start and resume prompts inherit the same
schema-driven wording. Validation remains unchanged and continues to reject
empty dispositions fail-closed.

## 1.3.2

Fixes the remaining deterministic first-write abort in `1.3.1`. A live
`1.3.1` run generated the concrete GitHub connector id correctly, yet its first
`create_branch` still returned `user cancelled MCP tool call` with a zero
duration and no approval-request event.

**Second red-test reproduction.** `1.3.1` emitted the CLI dotted path as
`apps."connector_...".default_tools_approval_mode="approve"`. Codex's override
parser retained those quote characters in the app-map key. An app-server
`config/read` showed a key shaped as `"\"connector_...\""`, which could not match
the unquoted connector id carried by the GitHub tool. The global `writes`
fallback therefore remained effective. A new test first failed by requiring the
bare-key form and rejecting the literal-quote form.

**Bare-key fix.** Connector ids already pass the narrow
`^connector_[A-Za-z0-9_]{1,128}$` grammar, so the worker now safely emits
`apps.connector_examplegithub123.default_tools_approval_mode="approve"`
without quote characters. The optional legacy reviewer path uses the same key.
Every other app keeps the global `writes` mode, and missing or unsafe connector
state still fails closed before spawn.

## 1.3.1

Fixes the deterministic first-write abort that remained after the `1.3.0`
approval-reviewer removal. A live `1.3.0` run completed all read-only GitHub
inspection and SOL/Terra review, then returned `user cancelled MCP tool call` in
zero milliseconds on its first `create_branch`, with no approval-request event.

**Red-test reproduction.** `1.3.0` emitted the intended exception as
`apps.github.default_tools_approval_mode="approve"`, while Codex resolves app
policy by the concrete connector id from tool metadata. The new regression test
supplied a neutral `connector_...` id and failed because the generated arguments
contained only the unmatched `apps.github` key. The global app default therefore
remained `writes`, which requested an unavailable interactive approval inside
non-interactive `codex exec` and immediately returned the cancellation string.

**Connector-specific fix.** The worker now resolves the concrete GitHub
connector id from a bounded Codex desktop state file before launch, validates it
against a narrow grammar, and attempts to apply
`default_tools_approval_mode="approve"` to that exact connector. This first
correction still quoted the CLI path segment; `1.3.2` documents and corrects
that follow-up defect.

**Fail-closed state handling.** Missing, malformed, symlinked, empty, or
oversized connector state returns `GITHUB_CONNECTOR_ID_UNAVAILABLE` before the
Codex child is spawned. Offline tests cover the originally red mismatch, valid
and invalid connector state, concrete-id targeting for both gate modes, and the
no-spawn terminal outcome.

## 1.3.0

Removed the LLM approval gate for GitHub writes. The runtime automatic approval
reviewer (`approvals_reviewer="auto_review"`) acted as a non-deterministic LLM
gate that inconsistently blocked rule-conformant GitHub writes — documented as
"Bug 8" and last observed on run `CFT-20260718-175818-63DABEBB`, where a
`create_commit` on the correct task branch was denied despite a bounded
re-request. That reviewer is gone; the "Bug 8" references are obsolete by
removal.

**CLI configuration.** The worker still starts Codex read-only
(`sandbox_mode="read-only"`, `--sandbox read-only`, `approval_policy="on-request"`,
`--strict-config`, ignored user config), and non-GitHub app writes still require
approval (`apps._default.default_tools_approval_mode="writes"`). The only change
is that the GitHub app's write tools now auto-approve
(`apps.github.default_tools_approval_mode="approve"`) with no
`approvals_reviewer` and no `auto_review.policy`. This is the minimal-invasive
option: approval interception is disabled precisely for the GitHub MCP writes,
not via a blanket `danger-full-access` or `--yolo`, and the read-only base mode
for everything else is unchanged.

**Reactivation flag.** Setting the `COWORK_CODEX_APPROVAL_GATE` environment
variable to `1`, `true`, or `on` restores the legacy gate (the
`approvals_reviewer="auto_review"` configuration and the run-specific
`auto_review.policy`), so the feature can be re-enabled without a code change.

**Approval-failure paths kept as fail-closed classification.** The
`GITHUB_WRITE_APPROVAL_DENIED` / `_TIMEOUT` / `_ABORTED` reason codes, the
one-retry tracker, and the sanitized `approval_denial_detail` projection are
retained rather than deleted. They remain a general fail-closed classifier for a
GitHub write that is rejected, times out, or is aborted — which now covers a
push that branch protection or repository permissions reject — so removing them
would have deleted tested protection that becomes more relevant under branch
protection. Only the reviewer-policy producer (`buildAutoReviewPolicy`) stays
gated behind the reactivation flag. No approval-classification test was deleted
or weakened.

**Security model after removal (three compensating controls).** Branch
protection on the base branch of the target repositories (configured by the
owner) blocks a bad merge to `main`; the fail-closed host observer and the full
guard family (commit-message contract, branch/repository/force checks,
marker-only PR body, `policyViolation` for foreign tools) block a bad write
before it lands; the GitHub Automatic/`@codex review` quality review still runs
unchanged. The host observer and guard family are untouched, proven by the
retained negative tests.

## 1.2.13

Robust commit observation across real MCP result shapes, plus a bounded,
self-describing commit guard. Since the 1.2.9 public release, every
implementation run failed with `IMPLEMENTATION_COMMIT_MESSAGE_INVALID` before a
commit landed on the task branch. Reproduced with sanitized replay fixtures
(`test/fixtures/replay-commit-shapes.json`) covering the observed runs
(`CFT-20260718-150029-9E85EBCA`, `CFT-20260718-151200-33D39EAF`,
`CFT-20260717-214541-0883FBF3`). Root cause: the observer read a low-level
`create_commit` result SHA only from `structured.result.sha` (and a
`create_file`/`update_file` SHA only from `structured.commit_sha`), so every
other equivalent MCP result shape left the explained-commit ledger empty and
`update_ref` was terminally blocked as `update_ref_requires_observed_explained_commit`.

- **Shape-tolerant SHA extraction.** A fallback chain now reads the commit SHA
  from `result.sha`, `sha`, `result.commit.sha`, `commit.sha`, `result.object.sha`,
  `object.sha`, and `commit_sha`, accepting a value only when the present shapes
  agree; conflicting shapes are ambiguous and rejected. Only when a call carries
  no structured content at all, a single unambiguous hex-bounded 40-hex SHA in
  the text content block is used as a last resort; structured content of an
  unrecognized shape never falls through to text, and a longer hex run (such as
  a sha256 digest) never yields a 40-hex substring match. A `create_commit` with
  a correct seven-line body is never rejected on result shape alone.
- **No silent terminal block for corrigible deviations.** A corrigible
  commit-guard deviation — a reused explanation
  (`new_commit_requires_fresh_explanation`) or a well-formed `update_ref` to a
  not-yet-observed explained commit
  (`update_ref_requires_observed_explained_commit`) — now names the rule and the
  exact expected correction in a classified guard result carrying a correctable
  flag. The run itself still ends fail-closed: the automatic in-run correction
  resume for guard blocks is not yet wired (today only `complete` jobs can be
  resumed), so the correctable flag is advisory until that resume gate lands.
- **Protection unchanged.** Unexplained commit bodies, foreign repositories or
  branches, force pushes, and base-branch writes stay rejected and are never
  advertised as correctable; the invalid write is still stopped at
  `item.started` before it can land.

## 1.2.12

Version and changelog catch-up: five write-denial commits landed on `main` after
the 1.2.11 bump without their own version, so 1.2.12 carries them for the
marketplace. The behavioral changes:

- **Denial signature correlation.** A denial is correlated to the signature
  recorded at the write's own `item.started` event, so an argument-less failed
  `item.completed` no longer records an empty-path signature and a denied
  path-scoped write reliably reaches `denied_once`.
- **Per-tool FIFO assignment.** Started signatures are queued per tool, so two
  same-tool writes in flight track independently instead of overwriting each
  other, and each completion resolves the write it belongs to.
- **Per-signature outstanding failures.** A write that recovers on its allowed
  retry clears only its own failure; another still-open denial or timeout stays
  the observed terminal outcome instead of `CODEX_RUN_FAILED`.
- **First-write detail preservation.** A first-write denial with no branch
  observed yet still surfaces the sanitized `approval_denial_detail` through a
  denial-only `partial_evidence` shape.
- **Extended host-path redaction.** Denial rationales now also redact
  single-segment absolute paths (`/tmp`, `/workspace`) and quoted or
  parenthesized absolute paths, in addition to `/Users/` and Windows drive
  paths.

Denied approvals still terminate as `blocked`/`incomplete` with the correct
reason code, timeouts and aborts are still never retried, and no
`approval_pending` state is invented.

## 1.2.11

Closes two edge cases in the 1.2.10 write-denial handling.

- A denied path-scoped write (`create_file`/`update_file`) is now correlated to
  the signature recorded at its own `item.started` event via a per-tool FIFO
  queue, so a failed `item.completed` that omits `arguments` no longer records
  an empty-path signature, and two same-tool writes in flight no longer
  overwrite each other's tracking. A denied path reliably reaches `denied_once`,
  and a third re-request for the same path fails closed.
- Outstanding approval failures are tracked per write signature, so a write that
  recovers on its allowed retry clears only its own failure. Another still-open
  denial or timeout remains the observed terminal outcome instead of falling
  back to `CODEX_RUN_FAILED`.
- A first-write denial (for example `create_branch` failing approval before any
  branch is observed) now surfaces the sanitized denial rationale to the caller:
  `sanitizedPublicEvidence` accepts a denial-only evidence object carrying only
  `approval_denial_detail`, without inventing repository/branch/head/PR fields,
  and that shape survives the MCP-facing projection.

Denied approvals still terminate as `blocked`/`incomplete` with the correct
reason code, timeouts and aborts are still never retried, and no
`approval_pending` state is invented.

## 1.2.10

Hardens GitHub write-denial handling and publishes a sanitized
`partial_evidence.approval_denial_detail` on a denied write.

- An invalid mutation (a malformed implementation commit message or an
  unauthorized PR-body update) fails closed at the tool's `item.started` event,
  before the write can execute, so an approved-but-invalid write can never land
  on the task branch. A well-formed write that is denied still reports
  `GITHUB_WRITE_APPROVAL_DENIED` with the sanitized denial detail.
- The published denial rationale is redacted: labelled and unlabelled
  credential formats, high-entropy blobs, host paths, and session/thread
  identifiers are dropped in favor of `runtime_emitted_no_rationale`; only a
  genuinely benign rationale is preserved verbatim.
- The bounded one-retry re-request tracker now covers every policy-authorized
  write tool bound to the deterministic task branch — `create_blob`,
  `create_branch`, `create_commit`, `create_file`, `create_pull_request`,
  `create_tree`, `update_file`, `update_pull_request`, and `update_ref` — not
  just the core delivery writes. A third matching attempt fails closed.
- All published release versions are synchronized to 1.2.10 (plugin manifest,
  runtime `PLUGIN_VERSION`, marketplace manifest, README, and both skill
  manifests).

The commit-stage replay for `CFT-20260717-204250-3279BBF5` records a created
branch at zero ahead/behind, no commit, no pull request, and no runtime
rationale in the available replay. The worker therefore reports
`runtime_emitted_no_rationale` without claiming that every runtime denial is
structurally rationale-free.

## 1.2.9

Resolves Bug 23 by moving the implementation explanation from the additional
context-comment write into the already necessary, host-validated commit body
while retaining the exact marker-only PR body. A validated private seed supports
a no-op correction resume; a real correction commit must replace it with a fresh
explanation.

## 1.2.8

Introduced the now-replaced post-PR context-comment design.

## 1.2.7

Closes residue-reporting Bug 20 and duplicate-evidence Bug 21, and removes Bug
8's ambiguous PR-body input by emitting only the canonical marker from the
SOL-owned main thread.

## 1.2.6

Closed result-envelope Bug 19. The frozen schema in `server/result-envelope.js`
now generates both start/resume runtime contracts, all 18 accepted top-level
keys, their exact nested shapes, sanitized expected types, and a canonical
type-shape example.

## 1.2.5

Closed audit-report Bugs 16–18 and made the earlier Bug 6 failure path reachable
and explicit. The host retains the last completed audit-report write, validates
its exact sentinel JSON, verifies the full report self-fetch plus byte-exact
cited ranges, and rejects the PR call at `item.started` before GitHub can create
it. Parse, schema, and binding failures have distinct sanitized path/rule
evidence. Every terminal path merges fresh observations with persisted branch/PR
residues, so a malformed result cannot erase already observed resources. A
parseable but unverified audit result remains `AUDIT_EVIDENCE_UNVERIFIED`.

Version 1.2.5 treats a reassuring final issue-comment as clean only from its
bound metadata, unique commit marker, explicit empty `review_comments`, and true
absence of priority-like material — not from the reassuring prose.

The former 30-minute cap would have left only about 29 seconds of margin in the
measured run; version 1.2.5 therefore retains the structured 45-minute default
unless an explicit 15–120 minute override is supplied.

## 1.2.3

Bug 10 stale status was fixed by same-repository event-bound progress and
`updated_at`. Bug 11 was mitigated by the one-shot structured 45-minute default
with explicit 15–120 bounds. The measured long delay was model reasoning, not an
approval wait.

## Cross-version bug notes

Bug 8 is an inconsistent approval-policy interpretation, not a timeout. Later
paired runs exposed the actual Bug 8 boundary: both PR calls came from Terra and
both included text beyond the PENDING marker, yet the automatic reviewer denied
one and allowed the other. The workflow does not retry or bypass that
inconsistent policy interpretation. It removes the ambiguous input and ownership
instead: Terra is read-only, SOL owns every mutation in the main thread, and a
new PR body is exactly the canonical marker.

## Measured run timing

Sanitized Bugreport-5 timing for `CFT-20260716-034901-8DA59548` was 1771.481s
total: Terra GitHub work 77.675s, then a 1605.934s reasoning/model gap with no
GitHub or approval event, then 69.957s for SOL's final segment. The outer PR
call took 10.053s and GitHub PR creation 1.4586s and succeeded.

## Recorded review observations

Reported historical initial-review observations, supplied on 2026-07-16 and not
inspected by this plugin, described Automatic review on `example-org/example-app`
PR #286 with P1 and PR-level `+1` no-findings behavior, plus canonical P2
findings with a `Reviewed commit: <10-hex-prefix>` marker on PRs #291/#292. They
are retained only as dated, reported initial-Automatic-review observations — not
guarantees of current GitHub behavior — and remain separate from the final
evidence below. They require P0–P3 handling even though the current official
manual describes GitHub review as P0/P1-focused.

Separately, an observed final run on 2026-07-16 for `example-org/web-template`
PR #4 used head `23652c4dac90ab4069dde1d3dcaeb6fc88d0a9da`. Trigger issue-comment
`4988770330` was created at `2026-07-16T06:11:06Z`; Codex response issue-comment
`4988786178` followed at `2026-07-16T06:13:25Z` with body `Codex Review: Didn't
find any major issues. Can't wait for the next one!`, a single Markdown
`Reviewed commit: 23652c4dac` marker, and zero review submissions, inline review
comments, or final reactions. Version 1.2.5 treats that final issue-comment as
clean only from its bound metadata, unique commit marker, explicit empty
`review_comments`, and true absence of priority-like material — not from the
reassuring prose. The current bundled regression reference for that supported
shape is `test/fixtures/final-issue-comment-template-pr4.json`, captured from
this 2026-07-16 observation. The fixture is current local test evidence, not a
guarantee about a changing external GitHub/Codex service. The `example-app`
observations above are historical background only and are subordinate to this
current bundled regression reference.
