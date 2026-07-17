"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ISSUE_COMMENT_ID_SCHEMA, TOOLS, createRequestHandler } = require("../server/index");
const {
  canonicalPriority,
  evaluateFinalEvidence,
  evaluateInitialEvidence,
  extractReviewedCommitPrefix,
  isExpectedBotActor,
  normalizeActorLogin,
  reviewPrefixMatchesExpected,
  scanPriorityMarkers,
  scanReviewedCommitMarkers,
} = require("../server/github-review-contract");

const liveIssueFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "final-issue-comment-template-pr4.json"), "utf8"));

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const OTHER = "1234567890abcdef1234567890abcdef12345678";
const READY_AT = "2026-07-15T10:00:00.000Z";
const TRIGGER_AT = "2026-07-15T10:10:00.000Z";
const PR_URL = "https://github.com/example/repo/pull/286";
const BOT = "chatgpt-codex-connector[bot]";

function context(final = false, overrides = {}) {
  return {
    readyAt: READY_AT,
    expectedHeadSha: HEAD,
    currentHeadSha: HEAD,
    knownCommitShas: [HEAD, OTHER],
    headChangeEventsSinceBoundary: 0,
    prNumber: 286,
    prUrl: PR_URL,
    ...(final ? {
      finalTriggerCommentId: 991,
      finalTriggerUrl: `${PR_URL}#issuecomment-991`,
      finalTriggerCreatedAt: TRIGGER_AT,
    } : {}),
    ...overrides,
  };
}

function reaction(final = false, overrides = {}) {
  return {
    kind: "reaction",
    actorLogin: BOT,
    createdAt: "2026-07-15T10:11:00.000Z",
    targetType: final ? "issue_comment" : "pull_request",
    targetId: final ? 991 : 286,
    targetUrl: final ? `${PR_URL}#issuecomment-991` : PR_URL,
    content: "+1",
    ...overrides,
  };
}

function badgeBody(priority = "P2") {
  return `**<sub><sub>![${priority} Badge](https://img.shields.io/badge/${priority}-yellow?style=flat)</sub></sub> Preserve the guard**\n\nExact finding text.`;
}

function reviewBundle(priority = "P2", overrides = {}) {
  const base = {
    kind: "review_bundle",
    submission: {
      id: 7001,
      actorLogin: BOT,
      createdAt: "2026-07-15T10:11:00.000Z",
      body: `Automated review.\n\n**Reviewed commit:** \`${HEAD.slice(0, 10)}\``,
    },
    comments: [{
      pullRequestReviewId: 7001,
      actorLogin: BOT,
      createdAt: "2026-07-15T10:10:30.000Z",
      url: `${PR_URL}#discussion_r1`,
      path: "src/example.js",
      line: 42,
      body: badgeBody(priority),
    }],
  };
  return {
    ...base,
    ...overrides,
    submission: { ...base.submission, ...(overrides.submission || {}) },
    comments: overrides.comments || base.comments,
  };
}

function liveFinalContext(overrides = {}) {
  return {
    expectedHeadSha: liveIssueFixture.head_sha,
    currentHeadSha: liveIssueFixture.head_sha,
    knownCommitShas: liveIssueFixture.known_commit_shas,
    headChangeEventsSinceBoundary: liveIssueFixture.head_change_events_since_final_trigger,
    prNumber: liveIssueFixture.pr_number,
    prUrl: liveIssueFixture.pr_url,
    finalTriggerCommentId: liveIssueFixture.final_trigger.id,
    finalTriggerUrl: liveIssueFixture.final_trigger.url,
    finalTriggerCreatedAt: liveIssueFixture.final_trigger.created_at,
    ...overrides,
  };
}

function liveIssueComment(overrides = {}) {
  const value = liveIssueFixture.response_event;
  return {
    kind: "issue_comment",
    id: value.id,
    actorLogin: value.actor_login,
    createdAt: value.created_at,
    url: value.url,
    prNumber: value.pr_number,
    prUrl: value.pr_url,
    body: value.body,
    reviewComments: [...value.review_comments],
    ...overrides,
  };
}

function liveFinalRpcArguments(overrides = {}) {
  const triggerId = overrides.triggerId ?? liveIssueFixture.final_trigger.id;
  const responseId = overrides.responseId ?? liveIssueFixture.response_event.id;
  return {
    final_trigger_comment_id: triggerId,
    final_trigger_url: `${liveIssueFixture.pr_url}#issuecomment-${String(triggerId)}`,
    final_trigger_created_at: liveIssueFixture.final_trigger.created_at,
    expected_head_sha: liveIssueFixture.head_sha,
    current_head_sha: liveIssueFixture.head_sha,
    known_commit_shas: liveIssueFixture.known_commit_shas,
    head_change_events_since_final_trigger: 0,
    pr_number: liveIssueFixture.pr_number,
    pr_url: liveIssueFixture.pr_url,
    event: {
      ...liveIssueFixture.response_event,
      id: responseId,
      url: `${liveIssueFixture.pr_url}#issuecomment-${String(responseId)}`,
    },
  };
}

test("bot identity permits case and optional bot suffix only", () => {
  assert.equal(normalizeActorLogin("ChatGPT-Codex-Connector[BOT]"), "chatgpt-codex-connector");
  assert.equal(isExpectedBotActor("CHATGPT-CODEX-CONNECTOR"), true);
  for (const wrong of ["codex", "ChatGPT Codex Connector", "other-codex-connector[bot]", "chatgpt-codex-connector-bot"]) assert.equal(isExpectedBotActor(wrong), false);
});

test("commit marker accepts exact live Markdown and plain shapes only", () => {
  assert.equal(extractReviewedCommitPrefix(`**Reviewed commit:** \`${HEAD.slice(0, 10)}\``), HEAD.slice(0, 10));
  assert.equal(extractReviewedCommitPrefix(`Reviewed commit: ${HEAD.slice(0, 10)}`), HEAD.slice(0, 10));
  for (const body of [
    "Reviewed commit: abcdef012",
    "**reviewed commit:** `abcdef0123`",
    `**Reviewed commit:** \`${HEAD.slice(0, 10)}\`\nReviewed commit: ${HEAD.slice(0, 10)}`,
  ]) assert.equal(extractReviewedCommitPrefix(body), null);
  assert.equal(reviewPrefixMatchesExpected(HEAD.slice(0, 10), context()), true);
  assert.equal(reviewPrefixMatchesExpected(HEAD.slice(0, 9), context()), false);
  assert.equal(reviewPrefixMatchesExpected(OTHER.slice(0, 10), context()), false);
  assert.equal(reviewPrefixMatchesExpected(HEAD.slice(0, 10), context(false, { knownCommitShas: [HEAD, `${HEAD.slice(0, 10)}${"f".repeat(30)}`] })), false);
});

test("commit marker scanner distinguishes absence, canonical, malformed, and multiple material", () => {
  assert.deepEqual(scanReviewedCommitMarkers("No commit marker."), { status: "absent", prefix: null });
  assert.deepEqual(scanReviewedCommitMarkers(`**Reviewed commit:** \`${HEAD.slice(0, 10)}\``), {
    status: "canonical", prefix: HEAD.slice(0, 10),
  });
  assert.deepEqual(scanReviewedCommitMarkers("Reviewed commit: not-a-sha"), { status: "malformed", prefix: null });
  assert.deepEqual(
    scanReviewedCommitMarkers(`**Reviewed commit:** \`${HEAD.slice(0, 10)}\`\nReviewed commit: not-a-sha`),
    { status: "multiple", prefix: null },
  );
  assert.equal(evaluateInitialEvidence(context(), reviewBundle("P2", {
    comments: [],
    submission: { body: `**Reviewed commit:** \`${HEAD.slice(0, 10)}\`\nReviewed commit: not-a-sha` },
  })).accepted, false);
  assert.equal(evaluateFinalEvidence(liveFinalContext(), liveIssueComment({
    body: `${liveIssueFixture.response_event.body}\nReviewed commit: not-a-sha`,
  })).accepted, false);
});

test("priority parser accepts real Codex badges and optional exact list markers", () => {
  for (const priority of ["P0", "P1", "P2", "P3"]) assert.equal(canonicalPriority(badgeBody(priority)), priority);
  assert.equal(canonicalPriority("- [P3] Finding — file.js:2"), "P3");
  for (const body of [badgeBody("P4"), `${badgeBody("P2")}\n- [P2] duplicate`, `${badgeBody("P2")}\n![P3 Badge](x)`]) assert.equal(canonicalPriority(body), null);
});

test("priority scanner distinguishes true absence, canonical, malformed, unknown, and multiple material", () => {
  assert.deepEqual(scanPriorityMarkers("No prioritized findings were emitted."), { status: "absent", priority: null });
  assert.deepEqual(scanPriorityMarkers(badgeBody("P2")), { status: "canonical", priority: "P2" });
  assert.deepEqual(scanPriorityMarkers("- [P3] Finding — file.js:2"), { status: "canonical", priority: "P3" });
  assert.deepEqual(scanPriorityMarkers("P0"), { status: "malformed", priority: null });
  assert.deepEqual(scanPriorityMarkers("![P Badge](x)"), { status: "malformed", priority: null });
  assert.deepEqual(scanPriorityMarkers("![P4 Badge](x)"), { status: "unknown", priority: null });
  assert.deepEqual(scanPriorityMarkers(`${badgeBody("P2")}\n- [P3] second`), { status: "multiple", priority: null });
});

test("review bundles with zero inline comments are clean only when submission priority material is absent", () => {
  const clean = reviewBundle("P2", { comments: [] });
  assert.equal(evaluateInitialEvidence(context(), clean).verdict, "clean");
  assert.equal(evaluateFinalEvidence(context(true), clean).verdict, "clean");
  for (const priorityMaterial of [
    "P0",
    "![P4 Badge](x)",
    "![P Badge](x)",
    `${badgeBody("P2")}\n- [P3] duplicate`,
  ]) {
    const candidate = reviewBundle("P2", {
      comments: [],
      submission: { body: `${priorityMaterial}\n\n**Reviewed commit:** \`${HEAD.slice(0, 10)}\`` },
    });
    assert.equal(evaluateInitialEvidence(context(), candidate).accepted, false);
    assert.equal(evaluateFinalEvidence(context(true), candidate).accepted, false);
  }
});

test("initial clean binds bot PR +1, time, exact target, and continuous head", () => {
  assert.deepEqual(evaluateInitialEvidence(context(), reaction()), { accepted: true, verdict: "clean", priorities: [], findings: [], reason: "ACCEPTED" });
  for (const [ctx, event] of [
    [context(), reaction(false, { actorLogin: "codex" })],
    [context(), reaction(false, { createdAt: READY_AT })],
    [context(), reaction(false, { targetId: 285 })],
    [context(false, { currentHeadSha: OTHER }), reaction()],
    [context(false, { headChangeEventsSinceBoundary: 2 }), reaction()],
  ]) assert.equal(evaluateInitialEvidence(ctx, event).accepted, false);
});

test("live-shaped review bundle accepts and preserves P0-P3 findings", () => {
  for (const priority of ["P0", "P1", "P2", "P3"]) {
    const result = evaluateInitialEvidence(context(), reviewBundle(priority));
    assert.equal(result.accepted, true);
    assert.equal(result.verdict, "findings");
    assert.deepEqual(result.priorities, [priority]);
    assert.deepEqual(result.findings[0], {
      priority,
      body: badgeBody(priority),
      url: `${PR_URL}#discussion_r1`,
      path: "src/example.js",
      line: 42,
    });
  }
});

test("review bundle rejects mismatched IDs, actors, times, SHA, and missing IDs", () => {
  const baseComment = reviewBundle().comments[0];
  const cases = [
    reviewBundle("P2", { submission: { id: undefined } }),
    reviewBundle("P2", { comments: [{ ...baseComment, pullRequestReviewId: 9999 }] }),
    reviewBundle("P2", { comments: [{ ...baseComment, actorLogin: "codex" }] }),
    reviewBundle("P2", { comments: [{ ...baseComment, createdAt: READY_AT }] }),
    reviewBundle("P2", { submission: { actorLogin: "codex" } }),
    reviewBundle("P2", { submission: { createdAt: READY_AT } }),
    reviewBundle("P2", { submission: { body: `**Reviewed commit:** \`${OTHER.slice(0, 10)}\`` } }),
  ];
  for (const candidate of cases) assert.equal(evaluateInitialEvidence(context(), candidate).accepted, false);
});

test("comment may precede review submission while both remain after boundary", () => {
  const candidate = reviewBundle("P2", {
    submission: { createdAt: "2026-07-15T10:12:00.000Z" },
    comments: [{ ...reviewBundle().comments[0], createdAt: "2026-07-15T10:01:00.000Z" }],
  });
  assert.equal(evaluateInitialEvidence(context(), candidate).accepted, true);
});

test("final clean accepts only +1 on exact final trigger comment", () => {
  assert.deepEqual(evaluateFinalEvidence(context(true), reaction(true)), { accepted: true, verdict: "clean", priorities: [], findings: [], reason: "ACCEPTED" });
  for (const [ctx, event] of [
    [context(true), reaction(true, { targetType: "pull_request", targetId: 286, targetUrl: PR_URL })],
    [context(true), reaction(true, { targetId: 992 })],
    [context(true), reaction(true, { actorLogin: "codex" })],
    [context(true), reaction(true, { createdAt: TRIGGER_AT })],
    [context(true, { currentHeadSha: OTHER }), reaction(true)],
    [context(true, { headChangeEventsSinceBoundary: 1 }), reaction(true)],
  ]) assert.equal(evaluateFinalEvidence(ctx, event).accepted, false);
});

test("observed template PR 4 final issue comment is accepted as clean without trusting its prose", async () => {
  assert.deepEqual(evaluateFinalEvidence(liveFinalContext(), liveIssueComment()), {
    accepted: true, verdict: "clean", priorities: [], findings: [], reason: "ACCEPTED",
  });
  assert.equal(liveIssueFixture.review_submissions_observed, 0);
  assert.equal(liveIssueFixture.inline_review_comments_observed, 0);
  assert.equal(liveIssueFixture.final_reactions_observed, 0);

  const messages = [];
  const { handle } = createRequestHandler({ send: (message) => messages.push(message) });
  await handle({ jsonrpc: "2.0", id: 44, method: "tools/call", params: {
    name: "orchestration_validate_final_review_evidence",
    arguments: {
      final_trigger_comment_id: liveIssueFixture.final_trigger.id,
      final_trigger_url: liveIssueFixture.final_trigger.url,
      final_trigger_created_at: liveIssueFixture.final_trigger.created_at,
      expected_head_sha: liveIssueFixture.head_sha,
      current_head_sha: liveIssueFixture.head_sha,
      known_commit_shas: liveIssueFixture.known_commit_shas,
      head_change_events_since_final_trigger: 0,
      pr_number: liveIssueFixture.pr_number,
      pr_url: liveIssueFixture.pr_url,
      event: liveIssueFixture.response_event,
    },
  } });
  assert.equal(messages[0].result.structuredContent.accepted, true);
  assert.equal(messages[0].result.structuredContent.verdict, "clean");
  assert.equal(JSON.stringify(messages[0]).includes("Didn't find"), false);

  await handle({ jsonrpc: "2.0", id: 47, method: "tools/call", params: {
    name: "orchestration_validate_final_review_evidence",
    arguments: liveFinalRpcArguments({
      triggerId: String(liveIssueFixture.final_trigger.id),
      responseId: String(liveIssueFixture.response_event.id),
    }),
  } });
  assert.equal(messages[1].result.structuredContent.accepted, true);
  assert.equal(messages[1].result.structuredContent.verdict, "clean");
});

test("issue-comment ID schemas exactly match the numeric runtime contract", () => {
  const expected = {
    oneOf: [
      { type: "integer", minimum: 1 },
      { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
    ],
  };
  assert.deepEqual(ISSUE_COMMENT_ID_SCHEMA, expected);
  const finalTool = TOOLS.find((item) => item.name === "orchestration_validate_final_review_evidence");
  assert.deepEqual(finalTool.inputSchema.properties.final_trigger_comment_id, expected);
  const issueSchema = finalTool.inputSchema.properties.event.oneOf.find((schema) => schema.properties?.kind?.const === "issue_comment");
  assert.deepEqual(issueSchema.properties.id, expected);
  const reviewSchema = finalTool.inputSchema.properties.event.oneOf.find((schema) => schema.properties?.kind?.const === "review_bundle");
  assert.deepEqual(reviewSchema.properties.submission.properties.id.oneOf[1], {
    type: "string", minLength: 1, maxLength: 100,
  });
});

test("RPC sanitizes alphabetic, leading-zero, and overlong issue-comment IDs without leaking them", async () => {
  const invalidIds = ["RAW-NODE-ID-LEAK", "04988770330", "123456789012345678901"];
  const messages = [];
  const { handle } = createRequestHandler({ send: (message) => messages.push(message) });
  let rpcId = 60;
  for (const invalidId of invalidIds) {
    for (const argumentsValue of [
      liveFinalRpcArguments({ triggerId: invalidId }),
      liveFinalRpcArguments({ responseId: invalidId }),
    ]) {
      await handle({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: {
        name: "orchestration_validate_final_review_evidence",
        arguments: argumentsValue,
      } });
      const message = messages.at(-1);
      assert.deepEqual(message.result.structuredContent, {
        accepted: false,
        verdict: "not_accepted",
        priorities: [],
        findings: [],
        reason: "EVIDENCE_INPUT_INVALID",
      });
      assert.equal(JSON.stringify(message).includes(invalidId), false);
      rpcId += 1;
    }
  }
});

test("final issue comment fails closed on actor, time, IDs, URLs, PR, head, marker, priority, comments, and eyes", () => {
  const wrongHead = "f".repeat(40);
  const invalid = [
    [liveFinalContext(), liveIssueComment({ actorLogin: "codex" })],
    [liveFinalContext(), liveIssueComment({ createdAt: liveIssueFixture.final_trigger.created_at })],
    [liveFinalContext(), liveIssueComment({ id: liveIssueFixture.final_trigger.id })],
    [liveFinalContext(), liveIssueComment({ id: 0 })],
    [liveFinalContext(), liveIssueComment({ url: `${liveIssueFixture.pr_url}#issuecomment-999` })],
    [liveFinalContext(), liveIssueComment({ prNumber: 5 })],
    [liveFinalContext(), liveIssueComment({ prUrl: "https://github.com/example-org/web-template/pull/5" })],
    [liveFinalContext({ finalTriggerUrl: `${liveIssueFixture.pr_url}#issuecomment-999` }), liveIssueComment()],
    [liveFinalContext({ currentHeadSha: wrongHead }), liveIssueComment()],
    [liveFinalContext({ headChangeEventsSinceBoundary: 1 }), liveIssueComment()],
    [liveFinalContext(), liveIssueComment({ body: "No marker." })],
    [liveFinalContext(), liveIssueComment({ body: `${liveIssueFixture.response_event.body}\nReviewed commit: ${liveIssueFixture.head_sha.slice(0, 10)}` })],
    [liveFinalContext(), liveIssueComment({ body: `${liveIssueFixture.response_event.body}\nP0` })],
    [liveFinalContext(), liveIssueComment({ body: `${liveIssueFixture.response_event.body}\n![P4 Badge](x)` })],
    [liveFinalContext(), liveIssueComment({ reviewComments: [{ body: badgeBody("P2") }] })],
  ];
  for (const [ctx, event] of invalid) assert.equal(evaluateFinalEvidence(ctx, event).accepted, false);
  assert.equal(evaluateFinalEvidence(liveFinalContext(), reaction(true, { content: "eyes" })).accepted, false);
});

test("issue comments are rejected initially and issue-comment findings are never synthesized", async () => {
  assert.equal(evaluateInitialEvidence({ ...liveFinalContext(), readyAt: READY_AT }, liveIssueComment()).accepted, false);
  const findingLike = liveIssueComment({ body: `${liveIssueFixture.response_event.body}\n- [P2] finding` });
  assert.equal(evaluateFinalEvidence(liveFinalContext(), findingLike).accepted, false);

  const messages = [];
  const { handle } = createRequestHandler({ send: (message) => messages.push(message) });
  await handle({ jsonrpc: "2.0", id: 45, method: "tools/call", params: {
    name: "orchestration_validate_initial_review_evidence",
    arguments: {
      ready_at: READY_AT,
      expected_head_sha: liveIssueFixture.head_sha,
      current_head_sha: liveIssueFixture.head_sha,
      known_commit_shas: liveIssueFixture.known_commit_shas,
      head_change_events_since_ready_at: 0,
      pr_number: liveIssueFixture.pr_number,
      pr_url: liveIssueFixture.pr_url,
      event: { ...liveIssueFixture.response_event, raw_secret: "MUST_NOT_LEAK" },
    },
  } });
  assert.equal(messages[0].result.structuredContent.accepted, false);
  assert.equal(messages[0].result.structuredContent.reason, "EVIDENCE_INPUT_INVALID");
  assert.equal(JSON.stringify(messages[0]).includes("MUST_NOT_LEAK"), false);

  await handle({ jsonrpc: "2.0", id: 46, method: "tools/call", params: {
    name: "orchestration_validate_final_review_evidence",
    arguments: {
      final_trigger_comment_id: liveIssueFixture.final_trigger.id,
      final_trigger_url: liveIssueFixture.final_trigger.url,
      final_trigger_created_at: liveIssueFixture.final_trigger.created_at,
      expected_head_sha: liveIssueFixture.head_sha,
      current_head_sha: liveIssueFixture.head_sha,
      known_commit_shas: liveIssueFixture.known_commit_shas,
      head_change_events_since_final_trigger: 0,
      pr_number: liveIssueFixture.pr_number,
      pr_url: liveIssueFixture.pr_url,
      event: { ...liveIssueFixture.response_event, raw_secret: "MUST_NOT_LEAK_FINAL" },
    },
  } });
  assert.equal(messages[1].result.structuredContent.reason, "EVIDENCE_INPUT_INVALID");
  assert.equal(JSON.stringify(messages[1]).includes("MUST_NOT_LEAK_FINAL"), false);
});

test("final P2/P3 bundles are findings, never clean", () => {
  for (const priority of ["P2", "P3"]) {
    const result = evaluateFinalEvidence(context(true), reviewBundle(priority));
    assert.equal(result.accepted, true);
    assert.equal(result.verdict, "findings");
    assert.deepEqual(result.priorities, [priority]);
  }
});

function mcpReviewBundle() {
  const bundle = reviewBundle("P2");
  return {
    kind: "review_bundle",
    submission: { id: bundle.submission.id, actor_login: bundle.submission.actorLogin, created_at: bundle.submission.createdAt, body: bundle.submission.body },
    comments: bundle.comments.map((comment) => ({
      pull_request_review_id: comment.pullRequestReviewId,
      actor_login: comment.actorLogin,
      created_at: comment.createdAt,
      url: comment.url,
      path: comment.path,
      line: comment.line,
      body: comment.body,
    })),
  };
}

test("MCP validator accepts live-shaped bundle and returns immutable finding data", async () => {
  const tool = TOOLS.find((item) => item.name === "orchestration_validate_initial_review_evidence");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.event.oneOf.length, 2);
  const finalTool = TOOLS.find((item) => item.name === "orchestration_validate_final_review_evidence");
  assert.equal(finalTool.inputSchema.properties.event.oneOf.length, 3);
  assert.equal(tool.inputSchema.properties.event.oneOf.some((schema) => schema.properties?.kind?.const === "issue_comment"), false);
  assert.equal(finalTool.inputSchema.properties.event.oneOf.some((schema) => schema.properties?.kind?.const === "issue_comment"), true);
  const messages = [];
  const { handle } = createRequestHandler({ send: (message) => messages.push(message) });
  await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "orchestration_validate_initial_review_evidence",
    arguments: {
      ready_at: READY_AT, expected_head_sha: HEAD, current_head_sha: HEAD,
      known_commit_shas: [HEAD, OTHER], head_change_events_since_ready_at: 0,
      pr_number: 286, pr_url: PR_URL, event: mcpReviewBundle(),
    },
  } });
  assert.equal(messages[0].result.structuredContent.accepted, true);
  assert.equal(messages[0].result.structuredContent.priorities[0], "P2");
  assert.equal(messages[0].result.structuredContent.findings[0].body, badgeBody("P2"));
});

test("MCP malformed input fails through sanitized evidence result", async () => {
  const messages = [];
  const { handle } = createRequestHandler({ send: (message) => messages.push(message) });
  await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "orchestration_validate_final_review_evidence",
    arguments: { attacker_path: "/tmp/repo", raw_secret: "must-not-return" },
  } });
  assert.deepEqual(messages[0].result.structuredContent, { accepted: false, verdict: "not_accepted", priorities: [], findings: [], reason: "EVIDENCE_INPUT_INVALID" });
  assert.equal(JSON.stringify(messages[0]).includes("must-not-return"), false);
});
