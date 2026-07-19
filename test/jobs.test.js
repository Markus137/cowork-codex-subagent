"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_WALL_CLOCK_LIMIT_MINUTES,
  JOB_STATE_ENV,
  cancelJob,
  makeJobId,
  publicStatus,
  readJob,
  resultJob,
  resumeJob,
  safeLaunchEnvironment,
  startJob,
  statusJob,
  taskBranchFor,
  auditPathFor,
  validateFindings,
  validateStartInput,
  writeJob,
} = require("../server/jobs");
const {
  approvalGateEnabled,
  buildCodexArgs,
  buildAutoReviewPolicy,
  buildResumePrompt,
  buildStartPrompt,
  policyViolation,
  classifyMcpApprovalFailure,
  createProgressPublisher,
  DEFAULT_TIMEOUT_MS,
  MAX_CODEX_GLOBAL_STATE_BYTES,
  mergeTerminalObservation,
  PROGRESS_HEARTBEAT_MS,
  resolveGithubConnectorId,
  runWorker,
  safeWorkerEnvironment,
  timeoutMsForState,
} = require("../server/job-worker");
const {
  ENVELOPE_KEYS,
  MAX_RESULT_BYTES,
  RESULT_ENVELOPE_SCHEMA,
  SOL_TERRA_KEYS,
  outcomeForEnvelope,
  parseAndValidateEnvelope,
  resultEnvelopeContractText,
  resultEnvelopeExampleText,
} = require("../server/result-envelope");
const { formatJobResult } = require("../server/index");
const { MANUAL_PR_RECOVERY_INSTRUCTION, auditEvidenceBlock, createObservationCollector, implementationCommitMessage, observeGithubEvent, pendingMergeMarker, trustedRunningObservation, validateImplementationCommitBeforeMutation } = require("../server/github-observations");

const CONTRACT = Object.freeze({
  repository: "example-org/example-app",
  base_branch: "main",
  task_type: "implementation",
  outcome: "Read repository metadata and prepare the requested remote change.",
  scope: "Only files required for the requested result.",
  constraints: ["GitHub MCP only"],
  exclusions: ["No local Git"],
  acceptance_checks: ["Return PR identity"],
  deliverables: ["Ready pull request"],
});
const THREAD_ID = "019b4d83-7e12-7000-8000-123456789abc";
const TEST_GITHUB_CONNECTOR_ID = "connector_examplegithub123";

function codexGlobalState(connectorId = TEST_GITHUB_CONNECTOR_ID) {
  return {
    "electron-persisted-atom-state": {
      environment: { github_connector_id: connectorId },
    },
  };
}

async function withJobs(run) {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cowork-codex-jobs-test-"));
  const jobs = path.join(parent, "jobs");
  const codexHome = path.join(parent, "codex-home");
  await fs.promises.mkdir(codexHome, { recursive: true });
  await fs.promises.writeFile(
    path.join(codexHome, ".codex-global-state.json"),
    JSON.stringify(codexGlobalState()),
    "utf8",
  );
  const environment = { ...process.env, CODEX_HOME: codexHome, [JOB_STATE_ENV]: jobs };
  try { await run(environment, jobs); } finally { await fs.promises.rm(parent, { recursive: true, force: true }); }
}

function stateFor(id, overrides = {}) {
  const timestamp = "2026-07-15T10:00:00.000Z";
  const taskType = overrides.contract?.taskType || "implementation";
  return {
    version: 1,
    id,
    status: "queued",
    phase: "implementation",
    createdAt: timestamp,
    updatedAt: timestamp,
    resumeCount: 0,
    roles: { SOL: "gpt-5.6-sol", Terra: "gpt-5.6-terra" },
    contract: {
      repository: CONTRACT.repository,
      baseBranch: CONTRACT.base_branch,
      taskType: "implementation",
      outcome: CONTRACT.outcome,
      scope: CONTRACT.scope,
      constraints: CONTRACT.constraints,
      exclusions: CONTRACT.exclusions,
      acceptanceChecks: CONTRACT.acceptance_checks,
      deliverables: CONTRACT.deliverables,
    },
    request: { kind: "start" },
    taskBranch: taskBranchFor(id),
    auditPath: null,
    internal: {},
    result: null,
    publicCode: null,
    prCertification: null,
    implementationCommit: null,
    ...overrides,
  };
}

function completeEnvelope(id, overrides = {}) {
  const repository = CONTRACT.repository;
  const prNumber = 42;
  return {
    run_id: id,
    status: "complete",
    reason_code: null,
    repository,
    base_branch: CONTRACT.base_branch,
    task_branch: taskBranchFor(id),
    head_sha: "a".repeat(40),
    pr_number: prNumber,
    pr_url: `https://github.com/${repository}/pull/${prNumber}`,
    work_summary: "Implemented and verified the requested remote change.",
    resources_consulted: [{ resource: "src/a.js", evidence: "Referenced element begins on line 7." }],
    changes_or_artifacts: [{ artifact: "src/a.js", kind: "modified_file", evidence: "Remote PR diff." }],
    audit_evidence: null,
    tests_and_verification: ["Remote evidence checked."],
    SOL_to_Terra_evidence: {
      terra_v1: "Terra produced V1.",
      sol_revision: "SOL requested a concrete revision.",
      terra_v2: "Terra produced V2.",
      sol_v2_review: "SOL accepted V2.",
    },
    finding_dispositions: [],
    risks_or_blockers: [],
    next_action: "Run the quality gate.",
    ...overrides,
  };
}

function completedChild(events) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => undefined;
  child.stdin = {
    end(prompt) {
      child.prompt = prompt;
      queueMicrotask(() => {
        child.stdout.emit("data", `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
        child.exitCode = 0;
        child.emit("exit", 0);
      });
    },
  };
  child.kill = (signal) => {
    child.exitCode = null;
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null));
    return true;
  };
  return child;
}

function hungProgressChild(events) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => undefined;
  child.stdin = {
    end() {
      events.forEach((event, index) => setTimeout(() => {
        if (child.exitCode === null) child.stdout.emit("data", `${JSON.stringify(event)}\n`);
      }, 2 + index * 5));
    },
  };
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null));
    return true;
  };
  return child;
}

function implementationMessage(id, overrides = {}) {
  return implementationCommitMessage({
    runId: id,
    subject: "Implement the scoped repository correction",
    problem: "The requested repository behavior needed a concrete correction.",
    change: "The accepted Terra V2 change was applied on the task branch.",
    rationale: "This is the smallest change that directly addresses the scoped behavior.",
    verification: "The remote result and requested file scope were checked at the final head.",
    ...overrides,
  });
}

function verifiedPrEvents(id, headSha = "a".repeat(40), options = {}) {
  const branch = taskBranchFor(id);
  const commitArgs = {
    repository_full_name: CONTRACT.repository,
    branch,
    path: options.path || "src/a.js",
    message: implementationMessage(id),
    content: options.content || "bounded implementation",
  };
  const pullRequest = {
    url: `https://github.com/${CONTRACT.repository}/pull/42`,
    number: 42,
    state: "open",
    merged: false,
    draft: false,
    base: CONTRACT.base_branch,
    head: branch,
    head_sha: headSha,
    body: pendingMergeMarker(id, headSha),
  };
  const commitStart = {
    type: "item.started",
    item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_file", arguments: commitArgs },
  };
  const commit = completedGithubEvent("create_file", CONTRACT.repository, {
    branch, path: commitArgs.path, message: commitArgs.message, content: commitArgs.content,
  }, { commit_sha: headSha });
  const prArgs = {
    repository_full_name: CONTRACT.repository,
    head: branch,
    base: CONTRACT.base_branch,
    draft: false,
    body: pendingMergeMarker(id, headSha),
  };
  const createStart = {
    type: "item.started",
    item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_pull_request", arguments: prArgs },
  };
  const create = {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "codex_apps",
      tool: "github.create_pull_request",
      status: "completed",
      error: null,
      arguments: prArgs,
      result: { isError: false, structuredContent: pullRequest },
    },
  };
  const fetch = {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "codex_apps",
      tool: "github.fetch_pr",
      status: "completed",
      error: null,
      arguments: { repo_full_name: CONTRACT.repository, pr_number: 42 },
      result: {
        isError: false,
        structuredContent: {
          pull_request: pullRequest,
        },
      },
    },
  };
  return [...(options.includeCommit === false ? [] : [commitStart, commit]), createStart, create, fetch];
}

function observedBranchEvent(id) {
  return {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "codex_apps",
      tool: "github.create_branch",
      status: "completed",
      error: null,
      arguments: { repository_full_name: CONTRACT.repository, branch_name: taskBranchFor(id), base_ref: CONTRACT.base_branch },
      result: { isError: false, structuredContent: { branch: taskBranchFor(id) } },
    },
  };
}

function completedGithubEvent(tool, repository, args = {}, structuredContent = { ok: true }) {
  return {
    type: "item.completed",
    item: {
      type: "mcp_tool_call", server: "codex_apps", tool: `github.${tool}`, status: "completed", error: null,
      arguments: { repository_full_name: repository, ...args },
      result: { isError: false, structuredContent },
    },
  };
}

test("structured start input rejects runtime controls and unsafe refs", () => {
  assert.equal(validateStartInput(CONTRACT).repository, CONTRACT.repository);
  assert.equal(validateStartInput(CONTRACT).wallClockLimitMinutes, DEFAULT_WALL_CLOCK_LIMIT_MINUTES);
  assert.equal(validateStartInput({ ...CONTRACT, wall_clock_limit_minutes: 15 }).wallClockLimitMinutes, 15);
  assert.equal(validateStartInput({ ...CONTRACT, wall_clock_limit_minutes: 120 }).wallClockLimitMinutes, 120);
  assert.equal(validateStartInput(CONTRACT).taskType, "implementation");
  assert.throws(() => validateStartInput({ ...CONTRACT, task_type: undefined }), /JOB_TASK_TYPE_INVALID/);
  assert.equal(validateStartInput({ ...CONTRACT, task_type: "audit" }).taskType, "audit");
  assert.throws(() => validateStartInput({ ...CONTRACT, task_type: "research" }), /JOB_TASK_TYPE_INVALID/);
  assert.throws(() => validateStartInput({ ...CONTRACT, model: "anything" }), /JOB_INPUT_INVALID/);
  assert.throws(() => validateStartInput({ ...CONTRACT, base_branch: "../escape" }), /JOB_BASE_BRANCH_INVALID/);
  assert.throws(() => validateStartInput({ ...CONTRACT, repository: "one/two/three" }), /JOB_REPOSITORY_INVALID/);
  for (const value of [14, 121, 45.5, "45", null]) {
    assert.throws(() => validateStartInput({ ...CONTRACT, wall_clock_limit_minutes: value }), /JOB_WALL_CLOCK_LIMIT_INVALID/);
  }
  assert.throws(() => validateStartInput({ ...CONTRACT, constraints: Array.from({ length: 100 }, () => "x".repeat(4000)) }), /JOB_INPUT_INVALID/);
});

test("job ids are deterministic shape and private job files use 0600", async () => withJobs(async (environment, jobs) => {
  const id = makeJobId(new Date("2026-07-15T11:22:33.000Z"), () => Buffer.from("a1b2c3d4", "hex"));
  assert.equal(id, "CFT-20260715-112233-A1B2C3D4");
  const report = startJob(CONTRACT, {
    environment,
    getRolesImpl: () => ({ roles: { Fable: "fable", SOL: "gpt-5.6-sol", Terra: "gpt-5.6-terra" } }),
    makeJobIdImpl: () => id,
    launchWorkerImpl: () => 12345,
  });
  assert.equal(report.status, "queued");
  assert.deepEqual(Object.keys(report).sort(), ["code", "correction_resumes_used", "created_at", "leftover_resources", "partial_evidence", "phase", "repository", "run_id", "status", "updated_at", "validation_error", "wall_clock_limit_minutes"]);
  assert.equal(report.wall_clock_limit_minutes, 45);
  assert.equal(JSON.stringify(report).includes("12345"), false);
  assert.equal((fs.statSync(path.join(jobs, `${id}.json`)).mode & 0o777), 0o600);
  assert.equal((fs.statSync(jobs).mode & 0o777), 0o700);
  assert.equal(statusJob(id, { environment }).repository, CONTRACT.repository);
  assert.equal(readJob(id, { environment }).implementationCommit, null);

  const auditId = "CFT-20260715-112233-A1B2C3D5";
  startJob({ ...CONTRACT, task_type: "audit" }, {
    environment,
    getRolesImpl: () => ({ roles: { Fable: "fable", SOL: "gpt-5.6-sol", Terra: "gpt-5.6-terra" } }),
    makeJobIdImpl: () => auditId,
    launchWorkerImpl: () => 12346,
  });
  assert.equal(readJob(auditId, { environment }).implementationCommit, null);
}));

test("legacy job status reports an unknown wall-clock contract while execution retains the safe fallback", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-ABCD4545";
  const legacy = stateFor(id);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.contract, "wallClockLimitMinutes"), false);
  writeJob(legacy, { environment });
  assert.equal(statusJob(id, { environment }).wall_clock_limit_minutes, null);
  assert.equal(timeoutMsForState(legacy), DEFAULT_TIMEOUT_MS);
}));

test("productive Codex roles reject Claude, Anthropic, and Fable bindings", async () => withJobs(async (environment) => {
  assert.throws(() => startJob(CONTRACT, {
    environment,
    getRolesImpl: () => ({ roles: { Fable: "fable", SOL: "claude-opus", Terra: "gpt-5.6-terra" } }),
    launchWorkerImpl: () => 1,
  }), /JOB_ROLE_INVALID/);
  assert.throws(() => startJob(CONTRACT, {
    environment,
    getRolesImpl: () => ({ roles: { Fable: "fable", SOL: "gpt-5.6-sol", Terra: "fable" } }),
    launchWorkerImpl: () => 1,
  }), /JOB_ROLE_INVALID/);
}));

test("result is passive and resume is allowed exactly once with immutable fields", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-ABCDEF12";
  const envelope = completeEnvelope(id);
  writeJob(stateFor(id, { status: "complete", phase: "ready_for_quality_gate", result: envelope, internal: { threadId: THREAD_ID } }), { environment });
  assert.deepEqual(resultJob(id, { environment }).result, envelope);
  const findings = [{ body: "![P2 Badge] fix this", url: "https://github.com/x/y/pull/1#discussion_r2", path: "src/a.js", line: 7 }];
  const queued = resumeJob(id, findings, { environment, launchWorkerImpl: () => 456 });
  assert.equal(queued.correction_resumes_used, 1);
  const stored = readJob(id, { environment });
  assert.deepEqual(stored.request.findings, findings);
  assert.equal(stored.internal.threadId, THREAD_ID);
  assert.throws(() => resumeJob(id, findings, { environment, launchWorkerImpl: () => 789 }), /JOB_RESUME_LIMIT_REACHED/);
  assert.throws(() => validateFindings([{ ...findings[0], model: "bad" }]), /JOB_FINDINGS_INVALID/);
  assert.throws(() => validateFindings(Array.from({ length: 5 }, (_, index) => ({ body: "x".repeat(65530), url: `https://example.test/${index}`, path: "a.js", line: 1 }))), /JOB_FINDINGS_INVALID/);
}));

test("legacy outer complete can never override a blocked no-PR envelope in status or result", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-ABCD1212";
  const blocked = completeEnvelope(id, {
    status: "blocked",
    reason_code: "GITHUB_WRITE_APPROVAL_ABORTED",
    task_branch: null,
    head_sha: "b".repeat(40),
    pr_number: null,
    pr_url: null,
    changes_or_artifacts: [],
    risks_or_blockers: ["The guarded GitHub mutation did not run."],
    next_action: "Resolve the approval path before a new run.",
  });
  writeJob(stateFor(id, {
    status: "complete",
    phase: "ready_for_quality_gate",
    result: JSON.stringify(blocked),
    internal: { threadId: THREAD_ID },
  }), { environment });
  const status = statusJob(id, { environment });
  const result = resultJob(id, { environment });
  assert.equal(status.status, "blocked");
  assert.equal(status.phase, "blocked");
  assert.equal(status.code, "GITHUB_WRITE_APPROVAL_ABORTED");
  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "blocked");
  assert.equal(result.result.status, "blocked");
  assert.equal(result.result.pr_number, null);
  assert.throws(() => resumeJob(id, [{ body: "![P2 Badge] fix", url: "https://example.test/f", path: "a.js", line: 1 }], { environment, launchWorkerImpl: () => 1 }), /JOB_NOT_RESUMABLE/);
}));

test("raw blocked state wins over a contradictory valid complete envelope", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-ABCD3434";
  writeJob(stateFor(id, {
    status: "blocked",
    phase: "stopped",
    publicCode: "BOUNDARY_VIOLATION",
    result: completeEnvelope(id),
    internal: { threadId: THREAD_ID },
  }), { environment });
  assert.equal(statusJob(id, { environment }).status, "blocked");
  assert.equal(statusJob(id, { environment }).code, "BOUNDARY_VIOLATION");
  assert.equal(resultJob(id, { environment }).status, "blocked");
  assert.equal(resultJob(id, { environment }).result, null);
  assert.throws(() => resumeJob(id, [{ body: "![P2 Badge] fix", url: "https://example.test/f", path: "a.js", line: 1 }], { environment, launchWorkerImpl: () => 1 }), /JOB_NOT_RESUMABLE/);
}));

test("invalid envelope preserves an existing stronger terminal reason code", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-ABCD7878";
  writeJob(stateFor(id, { status: "blocked", phase: "stopped", publicCode: "NON_GITHUB_TOOL_BLOCKED", result: "not json" }), { environment });
  const report = resultJob(id, { environment });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "NON_GITHUB_TOOL_BLOCKED");
  assert.equal(report.result, null);
}));

test("implementation null-diff delivery is explicit and never ready for quality gate", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-ABCD5656";
  const noDelivery = completeEnvelope(id, {
    status: "blocked",
    reason_code: "NULL_DIFF_NO_DELIVERY",
    task_branch: null,
    head_sha: "c".repeat(40),
    pr_number: null,
    pr_url: null,
    changes_or_artifacts: [],
    risks_or_blockers: ["No justified repository diff exists."],
    next_action: "Accept the no-change finding or reclassify an explicit audit task.",
  });
  writeJob(stateFor(id, { status: "complete", phase: "ready_for_quality_gate", result: noDelivery }), { environment });
  const report = resultJob(id, { environment });
  assert.equal(report.status, "blocked");
  assert.equal(report.phase, "blocked");
  assert.equal(report.code, "NULL_DIFF_NO_DELIVERY");
  assert.equal(report.result.pr_number, null);
}));

test("non-complete envelopes expose blocked and incomplete phases truthfully", async () => withJobs(async (environment) => {
  const cases = [
    ["ABCD0101", "blocked", "REMOTE_DELIVERY_BLOCKED", "blocked", "blocked"],
    ["ABCD0202", "incomplete", "REMOTE_DELIVERY_INCOMPLETE", "incomplete", "incomplete"],
  ];
  for (const [suffix, envelopeStatus, reasonCode, publicStatus, phase] of cases) {
    const id = `CFT-20260715-112233-${suffix}`;
    const envelope = completeEnvelope(id, {
      status: envelopeStatus,
      reason_code: reasonCode,
      task_branch: null,
      head_sha: null,
      pr_number: null,
      pr_url: null,
      changes_or_artifacts: [],
      risks_or_blockers: ["Terminal run evidence."],
      next_action: "Report the terminal state.",
    });
    writeJob(stateFor(id, { status: "complete", phase: "ready_for_quality_gate", result: envelope }), { environment });
    const report = resultJob(id, { environment });
    assert.equal(report.status, publicStatus);
    assert.equal(report.phase, phase);
    assert.equal(report.code, reasonCode);
  }
}));

test("cancel marks state without signaling a possibly reused stored PID", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-11112222";
  writeJob(stateFor(id, { internal: { pid: 4242 } }), { environment });
  const killed = [];
  const report = cancelJob(id, { environment, killImpl: (...args) => killed.push(args) });
  assert.deepEqual(killed, []);
  assert.equal(report.status, "cancelled");
  assert.equal(JSON.stringify(report).includes("4242"), false);
}));

test("resume rejects a non-UUID internal thread identifier before CLI argument construction", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-22223333";
  writeJob(stateFor(id, { status: "complete", result: completeEnvelope(id), internal: { threadId: "--last" } }), { environment });
  assert.throws(() => resumeJob(id, [{
    body: "![P2 Badge] fix",
    url: "https://github.com/x/y/pull/1#discussion_r2",
    path: "src/a.js",
    line: 1,
  }], { environment, launchWorkerImpl: () => 1 }), /JOB_THREAD_ID_INVALID/);
}));

test("worker environment removes Claude, API, and token credentials", () => {
  const safe = safeWorkerEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    OPENAI_API_KEY: "no",
    ANTHROPIC_API_KEY: "no",
    CLAUDE_SESSION: "no",
    AZURE_OPENAI_ENDPOINT: "no",
    GITHUB_PAT_TOKEN: "needed-only-by-mcp",
  });
  assert.deepEqual(safe, { PATH: "/bin", HOME: "/home/test" });
  assert.deepEqual(safeLaunchEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    CLAUDE_SESSION: "no",
    ANTHROPIC_API_KEY: "no",
    GITHUB_PAT_TOKEN: "no",
  }), { PATH: "/bin", HOME: "/home/test" });
});

test("prompt and CLI arguments enforce one-way GitHub-only transport", () => {
  const id = "CFT-20260715-112233-33334444";
  const state = stateFor(id);
  const prompt = buildStartPrompt(state);
  for (const invariant of ["GITHUB_MCP_ONLY", "NO_CLAUDE_MCP", "NO_FABLE_CALL", "NO_CLAUDE_COMMAND", "NO_ANTHROPIC_API"]) assert.match(prompt, new RegExp(invariant));
  assert.match(prompt, /exactly one Terra subagent/);
  assert.match(prompt, /concrete, testable revision/);
  const args = buildCodexArgs(state, "/private/jobs/workspace", {}, TEST_GITHUB_CONNECTOR_ID);
  assert.equal(args.includes("read-only"), true);
  assert.equal(args.includes("--json"), true);
  assert.equal(args.includes("--strict-config"), true);
  assert.equal(args.includes("--ignore-user-config"), true);
  assert.equal(args.includes('approval_policy="on-request"'), true);
  // The LLM approval gate is removed by default: no approvals_reviewer, no auto_review.policy,
  // and the GitHub app's write tools auto-approve instead of routing writes through a reviewer.
  assert.equal(args.some((item) => String(item).includes('approvals_reviewer="auto_review"')), false);
  assert.equal(args.includes(`apps.${JSON.stringify(TEST_GITHUB_CONNECTOR_ID)}.default_tools_approval_mode="approve"`), true);
  assert.equal(args.includes(`apps.${JSON.stringify(TEST_GITHUB_CONNECTOR_ID)}.default_tools_approval_mode="writes"`), false);
  assert.equal(args.some((item) => String(item).startsWith("auto_review.policy=")), false);
  // Non-GitHub app writes are still not auto-approved (read-only base for everything else).
  assert.equal(args.includes('apps._default.default_tools_approval_mode="writes"'), true);
  assert.equal(args.some((item) => String(item).includes("open_world_enabled")), false);
  assert.equal(args.some((item) => String(item).includes("destructive_enabled")), false);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(args.includes("danger-full-access"), false);
  assert.equal(args.includes('approval_policy="never"'), false);
  assert.equal(args.some((item) => String(item).includes("mcp_servers.")), false);
  assert.equal(args.at(-1), "-");
  assert.equal(args.join(" ").includes("claude"), false);
  const resume = buildResumePrompt({ ...state, request: { kind: "resume", findings: [{ body: "x", url: "u", path: "p", line: 1 }] } });
  assert.match(resume, /only permitted correction resume/);
  assert.match(prompt, /exact line on which the referenced element or value begins/);
  assert.match(prompt, /not an enclosing section, div, container/);
  assert.match(prompt, /Return JSON only/);
  assert.match(prompt, /NULL_DIFF_NO_DELIVERY/);
  assert.match(prompt, /AUTHORIZED GITHUB MUTATIONS/);
  assert.match(prompt, /create_pull_request only from that branch/);
  assert.match(prompt, /draft=false/);
  for (const denied of ["merge", "delete", "force-update", "workflow", "secret", "credential", "collaborator", "permission", "webhook"]) {
    assert.match(prompt, new RegExp(denied));
  }
  assert.match(prompt, /no automatic approval reviewer for your GitHub writes by default/);
  assert.match(prompt, /run without approval interception/);
  assert.match(prompt, /If the optional approval reviewer is reactivated, it is a Codex runtime safety control only/);
  assert.match(prompt, /not Fable, SOL, Terra, a productive subagent, or a manager cycle/);
  assert.match(prompt, /latest successful commit already made/);
  assert.match(prompt, /before calling create_pull_request/);
  assert.match(prompt, /entire create_pull_request body must be exactly this one canonical line and no other bytes/);
  assert.match(prompt, /Do not add a title, summary, blank line/);
  assert.match(prompt, /Every github\.create_file, github\.update_file, or low-level github\.create_commit call/);
  assert.match(prompt, /COWORK_CODEX_IMPLEMENTATION_V1/);
  assert.match(prompt, /Problem: <what made the change necessary>/);
  assert.match(prompt, /Rationale: <why it is the bounded solution>/);
  assert.match(prompt, /Verification: <how the exact remote result was checked, explicitly naming the checked scope>/);
  assert.match(prompt, /never post a separate PR context comment/i);
  assert.doesNotMatch(prompt, /Do not mention Codex/);
  assert.match(prompt, /Terra must not perform GitHub mutations/);
  assert.match(prompt, /SOL, must personally perform every GitHub mutation/);
  assert.doesNotMatch(prompt, /returned for the created PR/);
  assert.doesNotMatch(prompt, /status must be complete, blocked, incomplete, or approval_pending/);
  assert.match(prompt, /genuinely active reviewer request leaves the host job running/);
});

test("COWORK_CODEX_APPROVAL_GATE reactivates the legacy LLM approval gate without danger-full-access", () => {
  const id = "CFT-20260715-112233-44445555";
  const state = stateFor(id);
  // Default (flag unset): no LLM approval gate, GitHub writes auto-approve.
  assert.equal(approvalGateEnabled({}), false);
  const off = buildCodexArgs(state, "/private/jobs/workspace", {}, TEST_GITHUB_CONNECTOR_ID);
  assert.equal(off.includes(`apps.${JSON.stringify(TEST_GITHUB_CONNECTOR_ID)}.default_tools_approval_mode="approve"`), true);
  assert.equal(off.some((item) => String(item).includes('approvals_reviewer="auto_review"')), false);
  assert.equal(off.some((item) => String(item).startsWith("auto_review.policy=")), false);
  // Flag on: legacy gate restored, but still never danger-full-access or approval bypass.
  for (const truthy of ["1", "true", "on"]) assert.equal(approvalGateEnabled({ COWORK_CODEX_APPROVAL_GATE: truthy }), true);
  assert.equal(approvalGateEnabled({ COWORK_CODEX_APPROVAL_GATE: "0" }), false);
  const on = buildCodexArgs(state, "/private/jobs/workspace", { COWORK_CODEX_APPROVAL_GATE: "1" }, TEST_GITHUB_CONNECTOR_ID);
  assert.equal(on.includes('approvals_reviewer="auto_review"'), true);
  assert.equal(on.includes(`apps.${JSON.stringify(TEST_GITHUB_CONNECTOR_ID)}.approvals_reviewer="auto_review"`), true);
  assert.equal(on.includes(`apps.${JSON.stringify(TEST_GITHUB_CONNECTOR_ID)}.default_tools_approval_mode="writes"`), true);
  assert.equal(on.some((item) => String(item).startsWith("auto_review.policy=")), true);
  assert.equal(on.includes(`apps.${JSON.stringify(TEST_GITHUB_CONNECTOR_ID)}.default_tools_approval_mode="approve"`), false);
  assert.equal(on.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(on.includes("danger-full-access"), false);
  assert.equal(on.includes('approval_policy="never"'), false);
  assert.equal(on.includes("read-only"), true);
});

test("GitHub auto-approval targets the concrete connector id instead of the app display slug", () => {
  const id = "CFT-20260719-112233-51515151";
  const connectorId = TEST_GITHUB_CONNECTOR_ID;
  const args = buildCodexArgs(stateFor(id), "/private/jobs/workspace", {}, connectorId);

  assert.equal(args.includes('apps._default.default_tools_approval_mode="writes"'), true);
  assert.equal(args.includes(`apps.${JSON.stringify(connectorId)}.default_tools_approval_mode="approve"`), true);
  assert.equal(args.includes('apps.github.default_tools_approval_mode="approve"'), false);
});

test("GitHub connector resolution reads bounded Codex desktop state and rejects unsafe values", async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cowork-codex-connector-test-"));
  const globalStatePath = path.join(parent, ".codex-global-state.json");
  try {
    await fs.promises.writeFile(globalStatePath, JSON.stringify(codexGlobalState()), "utf8");
    assert.equal(resolveGithubConnectorId({ CODEX_HOME: parent }), TEST_GITHUB_CONNECTOR_ID);

    for (const connectorId of ["github", "connector_bad-value", "connector_quoted\""]) {
      await fs.promises.writeFile(globalStatePath, JSON.stringify(codexGlobalState(connectorId)), "utf8");
      assert.equal(resolveGithubConnectorId({ CODEX_HOME: parent }), null);
    }
    await fs.promises.writeFile(globalStatePath, "{broken", "utf8");
    assert.equal(resolveGithubConnectorId({ CODEX_HOME: parent }), null);
    assert.equal(resolveGithubConnectorId({ CODEX_HOME: "relative/path" }), null);
    assert.equal(resolveGithubConnectorId({ CODEX_HOME: parent }, {
      lstatSync: () => ({ isFile: () => true, size: MAX_CODEX_GLOBAL_STATE_BYTES + 1 }),
    }), null);
  } finally {
    await fs.promises.rm(parent, { recursive: true, force: true });
  }
});

test("guardian addendum narrows the exact run without replacing built-in auto-review", () => {
  const id = "CFT-20260715-112233-12121212";
  const policy = buildAutoReviewPolicy(stateFor(id));
  assert.match(policy, /Additional run-specific constraints \(apply in addition to the built-in guardian policy\)/);
  assert.match(policy, /Only consider reversible, task-branch-scoped GitHub mutations/);
  assert.doesNotMatch(policy, /Only consider non-destructive GitHub mutations/);
  assert.match(policy, new RegExp(CONTRACT.repository.replace("/", "\\/")));
  assert.match(policy, new RegExp(taskBranchFor(id).replaceAll("/", "\\/")));
  assert.match(policy, /update_ref with branch_name equal to that exact branch and force=false/);
  assert.match(policy, /create_pull_request from that branch to that base with draft=false/);
  assert.match(policy, /latest successful task-branch commit SHA already known before the PR call/);
  assert.match(policy, /body consisting of exactly the canonical line/);
  assert.match(policy, /Deny a terminal period on new creation, extra text, blank lines/);
  assert.match(policy, /COWORK_CODEX_IMPLEMENTATION_V1/);
  assert.match(policy, /No add_comment_to_issue mutation is authorized/);
  for (const denied of ["wrong repo", "direct base mutation", "merge", "delete", "force", "workflows", "secrets", "credentials", "permissions", "webhooks"]) {
    assert.match(policy, new RegExp(denied));
  }
});

test("audit jobs require one real deterministic report and exact same-SHA line evidence", () => {
  const id = "CFT-20260715-112233-13131313";
  const state = stateFor(id, {
    contract: { ...stateFor(id).contract, taskType: "audit" },
    auditPath: auditPathFor(id),
  });
  const prompt = buildStartPrompt(state);
  const policy = buildAutoReviewPolicy(state);
  assert.doesNotMatch(prompt, /PR CONTEXT COMMENT|add_comment_to_issue|fetch_issue_comments/);
  assert.doesNotMatch(policy, /add_comment_to_issue|COWORK_CODEX_PR_CONTEXT_V1/);
  assert.match(prompt, new RegExp(auditPathFor(id).replaceAll("/", "\\/")));
  assert.match(prompt, /full audited base\/head SHA/);
  assert.match(prompt, /exact source lines or ranges with short snippets re-read from that same SHA/);
  assert.match(prompt, /Product code must remain unchanged when the audit finds no defect/);
  assert.match(prompt, /Always create the report/);
  assert.match(prompt, /only after mechanically establishing a defect/);
  assert.match(prompt, /verification is exactly one non-empty string, not an array or object/);
  assert.match(prompt, /Every snippet must equal the corresponding UTF-8 github\.fetch_file range content exactly/);
  assert.match(prompt, /Do not trim, normalize Unicode, convert LF\/CR\/CRLF, or add\/remove a final newline/);
  assert.match(prompt, /final model envelope must return audit_evidence:null/i);
  assert.match(prompt, /host derives and hydrates audit_evidence only after independently validating the committed report, exact ranges, final head, and PR identity/i);
  const envelope = completeEnvelope(id, {
    changes_or_artifacts: [{ artifact: auditPathFor(id), kind: "audit_report", evidence: "Report re-read at the returned full SHA." }],
    audit_evidence: {
      audited_sha: "d".repeat(40),
      scope: ["Impressum page only."],
      findings: ["No mechanically provable defect."],
      verification: "  Re-read the exact audited SHA and matched every cited line.  ",
      line_evidence: [{ path: "src/pages/Impressum.tsx", start_line: 20, end_line: 20, snippet: "<h2>Angaben gemäß § 5 DDG</h2>" }],
    },
  });
  assert.equal(parseAndValidateEnvelope(envelope, {
    runId: id,
    repository: CONTRACT.repository,
    baseBranch: CONTRACT.base_branch,
    taskBranch: taskBranchFor(id),
    taskType: "audit",
    auditPath: auditPathFor(id),
  }).status, "complete");
  const context = {
    runId: id,
    repository: CONTRACT.repository,
    baseBranch: CONTRACT.base_branch,
    taskBranch: taskBranchFor(id),
    taskType: "audit",
    auditPath: auditPathFor(id),
  };
  const normalized = parseAndValidateEnvelope(envelope, context);
  const canonicalVerification = "Re-read the exact audited SHA and matched every cited line.";
  assert.equal(normalized.audit_evidence.verification, canonicalVerification);
  const legacyNormalized = parseAndValidateEnvelope({
    ...envelope,
    audit_evidence: { ...envelope.audit_evidence, verification: [`  ${canonicalVerification}  `] },
  }, context);
  assert.equal(legacyNormalized.audit_evidence.verification, canonicalVerification);
  assert.equal(Array.isArray(legacyNormalized.audit_evidence.verification), false);
  const sourcePath = "src/pages/Impressum.tsx";
  const sourceUrl = `https://github.com/${CONTRACT.repository}/blob/${envelope.audit_evidence.audited_sha}/${sourcePath}#L20`;
  const artifactUrl = `https://github.com/${CONTRACT.repository}/blob/${envelope.head_sha}/${auditPathFor(id)}#L1`;
  const dispositions = [
    { url: sourceUrl, path: sourcePath, line: 20, disposition: "verified", evidence: "Audited source." },
    { url: artifactUrl, path: auditPathFor(id), line: 1, disposition: "documented", evidence: "Final artifact." },
  ];
  assert.equal(parseAndValidateEnvelope({ ...envelope, finding_dispositions: dispositions }, context).finding_dispositions.length, 2);
  assert.throws(() => parseAndValidateEnvelope({
    ...envelope,
    finding_dispositions: [{ ...dispositions[0], url: `https://github.com/${CONTRACT.repository}/blob/${"e".repeat(40)}/${sourcePath}#L20` }],
  }, context), /CODEX_RESULT_ENVELOPE_INVALID/);
  for (const invalidVerification of [
    [],
    ["one", "two"],
    [42],
    [true],
    [null],
    [{ method: "re-read" }],
    ["   "],
    "",
    "   ",
    42,
    true,
    { method: "re-read" },
    null,
  ]) {
    assert.throws(() => parseAndValidateEnvelope({
      ...envelope,
      audit_evidence: { ...envelope.audit_evidence, verification: invalidVerification },
    }, context), /CODEX_RESULT_ENVELOPE_INVALID/);
  }
  assert.throws(() => parseAndValidateEnvelope({ ...envelope, changes_or_artifacts: [] }, {
    runId: id,
    repository: CONTRACT.repository,
    baseBranch: CONTRACT.base_branch,
    taskBranch: taskBranchFor(id),
    taskType: "audit",
    auditPath: auditPathFor(id),
  }), /CODEX_RESULT_ENVELOPE_INVALID/);
  assert.throws(() => parseAndValidateEnvelope({ ...envelope, audit_evidence: null }, context), /CODEX_RESULT_ENVELOPE_INVALID/);
  for (const invalidPath of ["/absolute/file.js", "src/../file.js", "src\\file.js", "src//file.js", "src/./file.js"]) {
    assert.throws(() => parseAndValidateEnvelope({
      ...envelope,
      audit_evidence: {
        ...envelope.audit_evidence,
        line_evidence: [{ ...envelope.audit_evidence.line_evidence[0], path: invalidPath }],
      },
    }, context), /CODEX_RESULT_ENVELOPE_INVALID/);
  }
});

test("implementation correction reuses the explained commit seed without requiring a fake commit", () => {
  const id = "CFT-20260715-112233-14141414";
  const headSha = "a".repeat(40);
  const message = implementationMessage(id);
  const state = stateFor(id, {
    request: { kind: "resume", findings: [{ body: "x", url: "u", path: "p", line: 1 }] },
    implementationCommit: {
      status: "branch_effective", runId: id, repository: CONTRACT.repository,
      branch: taskBranchFor(id), sha: headSha, message, tool: "create_file",
    },
  });
  const prompt = buildResumePrompt(state);
  const policy = buildAutoReviewPolicy(state);
  assert.match(prompt, /Every correction commit must use the same seven-line/);
  assert.match(prompt, /Do not post a PR context comment/);
  assert.match(prompt, /final PR head must equal the last branch-effective commit/i);
  assert.match(policy, /No add_comment_to_issue mutation is authorized/);
});

test("runtime policy allows GitHub MCP and fails closed on shell, files, web, or other MCP", () => {
  assert.equal(policyViolation({ type: "item.started", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.get_repo" } }), null);
  assert.equal(policyViolation({ type: "item.started", item: { type: "mcp_tool_call", server: "github", tool: "get_file" } }), null);
  assert.equal(policyViolation({ type: "item.started", item: { type: "collab_tool_call", tool: "spawn_agent" } }), null);
  assert.equal(policyViolation({ type: "item.started", item: { type: "command_execution" } }), "NON_GITHUB_TOOL_BLOCKED");
  assert.equal(policyViolation({ type: "item.started", item: { type: "file_change" } }), "NON_GITHUB_TOOL_BLOCKED");
  assert.equal(policyViolation({ type: "item.started", item: { type: "web_search" } }), "NON_GITHUB_TOOL_BLOCKED");
  assert.equal(policyViolation({ type: "item.started", item: { type: "mcp_tool_call", server: "imessage", tool: "send" } }), "NON_GITHUB_MCP_BLOCKED");
  assert.equal(policyViolation({ type: "item.started", item: { type: "unknown_tool_call" } }), "NON_GITHUB_TOOL_BLOCKED");
});

test("JSONL MCP approval failures are classified without relying on final prose", () => {
  const event = (message, server = "codex_apps", tool = "github.create_branch") => ({
    type: "item.completed",
    item: { type: "mcp_tool_call", server, tool, status: "failed", error: { message } },
  });
  assert.equal(classifyMcpApprovalFailure(event("user cancelled MCP tool call")), "GITHUB_WRITE_APPROVAL_ABORTED");
  assert.equal(classifyMcpApprovalFailure(event("Auto-review denied this request", "github", "update_file")), "GITHUB_WRITE_APPROVAL_DENIED");
  assert.equal(classifyMcpApprovalFailure(event("approval timed out", "github", "create_pull_request")), "GITHUB_WRITE_APPROVAL_TIMEOUT");
  assert.equal(classifyMcpApprovalFailure(event("request was rejected after timeout", "github", "create_pull_request")), "GITHUB_WRITE_APPROVAL_TIMEOUT");
  assert.equal(classifyMcpApprovalFailure(event("automatic approval denied this request", "github", "add_comment_to_issue")), null);
  assert.equal(classifyMcpApprovalFailure(event("upstream 500")), null);
  assert.equal(classifyMcpApprovalFailure(event("user cancelled MCP tool call", "imessage", "send")), null);
  assert.equal(classifyMcpApprovalFailure(event("user cancelled MCP tool call", "codex_apps", "github.get_file")), null);
  assert.equal(classifyMcpApprovalFailure(event("user cancelled MCP tool call", "github", "get_file")), null);
  assert.equal(classifyMcpApprovalFailure(event("user cancelled MCP tool call", "codex_apps", "github.create_issue")), null);
  assert.equal(classifyMcpApprovalFailure({ type: "item.started", item: { type: "mcp_tool_call" } }), null);
});

test("running observations advance through bounded branch, commit, PR-created, and PR-verified phases", () => {
  const id = "CFT-20260716-034901-8DA59548";
  const branch = taskBranchFor(id);
  const head = "8".repeat(40);
  const collector = createObservationCollector({
    runId: id, repository: CONTRACT.repository, baseBranch: CONTRACT.base_branch, taskBranch: branch, taskType: "implementation",
  });
  observeGithubEvent(collector, completedGithubEvent("create_branch", CONTRACT.repository, {
    branch_name: branch, base_ref: CONTRACT.base_branch,
  }, { branch }));
  let observed = trustedRunningObservation(collector);
  assert.equal(observed.partialEvidence.last_completed_phase, "branch_created");
  assert.deepEqual(observed.leftoverResources.map((item) => item.kind), ["branch"]);

  observeGithubEvent(collector, completedGithubEvent("create_file", CONTRACT.repository, {
    branch, path: "src/synthetic.js", message: implementationMessage(id), content: "redacted",
  }, { commit_sha: head }));
  observed = trustedRunningObservation(collector);
  assert.equal(observed.partialEvidence.last_completed_phase, "commit_observed");
  assert.deepEqual(observed.leftoverResources.map((item) => item.kind), ["branch"]);

  const marker = pendingMergeMarker(id, head);
  const pr = {
    url: `https://github.com/${CONTRACT.repository}/pull/48`, number: 48, state: "open", merged: false,
    draft: false, base: CONTRACT.base_branch, head: branch, head_sha: head, body: marker,
  };
  observeGithubEvent(collector, completedGithubEvent("create_pull_request", CONTRACT.repository, {
    head: branch, base: CONTRACT.base_branch, draft: false, body: marker,
  }, pr));
  observed = trustedRunningObservation(collector);
  assert.equal(observed.partialEvidence.last_completed_phase, "pr_created");
  assert.deepEqual(observed.leftoverResources.map((item) => item.kind), ["branch", "pull_request"]);

  observeGithubEvent(collector, completedGithubEvent("get_pr_info", CONTRACT.repository, { pr_number: 48 }, pr));
  assert.equal(trustedRunningObservation(collector).partialEvidence.last_completed_phase, "pr_verified");
});

test("running progress publishes material snapshots immediately and throttles same-repo read heartbeats", async () => withJobs(async (environment) => {
  const id = "CFT-20260716-034901-8DA59548";
  const state = stateFor(id, { status: "running", phase: "implementation", publicEvidence: null, leftoverResources: [] });
  writeJob(state, { environment });
  const collector = createObservationCollector({
    runId: id, repository: CONTRACT.repository, baseBranch: CONTRACT.base_branch, taskBranch: taskBranchFor(id),
  });
  let now = Date.parse("2026-07-16T03:49:14.467Z");
  const publish = createProgressPublisher(id, state, collector, { environment, nowImpl: () => now });
  observeGithubEvent(collector, completedGithubEvent("get_repo", CONTRACT.repository, {
    secret_argument: "MUST_NOT_PERSIST",
  }, { raw_tool_text: "MUST_NOT_PERSIST" }));
  assert.equal(publish(), true);
  let stored = readJob(id, { environment });
  assert.equal(stored.phase, "implementation");
  assert.equal(stored.updatedAt, new Date(now).toISOString());
  assert.equal(JSON.stringify(stored).includes("MUST_NOT_PERSIST"), false);

  now += PROGRESS_HEARTBEAT_MS - 1;
  observeGithubEvent(collector, completedGithubEvent("get_repo", CONTRACT.repository));
  assert.equal(publish(), false);
  assert.equal(readJob(id, { environment }).updatedAt, stored.updatedAt);
  now += 1;
  observeGithubEvent(collector, completedGithubEvent("get_repo", CONTRACT.repository));
  assert.equal(publish(), true);

  now += 1;
  observeGithubEvent(collector, completedGithubEvent("create_branch", CONTRACT.repository, {
    branch_name: taskBranchFor(id), base_ref: CONTRACT.base_branch,
  }, { branch: taskBranchFor(id) }));
  assert.equal(publish(), true);
  stored = readJob(id, { environment });
  assert.equal(stored.phase, "branch_created");
  assert.equal(stored.publicEvidence.last_completed_phase, "branch_created");

  const beforeIgnored = stored.updatedAt;
  const beforeIgnoredCount = collector.count;
  const beforeIgnoredTrustedCount = collector.trustedGithubEvents;
  observeGithubEvent(collector, completedGithubEvent("get_repo", "OtherOrg/other-repo"));
  assert.equal(publish(), false);
  assert.equal(collector.count, beforeIgnoredCount);
  assert.equal(collector.trustedGithubEvents, beforeIgnoredTrustedCount);
  observeGithubEvent(collector, {
    type: "item.completed",
    item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.get_repo", status: "failed", error: { message: "failed" } },
  });
  assert.equal(publish(), false);
  observeGithubEvent(collector, { type: "item.completed", item: { type: "agent_message", text: "not persisted" } });
  assert.equal(publish(), false);
  assert.equal(readJob(id, { environment }).updatedAt, beforeIgnored);

  cancelJob(id, { environment });
  now += PROGRESS_HEARTBEAT_MS;
  observeGithubEvent(collector, completedGithubEvent("get_repo", CONTRACT.repository));
  assert.equal(publish(), false);
  assert.equal(readJob(id, { environment }).status, "cancelled");
}));

test("worker fails closed when running-progress persistence throws inside the stream callback", async () => withJobs(async (environment) => {
  const id = "CFT-20260716-034901-8DA59549";
  writeJob(stateFor(id), { environment });
  const child = completedChild([
    { type: "thread.started", thread_id: THREAD_ID },
    completedGithubEvent("get_repo", CONTRACT.repository, { hidden: "RAW_PROGRESS_SECRET" }, { raw: "RAW_PROGRESS_SECRET" }),
  ]);
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => child,
    mutateJobImpl: () => { throw new Error("RAW_PROGRESS_SECRET"); },
    timeoutMs: 1000,
  });
  const report = resultJob(id, { environment });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "JOB_STATE_INVALID");
  assert.equal(JSON.stringify(readJob(id, { environment })).includes("RAW_PROGRESS_SECRET"), false);
  assert.equal(JSON.stringify(report).includes("RAW_PROGRESS_SECRET"), false);
}));

test("wall-clock timeout is fixed per attempt and defaults to the 45-minute host cap", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 45 * 60 * 1000);
  const id = "CFT-20260716-034901-8DA59548";
  const base = stateFor(id);
  const withMinutes = (wallClockLimitMinutes) => stateFor(id, {
    contract: { ...base.contract, wallClockLimitMinutes },
  });
  assert.equal(timeoutMsForState(base), 45 * 60 * 1000);
  assert.equal(timeoutMsForState(withMinutes(15)), 15 * 60 * 1000);
  assert.equal(timeoutMsForState(withMinutes(90)), 90 * 60 * 1000);
  assert.equal(timeoutMsForState(withMinutes(120)), 120 * 60 * 1000);
  for (const invalid of [14, 121, Number.MAX_SAFE_INTEGER]) {
    assert.equal(timeoutMsForState(withMinutes(invalid)), 45 * 60 * 1000);
  }
});

test("successful progress does not reset the worker's one-shot attempt timeout", async () => withJobs(async (environment) => {
  const id = "CFT-20260716-034901-8DA59550";
  writeJob(stateFor(id), { environment });
  const child = hungProgressChild([
    completedGithubEvent("get_repo", CONTRACT.repository),
    completedGithubEvent("get_repo", CONTRACT.repository),
    completedGithubEvent("get_repo", CONTRACT.repository),
  ]);
  const scheduledTimeouts = [];
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => child,
    timeoutMs: 25,
    setTimeoutImpl: (callback, milliseconds) => {
      scheduledTimeouts.push(milliseconds);
      return setTimeout(callback, milliseconds);
    },
    clearTimeoutImpl: clearTimeout,
  });
  const report = resultJob(id, { environment });
  assert.deepEqual(scheduledTimeouts, [25]);
  assert.equal(report.status, "incomplete");
  assert.equal(report.code, "JOB_TIMEOUT");
}));

test("8DA59548 sanitized replay attributes the long gap to model reasoning, not GitHub approval", () => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-8da59548.json"), "utf8"));
  const seconds = (start, end) => (Date.parse(end) - Date.parse(start)) / 1000;
  assert.equal(seconds(replay.run_started_at, replay.run_ended_at), replay.run_duration_seconds);
  assert.equal(seconds(replay.terra_started_at, replay.terra_github_work_ended_at), replay.terra_github_work_seconds);
  assert.equal(seconds(replay.reasoning_gap_started_at, replay.reasoning_gap_ended_at), replay.reasoning_gap_seconds);
  assert.equal(seconds(replay.sol_final_started_at, replay.sol_final_ended_at), replay.sol_final_seconds);
  assert.equal(replay.reasoning_gap_had_github_or_approval_event, false);
  assert.equal(replay.pr_creation_succeeded, true);
  assert.equal(replay.successful_marker_variant, "canonical_without_period");
  assert.equal(replay.prior_denied_marker_variant, "canonical_plus_terminal_period");
  assert.notEqual(replay.successful_marker_variant, replay.prior_denied_marker_variant);
  assert.equal(replay.reviewer_nondeterminism_established, false);
  assert.equal(replay.repository, "ExampleOrg/synthetic-template");
  assert.equal(Object.prototype.hasOwnProperty.call(replay, "audit_path"), false);
  assert.equal(JSON.stringify(replay).includes("audit_evidence"), false);
});

test("worker rejects a terminal model-only approval_pending envelope", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-64646464";
  writeJob(stateFor(id), { environment });
  const pending = completeEnvelope(id, {
    status: "approval_pending",
    reason_code: "GITHUB_WRITE_APPROVAL_PENDING",
    task_branch: null,
    head_sha: null,
    pr_number: null,
    pr_url: null,
    changes_or_artifacts: [],
    risks_or_blockers: ["A reviewer may still be active."],
    next_action: "Wait for the host-observed result.",
  });
  const child = completedChild([
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(pending) } },
    { type: "turn.completed" },
  ]);
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => child,
    timeoutMs: 1000,
  });
  const report = resultJob(id, { environment });
  assert.equal(report.status, "blocked");
  assert.equal(report.phase, "result_validation");
  assert.equal(report.code, "CODEX_RESULT_ENVELOPE_INVALID");
  assert.deepEqual(report.validation_error, { path: "status", rule: "value_out_of_range", expected: "one of complete, blocked, or incomplete" });
  assert.equal(report.result, null);
}));

test("worker stores only bounded final message and private thread id", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-55556666";
  writeJob(stateFor(id), { environment });
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "turn.started" },
    { type: "item.started", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.get_repo" } },
    ...verifiedPrEvents(id),
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(completeEnvelope(id)) } },
    { type: "turn.completed" },
  ];
  const child = completedChild(events);
  const scheduledTimeouts = [];
  const clearedTimeouts = [];
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: (executable, args, options) => {
      assert.equal(executable, "/mock/codex");
      assert.equal(options.shell, false);
      assert.equal(options.stdio[2], "ignore");
      assert.equal(args.at(-1), "-");
      return child;
    },
    setTimeoutImpl: (callback, milliseconds) => {
      const handle = { callback, milliseconds };
      scheduledTimeouts.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => clearedTimeouts.push(handle),
  });
  const publicResult = resultJob(id, { environment });
  assert.equal(publicResult.status, "complete");
  assert.deepEqual(publicResult.result, completeEnvelope(id));
  assert.equal(publicResult.leftover_resources[0].kind, "branch");
  assert.equal(publicResult.leftover_resources[1].kind, "pull_request");
  assert.equal(publicResult.leftover_resources[1].certification_status, "pending_do_not_merge");
  assert.equal(readJob(id, { environment }).prCertification.status, "pending_do_not_merge");
  assert.equal(JSON.stringify(publicResult).includes(THREAD_ID), false);
  assert.match(child.prompt, /GITHUB_MCP_ONLY/);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].milliseconds, DEFAULT_TIMEOUT_MS);
  assert.deepEqual(clearedTimeouts, scheduledTimeouts);
}));

test("worker surfaces observed GitHub approval abort when no valid envelope follows", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-56565656";
  writeJob(stateFor(id), { environment });
  const child = completedChild([
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_branch", status: "failed", error: { message: "user cancelled MCP tool call" } } },
    { type: "item.completed", item: { type: "agent_message", text: "not a JSON envelope" } },
    { type: "turn.completed" },
  ]);
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => child,
    timeoutMs: 1000,
  });
  const report = resultJob(id, { environment });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "GITHUB_WRITE_APPROVAL_ABORTED");
  assert.equal(report.result, null);
}));

test("mismatching approval-failure envelopes are discarded with truthful fail-closed phases", async () => withJobs(async (environment) => {
  const cases = [
    ["57575757", "github.create_branch", "user cancelled MCP tool call", "GITHUB_WRITE_APPROVAL_ABORTED", "blocked"],
    ["58585858", "github.update_file", "automatic approval denied this request", "GITHUB_WRITE_APPROVAL_DENIED", "blocked"],
    ["59595959", "github.create_pull_request", "approval timed out", "GITHUB_WRITE_APPROVAL_TIMEOUT", "incomplete"],
  ];
  for (const [suffix, tool, message, code, status] of cases) {
    const id = `CFT-20260715-112233-${suffix}`;
    writeJob(stateFor(id), { environment });
    const unresolved = completeEnvelope(id, {
      status: "blocked",
      reason_code: "REMOTE_DELIVERY_BLOCKED",
      task_branch: null,
      head_sha: null,
      pr_number: null,
      pr_url: null,
      changes_or_artifacts: [],
      risks_or_blockers: ["The write did not complete."],
      next_action: "Resolve the permission boundary.",
    });
    const child = completedChild([
      { type: "thread.started", thread_id: THREAD_ID },
      observedBranchEvent(id),
      { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool, status: "failed", error: { message } } },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(unresolved) } },
      { type: "turn.completed" },
    ]);
    await runWorker(id, {
      environment,
      resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
      readLoginMode: async () => "chatgpt",
      spawnImpl: () => child,
      timeoutMs: 1000,
    });
    const report = resultJob(id, { environment });
    assert.equal(report.status, status);
    assert.equal(report.phase, status);
    assert.equal(report.code, code);
    assert.equal(report.result, null);
    assert.equal(report.partial_evidence.task_branch, taskBranchFor(id));
    assert.equal(report.leftover_resources[0].name, taskBranchFor(id));
  }
}));

test("matching approval-failure envelopes preserve passive SOL-to-Terra evidence", async () => withJobs(async (environment) => {
  const cases = [
    ["61616161", "github.create_branch", "user cancelled MCP tool call", "GITHUB_WRITE_APPROVAL_ABORTED", "blocked", "blocked"],
    ["62626262", "github.update_file", "automatic approval denied this request", "GITHUB_WRITE_APPROVAL_DENIED", "blocked", "blocked"],
    ["63636363", "github.create_pull_request", "approval timed out", "GITHUB_WRITE_APPROVAL_TIMEOUT", "incomplete", "incomplete"],
  ];
  for (const [suffix, tool, message, code, envelopeStatus, publicStatus] of cases) {
    const id = `CFT-20260715-112233-${suffix}`;
    writeJob(stateFor(id), { environment });
    const envelope = completeEnvelope(id, {
      status: envelopeStatus,
      reason_code: code,
      task_branch: null,
      head_sha: null,
      pr_number: null,
      pr_url: null,
      changes_or_artifacts: [],
      risks_or_blockers: ["The approved write did not complete."],
      next_action: "Report the approval failure.",
    });
    const child = completedChild([
      { type: "thread.started", thread_id: THREAD_ID },
      observedBranchEvent(id),
      { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool, status: "failed", error: { message } } },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(envelope) } },
      { type: "turn.completed" },
    ]);
    await runWorker(id, {
      environment,
      resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
      readLoginMode: async () => "chatgpt",
      spawnImpl: () => child,
      timeoutMs: 1000,
    });
    const report = resultJob(id, { environment });
    assert.equal(report.status, publicStatus);
    assert.equal(report.phase, publicStatus);
    assert.equal(report.code, code);
    assert.equal(report.result.reason_code, code);
    assert.deepEqual(report.result.SOL_to_Terra_evidence, envelope.SOL_to_Terra_evidence);
    assert.equal(report.partial_evidence.task_branch, taskBranchFor(id));
    assert.equal(report.leftover_resources[0].name, taskBranchFor(id));
  }
}));

test("successful implementation adds no GitHub write beyond the explained commit and PR", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-70707070";
  writeJob(stateFor(id), { environment });
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    ...verifiedPrEvents(id),
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(completeEnvelope(id)) } },
    { type: "turn.completed" },
  ];
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => completedChild(events),
    timeoutMs: 1000,
  });
  assert.equal(resultJob(id, { environment }).status, "complete");
  assert.deepEqual(readJob(id, { environment }).implementationCommit, {
    status: "branch_effective",
    runId: id,
    repository: CONTRACT.repository,
    branch: taskBranchFor(id),
    sha: "a".repeat(40),
    message: implementationMessage(id),
    tool: "create_file",
  });
  assert.equal(events.some((event) => /(?:add_comment_to_issue|fetch_issue_comments)/.test(event.item?.tool || "")), false);
  assert.equal(events.filter((event) => /(?:create_file|create_pull_request)/.test(event.item?.tool || "") && event.type === "item.started").length, 2);
  assert.equal(events.filter((event) => /fetch_pr/.test(event.item?.tool || "")).length, 1);
}));

test("approval failures on the necessary PR write preserve the explained branch commit", async () => withJobs(async (environment) => {
  const cases = [
    ["71717171", "automatic approval denied this request", "GITHUB_WRITE_APPROVAL_DENIED", "blocked"],
    ["72727272", "approval timed out", "GITHUB_WRITE_APPROVAL_TIMEOUT", "incomplete"],
    ["73737373", "user cancelled MCP tool call", "GITHUB_WRITE_APPROVAL_ABORTED", "blocked"],
  ];
  for (const [suffix, message, code, status] of cases) {
    const id = `CFT-20260715-112233-${suffix}`;
    const headSha = "a".repeat(40);
    writeJob(stateFor(id), { environment });
    const envelope = completeEnvelope(id, {
      status,
      reason_code: code,
      task_branch: null,
      head_sha: null,
      pr_number: null,
      pr_url: null,
      changes_or_artifacts: [],
      risks_or_blockers: ["The necessary pull-request write did not complete."],
      next_action: "Preserve the explained task-branch commit and report the approval failure.",
    });
    const [commitStart, commit, prStart] = verifiedPrEvents(id, headSha);
    const failedPr = {
      type: "item.completed",
      item: {
        type: "mcp_tool_call", server: "codex_apps", tool: "github.create_pull_request",
        status: "failed", error: { message },
      },
    };
    const events = [
      { type: "thread.started", thread_id: THREAD_ID },
      commitStart,
      commit,
      prStart,
      failedPr,
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(envelope) } },
      { type: "turn.completed" },
    ];
    const child = completedChild(events);
    await runWorker(id, {
      environment,
      resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
      readLoginMode: async () => "chatgpt",
      spawnImpl: () => child,
      timeoutMs: 1000,
    });
    const report = resultJob(id, { environment });
    assert.equal(report.status, status);
    assert.equal(report.code, code);
    assert.equal(report.result.reason_code, code);
    assert.equal(report.partial_evidence.last_completed_phase, "commit_without_pr");
    assert.deepEqual(report.leftover_resources.map((item) => item.kind), ["branch", "commit_without_pr"]);
    assert.equal(report.leftover_resources[1].head_sha, headSha);
    assert.equal(events.some((event) => /add_comment_to_issue|fetch_issue_comments/.test(event.item?.tool || "")), false);
    assert.equal(events.some((event) => /update_pull_request/.test(event.item?.tool || "")), false);
  }
}));

test("an allowed GitHub write retry may recover to a valid complete envelope", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-60606060";
  writeJob(stateFor(id), { environment });
  const child = completedChild([
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_branch", status: "failed", error: { message: "user cancelled MCP tool call" } } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_branch", status: "completed" } },
    ...verifiedPrEvents(id),
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(completeEnvelope(id)) } },
    { type: "turn.completed" },
  ]);
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => child,
    timeoutMs: 1000,
  });
  const report = resultJob(id, { environment });
  assert.equal(report.status, "complete");
  assert.equal(report.phase, "ready_for_quality_gate");
  assert.equal(report.code, null);
  assert.equal(report.result.pr_number, 42);
}));

test("worker requires ChatGPT login before starting a Codex turn", async () => withJobs(async (environment) => {
  const id = "CFT-20260715-112233-77778888";
  writeJob(stateFor(id), { environment });
  let started = false;
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "api-key-not-permitted",
    spawnImpl: () => { started = true; throw new Error("must not start"); },
  });
  assert.equal(started, false);
  const report = statusJob(id, { environment });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "CHATGPT_LOGIN_REQUIRED");
}));

test("worker fails closed before spawn when the GitHub connector id is unavailable", async () => withJobs(async (environment) => {
  const id = "CFT-20260719-112233-52525252";
  writeJob(stateFor(id), { environment });
  await fs.promises.unlink(path.join(environment.CODEX_HOME, ".codex-global-state.json"));
  let started = false;
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => { started = true; throw new Error("must not start"); },
  });
  assert.equal(started, false);
  const report = statusJob(id, { environment });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "GITHUB_CONNECTOR_ID_UNAVAILABLE");
}));

test("strict JSON envelope rejects Markdown, prose, oversized output, and missing PR identity", () => {
  const id = "CFT-20260715-112233-14141414";
  const context = { runId: id, repository: CONTRACT.repository, baseBranch: CONTRACT.base_branch, taskBranch: taskBranchFor(id), taskType: "implementation", auditPath: null };
  const valid = completeEnvelope(id);
  assert.equal(parseAndValidateEnvelope(JSON.stringify(valid), context).status, "complete");
  assert.throws(() => parseAndValidateEnvelope(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, context), /CODEX_RESULT_ENVELOPE_INVALID/);
  assert.throws(() => parseAndValidateEnvelope(`Result:\n${JSON.stringify(valid)}`, context), /CODEX_RESULT_ENVELOPE_INVALID/);
  assert.throws(() => parseAndValidateEnvelope({ ...valid, pr_number: null, pr_url: null }, context), /CODEX_RESULT_ENVELOPE_INVALID/);
  assert.throws(() => parseAndValidateEnvelope({
    ...valid,
    status: "approval_pending",
    reason_code: "GITHUB_WRITE_APPROVAL_PENDING",
    task_branch: null,
    head_sha: null,
    pr_number: null,
    pr_url: null,
    changes_or_artifacts: [],
  }, context), /CODEX_RESULT_ENVELOPE_INVALID/);
  assert.throws(() => parseAndValidateEnvelope("x".repeat(MAX_RESULT_BYTES + 1), context), /CODEX_RESULT_ENVELOPE_INVALID/);
  assert.throws(() => parseAndValidateEnvelope(1n, context), /CODEX_RESULT_ENVELOPE_INVALID/);
});

test("one frozen schema drives all 18 validator keys plus start and resume contracts", () => {
  assert.equal(Object.isFrozen(RESULT_ENVELOPE_SCHEMA), true);
  assert.equal(ENVELOPE_KEYS.length, 18);
  assert.deepEqual(ENVELOPE_KEYS, Object.keys(RESULT_ENVELOPE_SCHEMA).sort());
  assert.deepEqual(SOL_TERRA_KEYS, Object.keys(RESULT_ENVELOPE_SCHEMA.SOL_to_Terra_evidence.example).sort());
  const contract = resultEnvelopeContractText();
  const implementationExample = resultEnvelopeExampleText("implementation");
  const auditExample = resultEnvelopeExampleText("audit");
  const parsedImplementationExample = JSON.parse(implementationExample);
  const parsedAuditExample = JSON.parse(auditExample);
  assert.deepEqual(Object.keys(parsedImplementationExample).sort(), ENVELOPE_KEYS);
  assert.equal(parsedAuditExample.audit_evidence, null);
  assert.equal(parsedAuditExample.changes_or_artifacts[0].kind, "audit_report");
  assert.equal(parseAndValidateEnvelope(parsedImplementationExample, {
    runId: "CURRENT_RUN_ID", repository: "OWNER/REPO", baseBranch: "main", taskBranch: "sol/example",
    taskType: "implementation", auditPath: null,
  }).status, "blocked");
  assert.equal(parseAndValidateEnvelope(parsedAuditExample, {
    runId: "CURRENT_RUN_ID", repository: "OWNER/REPO", baseBranch: "main", taskBranch: "sol/example",
    taskType: "audit", auditPath: null,
  }).status, "blocked");
  for (const [field, definition] of Object.entries(RESULT_ENVELOPE_SCHEMA)) {
    assert.match(contract, new RegExp(`- ${field}:`));
    assert.equal(typeof definition.expected, "string");
    assert.equal(typeof definition.contract, "string");
  }
  for (const field of ["resources_consulted", "changes_or_artifacts", "finding_dispositions"]) {
    assert.equal(RESULT_ENVELOPE_SCHEMA[field].type, "object_list");
    assert.deepEqual(Object.keys(RESULT_ENVELOPE_SCHEMA[field].children).sort(),
      field === "resources_consulted" ? ["evidence", "resource"]
        : field === "changes_or_artifacts" ? ["artifact", "evidence", "kind"]
          : ["disposition", "evidence", "line", "path", "url"]);
  }
  assert.equal(RESULT_ENVELOPE_SCHEMA.audit_evidence.type, "nullable_object");
  assert.equal(RESULT_ENVELOPE_SCHEMA.audit_evidence.children.line_evidence.type, "object_list");
  assert.equal(RESULT_ENVELOPE_SCHEMA.SOL_to_Terra_evidence.type, "object");
  const implementationState = stateFor("CFT-20260716-191500-ABCD1234");
  const auditState = stateFor("CFT-20260716-191501-ABCD1235", {
    contract: { ...stateFor("CFT-20260716-191501-ABCD1235").contract, taskType: "audit" },
    auditPath: auditPathFor("CFT-20260716-191501-ABCD1235"),
  });
  for (const prompt of [
    buildStartPrompt(implementationState),
    buildResumePrompt({ ...implementationState, request: { kind: "resume", findings: [{ body: "x", url: "u", path: "p", line: 1 }] } }),
    buildStartPrompt(auditState),
    buildResumePrompt({ ...auditState, request: { kind: "resume", findings: [{ body: "x", url: "u", path: "p", line: 1 }] } }),
  ]) {
    assert.match(prompt, /exactly 18 top-level fields/);
    assert.match(prompt, /tests_and_verification: array \(0 to 100 items\) of non-empty strings/);
    assert.match(prompt, /Canonical type-shape example/);
  }
});

test("structured child schema rejects nested type drift before semantic normalization", () => {
  const id = "CFT-20260716-191550-ABCD1299";
  const context = {
    runId: id, repository: CONTRACT.repository, baseBranch: CONTRACT.base_branch,
    taskBranch: taskBranchFor(id), taskType: "implementation", auditPath: null,
  };
  const checks = [
    [{ ...completeEnvelope(id), resources_consulted: [{ resource: 7, evidence: "Observed." }] }, "resources_consulted[0].resource", RESULT_ENVELOPE_SCHEMA.resources_consulted.children.resource.expected],
    [{ ...completeEnvelope(id), changes_or_artifacts: [{ artifact: "src/a.js", kind: 7, evidence: "Changed." }] }, "changes_or_artifacts[0].kind", RESULT_ENVELOPE_SCHEMA.changes_or_artifacts.children.kind.expected],
    [{ ...completeEnvelope(id), SOL_to_Terra_evidence: { ...completeEnvelope(id).SOL_to_Terra_evidence, terra_v1: 7 } }, "SOL_to_Terra_evidence.terra_v1", RESULT_ENVELOPE_SCHEMA.SOL_to_Terra_evidence.children.terra_v1.expected],
  ];
  for (const [candidate, expectedPath, expected] of checks) {
    assert.throws(() => parseAndValidateEnvelope(candidate, context), (error) => {
      assert.deepEqual(error.publicValidationError, { path: expectedPath, rule: "type_mismatch", expected });
      return true;
    });
  }
});

test("public job projection preserves a validated result and drops unknown top-level and nested data", () => {
  const id = "CFT-20260716-191551-ABCD1298";
  const result = completeEnvelope(id);
  const report = {
    status: "complete", run_id: id, phase: "ready_for_quality_gate", repository: CONTRACT.repository,
    created_at: "2026-07-16T19:15:51.000Z", updated_at: "2026-07-16T19:16:51.000Z",
    correction_resumes_used: 0, wall_clock_limit_minutes: 45, code: null, validation_error: null,
    partial_evidence: null, leftover_resources: [], result, internal_secret: "LEAK",
  };
  const projected = formatJobResult(report).structuredContent;
  assert.equal(JSON.stringify(projected).includes("LEAK"), false);
  assert.deepEqual(projected.result, parseAndValidateEnvelope(result, {
    runId: id, repository: CONTRACT.repository, baseBranch: CONTRACT.base_branch,
    taskBranch: taskBranchFor(id), taskType: "implementation", auditPath: null,
  }));
  const poisoned = structuredClone(report);
  poisoned.result.resources_consulted[0].internal_secret = "NESTED_LEAK";
  const poisonedOutput = formatJobResult(poisoned).structuredContent;
  assert.equal(poisonedOutput.result, null);
  assert.equal(JSON.stringify(poisonedOutput).includes("NESTED_LEAK"), false);
});

test("valid implementation and audit envelopes reach ready_for_quality_gate; wrong tests shape exposes expected", () => {
  const implementationId = "CFT-20260716-191600-ABCD1236";
  const implementation = completeEnvelope(implementationId);
  const implementationContext = {
    runId: implementationId, repository: CONTRACT.repository, baseBranch: CONTRACT.base_branch,
    taskBranch: taskBranchFor(implementationId), taskType: "implementation", auditPath: null,
  };
  const normalizedImplementation = parseAndValidateEnvelope(implementation, implementationContext);
  assert.deepEqual(outcomeForEnvelope(normalizedImplementation), { status: "complete", phase: "ready_for_quality_gate", code: null });
  assert.throws(() => parseAndValidateEnvelope({ ...implementation, tests_and_verification: { passed: true } }, implementationContext), (error) => {
    assert.deepEqual(error.publicValidationError, {
      path: "tests_and_verification",
      rule: "type_mismatch",
      expected: "array (0 to 100 items) of non-empty strings",
    });
    assert.equal(JSON.stringify(error.publicValidationError).includes("passed"), false);
    return true;
  });

  const auditId = "CFT-20260716-191601-ABCD1237";
  const auditPath = auditPathFor(auditId);
  const audit = completeEnvelope(auditId, {
    changes_or_artifacts: [{ artifact: auditPath, kind: "audit_report", evidence: "Report re-read at final head." }],
    audit_evidence: {
      audited_sha: "b".repeat(40),
      scope: ["Requested audit scope."],
      findings: ["No mechanically provable defect."],
      verification: "Re-read exact source range at audited SHA.",
      line_evidence: [{ path: "src/a.js", start_line: 1, end_line: 1, snippet: "const x = 1;" }],
    },
  });
  const normalizedAudit = parseAndValidateEnvelope(audit, {
    runId: auditId, repository: CONTRACT.repository, baseBranch: CONTRACT.base_branch,
    taskBranch: taskBranchFor(auditId), taskType: "audit", auditPath,
  });
  assert.deepEqual(outcomeForEnvelope(normalizedAudit), { status: "complete", phase: "ready_for_quality_gate", code: null });
});

test("strict envelope errors expose concrete indexed paths without raw values", () => {
  const id = "CFT-20260715-112233-ABCD1234";
  const context = {
    runId: id, repository: CONTRACT.repository, baseBranch: CONTRACT.base_branch,
    taskBranch: taskBranchFor(id), taskType: "implementation", auditPath: null,
  };
  const unknown = { ...completeEnvelope(id), attacker_payload: "do-not-leak" };
  assert.throws(() => parseAndValidateEnvelope(JSON.stringify(unknown), context), (error) => {
    assert.deepEqual(error.publicValidationError, { path: "envelope.attacker_payload", rule: "unknown_key", expected: "object with exactly the 18 documented top-level fields" });
    assert.equal(JSON.stringify(error).includes("do-not-leak"), false);
    return true;
  });
  const indexed = completeEnvelope(id);
  indexed.resources_consulted[0].evidence = 7;
  assert.throws(() => parseAndValidateEnvelope(indexed, context), (error) => {
    assert.deepEqual(error.publicValidationError, { path: "resources_consulted[0].evidence", rule: "type_mismatch", expected: "non-empty string" });
    return true;
  });
  assert.throws(() => parseAndValidateEnvelope("{broken", context), (error) => {
    assert.deepEqual(error.publicValidationError, { path: "envelope", rule: "json_parse_failed", expected: "object" });
    return true;
  });
});

test("terminal observation merge never deletes an already persisted branch and PR", () => {
  const persisted = {
    publicEvidence: {
      repository: "example-org/web-template", base_branch: "main", task_branch: "sol/cft-20260716-135002-ea345997",
      head_sha: "e".repeat(40), pr_number: 5, pr_url: "https://github.com/example-org/web-template/pull/5",
      last_completed_phase: "pr_verified",
    },
    leftoverResources: [
      { kind: "branch", repository: "example-org/web-template", name: "sol/cft-20260716-135002-ea345997" },
      { kind: "pull_request", repository: "example-org/web-template", number: 5, url: "https://github.com/example-org/web-template/pull/5", state: "open", draft: false, certification_status: "pending_do_not_merge" },
    ],
  };
  for (const fresh of [
    { partialEvidence: null, leftoverResources: [] },
    { partialEvidence: { repository: "example-org/web-template", task_branch: "sol/cft-20260716-135002-ea345997", last_completed_phase: "branch_created" }, leftoverResources: [{ kind: "branch", repository: "example-org/web-template", name: "sol/cft-20260716-135002-ea345997" }] },
  ]) {
    const merged = mergeTerminalObservation(persisted, fresh);
    assert.equal(merged.partialEvidence.pr_number, 5);
    assert.deepEqual(merged.leftoverResources.map((item) => item.kind), ["branch", "pull_request"]);
  }
});

test("terminal merge never invents a branch from the contract alone", () => {
  const id = "CFT-20260716-135002-00000001";
  const empty = stateFor(id, {
    status: "running",
    publicEvidence: null,
    leftoverResources: [],
  });
  const mergedEmpty = mergeTerminalObservation(empty, { partialEvidence: null, leftoverResources: [] });
  assert.deepEqual(mergedEmpty, { partialEvidence: null, leftoverResources: [] });
  assert.deepEqual(publicStatus({
    ...empty,
    status: "blocked",
    phase: "blocked",
    publicCode: "CODEX_NOT_FOUND",
    publicEvidence: mergedEmpty.partialEvidence,
    leftoverResources: mergedEmpty.leftoverResources,
  }).leftover_resources, []);

  for (const invalidEvidence of [
    { last_completed_phase: "branch_created" },
    { repository: "OtherOrg/other", task_branch: taskBranchFor(id), last_completed_phase: "branch_created" },
    { repository: CONTRACT.repository, task_branch: "sol/wrong-branch", last_completed_phase: "branch_created" },
  ]) {
    const invalidMerge = mergeTerminalObservation({ ...empty, publicEvidence: invalidEvidence }, {
      partialEvidence: null,
      leftoverResources: [],
    });
    assert.deepEqual(invalidMerge.leftoverResources, []);
    assert.deepEqual(publicStatus({
      ...empty,
      status: "blocked",
      phase: "blocked",
      publicCode: "CODEX_RUN_FAILED",
      publicEvidence: invalidMerge.partialEvidence,
      leftoverResources: invalidMerge.leftoverResources,
    }).leftover_resources, []);
  }

  const observed = {
    repository: CONTRACT.repository,
    base_branch: CONTRACT.base_branch,
    task_branch: taskBranchFor(id),
    head_sha: null,
    pr_number: null,
    pr_url: null,
    last_completed_phase: "branch_created",
  };
  const mergedObserved = mergeTerminalObservation({ ...empty, publicEvidence: observed }, {
    partialEvidence: null,
    leftoverResources: [],
  });
  assert.deepEqual(mergedObserved.leftoverResources, [{
    kind: "branch",
    repository: CONTRACT.repository,
    name: taskBranchFor(id),
  }]);
  assert.deepEqual(publicStatus({
    ...empty,
    status: "blocked",
    phase: "blocked",
    publicCode: "CODEX_RUN_FAILED",
    publicEvidence: mergedObserved.partialEvidence,
    leftoverResources: mergedObserved.leftoverResources,
  }).leftover_resources.map((item) => item.kind), ["branch"]);
});

test("Bug 17 merge deterministically supersedes commit residues with exactly branch plus PR", () => {
  const id = "CFT-20260716-135002-EA345997";
  const repository = "example-org/web-template";
  const branch = taskBranchFor(id);
  const auditPath = auditPathFor(id);
  const headSha = "e".repeat(40);
  const base = stateFor(id, {
    contract: { ...stateFor(id).contract, repository, baseBranch: "main", taskType: "audit" },
    taskBranch: branch,
    auditPath,
    status: "running",
    publicEvidence: {
      repository, base_branch: "main", task_branch: branch, head_sha: headSha,
      pr_number: null, pr_url: null, last_completed_phase: "audit_artifact_committed_pr_missing",
    },
  });
  const branchResidue = { kind: "branch", repository, name: branch };
  const auditResidue = {
    kind: "audit_artifact_committed_pr_missing", repository, base_branch: "main", branch,
    head_sha: headSha, artifact_path: auditPath, pr_missing: true, pr_number: null, pr_url: null,
    required_pr_body_marker: pendingMergeMarker(id, headSha), accepted_terminal_period: true,
    recovery_status: "manual_pr_creation_required", recovery_instruction: MANUAL_PR_RECOVERY_INSTRUCTION,
  };
  const pullRequest = {
    kind: "pull_request", repository, number: 5, url: `https://github.com/${repository}/pull/5`,
    state: "open", draft: false, certification_status: "pending_do_not_merge",
  };
  const fresh = {
    partialEvidence: {
      repository, base_branch: "main", task_branch: branch, head_sha: headSha,
      pr_number: 5, pr_url: pullRequest.url, last_completed_phase: "pr_verified",
    },
    leftoverResources: [branchResidue, pullRequest],
  };
  for (const [persistedResources, freshResources] of [
    [[branchResidue, auditResidue], [branchResidue, pullRequest]],
    [[auditResidue, branchResidue], [pullRequest, branchResidue]],
  ]) {
    const merged = mergeTerminalObservation({ ...base, leftoverResources: persistedResources }, { ...fresh, leftoverResources: freshResources });
    assert.deepEqual(merged.leftoverResources.map((item) => item.kind), ["branch", "pull_request"]);
    assert.equal(merged.leftoverResources.length, 2);
    const visible = publicStatus({
      ...base,
      status: "blocked",
      phase: "result_validation",
      publicCode: "CODEX_RESULT_ENVELOPE_INVALID",
      publicEvidence: merged.partialEvidence,
      leftoverResources: merged.leftoverResources,
    });
    assert.deepEqual(visible.leftover_resources.map((item) => item.kind), ["branch", "pull_request"]);
    assert.match(formatJobResult(visible).content[0].text, /leftover_resources=branch:.*\|pr:example-org\/web-template#5/);
  }
  const reverse = mergeTerminalObservation({
    ...base,
    publicEvidence: fresh.partialEvidence,
    leftoverResources: [pullRequest, branchResidue],
  }, {
    partialEvidence: base.publicEvidence,
    leftoverResources: [auditResidue, branchResidue],
  });
  assert.deepEqual(reverse.leftoverResources.map((item) => item.kind), ["branch", "pull_request"]);

  const commitResidue = { ...auditResidue, kind: "commit_without_pr" };
  delete commitResidue.artifact_path;
  const noPr = mergeTerminalObservation({ ...base, leftoverResources: [commitResidue, branchResidue] }, {
    partialEvidence: base.publicEvidence,
    leftoverResources: [branchResidue, auditResidue],
  });
  assert.deepEqual(noPr.leftoverResources.map((item) => item.kind), ["branch", "audit_artifact_committed_pr_missing"]);
});

test("Bug 6 remains reachable: parseable audit envelope mismatch is unverified and preserves branch plus PR", async () => withJobs(async (environment) => {
  const id = "CFT-20260716-135002-B0060006";
  const auditPath = auditPathFor(id);
  const auditedSha = "d".repeat(40);
  const headSha = "a".repeat(40);
  const auditState = stateFor(id, {
    contract: { ...stateFor(id).contract, taskType: "audit" },
    auditPath,
  });
  writeJob(auditState, { environment });
  const reportEnvelope = completeEnvelope(id, {
    changes_or_artifacts: [{ artifact: auditPath, kind: "audit_report", evidence: "Verified report." }],
    audit_evidence: {
      audited_sha: auditedSha,
      scope: ["src/a.js"], findings: ["Report finding."], verification: "Range fetched.",
      line_evidence: [{ path: "src/a.js", start_line: 1, end_line: 1, snippet: "const x = 1;" }],
    },
  });
  const finalEnvelope = {
    ...reportEnvelope,
    audit_evidence: { ...reportEnvelope.audit_evidence, findings: ["Envelope mismatch."] },
  };
  const report = `# Audit\n\n${auditEvidenceBlock(auditState, reportEnvelope)}\n`;
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    observedBranchEvent(id),
    completedGithubEvent("create_file", CONTRACT.repository, {
      branch: taskBranchFor(id), path: auditPath, content: report,
    }, { commit_sha: headSha }),
    completedGithubEvent("fetch_file", CONTRACT.repository, {
      path: "src/a.js", ref: auditedSha, start_line: 1, end_line: 1, encoding: "utf-8",
    }, { content: "const x = 1;", encoding: "utf-8", sha: "c".repeat(40) }),
    completedGithubEvent("fetch_file", CONTRACT.repository, {
      path: auditPath, ref: headSha, encoding: "utf-8",
    }, { content: report, encoding: "utf-8", sha: "b".repeat(40) }),
    {
      type: "item.started",
      item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_pull_request", arguments: {} },
    },
    ...verifiedPrEvents(id, headSha, { contextComment: false }),
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(finalEnvelope) } },
    { type: "turn.completed" },
  ];
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => completedChild(events),
    timeoutMs: 1000,
  });
  const result = resultJob(id, { environment });
  assert.equal(result.code, "AUDIT_EVIDENCE_UNVERIFIED");
  assert.deepEqual(result.validation_error, {
    path: "audit_artifact.evidence_block.audit_evidence.findings[0]",
    rule: "report_block_mismatch",
    expected: "host-observed GitHub evidence satisfying the named rule",
    mismatch: {
      artifact: { preview: "Report finding.", utf8_bytes: 15, truncated: false, sensitive: false },
      envelope: { preview: "Envelope mismatch.", utf8_bytes: 18, truncated: false, sensitive: false },
    },
  });
  assert.deepEqual(result.leftover_resources.map((item) => item.kind), ["branch", "pull_request"]);
}));

test("EA345997 worker stops malformed audit JSON before a PR completion can be observed", async () => withJobs(async (environment) => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-ea345997.json"), "utf8"));
  const initial = stateFor(replay.source_run_id, {
    contract: {
      ...stateFor(replay.source_run_id).contract,
      repository: replay.repository,
      baseBranch: replay.base_branch,
      taskType: replay.task_type,
    },
    taskBranch: replay.task_branch,
    auditPath: replay.audit_path,
  });
  writeJob(initial, { environment });
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    completedGithubEvent("create_branch", replay.repository, {
      branch_name: replay.task_branch, sha: replay.audited_sha,
    }, { branch: replay.task_branch }),
    completedGithubEvent("create_file", replay.repository, {
      branch: replay.task_branch, path: replay.audit_path, content: replay.invalid_report_content,
    }, { commit_sha: replay.head_sha }),
    {
      type: "item.started",
      item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_pull_request", arguments: {} },
    },
    completedGithubEvent("create_pull_request", replay.repository, {
      head: replay.task_branch, base: replay.base_branch, draft: false,
      body: pendingMergeMarker(replay.source_run_id, replay.head_sha),
    }, {
      url: replay.pr_url, number: replay.pr_number, state: replay.pr_state, merged: false, draft: replay.pr_draft,
      base: replay.base_branch, head: replay.task_branch, head_sha: replay.head_sha,
      body: pendingMergeMarker(replay.source_run_id, replay.head_sha),
    }),
  ];
  await runWorker(replay.source_run_id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => completedChild(events),
    timeoutMs: 1000,
  });
  const result = resultJob(replay.source_run_id, { environment });
  assert.equal(result.code, replay.expected_pre_pr_code);
  assert.deepEqual(result.validation_error, replay.expected_validation_error);
  assert.equal(result.partial_evidence.pr_number, null);
  assert.equal(result.leftover_resources.some((item) => item.kind === "pull_request"), false);
  assert.deepEqual(result.leftover_resources.map((item) => item.kind), ["branch", "audit_artifact_committed_pr_missing"]);
}));

test("EA345997 historical terminal replay preserves the already observed branch and PR 5", async () => withJobs(async (environment) => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-ea345997.json"), "utf8"));
  writeJob(stateFor(replay.source_run_id, {
    contract: {
      ...stateFor(replay.source_run_id).contract,
      repository: replay.repository, baseBranch: replay.base_branch, taskType: replay.task_type,
    },
    taskBranch: replay.task_branch,
    auditPath: replay.audit_path,
    publicEvidence: {
      repository: replay.repository, base_branch: replay.base_branch, task_branch: replay.task_branch,
      head_sha: replay.head_sha, pr_number: replay.pr_number, pr_url: replay.pr_url,
      last_completed_phase: "pr_verified",
    },
    leftoverResources: [
      { kind: "branch", repository: replay.repository, name: replay.task_branch },
      { kind: "pull_request", repository: replay.repository, number: replay.pr_number, url: replay.pr_url, state: replay.pr_state, draft: replay.pr_draft, certification_status: "pending_do_not_merge" },
    ],
  }), { environment });
  const child = completedChild([
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "item.completed", item: { type: "agent_message", text: "{historically-malformed-envelope" } },
    { type: "turn.completed" },
  ]);
  await runWorker(replay.source_run_id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => child,
    timeoutMs: 1000,
  });
  const result = resultJob(replay.source_run_id, { environment });
  assert.equal(result.code, "CODEX_RESULT_ENVELOPE_INVALID");
  assert.deepEqual(result.validation_error, { path: "envelope", rule: "json_parse_failed", expected: "object" });
  assert.equal(result.partial_evidence.pr_number, replay.pr_number);
  assert.deepEqual(result.leftover_resources.map((item) => item.kind), ["branch", "pull_request"]);
}));

test("76760B4C replay returns sanitized validation failure with trusted branch residue", async () => withJobs(async (environment) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-76760b4c.json"), "utf8"));
  const id = fixture.source_run_id;
  const state = stateFor(id, {
    contract: { ...stateFor(id).contract, repository: fixture.repository, taskType: fixture.task_type },
  });
  state.taskBranch = fixture.task_branch;
  writeJob(state, { environment });
  const invalidEnvelope = completeEnvelope(id, {
    repository: fixture.repository,
    task_branch: fixture.task_branch,
    head_sha: fixture.envelope_head_sha,
    status: "blocked",
    reason_code: "NULL_DIFF_NO_DELIVERY",
    pr_number: null,
    pr_url: null,
    changes_or_artifacts: [],
    finding_dispositions: [{
      url: "https://github.com/ExampleCo/example-site/pull/104",
      path: fixture.finding_path,
      line: null,
      disposition: "not_present",
      evidence: "Field was not present.",
    }],
  });
  const child = completedChild([
    { type: "thread.started", thread_id: THREAD_ID },
    {
      type: "item.completed",
      item: {
        type: "mcp_tool_call", server: "codex_apps", tool: "github.create_branch", status: "completed", error: null,
        arguments: { repository_full_name: fixture.repository, branch_name: fixture.task_branch, base_ref: fixture.base_ref },
        result: { isError: false, structuredContent: { branch: fixture.task_branch } },
      },
    },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(invalidEnvelope) } },
    { type: "turn.completed" },
  ]);
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => child,
    timeoutMs: 1000,
  });
  const report = resultJob(id, { environment });
  assert.equal(report.status, fixture.expected_status);
  assert.equal(report.code, fixture.expected_code);
  assert.equal(report.phase, fixture.expected_phase);
  assert.equal(report.result, null);
  assert.equal(report.partial_evidence.task_branch, fixture.task_branch);
  assert.equal(report.partial_evidence.head_sha, null);
  assert.equal(report.leftover_resources[0].name, fixture.task_branch);
  assert.deepEqual(report.validation_error, { path: "finding_dispositions[0].url", rule: "canonical_unanchored_file_url_required", expected: "canonical same-repository blob URL at an allowed SHA" });
  const formatted = formatJobResult(report);
  assert.match(formatted.content[0].text, /status=blocked; code=CODEX_RESULT_ENVELOPE_INVALID; phase=result_validation/);
  assert.match(formatted.content[0].text, new RegExp(fixture.task_branch.replaceAll("/", "\\/")));
  assert.equal(JSON.stringify(formatted).includes("Field was not present"), false);
}));

test("62548D60 replay preserves the exact denial and committed-audit manual recovery residue", async () => withJobs(async (environment) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-62548d60.json"), "utf8"));
  const id = fixture.source_run_id;
  const base = stateFor(id);
  writeJob(stateFor(id, {
    contract: { ...base.contract, repository: fixture.repository, baseBranch: fixture.base_branch, taskType: "audit" },
    taskBranch: fixture.task_branch,
    auditPath: fixture.audit_path,
  }), { environment });
  const denied = completeEnvelope(id, {
    status: "blocked",
    reason_code: fixture.expected_code,
    repository: fixture.repository,
    base_branch: fixture.base_branch,
    task_branch: fixture.task_branch,
    head_sha: fixture.head_sha,
    pr_number: null,
    pr_url: null,
    changes_or_artifacts: [{ artifact: fixture.audit_path, kind: "audit_report", evidence: "Committed before PR creation was denied." }],
    audit_evidence: null,
    risks_or_blockers: ["Automatic review denied PR creation."],
    next_action: "Use the exact manual recovery residue without mutating the branch.",
  });
  const child = completedChild([
    { type: "thread.started", thread_id: THREAD_ID },
    {
      type: "item.completed",
      item: {
        type: "mcp_tool_call", server: "codex_apps", tool: "github.create_branch", status: "completed", error: null,
        arguments: { repository_full_name: fixture.repository, branch_name: fixture.task_branch, base_ref: fixture.base_branch },
        result: { isError: false, structuredContent: { branch: fixture.task_branch } },
      },
    },
    {
      type: "item.completed",
      item: {
        type: "mcp_tool_call", server: "codex_apps", tool: "github.create_file", status: "completed", error: null,
        arguments: { repository_full_name: fixture.repository, branch: fixture.task_branch, path: fixture.audit_path, message: "audit", content: "bounded" },
        result: { isError: false, structuredContent: { commit_sha: fixture.head_sha } },
      },
    },
    {
      type: "item.completed",
      item: {
        type: "mcp_tool_call", server: "codex_apps", tool: "github.create_pull_request", status: "failed",
        arguments: { repository_full_name: fixture.repository, head: fixture.task_branch, base: fixture.base_branch, draft: false, body: fixture.pr_body_marker },
        error: { message: fixture.denial_message },
      },
    },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(denied) } },
    { type: "turn.completed" },
  ]);
  await runWorker(id, {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => child,
    timeoutMs: 1000,
  });
  const report = resultJob(id, { environment });
  assert.equal(report.status, fixture.expected_status);
  assert.equal(report.phase, fixture.expected_phase);
  assert.equal(report.code, fixture.expected_code);
  assert.equal(report.partial_evidence.head_sha, fixture.head_sha);
  assert.equal(report.partial_evidence.pr_number, null);
  assert.equal(report.partial_evidence.last_completed_phase, "audit_artifact_committed_pr_missing");
  assert.equal(report.leftover_resources[1].kind, "audit_artifact_committed_pr_missing");
  assert.equal(report.leftover_resources[1].head_sha, fixture.head_sha);
  assert.equal(report.leftover_resources[1].required_pr_body_marker, fixture.pr_body_marker.slice(0, -1));
  assert.equal(report.leftover_resources[1].recovery_status, "manual_pr_creation_required");
  const formatted = formatJobResult(report);
  assert.match(formatted.content[0].text, /audit_commit:ExampleOrg\/synthetic-audit@sol\/cft-20260716-033135-62548d60#/);
  assert.match(formatted.content[0].text, /pr=missing:recovery=manual_pr_creation_required/);
  assert.deepEqual(formatted.structuredContent.leftover_resources[1], report.leftover_resources[1]);
  assert.equal(formatted.structuredContent.leftover_resources[1].recovery_instruction, MANUAL_PR_RECOVERY_INSTRUCTION);
}));

test("null finding lines require an exact unanchored same-head file URL", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-76760b4c.json"), "utf8"));
  const id = fixture.source_run_id;
  const fileUrl = `https://github.com/${fixture.repository}/blob/${fixture.envelope_head_sha}/${fixture.finding_path}`;
  const envelope = completeEnvelope(id, {
    repository: fixture.repository,
    task_branch: fixture.task_branch,
    head_sha: fixture.envelope_head_sha,
    status: "blocked",
    reason_code: "NULL_DIFF_NO_DELIVERY",
    pr_number: null,
    pr_url: null,
    changes_or_artifacts: [],
    finding_dispositions: [{ url: fileUrl, path: fixture.finding_path, line: null, disposition: "not_present", evidence: "Absent." }],
  });
  const context = { runId: id, repository: fixture.repository, baseBranch: CONTRACT.base_branch, taskBranch: fixture.task_branch, taskType: "implementation", auditPath: null };
  assert.equal(parseAndValidateEnvelope(envelope, context).finding_dispositions[0].line, null);
  assert.throws(() => parseAndValidateEnvelope({
    ...envelope,
    finding_dispositions: [{ ...envelope.finding_dispositions[0], url: `${fileUrl}#L1` }],
  }, context), /CODEX_RESULT_ENVELOPE_INVALID/);
  assert.equal(parseAndValidateEnvelope({
    ...envelope,
    finding_dispositions: [{ ...envelope.finding_dispositions[0], line: 7, url: `${fileUrl}#L7` }],
  }, context).finding_dispositions[0].line, 7);
});

function terminalPublicSnapshot(report) {
  return {
    status: report.status,
    code: report.code,
    phase: report.phase,
    validation_error: report.validation_error,
    partial_evidence: report.partial_evidence,
    leftover_resources: report.leftover_resources,
  };
}

function terminalWorkerOptions(environment, events, overrides = {}) {
  return {
    environment,
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex" }),
    readLoginMode: async () => "chatgpt",
    spawnImpl: () => completedChild(events),
    timeoutMs: 1000,
    ...overrides,
  };
}

function observedExactBranchHeadEvent(repository, baseBranch, taskBranch, headSha) {
  return completedGithubEvent("compare_commits", repository, {
    base: headSha,
    head: taskBranch,
  }, {
    repository_full_name: repository,
    base: headSha,
    head: taskBranch,
    status: "identical",
    ahead_by: 0,
    behind_by: 0,
    total_commits: 0,
    files: [],
  });
}

test("terminal fixture matrix keeps every host-observed residue on all terminal paths", async (t) => {
  const branchResidue = (repository, branch) => ({ kind: "branch", repository, name: branch });
  const commitResidue = (id, repository, baseBranch, branch, headSha, auditPath = null) => ({
    kind: auditPath ? "audit_artifact_committed_pr_missing" : "commit_without_pr",
    repository,
    base_branch: baseBranch,
    branch,
    head_sha: headSha,
    ...(auditPath ? { artifact_path: auditPath } : {}),
    pr_missing: true,
    pr_number: null,
    pr_url: null,
    required_pr_body_marker: pendingMergeMarker(id, headSha),
    accepted_terminal_period: true,
    recovery_status: "manual_pr_creation_required",
    recovery_instruction: MANUAL_PR_RECOVERY_INSTRUCTION,
  });
  const partial = (repository, baseBranch, branch, headSha, pr = null, phase = "commit_without_pr") => ({
    repository,
    base_branch: baseBranch,
    task_branch: branch,
    head_sha: headSha,
    pr_number: pr?.number || null,
    pr_url: pr?.url || null,
    last_completed_phase: phase,
  });

  await t.test("complete", async () => withJobs(async (environment) => {
    const id = "CFT-20260716-180001-AAAABBBB";
    const headSha = "a".repeat(40);
    writeJob(stateFor(id), { environment });
    const events = [
      { type: "thread.started", thread_id: THREAD_ID },
      observedBranchEvent(id),
      ...verifiedPrEvents(id, headSha),
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(completeEnvelope(id, { head_sha: headSha })) } },
      { type: "turn.completed" },
    ];
    await runWorker(id, terminalWorkerOptions(environment, events));
    const pr = { number: 42, url: `https://github.com/${CONTRACT.repository}/pull/42` };
    assert.deepEqual(terminalPublicSnapshot(resultJob(id, { environment })), {
      status: "complete", code: null, phase: "ready_for_quality_gate", validation_error: null,
      partial_evidence: partial(CONTRACT.repository, CONTRACT.base_branch, taskBranchFor(id), headSha, pr, "pr_verified"),
      leftover_resources: [
        branchResidue(CONTRACT.repository, taskBranchFor(id)),
        { kind: "pull_request", repository: CONTRACT.repository, number: 42, url: pr.url, state: "open", draft: false, certification_status: "pending_do_not_merge" },
      ],
    });
  }));

  await t.test("1CDB3BEA approval denial preserves main-thread branch and commit proof", async () => withJobs(async (environment) => {
    const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-1cdb3bea.json"), "utf8"));
    writeJob(stateFor(replay.source_run_id, {
      contract: { ...stateFor(replay.source_run_id).contract, repository: replay.repository, baseBranch: replay.base_branch, taskType: "audit" },
      taskBranch: replay.task_branch,
      auditPath: replay.audit_path,
    }), { environment });
    const events = [
      { type: "thread.started", thread_id: THREAD_ID },
      observedExactBranchHeadEvent(replay.repository, replay.base_branch, replay.task_branch, replay.head_sha),
      completedGithubEvent("fetch_file", replay.repository, {
        path: replay.audit_path, ref: replay.head_sha, encoding: "utf-8",
      }, {
        content: `# Audit\n\n${auditEvidenceBlock({ auditPath: replay.audit_path, contract: { repository: replay.repository, baseBranch: replay.base_branch } }, replay.raw_envelope)}\n`,
        encoding: "utf-8", sha: "f".repeat(40),
      }),
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(replay.raw_envelope) } },
      { type: "turn.completed" },
    ];
    await runWorker(replay.source_run_id, terminalWorkerOptions(environment, events));
    assert.deepEqual(terminalPublicSnapshot(resultJob(replay.source_run_id, { environment })), {
      status: "blocked", code: "GITHUB_WRITE_APPROVAL_DENIED", phase: "blocked", validation_error: null,
      partial_evidence: partial(replay.repository, replay.base_branch, replay.task_branch, replay.head_sha, null, "audit_artifact_committed_pr_missing"),
      leftover_resources: [
        branchResidue(replay.repository, replay.task_branch),
        commitResidue(replay.source_run_id, replay.repository, replay.base_branch, replay.task_branch, replay.head_sha, replay.audit_path),
      ],
    });
  }));

  await t.test("approval timeout preserves the same observed branch and commit", async () => withJobs(async (environment) => {
    const id = "CFT-20260716-180002-CCCCDDDD";
    const headSha = "c".repeat(40);
    const branch = taskBranchFor(id);
    writeJob(stateFor(id), { environment });
    const envelope = completeEnvelope(id, {
      status: "incomplete", reason_code: "GITHUB_WRITE_APPROVAL_TIMEOUT", task_branch: branch,
      head_sha: headSha, pr_number: null, pr_url: null,
    });
    const events = [
      { type: "thread.started", thread_id: THREAD_ID },
      observedExactBranchHeadEvent(CONTRACT.repository, CONTRACT.base_branch, branch, headSha),
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(envelope) } },
      { type: "turn.completed" },
    ];
    await runWorker(id, terminalWorkerOptions(environment, events));
    assert.deepEqual(terminalPublicSnapshot(resultJob(id, { environment })), {
      status: "incomplete", code: "GITHUB_WRITE_APPROVAL_TIMEOUT", phase: "incomplete", validation_error: null,
      partial_evidence: partial(CONTRACT.repository, CONTRACT.base_branch, branch, headSha),
      leftover_resources: [branchResidue(CONTRACT.repository, branch), commitResidue(id, CONTRACT.repository, CONTRACT.base_branch, branch, headSha)],
    });
  }));

  await t.test("F1275700 legacy envelope is hydrated from the verified report and reaches ready", async () => withJobs(async (environment) => {
    const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-f1275700.json"), "utf8"));
    const state = stateFor(replay.source_run_id, {
      contract: { ...stateFor(replay.source_run_id).contract, repository: replay.repository, baseBranch: replay.base_branch, taskType: "audit" },
      taskBranch: replay.task_branch,
      auditPath: replay.audit_path,
    });
    writeJob(state, { environment });
    const marker = pendingMergeMarker(replay.source_run_id, replay.head_sha);
    const pr = {
      url: replay.pr_url, number: replay.pr_number, state: "open", merged: false, draft: false,
      base: replay.base_branch, head: replay.task_branch, head_sha: replay.head_sha, body: marker,
    };
    const report = `# Audit\n\n${auditEvidenceBlock(state, replay.raw_envelope)}\n`;
    const events = [
      { type: "thread.started", thread_id: THREAD_ID },
      completedGithubEvent("create_branch", replay.repository, {
        branch_name: replay.task_branch, sha: replay.audited_sha,
      }, { branch: replay.task_branch }),
      ...replay.raw_envelope.audit_evidence.line_evidence.map((item) => completedGithubEvent("fetch_file", replay.repository, {
        path: item.path, ref: replay.audited_sha, start_line: item.start_line, end_line: item.end_line, encoding: "utf-8",
      }, { content: item.snippet, encoding: "utf-8", sha: "e".repeat(40) })),
      completedGithubEvent("create_file", replay.repository, {
        branch: replay.task_branch, path: replay.audit_path, content: report,
      }, { commit_sha: replay.head_sha }),
      completedGithubEvent("fetch_file", replay.repository, {
        path: replay.audit_path, ref: replay.head_sha, encoding: "utf-8",
      }, { content: report, encoding: "utf-8", sha: "f".repeat(40) }),
      completedGithubEvent("create_pull_request", replay.repository, {
        head: replay.task_branch, base: replay.base_branch, draft: false, body: marker,
      }, pr),
      completedGithubEvent("get_pr_info", replay.repository, { pr_number: replay.pr_number }, pr),
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(replay.raw_envelope) } },
      { type: "turn.completed" },
    ];
    await runWorker(replay.source_run_id, terminalWorkerOptions(environment, events));
    assert.deepEqual(terminalPublicSnapshot(resultJob(replay.source_run_id, { environment })), {
      status: "complete", code: null, phase: "ready_for_quality_gate",
      validation_error: null,
      partial_evidence: partial(replay.repository, replay.base_branch, replay.task_branch, replay.head_sha, pr, "pr_verified"),
      leftover_resources: [
        branchResidue(replay.repository, replay.task_branch),
        { kind: "pull_request", repository: replay.repository, number: replay.pr_number, url: replay.pr_url, state: "open", draft: false, certification_status: "pending_do_not_merge" },
      ],
    });
  }));

  await t.test("AUDIT_EVIDENCE_UNVERIFIED remains directly reachable with observed PR residue", async () => withJobs(async (environment) => {
    const id = "CFT-20260716-180003-EEEEFFFF";
    const auditPath = auditPathFor(id);
    const auditedSha = "d".repeat(40);
    const headSha = "e".repeat(40);
    const state = stateFor(id, { contract: { ...stateFor(id).contract, taskType: "audit" }, auditPath });
    writeJob(state, { environment });
    const reportEnvelope = completeEnvelope(id, {
      head_sha: headSha,
      changes_or_artifacts: [{ artifact: auditPath, kind: "audit_report", evidence: "Report." }],
      audit_evidence: { audited_sha: auditedSha, scope: ["src/a.js"], findings: ["Report finding."], verification: "Fetched.", line_evidence: [{ path: "src/a.js", start_line: 1, end_line: 1, snippet: "const x = 1;" }] },
    });
    const envelope = { ...reportEnvelope, audit_evidence: { ...reportEnvelope.audit_evidence, findings: ["Envelope mismatch."] } };
    const report = `# Audit\n\n${auditEvidenceBlock(state, reportEnvelope)}\n`;
    const events = [
      { type: "thread.started", thread_id: THREAD_ID },
      completedGithubEvent("fetch_file", CONTRACT.repository, { path: "src/a.js", ref: auditedSha, start_line: 1, end_line: 1, encoding: "utf-8" }, { content: "const x = 1;", encoding: "utf-8", sha: "c".repeat(40) }),
      completedGithubEvent("create_file", CONTRACT.repository, {
        branch: taskBranchFor(id), path: auditPath, message: "Add the audit report", content: report,
      }, { commit_sha: headSha }),
      completedGithubEvent("fetch_file", CONTRACT.repository, { path: auditPath, ref: headSha, encoding: "utf-8" }, { content: report, encoding: "utf-8", sha: "b".repeat(40) }),
      ...verifiedPrEvents(id, headSha, { includeCommit: false }),
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(envelope) } },
      { type: "turn.completed" },
    ];
    await runWorker(id, terminalWorkerOptions(environment, events));
    const pr = { number: 42, url: `https://github.com/${CONTRACT.repository}/pull/42` };
    assert.deepEqual(terminalPublicSnapshot(resultJob(id, { environment })), {
      status: "blocked", code: "AUDIT_EVIDENCE_UNVERIFIED", phase: "result_validation",
      validation_error: {
        path: "audit_artifact.evidence_block.audit_evidence.findings[0]",
        rule: "report_block_mismatch",
        expected: "host-observed GitHub evidence satisfying the named rule",
        mismatch: {
          envelope: { preview: "Envelope mismatch.", utf8_bytes: 18, truncated: false, sensitive: false },
          artifact: { preview: "Report finding.", utf8_bytes: 15, truncated: false, sensitive: false },
        },
      },
      partial_evidence: partial(CONTRACT.repository, CONTRACT.base_branch, taskBranchFor(id), headSha, pr, "pr_verified"),
      leftover_resources: [branchResidue(CONTRACT.repository, taskBranchFor(id)), { kind: "pull_request", repository: CONTRACT.repository, number: 42, url: pr.url, state: "open", draft: false, certification_status: "pending_do_not_merge" }],
    });
  }));

  await t.test("GITHUB_PR_IDENTITY_UNVERIFIED preserves the created PR", async () => withJobs(async (environment) => {
    const id = "CFT-20260716-180004-11112222";
    const headSha = "1".repeat(40);
    writeJob(stateFor(id), { environment });
    const createOnly = verifiedPrEvents(id, headSha).slice(0, -1);
    const events = [
      { type: "thread.started", thread_id: THREAD_ID }, ...createOnly,
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(completeEnvelope(id, { head_sha: headSha })) } },
      { type: "turn.completed" },
    ];
    await runWorker(id, terminalWorkerOptions(environment, events));
    const pr = { number: 42, url: `https://github.com/${CONTRACT.repository}/pull/42` };
    assert.deepEqual(terminalPublicSnapshot(resultJob(id, { environment })), {
      status: "blocked", code: "GITHUB_PR_IDENTITY_UNVERIFIED", phase: "result_validation",
      validation_error: { path: "pr_identity", rule: "successful_final_same_pr_fetch_required", expected: "host-observed GitHub evidence satisfying the named rule" },
      partial_evidence: partial(CONTRACT.repository, CONTRACT.base_branch, taskBranchFor(id), headSha, pr, "pr_created"),
      leftover_resources: [branchResidue(CONTRACT.repository, taskBranchFor(id)), { kind: "pull_request", repository: CONTRACT.repository, number: 42, url: pr.url, state: "open", draft: false, certification_status: "pending_do_not_merge" }],
    });
  }));

  await t.test("8DA59548 complete replay reaches ready_for_quality_gate", async () => withJobs(async (environment) => {
    const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-8da59548.json"), "utf8"));
    writeJob(stateFor(replay.source_run_id, {
      contract: { ...stateFor(replay.source_run_id).contract, repository: replay.repository, baseBranch: replay.base_branch },
      taskBranch: replay.task_branch,
    }), { environment });
    const prNumber = 48;
    const prUrl = `https://github.com/${replay.repository}/pull/${prNumber}`;
    const marker = pendingMergeMarker(replay.source_run_id, replay.head_sha);
    const pr = { url: prUrl, number: prNumber, state: "open", merged: false, draft: false, base: replay.base_branch, head: replay.task_branch, head_sha: replay.head_sha, body: marker };
    const envelope = completeEnvelope(replay.source_run_id, {
      repository: replay.repository, base_branch: replay.base_branch, task_branch: replay.task_branch,
      head_sha: replay.head_sha, pr_number: prNumber, pr_url: prUrl,
      resources_consulted: [{ resource: "remote repository", evidence: "Host-observed." }],
      changes_or_artifacts: [{ artifact: "src/a.js", kind: "modified_file", evidence: "Changed." }],
    });
    const events = [
      { type: "thread.started", thread_id: THREAD_ID },
      completedGithubEvent("create_branch", replay.repository, { branch_name: replay.task_branch, base_ref: replay.base_branch }, { branch: replay.task_branch }),
      completedGithubEvent("create_file", replay.repository, {
        branch: replay.task_branch, path: "src/a.js", message: implementationMessage(replay.source_run_id), content: "changed",
      }, { commit_sha: replay.head_sha }),
      completedGithubEvent("create_pull_request", replay.repository, { head: replay.task_branch, base: replay.base_branch, draft: false, body: marker }, pr),
      completedGithubEvent("get_pr_info", replay.repository, { pr_number: prNumber }, pr),
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(envelope) } },
      { type: "turn.completed" },
    ];
    await runWorker(replay.source_run_id, terminalWorkerOptions(environment, events));
    assert.deepEqual(terminalPublicSnapshot(resultJob(replay.source_run_id, { environment })), {
      status: "complete", code: null, phase: "ready_for_quality_gate", validation_error: null,
      partial_evidence: partial(replay.repository, replay.base_branch, replay.task_branch, replay.head_sha, { number: prNumber, url: prUrl }, "pr_verified"),
      leftover_resources: [branchResidue(replay.repository, replay.task_branch), { kind: "pull_request", repository: replay.repository, number: prNumber, url: prUrl, state: "open", draft: false, certification_status: "pending_do_not_merge" }],
    });
  }));

  await t.test("separate JOB_TIMEOUT preserves a host-observed branch and commit", async () => withJobs(async (environment) => {
    const id = "CFT-20260716-180005-33334444";
    const headSha = "3".repeat(40);
    const branch = taskBranchFor(id);
    writeJob(stateFor(id), { environment });
    const child = hungProgressChild([observedExactBranchHeadEvent(CONTRACT.repository, CONTRACT.base_branch, branch, headSha)]);
    await runWorker(id, terminalWorkerOptions(environment, [], { spawnImpl: () => child, timeoutMs: 25 }));
    assert.deepEqual(terminalPublicSnapshot(resultJob(id, { environment })), {
      status: "incomplete", code: "JOB_TIMEOUT", phase: "incomplete", validation_error: null,
      partial_evidence: partial(CONTRACT.repository, CONTRACT.base_branch, branch, headSha),
      leftover_resources: [branchResidue(CONTRACT.repository, branch), commitResidue(id, CONTRACT.repository, CONTRACT.base_branch, branch, headSha)],
    });
  }));
});

test("Bug 4→7→17→20 invariant preserves strongest host observation under every terminal reason", async () => withJobs(async (environment) => {
  const id = "CFT-20260716-180006-55556666";
  const branch = taskBranchFor(id);
  const headSha = "5".repeat(40);
  const prNumber = 55;
  const prUrl = `https://github.com/${CONTRACT.repository}/pull/${prNumber}`;
  const observed = {
    partialEvidence: {
      repository: CONTRACT.repository,
      base_branch: CONTRACT.base_branch,
      task_branch: branch,
      head_sha: headSha,
      pr_number: prNumber,
      pr_url: prUrl,
      last_completed_phase: "pr_verified",
    },
    leftoverResources: [
      { kind: "branch", repository: CONTRACT.repository, name: branch },
      { kind: "pull_request", repository: CONTRACT.repository, number: prNumber, url: prUrl, state: "open", draft: false, certification_status: "pending_do_not_merge" },
    ],
  };
  const scenarios = [
    ["complete", null, "ready_for_quality_gate"],
    ["blocked", "GITHUB_WRITE_APPROVAL_DENIED", "blocked"],
    ["incomplete", "GITHUB_WRITE_APPROVAL_TIMEOUT", "incomplete"],
    ["incomplete", "JOB_TIMEOUT", "incomplete"],
    ["blocked", "CODEX_RESULT_ENVELOPE_INVALID", "result_validation"],
    ["blocked", "AUDIT_EVIDENCE_UNVERIFIED", "result_validation"],
    ["blocked", "GITHUB_PR_IDENTITY_UNVERIFIED", "result_validation"],
    ["blocked", "CUSTOM_UPPER_SNAKE_REASON", "blocked"],
  ];
  for (const [index, [status, code, phase]] of scenarios.entries()) {
    const runId = `${id.slice(0, -8)}${(0x55556666 + index).toString(16).toUpperCase().padStart(8, "0")}`;
    const runBranch = taskBranchFor(runId);
    const runPrUrl = `https://github.com/${CONTRACT.repository}/pull/${prNumber + index}`;
    const fresh = {
      partialEvidence: { ...observed.partialEvidence, task_branch: runBranch, pr_number: prNumber + index, pr_url: runPrUrl },
      leftoverResources: [
        { kind: "branch", repository: CONTRACT.repository, name: runBranch },
        { ...observed.leftoverResources[1], number: prNumber + index, url: runPrUrl },
      ],
    };
    const base = stateFor(runId, { status, phase, publicCode: code, taskBranch: runBranch });
    const merged = mergeTerminalObservation(base, fresh);
    const persisted = mergeTerminalObservation({ ...base, publicEvidence: merged.partialEvidence, leftoverResources: merged.leftoverResources }, { partialEvidence: null, leftoverResources: [] });
    writeJob({ ...base, publicEvidence: persisted.partialEvidence, leftoverResources: persisted.leftoverResources, validationError: null }, { environment });
    const report = resultJob(runId, { environment });
    assert.equal(report.status, status, `${code || "complete"}: status`);
    assert.equal(report.code, code, `${code || "complete"}: code`);
    assert.equal(report.phase, phase, `${code || "complete"}: phase`);
    assert.deepEqual(report.leftover_resources.map((item) => item.kind), ["branch", "pull_request"], `${code || "complete"}: leftovers`);
    assert.equal(report.partial_evidence.last_completed_phase, "pr_verified", `${code || "complete"}: strongest phase`);
    assert.equal(report.partial_evidence.pr_number, prNumber + index, `${code || "complete"}: PR identity`);
  }
}));

test("future audit null envelope is hydrated only from exact host-observed report evidence", async () => withJobs(async (environment) => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-f1275700.json"), "utf8"));
  const state = stateFor(replay.source_run_id, {
    contract: { ...stateFor(replay.source_run_id).contract, repository: replay.repository, baseBranch: replay.base_branch, taskType: "audit" },
    taskBranch: replay.task_branch,
    auditPath: replay.audit_path,
  });
  writeJob(state, { environment });
  const futureEnvelope = { ...replay.raw_envelope, audit_evidence: null };
  const report = `# Audit\n\n${auditEvidenceBlock(state, replay.raw_envelope)}\n`;
  const marker = pendingMergeMarker(replay.source_run_id, replay.head_sha);
  const pr = {
    url: replay.pr_url, number: replay.pr_number, state: "open", merged: false, draft: false,
    base: replay.base_branch, head: replay.task_branch, head_sha: replay.head_sha, body: marker,
  };
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    completedGithubEvent("create_branch", replay.repository, { branch_name: replay.task_branch, sha: replay.audited_sha }, { branch: replay.task_branch }),
    ...replay.raw_envelope.audit_evidence.line_evidence.map((item) => completedGithubEvent("fetch_file", replay.repository, {
      path: item.path, ref: replay.audited_sha, start_line: item.start_line, end_line: item.end_line, encoding: "utf-8",
    }, { content: item.snippet, encoding: "utf-8", sha: "e".repeat(40) })),
    completedGithubEvent("create_file", replay.repository, { branch: replay.task_branch, path: replay.audit_path, content: report }, { commit_sha: replay.head_sha }),
    completedGithubEvent("fetch_file", replay.repository, { path: replay.audit_path, ref: replay.head_sha, encoding: "utf-8" }, { content: report, encoding: "utf-8", sha: "f".repeat(40) }),
    completedGithubEvent("create_pull_request", replay.repository, { head: replay.task_branch, base: replay.base_branch, draft: false, body: marker }, pr),
    completedGithubEvent("get_pr_info", replay.repository, { pr_number: replay.pr_number }, pr),
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(futureEnvelope) } },
    { type: "turn.completed" },
  ];
  await runWorker(replay.source_run_id, terminalWorkerOptions(environment, events));
  const result = resultJob(replay.source_run_id, { environment });
  assert.equal(result.status, "complete");
  assert.equal(result.phase, "ready_for_quality_gate");
  assert.deepEqual(result.result.audit_evidence, replay.raw_envelope.audit_evidence);
  assert.notEqual(result.result.audit_evidence, null);
}));


// --- 1.2.10 approval-denial hardening regressions (PR #2 findings 1-3) ---

test("commit-stage denial reports approval denial, not commit-message invalid, with sanitized detail", async () => withJobs(async (environment) => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-3279bbf5.json"), "utf8"));
  const base = stateFor(replay.source_run_id);
  const state = stateFor(replay.source_run_id, {
    contract: { ...base.contract, repository: replay.repository, baseBranch: replay.base_branch },
    taskBranch: replay.task_branch,
  });
  writeJob(state, { environment });
  const argumentsValue = {
    repository_full_name: replay.repository, branch: replay.task_branch, path: "src/change.js",
    message: implementationMessage(replay.source_run_id),
    content: "must-not-leak", token: "credential-must-not-leak", session_id: "internal-must-not-leak",
  };
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    completedGithubEvent("create_branch", replay.repository,
      { branch_name: replay.task_branch, base_ref: replay.base_branch }, { branch: replay.task_branch }),
    { type: "item.started", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_commit", arguments: argumentsValue } },
    { type: "item.completed", item: {
      type: "mcp_tool_call", server: "codex_apps", tool: "github.create_commit", status: "failed",
      arguments: argumentsValue, error: { message: "Automatic approval denied this request" },
    } },
  ];
  await runWorker(replay.source_run_id, terminalWorkerOptions(environment, events));
  const report = resultJob(replay.source_run_id, { environment });
  assert.equal(report.status, replay.expected_status);
  assert.equal(report.phase, replay.expected_phase);
  assert.equal(report.code, replay.expected_code);
  assert.notEqual(report.code, "IMPLEMENTATION_COMMIT_MESSAGE_INVALID");
  assert.deepEqual(report.partial_evidence.approval_denial_detail, {
    rationale: "runtime_emitted_no_rationale", tool: "create_commit",
    target: { repository: replay.repository, branch: replay.task_branch, path: "src/change.js" },
  });
  const serialized = JSON.stringify(report.partial_evidence.approval_denial_detail);
  assert.doesNotMatch(serialized, /must-not-leak|credential|session_id/);
  // The detail must also survive the MCP-facing projection in server/index.js.
  const mcp = formatJobResult(report).structuredContent;
  assert.deepEqual(mcp.partial_evidence.approval_denial_detail, {
    rationale: "runtime_emitted_no_rationale", tool: "create_commit",
    target: { repository: replay.repository, branch: replay.task_branch, path: "src/change.js" },
  });
}));

test("denial rationale redacts unlabelled credentials and high-entropy values", () => {
  const { approvalFailureObservation, containsSuspiciousSecretLiteral } = require("../server/job-worker");
  const state = { id: "CFT-20260717-204250-3279BBF5", contract: { repository: "ExampleOrg/synthetic-implementation" }, taskBranch: "sol/cft-20260717-204250-3279bbf5" };
  const denial = (error) => approvalFailureObservation({
    type: "item.completed",
    item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_commit", status: "failed", arguments: { path: "src/x.js" }, error },
  }, state);
  // Unlabelled GitHub token embedded in a free-form rationale must not surface.
  assert.equal(denial({ message: "automatic approval denied this request", reason: "content still contains ghp_ABCDEFGHIJKLMNOPQRSTUV" }).detail.rationale, "runtime_emitted_no_rationale");
  // High-entropy blob without a token:/secret: label is treated as suspicious.
  assert.equal(denial({ message: "denied", rationale: "value a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 rejected" }).detail.rationale, "runtime_emitted_no_rationale");
  // Absolute host paths are redacted on Linux, not only macOS/Windows.
  assert.equal(denial({ message: "denied", rationale: "path /home/codex/job/src is out of scope" }).detail.rationale, "runtime_emitted_no_rationale");
  assert.equal(denial({ message: "denied", rationale: "the /tmp/build/output artifact was rejected" }).detail.rationale, "runtime_emitted_no_rationale");
  assert.equal(denial({ message: "denied", rationale: "/workspace/repo/secret.env is not allowed" }).detail.rationale, "runtime_emitted_no_rationale");
  // Single-segment absolute host paths are redacted too.
  assert.equal(denial({ message: "denied", rationale: "wrote to /tmp" }).detail.rationale, "runtime_emitted_no_rationale");
  assert.equal(denial({ message: "denied", rationale: "/workspace is off limits" }).detail.rationale, "runtime_emitted_no_rationale");
  // Quoted or parenthesized absolute host paths are redacted too.
  assert.equal(denial({ message: "denied", rationale: "path \"/home/codex/job/src\" is out of scope" }).detail.rationale, "runtime_emitted_no_rationale");
  assert.equal(denial({ message: "denied", rationale: "blocked (/etc/passwd)" }).detail.rationale, "runtime_emitted_no_rationale");
  // A genuinely benign rationale (including a repo-relative path) is preserved verbatim.
  assert.equal(denial({ message: "denied", rationale: "branch is outside the allowed scope" }).detail.rationale, "branch is outside the allowed scope");
  assert.equal(containsSuspiciousSecretLiteral("ghp_ABCDEFGHIJKLMNOPQRSTUV"), true);
  assert.equal(containsSuspiciousSecretLiteral("outside the allowed scope"), false);
});

test("approval re-request tracker bounds retries for every policy-authorized write tool", () => {
  const { APPROVAL_WRITE_ALLOWLIST, createApprovalRetryTracker } = require("../server/job-worker");
  for (const tool of APPROVAL_WRITE_ALLOWLIST) {
    const tracker = createApprovalRetryTracker();
    const access = `${tool}|ExampleOrg/synthetic-implementation|sol/cft-example|`;
    assert.equal(tracker.started(access), true, `${tool}: first attempt`);
    tracker.denied(access);
    assert.equal(tracker.started(access), true, `${tool}: one bounded retry`);
    tracker.denied(access);
    assert.equal(tracker.started(access), false, `${tool}: fail closed before third`);
  }
  for (const tool of ["create_branch", "create_blob", "create_tree", "update_pull_request"]) {
    assert.equal(APPROVAL_WRITE_ALLOWLIST.includes(tool), true, `${tool} must be tracked`);
  }
});

test("worker fails closed on a third denied re-request for a non-core write tool", async () => withJobs(async (environment) => {
  const id = "CFT-20260717-214541-0883FBF3";
  writeJob(stateFor(id), { environment });
  const branchEvent = (type, status) => ({
    type,
    item: {
      type: "mcp_tool_call", server: "codex_apps", tool: "github.create_branch",
      ...(status ? { status } : {}),
      arguments: { repository_full_name: CONTRACT.repository, branch_name: taskBranchFor(id), base_ref: CONTRACT.base_branch },
      ...(status === "failed" ? { error: { message: "automatic approval denied this request" } } : {}),
    },
  });
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    branchEvent("item.started"),
    branchEvent("item.completed", "failed"),
    branchEvent("item.started"),
    branchEvent("item.completed", "failed"),
    branchEvent("item.started"),
  ];
  await runWorker(id, terminalWorkerOptions(environment, events));
  const report = resultJob(id, { environment });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "GITHUB_WRITE_APPROVAL_DENIED");
}));

test("approval policy and start prompt bind the full write-tool allowlist and re-request marker", () => {
  const { APPROVAL_WRITE_ALLOWLIST } = require("../server/job-worker");
  const state = stateFor("CFT-20260717-214541-0883FBF3");
  const expected = "create_blob, create_branch, create_commit, create_file, create_pull_request, create_tree, update_file, update_pull_request, update_ref";
  assert.deepEqual(APPROVAL_WRITE_ALLOWLIST,
    ["create_blob", "create_branch", "create_commit", "create_file", "create_pull_request", "create_tree", "update_file", "update_pull_request", "update_ref"]);
  const policy = buildAutoReviewPolicy(state);
  assert.equal(policy.includes(expected), true);
  assert.equal(policy.includes(state.taskBranch), true);
  const prompt = buildStartPrompt(state);
  assert.equal(prompt.includes("COWORK_CODEX_APPROVAL_REREQUEST_V1"), true);
  assert.equal(prompt.includes("attempt=2/2"), true);
  assert.equal(prompt.includes(state.id), true);
});

test("an approved-but-invalid mutation is blocked at item.started before it can land", async () => withJobs(async (environment) => {
  const id = "CFT-20260717-214541-0883FBF3";
  writeJob(stateFor(id), { environment });
  const branch = taskBranchFor(id);
  const invalidArgs = { repository_full_name: CONTRACT.repository, branch, path: "src/change.js", message: "not a valid marker message", content: "x" };
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    completedGithubEvent("create_branch", CONTRACT.repository, { branch_name: branch, base_ref: CONTRACT.base_branch }, { branch }),
    { type: "item.started", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_commit", arguments: invalidArgs } },
    // If the child were allowed to proceed past the invalid start, this approved completion would
    // land a malformed commit. The host must stop at item.started, so it is never observed.
    completedGithubEvent("create_commit", CONTRACT.repository, { branch, path: "src/change.js", message: "not a valid marker message", content: "x" }, { commit_sha: "b".repeat(40) }),
  ];
  await runWorker(id, terminalWorkerOptions(environment, events));
  const report = resultJob(id, { environment });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "IMPLEMENTATION_COMMIT_MESSAGE_INVALID");
  assert.equal(report.partial_evidence.last_completed_phase, "branch_created");
}));

test("a timed-out or aborted write is never retried and fails closed", async () => withJobs(async (environment) => {
  for (const [suffix, message, code, status] of [
    ["11112222", "approval timed out", "GITHUB_WRITE_APPROVAL_TIMEOUT", "incomplete"],
    ["33334444", "user cancelled MCP tool call", "GITHUB_WRITE_APPROVAL_ABORTED", "blocked"],
  ]) {
    const id = `CFT-20260717-214541-${suffix}`;
    writeJob(stateFor(id), { environment });
    const branch = taskBranchFor(id);
    const args = { repository_full_name: CONTRACT.repository, branch_name: branch, base_ref: CONTRACT.base_branch };
    const startEvent = { type: "item.started", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_branch", arguments: args } };
    const failEvent = { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_branch", status: "failed", arguments: args, error: { message } } };
    const events = [
      { type: "thread.started", thread_id: THREAD_ID },
      startEvent,
      failEvent,
      // The child re-requests the same write after a timeout/abort; it must never be retried.
      startEvent,
      completedGithubEvent("create_branch", CONTRACT.repository, { branch_name: branch, base_ref: CONTRACT.base_branch }, { branch }),
    ];
    await runWorker(id, terminalWorkerOptions(environment, events));
    const report = resultJob(id, { environment });
    assert.equal(report.status, status);
    assert.equal(report.code, code);
  }
}));

test("a denied path-scoped write with argument-less completions still fails closed on the third attempt", async () => withJobs(async (environment) => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-6b2d9f04.json"), "utf8"));
  const base = stateFor(replay.source_run_id);
  const state = stateFor(replay.source_run_id, {
    contract: { ...base.contract, repository: replay.repository, baseBranch: replay.base_branch },
    taskBranch: replay.task_branch,
  });
  writeJob(state, { environment });
  const startArgs = {
    repository_full_name: replay.repository, branch: replay.task_branch, path: replay.denied_path,
    message: implementationMessage(replay.source_run_id), content: "x",
  };
  const start = { type: "item.started", item: { type: "mcp_tool_call", server: "codex_apps", tool: `github.${replay.denied_tool}`, arguments: startArgs } };
  // The failed completion omits arguments, a shape the runtime already emits.
  const denyNoArgs = { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: `github.${replay.denied_tool}`, status: "failed", error: { message: "automatic approval denied this request" } } };
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    start, denyNoArgs, // first denial
    start, denyNoArgs, // one bounded retry, second denial
    start,             // third attempt must fail closed here, before the event below
    // Without correlating the denial to the started signature, the third start would be allowed and
    // this non-GitHub started event would surface a different terminal code.
    { type: "item.started", item: { type: "mcp_tool_call", server: "imessage", tool: "send" } },
  ];
  await runWorker(replay.source_run_id, terminalWorkerOptions(environment, events));
  const report = resultJob(replay.source_run_id, { environment });
  assert.equal(report.status, replay.expected_status);
  assert.equal(report.code, replay.expected_code);
}));

test("a first-write denial surfaces the sanitized detail without any observed progress", async () => withJobs(async (environment) => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-c1a7e5b8.json"), "utf8"));
  const base = stateFor(replay.source_run_id);
  const state = stateFor(replay.source_run_id, {
    contract: { ...base.contract, repository: replay.repository, baseBranch: replay.base_branch },
    taskBranch: replay.task_branch,
  });
  writeJob(state, { environment });
  const args = { repository_full_name: replay.repository, branch_name: replay.task_branch, base_ref: replay.base_branch };
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "item.started", item: { type: "mcp_tool_call", server: "codex_apps", tool: `github.${replay.denied_tool}`, arguments: args } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: `github.${replay.denied_tool}`, status: "failed", arguments: args, error: { message: "automatic approval denied this request" } } },
  ];
  await runWorker(replay.source_run_id, terminalWorkerOptions(environment, events));
  const report = resultJob(replay.source_run_id, { environment });
  assert.equal(report.status, replay.expected_status);
  assert.equal(report.code, replay.expected_code);
  assert.notEqual(report.partial_evidence, null);
  assert.equal(report.partial_evidence.last_completed_phase, replay.expected_last_completed_phase);
  const expectedDetail = { rationale: replay.expected_denial_rationale, tool: replay.denied_tool, target: { repository: replay.repository, branch: replay.task_branch } };
  assert.deepEqual(report.partial_evidence.approval_denial_detail, expectedDetail);
  // The denial-only evidence must also survive the MCP-facing projection.
  assert.deepEqual(formatJobResult(report).structuredContent.partial_evidence.approval_denial_detail, expectedDetail);
}));

test("two same-tool writes in flight track denials per call, not per tool", async () => withJobs(async (environment) => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-9e4b2a7d.json"), "utf8"));
  const base = stateFor(replay.source_run_id);
  const state = stateFor(replay.source_run_id, {
    contract: { ...base.contract, repository: replay.repository, baseBranch: replay.base_branch },
    taskBranch: replay.task_branch,
  });
  writeJob(state, { environment });
  const startFor = (targetPath, subject) => ({
    type: "item.started",
    item: {
      type: "mcp_tool_call", server: "codex_apps", tool: `github.${replay.denied_tool}`,
      arguments: { repository_full_name: replay.repository, branch: replay.task_branch, path: targetPath, message: implementationMessage(replay.source_run_id, { subject }), content: "x" },
    },
  });
  const denyNoArgs = { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: `github.${replay.denied_tool}`, status: "failed", error: { message: "automatic approval denied this request" } } };
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    startFor(replay.first_path, "Implement scoped correction one"),
    startFor(replay.second_path, "Implement scoped correction two"), // both in flight before any completion
    denyNoArgs, // FIFO -> correlates to first_path
    denyNoArgs, // FIFO -> correlates to second_path
    startFor(replay.first_path, "Implement scoped correction one"), // bounded retry of first_path
    denyNoArgs, // first_path -> denied twice
    startFor(replay.first_path, "Implement scoped correction one"), // third attempt on first_path must fail closed
    // If the first path were mis-tracked (per-tool overwrite), the third start would be allowed and
    // this non-GitHub started event would surface a different terminal code.
    { type: "item.started", item: { type: "mcp_tool_call", server: "imessage", tool: "send" } },
  ];
  await runWorker(replay.source_run_id, terminalWorkerOptions(environment, events));
  const report = resultJob(replay.source_run_id, { environment });
  assert.equal(report.status, replay.expected_status);
  assert.equal(report.code, replay.expected_code);
}));

test("a recovered write does not erase another still-outstanding approval failure", async () => withJobs(async (environment) => {
  const replay = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-3c7f1e62.json"), "utf8"));
  const base = stateFor(replay.source_run_id);
  const state = stateFor(replay.source_run_id, {
    contract: { ...base.contract, repository: replay.repository, baseBranch: replay.base_branch },
    taskBranch: replay.task_branch,
  });
  writeJob(state, { environment });
  const startFor = (targetPath, subject) => ({
    type: "item.started",
    item: {
      type: "mcp_tool_call", server: "codex_apps", tool: "github.create_file",
      arguments: { repository_full_name: replay.repository, branch: replay.task_branch, path: targetPath, message: implementationMessage(replay.source_run_id, { subject }), content: "x" },
    },
  });
  const denyNoArgs = { type: "item.completed", item: { type: "mcp_tool_call", server: "codex_apps", tool: "github.create_file", status: "failed", error: { message: "automatic approval denied this request" } } };
  const successA = completedGithubEvent("create_file", replay.repository,
    { branch: replay.task_branch, path: replay.recovered_path, message: implementationMessage(replay.source_run_id, { subject: "Recovered write" }), content: "x" },
    { commit_sha: "a".repeat(40) });
  const events = [
    { type: "thread.started", thread_id: THREAD_ID },
    startFor(replay.recovered_path, "Recovered write"),
    denyNoArgs,                                          // recovered_path denied once
    startFor(replay.still_denied_path, "Other write"),
    denyNoArgs,                                          // still_denied_path denied once (stays outstanding)
    startFor(replay.recovered_path, "Recovered write"),  // recovered_path retried
    successA,                                            // recovered_path succeeds on its allowed retry
  ];
  await runWorker(replay.source_run_id, terminalWorkerOptions(environment, events));
  const report = resultJob(replay.source_run_id, { environment });
  // The other write's denial is still outstanding, so the terminal must report the approval
  // denial, not fall back to CODEX_RUN_FAILED.
  assert.equal(report.status, replay.expected_status);
  assert.equal(report.code, replay.expected_code);
}));
