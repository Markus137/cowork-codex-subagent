# Changelog

This file preserves the development history of Cowork Codex Preflight — the
version-by-version bug work, the measured run timings, and the dated review
observations that shaped the current design. It was extracted from earlier
revisions of the README so that history is kept without turning the README into
a change log. Newest first.

Repository names in the recorded observations below are neutral placeholders
(`example-org/web-template`, `example-org/example-app`); the observations
themselves are otherwise unchanged.

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
