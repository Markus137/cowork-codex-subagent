"use strict";

const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PreflightError, getRoles, removeApiKeyEnvironment } = require("./bridge");
const { MANUAL_PR_RECOVERY_INSTRUCTION, pendingMergeMarker } = require("./github-observations");
const { envelopeContext, outcomeForEnvelope, parseAndValidateEnvelope, sanitizePublicExpected, sanitizePublicMismatch } = require("./result-envelope");

const JOB_STATE_ENV = "COWORK_CODEX_PREFLIGHT_JOBS_PATH";
const JOB_ID_PATTERN = /^CFT-[0-9]{8}-[0-9]{6}-[A-F0-9]{8}$/;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const MAX_TEXT = 12_000;
const MAX_ITEM_TEXT = 4_000;
const MAX_ITEMS = 100;
const MAX_FINDINGS = 100;
const MAX_CONTRACT_BYTES = 128 * 1024;
const MAX_FINDINGS_BYTES = 256 * 1024;
const TASK_TYPES = new Set(["implementation", "audit"]);
const TERMINAL_STATES = new Set(["complete", "blocked", "incomplete", "cancelled"]);
const FORBIDDEN_CODEX_ROLE = /(?:claude|anthropic|fable)/i;
const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_MS = 10;
const DEFAULT_WALL_CLOCK_LIMIT_MINUTES = 45;
const MIN_WALL_CLOCK_LIMIT_MINUTES = 15;
const MAX_WALL_CLOCK_LIMIT_MINUTES = 120;

function nowIso() {
  return new Date().toISOString();
}

function fail(code) {
  throw new PreflightError(code);
}

function resolveJobsPath(environment = process.env) {
  const override = environment[JOB_STATE_ENV];
  if (!override) return path.join(os.homedir(), ".config", "cowork-codex-subagent", "jobs");
  if (
    typeof override !== "string" ||
    !path.isAbsolute(override) ||
    path.normalize(override) !== override ||
    path.basename(override) !== "jobs"
  ) fail("JOB_STATE_PATH_INVALID");
  return override;
}

function assertSafeDirectory(directory, create = false) {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("JOB_STATE_UNSAFE");
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    if (error?.code !== "ENOENT") fail("JOB_STATE_UNSAFE");
    if (!create) return;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("JOB_STATE_UNSAFE");
  }
  if (create) fs.chmodSync(directory, 0o700);
}

function jobPath(jobId, environment = process.env) {
  validateJobId(jobId);
  return path.join(resolveJobsPath(environment), `${jobId}.json`);
}

function validateJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) fail("JOB_ID_INVALID");
  return jobId;
}

function validateThreadId(threadId) {
  if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) fail("JOB_THREAD_ID_INVALID");
  return threadId;
}

function validateText(value, code, maximum = MAX_TEXT) {
  if (typeof value !== "string") fail(code);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximum || normalized.includes("\u0000")) fail(code);
  return normalized;
}

function validateTextList(value, code, maximumItems = MAX_ITEMS) {
  if (!Array.isArray(value) || value.length > maximumItems) fail(code);
  return value.map((item) => validateText(item, code, MAX_ITEM_TEXT));
}

function validateCodexRoleBinding(value) {
  const binding = validateText(value, "JOB_ROLE_INVALID", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding) || FORBIDDEN_CODEX_ROLE.test(binding)) {
    fail("JOB_ROLE_INVALID");
  }
  return binding;
}

function validateStartInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("JOB_INPUT_INVALID");
  const allowed = new Set([
    "repository",
    "base_branch",
    "task_type",
    "outcome",
    "scope",
    "constraints",
    "exclusions",
    "acceptance_checks",
    "deliverables",
    "wall_clock_limit_minutes",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("JOB_INPUT_INVALID");
  if (!Object.prototype.hasOwnProperty.call(value, "task_type")) fail("JOB_TASK_TYPE_INVALID");
  const repository = validateText(value.repository, "JOB_REPOSITORY_INVALID", 201);
  if (!REPOSITORY_PATTERN.test(repository)) fail("JOB_REPOSITORY_INVALID");
  const baseBranch = validateText(value.base_branch, "JOB_BASE_BRANCH_INVALID", 200);
  if (!REF_PATTERN.test(baseBranch) || baseBranch.includes("..") || baseBranch.endsWith("/")) {
    fail("JOB_BASE_BRANCH_INVALID");
  }
  const wallClockLimitMinutes = value.wall_clock_limit_minutes === undefined
    ? DEFAULT_WALL_CLOCK_LIMIT_MINUTES
    : value.wall_clock_limit_minutes;
  if (
    !Number.isSafeInteger(wallClockLimitMinutes) ||
    wallClockLimitMinutes < MIN_WALL_CLOCK_LIMIT_MINUTES ||
    wallClockLimitMinutes > MAX_WALL_CLOCK_LIMIT_MINUTES
  ) fail("JOB_WALL_CLOCK_LIMIT_INVALID");
  const contract = {
    repository,
    baseBranch,
    taskType: validateText(value.task_type, "JOB_TASK_TYPE_INVALID", 32),
    outcome: validateText(value.outcome, "JOB_OUTCOME_INVALID"),
    scope: validateText(value.scope, "JOB_SCOPE_INVALID"),
    constraints: validateTextList(value.constraints, "JOB_CONSTRAINTS_INVALID"),
    exclusions: validateTextList(value.exclusions, "JOB_EXCLUSIONS_INVALID"),
    acceptanceChecks: validateTextList(value.acceptance_checks, "JOB_ACCEPTANCE_INVALID"),
    deliverables: validateTextList(value.deliverables, "JOB_DELIVERABLES_INVALID"),
    wallClockLimitMinutes,
  };
  if (!TASK_TYPES.has(contract.taskType)) fail("JOB_TASK_TYPE_INVALID");
  if (Buffer.byteLength(JSON.stringify(contract), "utf8") > MAX_CONTRACT_BYTES) fail("JOB_INPUT_INVALID");
  return contract;
}

function validateFindings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FINDINGS) fail("JOB_FINDINGS_INVALID");
  const findings = value.map((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) fail("JOB_FINDINGS_INVALID");
    const keys = Object.keys(finding).sort();
    if (keys.join(",") !== "body,line,path,url") fail("JOB_FINDINGS_INVALID");
    if (!Number.isSafeInteger(finding.line) || finding.line < 1) fail("JOB_FINDINGS_INVALID");
    return {
      body: validateText(finding.body, "JOB_FINDINGS_INVALID", 65_536),
      url: validateText(finding.url, "JOB_FINDINGS_INVALID", 2_048),
      path: validateText(finding.path, "JOB_FINDINGS_INVALID", 2_048),
      line: finding.line,
    };
  });
  if (Buffer.byteLength(JSON.stringify(findings), "utf8") > MAX_FINDINGS_BYTES) fail("JOB_FINDINGS_INVALID");
  return findings;
}

function makeJobId(date = new Date(), random = randomBytes) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `CFT-${stamp}-${random(4).toString("hex").toUpperCase()}`;
}

function taskBranchFor(jobId) {
  return `sol/${validateJobId(jobId).toLowerCase()}`;
}

function auditPathFor(jobId) {
  return `.github/audits/${validateJobId(jobId).toLowerCase()}.md`;
}

function readJob(jobId, options = {}) {
  const environment = options.environment || process.env;
  const directory = resolveJobsPath(environment);
  assertSafeDirectory(directory, false);
  const filePath = jobPath(jobId, environment);
  let descriptor;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    if (!fs.fstatSync(descriptor).isFile()) fail("JOB_STATE_UNSAFE");
    const state = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!state || state.id !== jobId || state.version !== 1) fail("JOB_STATE_INVALID");
    return state;
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    if (error?.code === "ENOENT") fail("JOB_NOT_FOUND");
    if (error?.code === "ELOOP") fail("JOB_STATE_UNSAFE");
    fail("JOB_STATE_INVALID");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeJob(state, options = {}) {
  const environment = options.environment || process.env;
  const directory = resolveJobsPath(environment);
  assertSafeDirectory(directory, true);
  const filePath = jobPath(state.id, environment);
  try {
    const current = fs.lstatSync(filePath);
    if (current.isSymbolicLink() || !current.isFile()) fail("JOB_STATE_UNSAFE");
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    if (error?.code !== "ENOENT") fail("JOB_STATE_UNSAFE");
  }
  const temporary = path.join(directory, `.${state.id}-${randomBytes(6).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* sanitized below */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* sanitized below */ }
    if (error instanceof PreflightError) throw error;
    fail("JOB_STATE_WRITE_FAILED");
  }
}

function withJobLock(jobId, callback, options = {}) {
  const environment = options.environment || process.env;
  const directory = resolveJobsPath(environment);
  assertSafeDirectory(directory, true);
  const lockPath = path.join(directory, `.${validateJobId(jobId)}.lock`);
  let descriptor;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") fail("JOB_STATE_WRITE_FAILED");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
  if (descriptor === undefined) fail("JOB_STATE_WRITE_FAILED");
  try {
    return callback();
  } finally {
    try { fs.closeSync(descriptor); } catch { /* preserve sanitized state */ }
    try { fs.unlinkSync(lockPath); } catch { /* later mutations fail closed */ }
  }
}

function mutateJob(jobId, mutate, options = {}) {
  const environment = options.environment || process.env;
  return withJobLock(jobId, () => {
    const current = readJob(jobId, { environment });
    const next = mutate(current);
    if (next !== current) writeJob(next, { environment });
    return next;
  }, { environment });
}

function workerScriptPath() {
  return path.join(__dirname, "job-worker.js");
}

function safeLaunchEnvironment(source = process.env) {
  const environment = removeApiKeyEnvironment(source);
  for (const name of Object.keys(environment)) {
    if (/CLAUDE|ANTHROPIC/i.test(name)) delete environment[name];
  }
  return environment;
}

function launchWorker(jobId, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  let child;
  try {
    child = spawnImpl(process.execPath, [workerScriptPath(), jobId], {
      cwd: resolveJobsPath(options.environment || process.env),
      env: safeLaunchEnvironment(options.environment || process.env),
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref?.();
  } catch {
    fail("JOB_WORKER_START_FAILED");
  }
  return child?.pid || null;
}

function effectiveState(state) {
  if (state.result === null || state.result === undefined) return { state, envelope: null };
  let envelope;
  try {
    envelope = parseAndValidateEnvelope(state.result, envelopeContext({
      ...state,
      taskBranch: state.taskBranch || taskBranchFor(state.id),
    }));
  } catch {
    if (!TERMINAL_STATES.has(state.status)) return { state, envelope: null };
    const preservedCode = ["blocked", "incomplete", "cancelled"].includes(state.status) && state.publicCode
      ? state.publicCode
      : state.status === "cancelled" ? "JOB_CANCELLED" : "CODEX_RESULT_ENVELOPE_INVALID";
    return {
      state: {
        ...state,
        status: state.status === "cancelled" ? "cancelled" : "blocked",
        phase: state.status === "cancelled" ? "cancelled" : "result_validation",
        publicCode: preservedCode,
      },
      envelope: null,
    };
  }
  const envelopeOutcome = outcomeForEnvelope(envelope, state.request?.kind);
  const rank = { complete: 0, queued: 0, running: 0, incomplete: 1, blocked: 2, cancelled: 3 };
  const stateRank = rank[state.status] ?? 2;
  const envelopeRank = rank[envelopeOutcome.status] ?? 2;
  if (stateRank > envelopeRank) return { state, envelope: null };
  if (stateRank === envelopeRank && state.status !== "complete") {
    return { state, envelope: !state.publicCode || state.publicCode === envelope.reason_code ? envelope : null };
  }
  return {
    state: {
      ...state,
      status: envelopeOutcome.status,
      phase: envelopeOutcome.phase,
      publicCode: envelopeOutcome.code,
    },
    envelope,
  };
}

function sanitizedValidationError(state) {
  const value = state.validationError;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.path !== "string" || typeof value.rule !== "string") return null;
  if (!/^[A-Za-z0-9_.\[\]-]{1,120}$/.test(value.path) || !/^[a-z0-9_]{1,120}$/.test(value.rule)) return null;
  const mismatch = sanitizePublicMismatch(value.mismatch);
  return {
    path: value.path,
    rule: value.rule,
    expected: sanitizePublicExpected(value.expected),
    ...(mismatch === null ? {} : { mismatch }),
  };
}

function sanitizedApprovalDenialDetail(detail, repository, taskBranch) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const { rationale, tool, target } = detail;
  if (typeof rationale !== "string" || typeof tool !== "string" ||
      !target || typeof target !== "object" || Array.isArray(target) ||
      target.repository !== repository || target.branch !== taskBranch) return null;
  const sanitizedTarget = { repository, branch: taskBranch };
  if (typeof target.path === "string") sanitizedTarget.path = target.path;
  return { rationale, tool, target: sanitizedTarget };
}

function sanitizedPublicEvidence(state) {
  const value = state.publicEvidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const repository = state.contract.repository;
  const baseBranch = state.contract.baseBranch;
  const taskBranch = state.taskBranch;
  const headSha = value.head_sha;
  const prNumber = value.pr_number;
  const prUrl = value.pr_url;
  if (
    value.repository !== repository || value.base_branch !== baseBranch || value.task_branch !== taskBranch ||
    (headSha !== null && (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha))) ||
    (prNumber !== null && (!Number.isSafeInteger(prNumber) || prNumber < 1)) ||
    (prNumber === null ? prUrl !== null : prUrl !== `https://github.com/${repository}/pull/${prNumber}`) ||
    !["branch_created", "branch_or_commit_observed", "commit_observed", "pr_created", "audit_artifact_committed_pr_missing", "commit_without_pr", "pr_verified"].includes(value.last_completed_phase)
  ) return null;
  const sanitized = {
    repository,
    base_branch: baseBranch,
    task_branch: taskBranch,
    head_sha: headSha,
    pr_number: prNumber,
    pr_url: prUrl,
    last_completed_phase: value.last_completed_phase,
  };
  const approvalDenialDetail = sanitizedApprovalDenialDetail(value.approval_denial_detail, repository, taskBranch);
  if (approvalDenialDetail) sanitized.approval_denial_detail = approvalDenialDetail;
  return sanitized;
}

function sanitizedLeftoverResources(state) {
  if (!Array.isArray(state.leftoverResources)) return [];
  if (state.leftoverResources.length < 1 || state.leftoverResources.length > 2) return [];
  const branch = state.leftoverResources[0];
  if (
    branch?.kind !== "branch" || branch.repository !== state.contract.repository ||
    branch.name !== state.taskBranch || Object.keys(branch).sort().join(",") !== "kind,name,repository"
  ) return [];
  const sanitized = [{ kind: "branch", repository: state.contract.repository, name: state.taskBranch }];
  if (state.leftoverResources.length === 1) return sanitized;
  const second = state.leftoverResources[1];
  if (["audit_artifact_committed_pr_missing", "commit_without_pr"].includes(second?.kind)) {
    const expectedKeys = second.kind === "audit_artifact_committed_pr_missing"
      ? "accepted_terminal_period,artifact_path,base_branch,branch,head_sha,kind,pr_missing,pr_number,pr_url,recovery_instruction,recovery_status,repository,required_pr_body_marker"
      : "accepted_terminal_period,base_branch,branch,head_sha,kind,pr_missing,pr_number,pr_url,recovery_instruction,recovery_status,repository,required_pr_body_marker";
    const auditPathValid = second.kind !== "audit_artifact_committed_pr_missing" ||
      (state.contract.taskType === "audit" && second.artifact_path === state.auditPath);
    if (
      second.repository !== state.contract.repository || second.base_branch !== state.contract.baseBranch ||
      second.branch !== state.taskBranch || typeof second.head_sha !== "string" || !/^[0-9a-f]{40}$/.test(second.head_sha) ||
      second.pr_missing !== true || second.pr_number !== null || second.pr_url !== null ||
      second.required_pr_body_marker !== pendingMergeMarker(state.id, second.head_sha) ||
      second.accepted_terminal_period !== true || second.recovery_status !== "manual_pr_creation_required" ||
      second.recovery_instruction !== MANUAL_PR_RECOVERY_INSTRUCTION || !auditPathValid ||
      Object.keys(second).sort().join(",") !== expectedKeys
    ) return [];
    sanitized.push({
      kind: second.kind,
      repository: state.contract.repository,
      base_branch: state.contract.baseBranch,
      branch: state.taskBranch,
      head_sha: second.head_sha,
      ...(second.kind === "audit_artifact_committed_pr_missing" ? { artifact_path: state.auditPath } : {}),
      pr_missing: true,
      pr_number: null,
      pr_url: null,
      required_pr_body_marker: pendingMergeMarker(state.id, second.head_sha),
      accepted_terminal_period: true,
      recovery_status: "manual_pr_creation_required",
      recovery_instruction: MANUAL_PR_RECOVERY_INSTRUCTION,
    });
    return sanitized;
  }
  const pullRequest = second;
  if (
    pullRequest?.kind !== "pull_request" || pullRequest.repository !== state.contract.repository ||
    !Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1 ||
    pullRequest.url !== `https://github.com/${state.contract.repository}/pull/${pullRequest.number}` ||
    pullRequest.state !== "open" || pullRequest.draft !== false ||
    !["pending_do_not_merge", "unverified"].includes(pullRequest.certification_status) ||
    Object.keys(pullRequest).sort().join(",") !== "certification_status,draft,kind,number,repository,state,url"
  ) return [];
  sanitized.push({
    kind: "pull_request",
    repository: state.contract.repository,
    number: pullRequest.number,
    url: pullRequest.url,
    state: "open",
    draft: false,
    certification_status: pullRequest.certification_status,
  });
  return sanitized;
}

function publicStatus(rawState) {
  const { state } = effectiveState(rawState);
  return {
    status: state.status,
    run_id: state.id,
    phase: state.phase,
    repository: state.contract.repository,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    correction_resumes_used: state.resumeCount,
    wall_clock_limit_minutes: Number.isSafeInteger(state.contract.wallClockLimitMinutes) &&
      state.contract.wallClockLimitMinutes >= MIN_WALL_CLOCK_LIMIT_MINUTES &&
      state.contract.wallClockLimitMinutes <= MAX_WALL_CLOCK_LIMIT_MINUTES
      ? state.contract.wallClockLimitMinutes : null,
    code: state.publicCode || null,
    validation_error: sanitizedValidationError(state),
    partial_evidence: sanitizedPublicEvidence(state),
    leftover_resources: sanitizedLeftoverResources(state),
  };
}

function startJob(input, options = {}) {
  const environment = options.environment || process.env;
  const contract = validateStartInput(input);
  const roles = (options.getRolesImpl || getRoles)({ environment }).roles;
  const sol = validateCodexRoleBinding(roles.SOL);
  const terra = validateCodexRoleBinding(roles.Terra);
  const id = (options.makeJobIdImpl || makeJobId)();
  const timestamp = nowIso();
  const state = {
    version: 1,
    id,
    status: "queued",
    phase: "implementation",
    createdAt: timestamp,
    updatedAt: timestamp,
    resumeCount: 0,
    roles: { SOL: sol, Terra: terra },
    taskBranch: taskBranchFor(id),
    auditPath: contract.taskType === "audit" ? auditPathFor(id) : null,
    contract,
    request: { kind: "start" },
    internal: {},
    result: null,
    publicCode: null,
    validationError: null,
    publicEvidence: null,
    leftoverResources: [],
    prCertification: null,
    implementationCommit: null,
  };
  writeJob(state, { environment });
  try {
    (options.launchWorkerImpl || launchWorker)(id, { environment, spawnImpl: options.spawnImpl });
  } catch (error) {
    mutateJob(id, (current) => ({ ...current, status: "blocked", phase: "blocked", publicCode: "JOB_WORKER_START_FAILED", updatedAt: nowIso() }), { environment });
    throw error;
  }
  return publicStatus(readJob(id, { environment }));
}

function statusJob(jobId, options = {}) {
  return publicStatus(readJob(validateJobId(jobId), options));
}

function resultJob(jobId, options = {}) {
  const rawState = readJob(validateJobId(jobId), options);
  const { state, envelope } = effectiveState(rawState);
  const base = publicStatus(state);
  if (!TERMINAL_STATES.has(state.status)) return { ...base, result: null };
  return { ...base, result: envelope };
}

function resumeJob(jobId, findings, options = {}) {
  const environment = options.environment || process.env;
  const id = validateJobId(jobId);
  const immutableFindings = validateFindings(findings);
  const next = mutateJob(id, (state) => {
    if (state.resumeCount !== 0) fail("JOB_RESUME_LIMIT_REACHED");
    const effective = effectiveState(state);
    if (effective.state.status !== "complete" || !effective.envelope || !state.internal?.threadId) fail("JOB_NOT_RESUMABLE");
    const threadId = validateThreadId(state.internal.threadId);
    return {
      ...state,
      status: "queued",
      phase: "correction",
      updatedAt: nowIso(),
      resumeCount: 1,
      request: { kind: "resume", findings: immutableFindings },
      result: null,
      publicCode: null,
      validationError: null,
      publicEvidence: null,
      leftoverResources: [],
      internal: { threadId },
    };
  }, { environment });
  try {
    (options.launchWorkerImpl || launchWorker)(id, { environment, spawnImpl: options.spawnImpl });
  } catch (error) {
    mutateJob(id, (current) => ({ ...current, status: "incomplete", phase: "incomplete", publicCode: "JOB_WORKER_START_FAILED", updatedAt: nowIso() }), { environment });
    throw error;
  }
  return publicStatus(readJob(id, { environment }));
}

function cancelJob(jobId, options = {}) {
  const environment = options.environment || process.env;
  const id = validateJobId(jobId);
  const next = mutateJob(id, (state) => {
    if (TERMINAL_STATES.has(state.status)) return state;
    return { ...state, status: "cancelled", phase: "cancelled", publicCode: "JOB_CANCELLED", result: null, updatedAt: nowIso() };
  }, { environment });
  return publicStatus(next);
}

module.exports = {
  DEFAULT_WALL_CLOCK_LIMIT_MINUTES,
  JOB_ID_PATTERN,
  JOB_STATE_ENV,
  THREAD_ID_PATTERN,
  MAX_CONTRACT_BYTES,
  MAX_FINDINGS,
  MAX_FINDINGS_BYTES,
  MAX_WALL_CLOCK_LIMIT_MINUTES,
  MIN_WALL_CLOCK_LIMIT_MINUTES,
  cancelJob,
  auditPathFor,
  effectiveState,
  jobPath,
  launchWorker,
  makeJobId,
  mutateJob,
  publicStatus,
  readJob,
  resolveJobsPath,
  resultJob,
  resumeJob,
  safeLaunchEnvironment,
  startJob,
  statusJob,
  taskBranchFor,
  validateCodexRoleBinding,
  validateFindings,
  validateJobId,
  validateStartInput,
  validateThreadId,
  writeJob,
};
