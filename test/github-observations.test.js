"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MANUAL_PR_RECOVERY_INSTRUCTION,
  acceptedImplementationCommitMessage,
  acceptedPendingMarkerLine,
  auditEvidenceBlock,
  createObservationCollector,
  implementationCommitMessage,
  observeGithubEvent,
  pendingMergeMarker,
  trustedPublicObservation,
  validateAuditReportBeforePullRequest,
  validateImplementationCommitBeforeMutation,
  validateObservedAuditEvidence,
  validateObservedPullRequest,
} = require("../server/github-observations");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-af8688fd.json"), "utf8"));
const saturationFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-937c1ad8.json"), "utf8"));

function collectorContext() {
  return {
    runId: fixture.source_run_id,
    repository: fixture.repository,
    baseBranch: fixture.base_branch,
    taskBranch: fixture.task_branch,
    auditPath: fixture.audit_path,
  };
}

function completed(tool, args, structured, casing = "structuredContent") {
  return {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "codex_apps",
      tool: `github.${tool}`,
      status: "completed",
      error: null,
      arguments: args,
      result: { isError: false, [casing]: structured },
    },
  };
}

function stateAndEnvelope() {
  const state = {
    auditPath: fixture.audit_path,
    contract: { repository: fixture.repository, baseBranch: fixture.base_branch, taskType: fixture.task_type },
  };
  const envelope = {
    status: "complete",
    repository: fixture.repository,
    base_branch: fixture.base_branch,
    task_branch: fixture.task_branch,
    head_sha: fixture.head_sha,
    pr_number: fixture.pr_number,
    pr_url: `https://github.com/${fixture.repository}/pull/${fixture.pr_number}`,
    audit_evidence: {
      audited_sha: fixture.audited_sha,
      scope: ["Impressum page."],
      findings: ["No defect established."],
      verification: "Exact range fetched.",
      line_evidence: [{ path: fixture.source_path, start_line: fixture.start_line, end_line: fixture.end_line, snippet: fixture.snippet }],
    },
  };
  return { state, envelope };
}

function collectorWithAuditReport(content) {
  const collector = createObservationCollector(collectorContext());
  observeGithubEvent(collector, completed("fetch_file", {
    repository_full_name: fixture.repository,
    path: fixture.source_path,
    ref: fixture.audited_sha,
    start_line: fixture.start_line,
    end_line: fixture.end_line,
    encoding: "utf-8",
  }, { content: fixture.snippet, encoding: "utf-8", sha: "e".repeat(40) }));
  observeGithubEvent(collector, completed("fetch_file", {
    repository_full_name: fixture.repository,
    path: fixture.audit_path,
    ref: fixture.head_sha,
    encoding: "utf-8",
  }, { content, encoding: "utf-8", sha: "f".repeat(40) }));
  return collector;
}

test("sanitized AF8688FD replay proves PR identity and exact audit evidence", () => {
  const { state, envelope } = stateAndEnvelope();
  const collector = createObservationCollector(collectorContext());
  const events = [
    completed("create_branch", { repository_full_name: fixture.repository, branch_name: fixture.task_branch, sha: fixture.audited_sha }, { branch: fixture.task_branch }),
    completed("create_file", { repository_full_name: fixture.repository, branch: fixture.task_branch, path: fixture.audit_path, message: "audit", content: "bounded" }, { commit_sha: fixture.head_sha }),
    completed("create_pull_request", { repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch, draft: false, body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha) }, {
      url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
      base: fixture.base_branch, base_sha: fixture.audited_sha, head: fixture.task_branch, head_sha: fixture.head_sha,
      body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
    }),
    completed("fetch_pr", { repository_full_name: fixture.repository, pr_number: fixture.pr_number }, {
      pull_request: {
        url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
        base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha,
        body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
      },
    }),
    completed("fetch_file", {
      repository_full_name: fixture.repository, path: fixture.source_path, ref: fixture.audited_sha,
      start_line: fixture.start_line, end_line: fixture.end_line, encoding: "utf-8",
    }, { content: fixture.snippet, encoding: "utf-8", sha: "e".repeat(40) }, "structured_content"),
    completed("fetch_file", {
      repository_full_name: fixture.repository, path: fixture.audit_path, ref: fixture.head_sha, encoding: "utf-8",
    }, { content: `# Audit\n\n${auditEvidenceBlock(state, envelope)}\n`, encoding: "utf-8", sha: "f".repeat(40) }),
  ];
  for (const event of events) observeGithubEvent(collector, event);
  assert.deepEqual(validateObservedPullRequest(collector, envelope), { ok: true });
  assert.deepEqual(validateObservedAuditEvidence(collector, state, envelope), { ok: true, auditEvidence: envelope.audit_evidence });
  const observed = trustedPublicObservation(collector);
  assert.equal(observed.partialEvidence.pr_number, fixture.pr_number);
  assert.equal(observed.leftoverResources[0].name, fixture.task_branch);
});

test("audit evidence fails closed when artifact and envelope diverge", () => {
  const { state, envelope } = stateAndEnvelope();
  const collector = createObservationCollector(collectorContext());
  observeGithubEvent(collector, completed("fetch_file", {
    repository_full_name: fixture.repository, path: fixture.audit_path, ref: fixture.head_sha, encoding: "utf-8",
  }, { content: `# Audit\n\n${auditEvidenceBlock(state, envelope)}\n`, encoding: "utf-8", sha: "f".repeat(40) }));
  const divergent = { ...envelope, audit_evidence: { ...envelope.audit_evidence, findings: ["Different finding."] } };
  assert.equal(validateObservedAuditEvidence(collector, state, divergent).ok, false);
});

test("audit mismatch detail is bounded and redacts long control and secret-like values", () => {
  const { state, envelope } = stateAndEnvelope();
  const report = `# Audit\n\n${auditEvidenceBlock(state, envelope)}\n`;
  const hostile = `SECRET_TOKEN_abcdefghijklmnopqrstuvwxyz0123456789\n\u0000${"x".repeat(2048)}`;
  const claimed = {
    ...envelope,
    audit_evidence: { ...envelope.audit_evidence, findings: [hostile] },
  };
  const result = validateObservedAuditEvidence(collectorWithAuditReport(report), state, claimed);
  assert.equal(result.ok, false);
  assert.equal(result.path, "audit_artifact.evidence_block.audit_evidence.findings[0]");
  assert.equal(result.rule, "report_block_mismatch");
  assert.deepEqual(Object.keys(result.mismatch).sort(), ["artifact", "envelope"]);
  assert.equal(Buffer.byteLength(JSON.stringify(result.mismatch), "utf8") <= 512, true);
  assert.equal(JSON.stringify(result.mismatch).includes("SECRET_TOKEN"), false);
  for (const preview of Object.values(result.mismatch)) {
    assert.deepEqual(Object.keys(preview).sort(), preview.truncated || preview.sensitive
      ? ["preview", "sensitive", "sha256", "truncated", "utf8_bytes"]
      : ["preview", "sensitive", "truncated", "utf8_bytes"]);
    assert.doesNotMatch(preview.preview, /[\u0000-\u001f\u007f]/);
    if (preview.truncated || preview.sensitive) assert.match(preview.sha256, /^[0-9a-f]{64}$/);
  }
});

test("audit report rejects duplicate start, duplicate end, and duplicate full blocks", () => {
  const { state, envelope } = stateAndEnvelope();
  const block = auditEvidenceBlock(state, envelope);
  const invalidReports = [
    `<!-- COWORK_CODEX_AUDIT_EVIDENCE_V1\n${block}`,
    `${block}\nCOWORK_CODEX_AUDIT_EVIDENCE_V1 -->`,
    `${block}\n${block}`,
  ];
  for (const content of invalidReports) {
  const collector = createObservationCollector(collectorContext());
    observeGithubEvent(collector, completed("fetch_file", {
      repository_full_name: fixture.repository, path: fixture.audit_path, ref: fixture.head_sha, encoding: "utf-8",
    }, { content, encoding: "utf-8", sha: "f".repeat(40) }));
    assert.equal(validateObservedAuditEvidence(collector, state, envelope).ok, false);
  }
});

test("verified PR alone proves deterministic branch residue", () => {
  const { envelope } = stateAndEnvelope();
  const collector = createObservationCollector(collectorContext());
  observeGithubEvent(collector, completed("create_pull_request", {
    repository_full_name: fixture.repository,
    head: fixture.task_branch,
    base: fixture.base_branch,
    draft: false,
    body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
  }, {
    url: envelope.pr_url,
    number: fixture.pr_number,
    state: "open",
    merged: false,
    draft: false,
    base: fixture.base_branch,
    base_sha: fixture.audited_sha,
    head: fixture.task_branch,
    head_sha: fixture.head_sha,
    body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
  }));
  assert.equal(collector.branchCreated, false);
  const observed = trustedPublicObservation(collector);
  assert.equal(observed.leftoverResources[0].name, fixture.task_branch);
});

test("create_branch accepts exactly one contract-bound source form", () => {
  const eventFor = (args) => completed("create_branch", {
    repository_full_name: fixture.repository,
    branch_name: fixture.task_branch,
    ...args,
  }, { branch: fixture.task_branch });
  const collect = (args) => {
  const collector = createObservationCollector(collectorContext());
    observeGithubEvent(collector, eventFor(args));
    return collector;
  };

  const byBase = collect({ base_ref: fixture.base_branch });
  assert.equal(byBase.branchCreated, true);
  assert.equal(byBase.headSha, null);
  const bySha = collect({ sha: fixture.audited_sha });
  assert.equal(bySha.branchCreated, true);
  assert.equal(bySha.headSha, fixture.audited_sha);
  for (const invalid of [
    { base_ref: "wrong" },
    { base_ref: fixture.base_branch, sha: fixture.audited_sha },
    {},
    { sha: "not-a-sha" },
  ]) assert.equal(collect(invalid).branchCreated, false);
});

test("identity events remain visible after observation counter saturation", () => {
  const collector = createObservationCollector(collectorContext());
  for (let index = 0; index < 200; index += 1) {
    observeGithubEvent(collector, completed("get_repo", { repository_full_name: fixture.repository }, { id: index + 1 }));
  }
  observeGithubEvent(collector, completed("create_branch", {
    repository_full_name: fixture.repository,
    branch_name: fixture.task_branch,
    base_ref: fixture.base_branch,
  }, { branch: fixture.task_branch }));
  observeGithubEvent(collector, completed("create_file", {
    repository_full_name: fixture.repository,
    branch: fixture.task_branch,
    path: fixture.audit_path,
    message: "audit",
    content: "bounded",
  }, { commit_sha: fixture.head_sha }));
  observeGithubEvent(collector, completed("create_pull_request", {
    repository_full_name: fixture.repository,
    head: fixture.task_branch,
    base: fixture.base_branch,
    draft: false,
    body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
  }, {
    url: `https://github.com/${fixture.repository}/pull/${fixture.pr_number}`,
    number: fixture.pr_number,
    state: "open",
    merged: false,
    draft: false,
    base: fixture.base_branch,
    base_sha: fixture.audited_sha,
    head: fixture.task_branch,
    head_sha: fixture.head_sha,
  }));
  assert.equal(collector.count, 200);
  assert.equal(collector.branchCreated, true);
  assert.equal(collector.headSha, fixture.head_sha);
  assert.equal(collector.pullRequest.number, fixture.pr_number);
});

test("machine block accepts JSON order and whitespace but rejects extra keys", () => {
  const { state, envelope } = stateAndEnvelope();
  const reordered = {
    audit_evidence: envelope.audit_evidence,
    report_path: fixture.audit_path,
    base_branch: fixture.base_branch,
    repository: fixture.repository,
    schema: "cowork-codex-audit-evidence/v1",
  };
  const pretty = `# Audit\n\n<!-- COWORK_CODEX_AUDIT_EVIDENCE_V1\n${JSON.stringify(reordered, null, 2)}\nCOWORK_CODEX_AUDIT_EVIDENCE_V1 -->\n`;
  assert.deepEqual(validateObservedAuditEvidence(collectorWithAuditReport(pretty), state, envelope), { ok: true, auditEvidence: envelope.audit_evidence });

  const withExtra = { ...reordered, extra: true };
  const invalid = `<!-- COWORK_CODEX_AUDIT_EVIDENCE_V1\n${JSON.stringify(withExtra)}\nCOWORK_CODEX_AUDIT_EVIDENCE_V1 -->`;
  assert.equal(validateObservedAuditEvidence(collectorWithAuditReport(invalid), state, envelope).ok, false);
});

test("exact-branch file commits prove branch existence without create_branch visibility", () => {
  for (const [tool, commitSha] of [["create_file", "1".repeat(40)], ["update_file", "2".repeat(40)]]) {
  const collector = createObservationCollector(collectorContext());
    observeGithubEvent(collector, completed(tool, {
      repository_full_name: fixture.repository,
      branch: fixture.task_branch,
      path: "src/example.js",
      message: "bounded change",
      content: "export default true;",
      ...(tool === "update_file" ? { sha: "3".repeat(40) } : {}),
    }, { commit_sha: commitSha }));
    assert.equal(collector.branchCreated, true);
    const observed = trustedPublicObservation(collector);
    assert.equal(observed.partialEvidence.head_sha, commitSha);
    assert.equal(observed.leftoverResources[0].name, fixture.task_branch);
  }
});

test("PENDING marker rejects missing, duplicate, wrong-run, and wrong-head bodies", () => {
  const { envelope } = stateAndEnvelope();
  const correct = pendingMergeMarker(fixture.source_run_id, fixture.head_sha);
  const invalidBodies = [
    "No gate marker.",
    `${correct}\n${correct}`,
    pendingMergeMarker("CFT-20260715-141500-937C1AD8", fixture.head_sha),
    pendingMergeMarker(fixture.source_run_id, "9".repeat(40)),
  ];
  for (const body of invalidBodies) {
    const collector = createObservationCollector(collectorContext());
    const structured = {
      url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
      base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha, body,
    };
    observeGithubEvent(collector, completed("create_pull_request", {
      repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch, draft: false, body,
    }, structured));
    observeGithubEvent(collector, completed("fetch_pr", {
      repository_full_name: fixture.repository, pr_number: fixture.pr_number,
    }, { pull_request: structured }));
    assert.deepEqual(validateObservedPullRequest(collector, envelope), {
      ok: false, path: "pr_body.pending_marker", rule: "pending_do_not_merge_marker_required",
    });
  }
});

test("PENDING marker reads the legacy period but new creation accepts canonical-only body", () => {
  const { envelope } = stateAndEnvelope();
  const canonical = pendingMergeMarker(fixture.source_run_id, fixture.head_sha);
  assert.equal(acceptedPendingMarkerLine(canonical, canonical), canonical);
  assert.equal(acceptedPendingMarkerLine(`${canonical}.`, canonical), `${canonical}.`);
  for (const invalid of [
    `${canonical}..`,
    `${canonical}!`,
    `${canonical} `,
    `**${canonical}**`,
    `${canonical}\n${canonical}.`,
    `${canonical}.\n${canonical}.`,
  ]) assert.equal(acceptedPendingMarkerLine(invalid, canonical), null);

  for (const marker of [canonical, `${canonical}.`, `Summary.\n\n${canonical}`]) {
    const collector = createObservationCollector(collectorContext());
    const structured = {
      url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
      base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha, body: marker,
    };
    observeGithubEvent(collector, completed("create_pull_request", {
      repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch, draft: false, body: marker,
    }, structured));
    observeGithubEvent(collector, completed("get_pr_info", {
      repository_full_name: fixture.repository, pr_number: fixture.pr_number,
    }, structured));
    if (marker === canonical) {
      assert.deepEqual(validateObservedPullRequest(collector, envelope), { ok: true });
      assert.equal(collector.pendingCertification.markerLine, canonical);
    } else {
      assert.deepEqual(validateObservedPullRequest(collector, envelope), {
        ok: false, path: "pr_body.pending_marker", rule: "pending_do_not_merge_marker_required",
      });
      assert.equal(collector.pendingCertification, null);
    }
  }
});

function implementationMessage(overrides = {}) {
  return implementationCommitMessage({
    runId: fixture.source_run_id,
    subject: "Fix the scoped repository behavior",
    problem: "The requested behavior needed a concrete correction.",
    change: "The accepted Terra V2 change updates the scoped implementation.",
    rationale: "The bounded change directly addresses the established problem.",
    verification: "The exact remote result and requested source scope were checked.",
    ...overrides,
  });
}

function started(tool, args) {
  return { type: "item.started", item: { type: "mcp_tool_call", server: "codex_apps", tool: `github.${tool}`, arguments: args } };
}

test("implementation commit message is exact, bounded, neutral, and run bound", () => {
  const message = implementationMessage();
  assert.equal(acceptedImplementationCommitMessage(message, fixture.source_run_id), message);
  for (const invalid of [
    `${message}\n`,
    message.replace("\n\n", "\n"),
    message.replace("Problem: ", "Problem:\n"),
    message.replace("The requested", "@codex review The requested"),
    message.replace("The requested", "https://example.test The requested"),
    message.replace("The requested", "COWORK_CODEX_GATE_V1 The requested"),
    message.replace("The requested", `The${"x".repeat(385)}`),
    message.replace(fixture.source_run_id, "CFT-20260716-190746-FFFFFFFF"),
  ]) assert.equal(acceptedImplementationCommitMessage(invalid, fixture.source_run_id), null);
});

test("direct implementation commits bind PR create and final head without another write", () => {
  const { envelope } = stateAndEnvelope();
  const context = { ...collectorContext(), auditPath: null, taskType: "implementation" };
  const state = { contract: { taskType: "implementation" } };
  const collector = createObservationCollector(context);
  const firstHead = "7".repeat(40);
  const firstMessage = implementationMessage({ subject: "Prepare the scoped correction" });
  const finalMessage = implementationMessage();
  const argsFor = (message, branch = fixture.task_branch, repository = fixture.repository) => ({
    repository_full_name: repository, branch, path: "src/scoped.js", message, content: "bounded",
  });
  for (const invalidArgs of [
    argsFor("short subject only"),
    argsFor(finalMessage, "main"),
    argsFor(finalMessage, `refs/heads/${fixture.task_branch}`),
    argsFor(finalMessage, fixture.task_branch, "OtherOrg/other"),
  ]) assert.equal(validateImplementationCommitBeforeMutation(collector, state, started("create_file", invalidArgs)).ok, false);
  assert.equal(validateImplementationCommitBeforeMutation(collector, state, started("create_file", argsFor(firstMessage))).ok, true);
  observeGithubEvent(collector, completed("create_file", argsFor(firstMessage), { commit_sha: firstHead }));
  assert.equal(validateImplementationCommitBeforeMutation(collector, state, started("update_file", argsFor(finalMessage))).ok, true);
  observeGithubEvent(collector, completed("update_file", argsFor(finalMessage), { commit_sha: fixture.head_sha }));

  const marker = pendingMergeMarker(fixture.source_run_id, fixture.head_sha);
  const prArgs = { repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch, draft: false, body: marker };
  assert.deepEqual(validateImplementationCommitBeforeMutation(collector, state, started("create_pull_request", prArgs)), { ok: true });
  for (const invalid of [
    { ...prArgs, body: pendingMergeMarker(fixture.source_run_id, firstHead) },
    { ...prArgs, head: "other" },
  ]) assert.equal(validateImplementationCommitBeforeMutation(collector, state, started("create_pull_request", invalid)).ok, false);
  const pr = {
    url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
    base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha, body: marker,
  };
  observeGithubEvent(collector, completed("create_pull_request", prArgs, pr));
  observeGithubEvent(collector, completed("get_pr_info", { repository_full_name: fixture.repository, pr_number: fixture.pr_number }, pr));
  assert.deepEqual(validateObservedPullRequest(collector, { ...envelope, audit_evidence: null }), { ok: true });

  const rogue = createObservationCollector(context);
  observeGithubEvent(rogue, completed("create_file", argsFor(finalMessage), { commit_sha: fixture.head_sha }));
  observeGithubEvent(rogue, completed("update_file", argsFor("short subject only"), { commit_sha: "8".repeat(40) }));
  const roguePr = { ...pr, head_sha: "8".repeat(40) };
  observeGithubEvent(rogue, completed("create_pull_request", { ...prArgs, body: pendingMergeMarker(fixture.source_run_id, "8".repeat(40)) }, roguePr));
  observeGithubEvent(rogue, completed("get_pr_info", { repository_full_name: fixture.repository, pr_number: fixture.pr_number }, roguePr));
  assert.equal(validateObservedPullRequest(rogue, { ...envelope, head_sha: "8".repeat(40), audit_evidence: null }).rule, "final_pr_head_must_match_latest_explained_commit");
});

test("low-level implementation commit becomes branch-effective only through exact update_ref", () => {
  const context = { ...collectorContext(), auditPath: null, taskType: "implementation" };
  const state = { contract: { taskType: "implementation" } };
  const message = implementationMessage();
  const commitArgs = { repository_full_name: fixture.repository, message, tree: "1".repeat(40), parents: ["2".repeat(40)] };
  const collector = createObservationCollector(context);
  assert.deepEqual(validateImplementationCommitBeforeMutation(collector, state, started("create_commit", commitArgs)), { ok: true });
  observeGithubEvent(collector, completed("create_commit", commitArgs, { result: { sha: fixture.head_sha } }));
  assert.equal(collector.latestImplementationCommit, null);
  const refArgs = { repository_full_name: fixture.repository, branch_name: fixture.task_branch, sha: fixture.head_sha, force: false };
  assert.deepEqual(validateImplementationCommitBeforeMutation(collector, state, started("update_ref", refArgs)), { ok: true });
  observeGithubEvent(collector, completed("update_ref", refArgs, { result: {} }));
  assert.equal(collector.latestImplementationCommit.sha, fixture.head_sha);
  assert.equal(validateImplementationCommitBeforeMutation(collector, state, started("update_ref", refArgs)).ok, false);
  for (const invalid of [
    { ...refArgs, branch_name: "main" },
    { ...refArgs, branch_name: `refs/heads/${fixture.task_branch}` },
    { ...refArgs, force: true },
    { ...refArgs, sha: "9".repeat(40) },
  ]) assert.equal(validateImplementationCommitBeforeMutation(collector, state, started("update_ref", invalid)).ok, false);
  assert.equal(validateImplementationCommitBeforeMutation(collector, state, started("add_comment_to_issue", {
    repo_full_name: fixture.repository, pr_number: fixture.pr_number, comment: "explanation",
  })).rule, "context_comment_not_authorized");

  const rich = createObservationCollector(context);
  observeGithubEvent(rich, completed("create_commit", commitArgs, { result: { sha: fixture.head_sha } }));
  observeGithubEvent(rich, completed("update_ref", refArgs, {
    result: { ref: `refs/heads/${fixture.task_branch}`, object: { sha: fixture.head_sha } },
  }));
  assert.equal(rich.latestImplementationCommit.sha, fixture.head_sha);

  for (const result of [
    { ref: "refs/heads/main", object: { sha: fixture.head_sha } },
    { ref: `refs/heads/${fixture.task_branch}`, object: { sha: "9".repeat(40) } },
  ]) {
    const contradiction = createObservationCollector(context);
    observeGithubEvent(contradiction, completed("create_commit", commitArgs, { result: { sha: fixture.head_sha } }));
    observeGithubEvent(contradiction, completed("update_ref", refArgs, { result }));
    assert.equal(contradiction.latestImplementationCommit, null);
    assert.equal(contradiction.implementationCommitViolation, true);
  }
});

test("implementation correction requires a fresh explained final commit", () => {
  const { envelope } = stateAndEnvelope();
  const context = { ...collectorContext(), auditPath: null, taskType: "implementation" };
  const originalMarker = pendingMergeMarker(fixture.source_run_id, fixture.head_sha);
  const originalPr = {
    url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
    base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha, body: originalMarker,
  };
  const initial = createObservationCollector(context);
  const initialArgs = { repository_full_name: fixture.repository, branch: fixture.task_branch, path: "src/scoped.js", message: implementationMessage(), content: "v1" };
  observeGithubEvent(initial, completed("create_file", initialArgs, { commit_sha: fixture.head_sha }));
  observeGithubEvent(initial, completed("create_pull_request", {
    repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch, draft: false, body: originalMarker,
  }, originalPr));

  const newHead = "8".repeat(40);
  const resumed = createObservationCollector({
    ...context,
    pendingCertification: initial.pendingCertification,
    implementationCommit: initial.latestImplementationCommit,
  });
  const state = { contract: { taskType: "implementation" } };
  const correctionArgs = { ...initialArgs, message: implementationMessage({ subject: "Correct the reviewed implementation" }), content: "v2" };
  assert.equal(validateImplementationCommitBeforeMutation(resumed, state, started("update_file", initialArgs)).rule, "new_commit_requires_fresh_explanation");
  assert.deepEqual(validateImplementationCommitBeforeMutation(resumed, state, started("update_file", correctionArgs)), { ok: true });
  observeGithubEvent(resumed, completed("update_file", correctionArgs, { commit_sha: newHead }));
  observeGithubEvent(resumed, completed("get_pr_info", {
    repository_full_name: fixture.repository, pr_number: fixture.pr_number,
  }, { ...originalPr, head_sha: newHead }));
  assert.deepEqual(validateObservedPullRequest(resumed, { ...envelope, head_sha: newHead, audit_evidence: null }), { ok: true });
});

test("validated implementation seed permits a no-op resume while invalid seeds fail closed", () => {
  const { envelope } = stateAndEnvelope();
  const message = implementationMessage();
  const marker = pendingMergeMarker(fixture.source_run_id, fixture.head_sha);
  const certification = {
    status: "pending_do_not_merge", runId: fixture.source_run_id, repository: fixture.repository,
    number: fixture.pr_number, url: envelope.pr_url, createdHeadSha: fixture.head_sha, markerLine: marker,
  };
  const seed = {
    status: "branch_effective", runId: fixture.source_run_id, repository: fixture.repository,
    branch: fixture.task_branch, sha: fixture.head_sha, message, tool: "create_file",
  };
  const context = { ...collectorContext(), auditPath: null, taskType: "implementation", pendingCertification: certification };
  const collector = createObservationCollector({ ...context, implementationCommit: seed });
  assert.deepEqual(collector.latestImplementationCommit, seed);
  const pr = {
    url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
    base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha, body: marker,
  };
  observeGithubEvent(collector, completed("get_pr_info", {
    repository_full_name: fixture.repository, pr_number: fixture.pr_number,
  }, pr));
  assert.deepEqual(validateObservedPullRequest(collector, { ...envelope, audit_evidence: null }), { ok: true });

  for (const invalid of [
    { ...seed, sha: "not-a-sha" },
    { ...seed, branch: "main" },
    { ...seed, message: "subject only" },
    { ...seed, extra: true },
  ]) assert.equal(createObservationCollector({ ...context, implementationCommit: invalid }).latestImplementationCommit, null);
});

const shapeFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-commit-shapes.json"), "utf8"));

function shapeContext(overrides = {}) {
  return {
    runId: shapeFixture.source_run_id,
    repository: shapeFixture.repository,
    baseBranch: shapeFixture.base_branch,
    taskBranch: shapeFixture.task_branch,
    auditPath: null,
    taskType: "implementation",
    ...overrides,
  };
}

function shapeMessage(overrides = {}) {
  return implementationCommitMessage({
    runId: shapeFixture.source_run_id,
    subject: "Fix the scoped repository behavior",
    problem: "The requested behavior needed a concrete correction.",
    change: "The accepted Terra V2 change updates the scoped implementation.",
    rationale: "The bounded change directly addresses the established problem.",
    verification: "The exact remote result and requested source scope were checked.",
    ...overrides,
  });
}

// Build a completed MCP call carrying structured_content, a text content block, or both, mirroring
// the real result envelope (the shared `completed` helper only models structured_content).
function completedShape(tool, args, shape) {
  const result = { isError: false };
  if (shape.structured) result.structuredContent = shape.structured;
  if (typeof shape.text === "string") result.content = [{ type: "text", text: shape.text }];
  return {
    type: "item.completed",
    item: { type: "mcp_tool_call", server: "codex_apps", tool: `github.${tool}`, status: "completed", error: null, arguments: args, result },
  };
}

test("create_commit registers the explained commit across every real MCP result shape", () => {
  const state = { contract: { taskType: "implementation" } };
  const message = shapeMessage();
  const commitArgs = { repository_full_name: shapeFixture.repository, message, tree: "1".repeat(40), parents: ["2".repeat(40)] };
  const refArgs = { repository_full_name: shapeFixture.repository, branch_name: shapeFixture.task_branch, sha: shapeFixture.commit_sha, force: false };
  assert.ok(shapeFixture.create_commit_shapes.length >= 5);
  for (const shape of shapeFixture.create_commit_shapes) {
    const collector = createObservationCollector(shapeContext());
    observeGithubEvent(collector, completedShape("create_commit", commitArgs, shape));
    assert.equal(collector.implementationCommitViolation, false, `${shape.label}: no false violation`);
    assert.ok(
      collector.pendingImplementationCommits.some((item) => item.sha === shapeFixture.commit_sha),
      `${shape.label}: commit registered in the pending ledger`,
    );
    // The exact-body commit is now bindable: update_ref is accepted, not terminally blocked.
    assert.deepEqual(
      validateImplementationCommitBeforeMutation(collector, state, started("update_ref", refArgs)),
      { ok: true },
      `${shape.label}: update_ref accepted`,
    );
    observeGithubEvent(collector, completedShape("update_ref", refArgs, { structured: { result: {} } }));
    assert.equal(collector.latestImplementationCommit?.sha, shapeFixture.commit_sha, `${shape.label}: branch-effective`);
  }
});

test("create_file and update_ref bind the explained commit across every real MCP result shape", () => {
  const message = shapeMessage();
  const fileArgs = { repository_full_name: shapeFixture.repository, branch: shapeFixture.task_branch, path: "src/scoped.js", message, content: "bounded" };
  for (const shape of shapeFixture.create_file_shapes) {
    const collector = createObservationCollector(shapeContext());
    observeGithubEvent(collector, completedShape("create_file", fileArgs, shape));
    assert.equal(collector.commitObserved, true, `${shape.label}: commit observed`);
    assert.equal(collector.latestImplementationCommit?.sha, shapeFixture.commit_sha, `${shape.label}: branch-effective`);
  }
  const commitArgs = { repository_full_name: shapeFixture.repository, message, tree: "1".repeat(40), parents: ["2".repeat(40)] };
  const refArgs = { repository_full_name: shapeFixture.repository, branch_name: shapeFixture.task_branch, sha: shapeFixture.commit_sha, force: false };
  for (const shape of shapeFixture.update_ref_shapes) {
    const collector = createObservationCollector(shapeContext());
    observeGithubEvent(collector, completedShape("create_commit", commitArgs, { structured: { result: { sha: shapeFixture.commit_sha } } }));
    observeGithubEvent(collector, completedShape("update_ref", refArgs, shape));
    assert.equal(collector.latestImplementationCommit?.sha, shapeFixture.commit_sha, `${shape.label}: ref binds explained commit`);
    assert.equal(collector.implementationCommitViolation, false, `${shape.label}: no violation`);
  }
});

test("ambiguous or absent commit SHAs never register or falsely bind", () => {
  const message = shapeMessage();
  const commitArgs = { repository_full_name: shapeFixture.repository, message, tree: "1".repeat(40), parents: ["2".repeat(40)] };
  // Two different SHAs at known commit paths are ambiguous and must not register.
  const ambiguous = createObservationCollector(shapeContext());
  observeGithubEvent(ambiguous, completedShape("create_commit", commitArgs, {
    structured: { sha: shapeFixture.commit_sha, object: { sha: shapeFixture.second_sha } },
  }));
  assert.equal(ambiguous.pendingImplementationCommits.length, 0);
  assert.equal(ambiguous.implementationCommitViolation, true);
  // Text with two distinct SHAs is not uniquely extractable.
  const ambiguousText = createObservationCollector(shapeContext());
  observeGithubEvent(ambiguousText, completedShape("create_commit", commitArgs, {
    text: `Created ${shapeFixture.commit_sha}, replacing ${shapeFixture.second_sha}.`,
  }));
  assert.equal(ambiguousText.pendingImplementationCommits.length, 0);
});

test("corrigible commit-guard deviations name the rule and expected correction, terminal ones do not", () => {
  const state = { contract: { taskType: "implementation" } };
  const message = shapeMessage();
  const fileArgs = { repository_full_name: shapeFixture.repository, branch: shapeFixture.task_branch, path: "src/scoped.js", message, content: "v1" };

  // Reused explanation on a second commit is corrigible: it names the rule and the expected fresh
  // body, and offers exactly one correction.
  const collector = createObservationCollector(shapeContext());
  observeGithubEvent(collector, completedShape("create_file", fileArgs, { structured: { commit_sha: shapeFixture.commit_sha } }));
  const reuse = validateImplementationCommitBeforeMutation(collector, state, started("update_file", fileArgs));
  assert.equal(reuse.ok, false);
  assert.equal(reuse.code, "IMPLEMENTATION_COMMIT_MESSAGE_INVALID");
  assert.equal(reuse.rule, "new_commit_requires_fresh_explanation");
  assert.equal(reuse.correctable, true);
  assert.equal(reuse.correction.rule, "new_commit_requires_fresh_explanation");
  assert.ok(typeof reuse.correction.expected_action === "string" && reuse.correction.expected_action.length > 0);
  assert.equal(reuse.expected, reuse.correction.expected_action);

  // A well-formed update_ref to a not-yet-observed commit is the corrigible ledger-timing case.
  const timing = createObservationCollector(shapeContext());
  const refArgs = { repository_full_name: shapeFixture.repository, branch_name: shapeFixture.task_branch, sha: shapeFixture.commit_sha, force: false };
  const unobserved = validateImplementationCommitBeforeMutation(timing, state, started("update_ref", refArgs));
  assert.equal(unobserved.ok, false);
  assert.equal(unobserved.rule, "update_ref_requires_observed_explained_commit");
  assert.equal(unobserved.correctable, true);

  // The one correction is spent: a repeat after the correction resume is terminal (not correctable).
  const spent = createObservationCollector(shapeContext({ implementationCorrectionUsed: true }));
  const spentReuse = validateImplementationCommitBeforeMutation(spent, state, started("update_ref", refArgs));
  assert.equal(spentReuse.ok, false);
  assert.equal(spentReuse.correctable, false);

  // Security violations stay hard-terminal and are never advertised as correctable.
  for (const [label, args] of [
    ["force push", { ...refArgs, force: true }],
    ["foreign branch", { ...refArgs, branch_name: "main" }],
    ["foreign repository", { ...refArgs, repository_full_name: "OtherOrg/other" }],
  ]) {
    const guard = validateImplementationCommitBeforeMutation(createObservationCollector(shapeContext()), state, started("update_ref", args));
    assert.equal(guard.ok, false, `${label}: rejected`);
    assert.notEqual(guard.correctable, true, `${label}: not correctable`);
  }
  // An unexplained commit body stays terminal on create_file/create_commit too.
  const unexplained = validateImplementationCommitBeforeMutation(
    createObservationCollector(shapeContext()), state,
    started("create_file", { ...fileArgs, message: "not a valid marker message" }),
  );
  assert.equal(unexplained.ok, false);
  assert.equal(unexplained.rule, "exact_bounded_run_commit_body_required");
  assert.notEqual(unexplained.correctable, true);
});

test("final PR body is byte-exact and body updates are blocked before mutation", () => {
  const { envelope } = stateAndEnvelope();
  const context = { ...collectorContext(), auditPath: null, taskType: "implementation" };
  const state = { contract: { taskType: "implementation" } };
  const collector = createObservationCollector(context);
  const args = {
    repository_full_name: fixture.repository, branch: fixture.task_branch, path: "src/scoped.js",
    message: implementationMessage(), content: "bounded",
  };
  observeGithubEvent(collector, completed("create_file", args, { commit_sha: fixture.head_sha }));
  const marker = pendingMergeMarker(fixture.source_run_id, fixture.head_sha);
  const prArgs = { repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch, draft: false, body: marker };
  const pr = {
    url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
    base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha, body: marker,
  };
  observeGithubEvent(collector, completed("create_pull_request", prArgs, pr));
  assert.equal(validateImplementationCommitBeforeMutation(collector, state, started("update_pull_request", {
    repository_full_name: fixture.repository, pr_number: fixture.pr_number, body: `${marker}\n\nSummary`,
  })).rule, "pull_request_body_update_not_authorized");
  observeGithubEvent(collector, completed("get_pr_info", {
    repository_full_name: fixture.repository, pr_number: fixture.pr_number,
  }, { ...pr, body: `${marker}\n\nSummary` }));
  assert.equal(validateObservedPullRequest(collector, { ...envelope, audit_evidence: null }).rule, "pending_do_not_merge_marker_required");
});

test("PENDING marker preserves the exact originally observed variant across create and final reads", () => {
  const { envelope } = stateAndEnvelope();
  const canonical = pendingMergeMarker(fixture.source_run_id, fixture.head_sha);
  const base = {
    url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
    base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha,
  };
  for (const [createdMarker, finalMarker] of [[canonical, `${canonical}.`], [`${canonical}.`, canonical]]) {
    const collector = createObservationCollector(collectorContext());
    observeGithubEvent(collector, completed("create_pull_request", {
      repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch,
      draft: false, body: createdMarker,
    }, { ...base, body: createdMarker }));
    observeGithubEvent(collector, completed("get_pr_info", {
      repository_full_name: fixture.repository, pr_number: fixture.pr_number,
    }, { ...base, body: finalMarker }));
    assert.deepEqual(validateObservedPullRequest(collector, envelope), {
      ok: false, path: "pr_body.pending_marker", rule: "pending_do_not_merge_marker_required",
    });
  }
});

test("final PR fetch is required and fetch-only cannot invent a trusted marker", () => {
  const { envelope } = stateAndEnvelope();
  const structured = {
    url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
    base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha,
    body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
  };
  const createOnly = createObservationCollector(collectorContext());
  observeGithubEvent(createOnly, completed("create_pull_request", {
    repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch, draft: false,
    body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
  }, structured));
  assert.deepEqual(validateObservedPullRequest(createOnly, envelope), {
    ok: false, path: "pr_identity", rule: "successful_final_same_pr_fetch_required",
  });

  const fetchOnly = createObservationCollector(collectorContext());
  observeGithubEvent(fetchOnly, completed("fetch_pr", {
    repository_full_name: fixture.repository, pr_number: fixture.pr_number,
  }, { pull_request: structured }));
  assert.deepEqual(validateObservedPullRequest(fetchOnly, envelope), {
    ok: false, path: "pr_body.pending_marker", rule: "pending_do_not_merge_marker_required",
  });
});

test("actual flat github.get_pr_info shape is an allowlisted final PR read", () => {
  const f = saturationFixture;
  const collector = createObservationCollector({
    runId: f.source_run_id, repository: f.repository, baseBranch: f.base_branch,
    taskBranch: f.task_branch, auditPath: f.audit_path,
  });
  observeGithubEvent(collector, completed("create_pull_request", {
    repository_full_name: f.repository, head: f.task_branch, base: f.base_branch, draft: false,
    body: pendingMergeMarker(f.source_run_id, f.head_sha),
  }, f.get_pr_info_structured));
  observeGithubEvent(collector, completed("get_pr_info", f.get_pr_info_args, f.get_pr_info_structured, "structured_content"));
  assert.deepEqual(validateObservedPullRequest(collector, {
    status: "complete", repository: f.repository, base_branch: f.base_branch, task_branch: f.task_branch,
    head_sha: f.head_sha, pr_number: f.pr_number, pr_url: f.get_pr_info_structured.url,
  }), { ok: true });
});

test("create result must return the same exact PENDING marker as create arguments", () => {
  const { envelope } = stateAndEnvelope();
  const marker = pendingMergeMarker(fixture.source_run_id, fixture.head_sha);
  const base = {
    url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
    base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha,
  };
  for (const returnedBody of [undefined, pendingMergeMarker(fixture.source_run_id, "9".repeat(40)), `${marker}.`]) {
    const collector = createObservationCollector(collectorContext());
    const created = returnedBody === undefined ? base : { ...base, body: returnedBody };
    observeGithubEvent(collector, completed("create_pull_request", {
      repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch,
      draft: false, body: marker,
    }, created));
    observeGithubEvent(collector, completed("get_pr_info", {
      repository_full_name: fixture.repository, pr_number: fixture.pr_number,
    }, { ...base, body: marker }));
    assert.deepEqual(validateObservedPullRequest(collector, envelope), {
      ok: false, path: "pr_body.pending_marker", rule: "pending_do_not_merge_marker_required",
    });
  }
});

test("both allowlisted final PR reads reject missing, duplicate, and omitted returned markers", () => {
  const { envelope } = stateAndEnvelope();
  const marker = pendingMergeMarker(fixture.source_run_id, fixture.head_sha);
  const base = {
    url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
    base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha,
  };
  for (const tool of ["get_pr_info", "fetch_pr"]) {
    for (const returnedBody of ["No pending marker.", `${marker}\n${marker}`, undefined]) {
      const collector = createObservationCollector(collectorContext());
      observeGithubEvent(collector, completed("create_pull_request", {
        repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch,
        draft: false, body: marker,
      }, { ...base, body: marker }));
      const final = returnedBody === undefined ? base : { ...base, body: returnedBody };
      observeGithubEvent(collector, completed(tool, {
        repository_full_name: fixture.repository, pr_number: fixture.pr_number,
      }, tool === "fetch_pr" ? { pull_request: final } : final));
      assert.deepEqual(validateObservedPullRequest(collector, envelope), {
        ok: false, path: "pr_body.pending_marker", rule: "pending_do_not_merge_marker_required",
      });
    }
  }
});

test("persisted observed PENDING seed survives one resume and binds the fetched new final head", () => {
  const { envelope } = stateAndEnvelope();
  const initial = createObservationCollector(collectorContext());
  const created = {
    url: envelope.pr_url, number: fixture.pr_number, state: "open", merged: false, draft: false,
    base: fixture.base_branch, head: fixture.task_branch, head_sha: fixture.head_sha,
    body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
  };
  observeGithubEvent(initial, completed("create_pull_request", {
    repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch, draft: false,
    body: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
  }, created));
  const newHead = "8".repeat(40);
  const resumed = createObservationCollector({ ...collectorContext(), pendingCertification: initial.pendingCertification });
  observeGithubEvent(resumed, completed("get_pr_info", {
    repository_full_name: fixture.repository, pr_number: fixture.pr_number,
  }, { ...created, head_sha: newHead }));
  assert.deepEqual(validateObservedPullRequest(resumed, { ...envelope, head_sha: newHead }), { ok: true });
  assert.equal(trustedPublicObservation(resumed).leftoverResources[1].certification_status, "pending_do_not_merge");

  const { markerLine, ...legacyCertification } = initial.pendingCertification;
  assert.equal(markerLine, pendingMergeMarker(fixture.source_run_id, fixture.head_sha));
  const legacy = createObservationCollector({ ...collectorContext(), pendingCertification: legacyCertification });
  observeGithubEvent(legacy, completed("get_pr_info", {
    repository_full_name: fixture.repository, pr_number: fixture.pr_number,
  }, { ...created, head_sha: newHead }));
  assert.deepEqual(validateObservedPullRequest(legacy, { ...envelope, head_sha: newHead }), { ok: true });

  const legacySwitch = createObservationCollector({ ...collectorContext(), pendingCertification: legacyCertification });
  observeGithubEvent(legacySwitch, completed("get_pr_info", {
    repository_full_name: fixture.repository, pr_number: fixture.pr_number,
  }, { ...created, head_sha: newHead, body: `${created.body}.` }));
  assert.deepEqual(validateObservedPullRequest(legacySwitch, { ...envelope, head_sha: newHead }), {
    ok: false, path: "pr_body.pending_marker", rule: "pending_do_not_merge_marker_required",
  });

  const paddedSeed = { ...legacyCertification, markerLine: ` ${created.body}` };
  assert.equal(createObservationCollector({ ...collectorContext(), pendingCertification: paddedSeed }).pendingCertification, null);
});

test("committed audit artifact without PR exposes a bounded exact manual-recovery residue", () => {
  const collector = createObservationCollector(collectorContext());
  observeGithubEvent(collector, completed("create_branch", {
    repository_full_name: fixture.repository, branch_name: fixture.task_branch, base_ref: fixture.base_branch,
  }, { branch: fixture.task_branch }));
  observeGithubEvent(collector, completed("create_file", {
    repository_full_name: fixture.repository, branch: fixture.task_branch, path: fixture.audit_path,
    message: "audit", content: "bounded",
  }, { commit_sha: fixture.head_sha }));
  const observed = trustedPublicObservation(collector);
  assert.equal(observed.leftoverResources.length, 2);
  assert.equal(observed.partialEvidence.last_completed_phase, "audit_artifact_committed_pr_missing");
  assert.deepEqual(observed.leftoverResources[1], {
    kind: "audit_artifact_committed_pr_missing",
    repository: fixture.repository,
    base_branch: fixture.base_branch,
    branch: fixture.task_branch,
    head_sha: fixture.head_sha,
    artifact_path: fixture.audit_path,
    pr_missing: true,
    pr_number: null,
    pr_url: null,
    required_pr_body_marker: pendingMergeMarker(fixture.source_run_id, fixture.head_sha),
    accepted_terminal_period: true,
    recovery_status: "manual_pr_creation_required",
    recovery_instruction: MANUAL_PR_RECOVERY_INSTRUCTION,
  });
});

test("zero-delta branch/head proof needs exact report fetch before claiming audit-specific residue", () => {
  const compare = completed("compare_commits", {
    repository_full_name: fixture.repository,
    base: fixture.head_sha,
    head: fixture.task_branch,
  }, {
    repository_full_name: fixture.repository,
    base: fixture.head_sha,
    head: fixture.task_branch,
    status: "identical",
    ahead_by: 0,
    behind_by: 0,
    total_commits: 0,
    files: [],
  });
  const collector = createObservationCollector(collectorContext());
  observeGithubEvent(collector, compare);
  assert.deepEqual(trustedPublicObservation(collector).leftoverResources.map((item) => item.kind), ["branch", "commit_without_pr"]);

  const { state, envelope } = stateAndEnvelope();
  observeGithubEvent(collector, completed("fetch_file", {
    repository_full_name: fixture.repository,
    path: fixture.audit_path,
    ref: fixture.head_sha,
    encoding: "utf-8",
  }, {
    content: `# Audit\n\n${auditEvidenceBlock(state, envelope)}\n`,
    encoding: "utf-8",
    sha: "f".repeat(40),
  }));
  assert.deepEqual(trustedPublicObservation(collector).leftoverResources.map((item) => item.kind), ["branch", "audit_artifact_committed_pr_missing"]);
});

test("937C1AD8 saturation replay reserves exact audit report and range evidence", () => {
  const f = saturationFixture;
  const state = { auditPath: f.audit_path, contract: { repository: f.repository, baseBranch: f.base_branch, taskType: "audit" } };
  const envelope = {
    status: "complete", repository: f.repository, base_branch: f.base_branch, task_branch: f.task_branch,
    head_sha: f.head_sha, pr_number: f.pr_number, pr_url: `https://github.com/${f.repository}/pull/${f.pr_number}`,
    audit_evidence: {
      audited_sha: f.audited_sha, scope: ["Synthetic scope."], findings: ["Synthetic clean result."],
      verification: "Exact synthetic range fetched.",
      line_evidence: [{ path: f.source_path, start_line: f.start_line, end_line: f.end_line, snippet: f.snippet }],
    },
  };
  const collector = createObservationCollector({
    runId: f.source_run_id, repository: f.repository, baseBranch: f.base_branch,
    taskBranch: f.task_branch, auditPath: f.audit_path,
  });
  for (let index = 0; index < f.irrelevant_fetch_count; index += 1) {
    observeGithubEvent(collector, completed("fetch_file", {
      repository_full_name: f.repository, path: `notes/irrelevant-${index}.txt`, ref: f.audited_sha, encoding: "utf-8",
    }, { content: "x".repeat(f.irrelevant_fetch_bytes), encoding: "utf-8", sha: "5".repeat(40) }));
  }
  observeGithubEvent(collector, completed("fetch_file", {
    repository_full_name: f.repository, path: f.source_path, ref: f.audited_sha,
    start_line: f.start_line, end_line: f.end_line, encoding: "utf-8",
  }, { content: f.snippet, encoding: "utf-8", sha: f.source_blob_sha }));
  observeGithubEvent(collector, completed("fetch_file", {
    repository_full_name: f.repository, path: f.audit_path, ref: f.head_sha, encoding: "utf-8",
  }, { content: `# Synthetic audit\n\n${auditEvidenceBlock(state, envelope)}\n`, encoding: "utf-8", sha: f.report_blob_sha }));
  const pr = {
    url: envelope.pr_url, number: f.pr_number, state: "open", merged: false, draft: false,
    base: f.base_branch, head: f.task_branch, head_sha: f.head_sha,
    body: f.pr_body,
  };
  observeGithubEvent(collector, completed("create_pull_request", {
    repository_full_name: f.repository, head: f.task_branch, base: f.base_branch, draft: false,
    body: pendingMergeMarker(f.source_run_id, f.head_sha),
  }, pr));
  observeGithubEvent(collector, completed("get_pr_info", f.get_pr_info_args, f.get_pr_info_structured));
  assert.equal(collector.fetches.length < f.irrelevant_fetch_count, true);
  assert.deepEqual(validateObservedAuditEvidence(collector, state, envelope), { ok: true, auditEvidence: envelope.audit_evidence });
  assert.deepEqual(validateObservedPullRequest(collector, envelope), { ok: true });
});

test("audit failure rules distinguish report fetch, block shape, block mismatch, and range mismatch", () => {
  const { state, envelope } = stateAndEnvelope();
  const rangeEvent = completed("fetch_file", {
    repository_full_name: fixture.repository, path: fixture.source_path, ref: fixture.audited_sha,
    start_line: fixture.start_line, end_line: fixture.end_line, encoding: "utf-8",
  }, { content: fixture.snippet, encoding: "utf-8", sha: "e".repeat(40) });
  const reportEvent = (content) => completed("fetch_file", {
    repository_full_name: fixture.repository, path: fixture.audit_path, ref: fixture.head_sha, encoding: "utf-8",
  }, { content, encoding: "utf-8", sha: "f".repeat(40) });

  const missing = createObservationCollector(collectorContext());
  observeGithubEvent(missing, rangeEvent);
  assert.equal(validateObservedAuditEvidence(missing, state, envelope).rule, "report_fetch_missing");

  for (const content of ["# no block", `${auditEvidenceBlock(state, envelope)}\n${auditEvidenceBlock(state, envelope)}`]) {
    const collector = createObservationCollector(collectorContext());
    observeGithubEvent(collector, reportEvent(content));
    assert.equal(validateObservedAuditEvidence(collector, state, envelope).rule, "report_block_missing_or_duplicate");
  }

  const malformed = createObservationCollector(collectorContext());
  observeGithubEvent(malformed, reportEvent("<!-- COWORK_CODEX_AUDIT_EVIDENCE_V1\n{not-json}\nCOWORK_CODEX_AUDIT_EVIDENCE_V1 -->"));
  assert.equal(validateObservedAuditEvidence(malformed, state, envelope).rule, "json_parse_failed");

  const mismatched = createObservationCollector(collectorContext());
  observeGithubEvent(mismatched, reportEvent(auditEvidenceBlock(state, { ...envelope, audit_evidence: { ...envelope.audit_evidence, findings: ["Mismatch."] } })));
  assert.equal(validateObservedAuditEvidence(mismatched, state, envelope).rule, "report_block_mismatch");

  const noRange = createObservationCollector(collectorContext());
  observeGithubEvent(noRange, reportEvent(auditEvidenceBlock(state, envelope)));
  assert.equal(validateObservedAuditEvidence(noRange, state, envelope).rule, "range_fetch_missing_or_mismatch");
});

test("expected-block serialization helper and audit proof preserve hostile snippets byte-for-byte without a host write", () => {
  const { state, envelope } = stateAndEnvelope();
  const hostile = "quote=\" backslash=\\ true-LF=\n lone-CR=\r CRLF=\r\n tab=\t composed=é decomposed=e\u0301 emoji=😀 separators=\u2028\u2029 final-newline=\n";
  envelope.audit_evidence.line_evidence[0].snippet = hostile;
  const block = auditEvidenceBlock(state, envelope);
  const serialized = block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n"));
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.audit_evidence.line_evidence[0].snippet, hostile);
  const report = `# Audit\n\n${block}\n`;
  const started = {
    type: "item.started",
    item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_pull_request", arguments: {} },
  };
  const collectorFor = (rangeContent) => {
    const collector = createObservationCollector(collectorContext());
    observeGithubEvent(collector, completed("create_file", {
      repository_full_name: fixture.repository, branch: fixture.task_branch,
      path: fixture.audit_path, content: report,
    }, { commit_sha: fixture.head_sha }));
    observeGithubEvent(collector, completed("fetch_file", {
      repository_full_name: fixture.repository, path: fixture.source_path, ref: fixture.audited_sha,
      start_line: fixture.start_line, end_line: fixture.end_line, encoding: "utf-8",
    }, { content: rangeContent, encoding: "utf-8", sha: "d".repeat(40) }));
    observeGithubEvent(collector, completed("fetch_file", {
      repository_full_name: fixture.repository, path: fixture.audit_path, ref: fixture.head_sha, encoding: "utf-8",
    }, { content: report, encoding: "utf-8", sha: "f".repeat(40) }));
    return collector;
  };
  const exact = collectorFor(hostile);
  assert.deepEqual(validateAuditReportBeforePullRequest(exact, state, started), { ok: true });
  assert.deepEqual(validateObservedAuditEvidence(exact, state, envelope), { ok: true, auditEvidence: envelope.audit_evidence });

  const deviations = [
    hostile.replace('quote="', "quote="),
    hostile.replace("backslash=\\", "backslash="),
    hostile.replace("tab=\t", "tab= "),
    hostile.replace("composed=é", "composed=e"),
    hostile.replace("decomposed=e\u0301", "decomposed=e"),
    hostile.replace("emoji=😀", "emoji=😁"),
    hostile.replace("separators=\u2028", "separators=\n"),
    hostile.replace("\u2029 final-newline", "  final-newline"),
    hostile.replace("true-LF=\n", "true-LF="),
    hostile.replace("lone-CR=\r", "lone-CR=\n"),
    hostile.replace("CRLF=\r\n", "CRLF=\n"),
    hostile.slice(0, -1),
  ];
  assert.equal(new Set(deviations).size, deviations.length);
  for (const deviation of deviations) {
    const collector = collectorFor(deviation);
    assert.deepEqual(validateAuditReportBeforePullRequest(collector, state, started), {
      ok: false,
      code: "AUDIT_EVIDENCE_BLOCK_INVALID",
      path: "audit_evidence.line_evidence[0]",
      rule: "range_fetch_missing_or_mismatch",
    });
    assert.deepEqual(validateObservedAuditEvidence(collector, state, envelope), {
      ok: false,
      path: "audit_evidence.line_evidence[0]",
      rule: "range_fetch_missing_or_mismatch",
    });
  }
});

test("EA345997 malformed completed audit write is rejected before PR creation starts", () => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-ea345997.json"), "utf8"));
  const state = {
    auditPath: replay.audit_path,
    contract: { repository: replay.repository, baseBranch: replay.base_branch, taskType: replay.task_type },
  };
  const collector = createObservationCollector({
    runId: replay.source_run_id, repository: replay.repository, baseBranch: replay.base_branch,
    taskBranch: replay.task_branch, auditPath: replay.audit_path,
  });
  observeGithubEvent(collector, completed("create_branch", {
    repository_full_name: replay.repository, branch_name: replay.task_branch, sha: replay.audited_sha,
  }, { branch: replay.task_branch }));
  observeGithubEvent(collector, completed("create_file", {
    repository_full_name: replay.repository, branch: replay.task_branch,
    path: replay.audit_path, content: replay.invalid_report_content,
  }, { commit_sha: replay.head_sha }));
  const started = {
    type: "item.started",
    item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_pull_request", arguments: {} },
  };
  assert.deepEqual(validateAuditReportBeforePullRequest(collector, state, started), {
    ok: false, code: replay.expected_pre_pr_code, ...replay.expected_validation_error,
  });
  const residue = trustedPublicObservation(collector);
  assert.deepEqual(residue.leftoverResources.map((item) => item.kind), ["branch", "audit_artifact_committed_pr_missing"]);
  assert.equal(residue.leftoverResources.some((item) => item.kind === "pull_request"), false);
});

test("pre-PR audit block uses the shared strict audit-evidence schema", () => {
  const { state, envelope } = stateAndEnvelope();
  const started = {
    type: "item.started",
    item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_pull_request", arguments: {} },
  };
  const validationFor = (auditEvidence, includeProof = false) => {
    const candidate = { ...envelope, audit_evidence: auditEvidence };
    const report = `# Audit\n\n${auditEvidenceBlock(state, candidate)}\n`;
    const collector = createObservationCollector(collectorContext());
    observeGithubEvent(collector, completed("create_file", {
      repository_full_name: fixture.repository, branch: fixture.task_branch,
      path: fixture.audit_path, content: report,
    }, { commit_sha: fixture.head_sha }));
    if (includeProof) {
      for (const item of auditEvidence.line_evidence) {
        observeGithubEvent(collector, completed("fetch_file", {
          repository_full_name: fixture.repository, path: item.path, ref: auditEvidence.audited_sha,
          start_line: item.start_line, end_line: item.end_line, encoding: "utf-8",
        }, { content: item.snippet, encoding: "utf-8", sha: "d".repeat(40) }));
      }
      observeGithubEvent(collector, completed("fetch_file", {
        repository_full_name: fixture.repository, path: fixture.audit_path, ref: fixture.head_sha, encoding: "utf-8",
      }, { content: report, encoding: "utf-8", sha: "f".repeat(40) }));
    }
    return validateAuditReportBeforePullRequest(collector, state, started);
  };
  assert.deepEqual(validationFor(envelope.audit_evidence, true), { ok: true });
  const invalidCases = [
    [{ ...envelope.audit_evidence, verification: [envelope.audit_evidence.verification] }, "audit_artifact.evidence_block.audit_evidence.verification", "type_mismatch", "non-empty string"],
    [{ ...envelope.audit_evidence, scope: ["   "] }, "audit_artifact.evidence_block.audit_evidence.scope[0]", "value_out_of_range", "non-empty string"],
    [{ ...envelope.audit_evidence, findings: ["   "] }, "audit_artifact.evidence_block.audit_evidence.findings[0]", "value_out_of_range", "non-empty string"],
    [{ ...envelope.audit_evidence, verification: "   " }, "audit_artifact.evidence_block.audit_evidence.verification", "value_out_of_range", "non-empty string"],
    [{ ...envelope.audit_evidence, line_evidence: Array.from({ length: 101 }, () => ({ ...envelope.audit_evidence.line_evidence[0] })) }, "audit_artifact.evidence_block.audit_evidence.line_evidence", "value_out_of_range", "array (1 to 100 items) of objects with exactly path (non-empty repository-relative path without dot segments or backslashes), start_line (positive integer), end_line (positive integer), and snippet (non-empty byte-exact string)"],
  ];
  for (const [auditEvidence, validationPath, rule, expected] of invalidCases) {
    assert.deepEqual(validationFor(auditEvidence), {
      ok: false,
      code: "AUDIT_EVIDENCE_BLOCK_INVALID",
      path: validationPath,
      rule,
      expected,
    });
  }
});
