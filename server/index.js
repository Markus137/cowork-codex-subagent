#!/usr/bin/env node
"use strict";

const { PLUGIN_VERSION, PreflightError, getHealth, getRoles, runRoundtrip, setRole } = require("./bridge");
const { MANUAL_PR_RECOVERY_INSTRUCTION } = require("./github-observations");
const { evaluateFinalEvidence, evaluateInitialEvidence } = require("./github-review-contract");
const { cancelJob, resultJob, resumeJob, startJob, statusJob } = require("./jobs");
const { ENVELOPE_KEYS, parseAndValidateEnvelope, sanitizePublicExpected, sanitizePublicMismatch } = require("./result-envelope");

const SHA_SCHEMA = { type: "string", pattern: "^[0-9A-Fa-f]{40}$" };
const REACTION_SCHEMA = {
  type: "object",
  properties: {
    kind: { const: "reaction" },
    actor_login: { type: "string", minLength: 1, maxLength: 100 },
    created_at: { type: "string", minLength: 1, maxLength: 64 },
    target_type: { type: "string", enum: ["pull_request", "issue_comment"] },
    target_id: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1, maxLength: 100 }] },
    target_url: { type: "string", minLength: 1, maxLength: 2048 },
    content: { type: "string", enum: ["+1"] },
  },
  required: ["kind", "actor_login", "created_at", "target_type", "target_id", "target_url", "content"],
  additionalProperties: false,
};
const REVIEW_ID_SCHEMA = { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1, maxLength: 100 }] };
const ISSUE_COMMENT_ID_SCHEMA = {
  oneOf: [
    { type: "integer", minimum: 1 },
    { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
  ],
};
const REVIEW_SUBMISSION_SCHEMA = {
  type: "object",
  properties: {
    id: REVIEW_ID_SCHEMA,
    actor_login: { type: "string", minLength: 1, maxLength: 100 },
    created_at: { type: "string", minLength: 1, maxLength: 64 },
    body: { type: "string", minLength: 1, maxLength: 65536 },
  },
  required: ["id", "actor_login", "created_at", "body"],
  additionalProperties: false,
};
const REVIEW_COMMENT_SCHEMA = {
  type: "object",
  properties: {
    pull_request_review_id: REVIEW_ID_SCHEMA,
    actor_login: { type: "string", minLength: 1, maxLength: 100 },
    created_at: { type: "string", minLength: 1, maxLength: 64 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    path: { type: "string", minLength: 1, maxLength: 2048 },
    line: { type: "integer", minimum: 1 },
    body: { type: "string", minLength: 1, maxLength: 65536 },
  },
  required: ["pull_request_review_id", "actor_login", "created_at", "url", "path", "line", "body"],
  additionalProperties: false,
};
const REVIEW_BUNDLE_SCHEMA = {
  type: "object",
  properties: {
    kind: { const: "review_bundle" },
    submission: REVIEW_SUBMISSION_SCHEMA,
    comments: { type: "array", minItems: 0, maxItems: 100, items: REVIEW_COMMENT_SCHEMA },
  },
  required: ["kind", "submission", "comments"],
  additionalProperties: false,
};
const ISSUE_COMMENT_SCHEMA = {
  type: "object",
  properties: {
    kind: { const: "issue_comment" },
    id: ISSUE_COMMENT_ID_SCHEMA,
    actor_login: { type: "string", minLength: 1, maxLength: 100 },
    created_at: { type: "string", minLength: 1, maxLength: 64 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    pr_number: { type: "integer", minimum: 1 },
    pr_url: { type: "string", minLength: 1, maxLength: 2048 },
    body: { type: "string", minLength: 1, maxLength: 65536 },
    review_comments: { type: "array", maxItems: 0 },
  },
  required: ["kind", "id", "actor_login", "created_at", "url", "pr_number", "pr_url", "body", "review_comments"],
  additionalProperties: false,
};
const INITIAL_EVENT_SCHEMA = { oneOf: [REACTION_SCHEMA, REVIEW_BUNDLE_SCHEMA] };
const FINAL_EVENT_SCHEMA = { oneOf: [REACTION_SCHEMA, REVIEW_BUNDLE_SCHEMA, ISSUE_COMMENT_SCHEMA] };
const JOB_ID_SCHEMA = { type: "string", pattern: "^CFT-[0-9]{8}-[0-9]{6}-[A-F0-9]{8}$" };
const TEXT_LIST_SCHEMA = {
  type: "array",
  maxItems: 100,
  items: { type: "string", minLength: 1, maxLength: 4000 },
};
const FINDING_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string", minLength: 1, maxLength: 65536 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    path: { type: "string", minLength: 1, maxLength: 2048 },
    line: { type: "integer", minimum: 1 },
  },
  required: ["body", "url", "path", "line"],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "preflight_health",
    description: "Check the local Codex executable and existing ChatGPT login mode without starting a Codex session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "preflight_codex_roundtrip",
    description: "Run a temporary read-only Codex MCP session and validate deterministic initial and same-session reply checks.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "orchestration_get_roles",
    description: "Read the persistent Fable, SOL, and Terra runtime selectors without exposing the state path.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "orchestration_set_role",
    description: "Persist one allowlisted Fable, SOL, or Terra runtime selector in the user-level role state.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["Fable", "SOL", "Terra"] },
        binding: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        },
      },
      required: ["role", "binding"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_codex_start",
    description: "Queue one Cowork-native, host-side SOL job. Codex uses GitHub MCP only and returns passively; no executable, cwd, model, flags, environment, or callback is caller-selectable.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$" },
        base_branch: { type: "string", minLength: 1, maxLength: 200 },
        task_type: { type: "string", enum: ["implementation", "audit"] },
        outcome: { type: "string", minLength: 1, maxLength: 12000 },
        scope: { type: "string", minLength: 1, maxLength: 12000 },
        constraints: TEXT_LIST_SCHEMA,
        exclusions: TEXT_LIST_SCHEMA,
        acceptance_checks: TEXT_LIST_SCHEMA,
        deliverables: TEXT_LIST_SCHEMA,
        wall_clock_limit_minutes: { type: "integer", minimum: 15, maximum: 120, default: 45 },
      },
      required: ["repository", "base_branch", "task_type", "outcome", "scope", "constraints", "exclusions", "acceptance_checks", "deliverables"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_codex_status",
    description: "Read sanitized status for one host-side Codex job. Never returns process, path, prompt, stream, credential, or internal session data.",
    inputSchema: {
      type: "object",
      properties: { job_id: JOB_ID_SCHEMA },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_codex_result",
    description: "Return the bounded passive final response for a terminal Codex job, or null while it is still running.",
    inputSchema: {
      type: "object",
      properties: { job_id: JOB_ID_SCHEMA },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_codex_resume",
    description: "Resume the same SOL session exactly once with immutable GitHub review findings for the single permitted correction pass.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: JOB_ID_SCHEMA,
        findings: { type: "array", minItems: 1, maxItems: 100, items: FINDING_SCHEMA },
      },
      required: ["job_id", "findings"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_codex_cancel",
    description: "Cancel one queued or running host-side Codex job without returning internal process information.",
    inputSchema: {
      type: "object",
      properties: { job_id: JOB_ID_SCHEMA },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_validate_initial_review_evidence",
    description: "Validate already-read GitHub Automatic-review metadata without network or repository access.",
    inputSchema: {
      type: "object",
      properties: {
        ready_at: { type: "string", minLength: 1, maxLength: 64 },
        expected_head_sha: SHA_SCHEMA,
        current_head_sha: SHA_SCHEMA,
        known_commit_shas: { type: "array", minItems: 1, maxItems: 1000, items: SHA_SCHEMA },
        head_change_events_since_ready_at: { type: "integer", minimum: 0 },
        pr_number: { type: "integer", minimum: 1 },
        pr_url: { type: "string", minLength: 1, maxLength: 2048 },
        event: INITIAL_EVENT_SCHEMA,
      },
      required: ["ready_at", "expected_head_sha", "current_head_sha", "known_commit_shas", "head_change_events_since_ready_at", "pr_number", "pr_url", "event"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_validate_final_review_evidence",
    description: "Validate already-read GitHub final-review metadata without network or repository access.",
    inputSchema: {
      type: "object",
      properties: {
        final_trigger_comment_id: ISSUE_COMMENT_ID_SCHEMA,
        final_trigger_url: { type: "string", minLength: 1, maxLength: 2048 },
        final_trigger_created_at: { type: "string", minLength: 1, maxLength: 64 },
        expected_head_sha: SHA_SCHEMA,
        current_head_sha: SHA_SCHEMA,
        known_commit_shas: { type: "array", minItems: 1, maxItems: 1000, items: SHA_SCHEMA },
        head_change_events_since_final_trigger: { type: "integer", minimum: 0 },
        pr_number: { type: "integer", minimum: 1 },
        pr_url: { type: "string", minLength: 1, maxLength: 2048 },
        event: FINAL_EVENT_SCHEMA,
      },
      required: ["final_trigger_comment_id", "final_trigger_url", "final_trigger_created_at", "expected_head_sha", "current_head_sha", "known_commit_shas", "head_change_events_since_final_trigger", "pr_number", "pr_url", "event"],
      additionalProperties: false,
    },
  },
];

function formatToolResult(report, label) {
  const passed = report.status === "passed" || report.status === "ok";
  return {
    content: [{ type: "text", text: passed ? `${label}: passed.` : `${label}: unavailable or failed.` }],
    structuredContent: report,
    isError: !passed,
  };
}

function sanitizedToolFailure() {
  return {
    content: [{ type: "text", text: "Codex preflight: unavailable or failed." }],
    structuredContent: { status: "failed", code: "PREFLIGHT_TOOL_FAILED" },
    isError: true,
  };
}

function sanitizedRoleFailure(error) {
  const allowedCodes = new Set([
    "ROLE_INVALID",
    "ROLE_BINDING_INVALID",
    "ROLE_STATE_INVALID",
    "ROLE_STATE_PATH_INVALID",
    "ROLE_STATE_UNSAFE",
    "ROLE_STATE_WRITE_FAILED",
  ]);
  const code = error instanceof PreflightError && allowedCodes.has(error.code) ? error.code : "ROLE_TOOL_FAILED";
  return {
    content: [{ type: "text", text: "Role state update: unavailable or failed." }],
    structuredContent: { status: "failed", code },
    isError: true,
  };
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function projectApprovalDenialDetail(value, repository, taskBranch) {
  if (!plainObject(value)) return null;
  const { rationale, tool, target } = value;
  if (typeof rationale !== "string" || Buffer.byteLength(rationale, "utf8") > 1024 || /[\u0000-\u001f\u007f]/.test(rationale)) return null;
  if (typeof tool !== "string" || !/^[a-z_]{1,40}$/.test(tool)) return null;
  if (!plainObject(target) || target.repository !== repository || target.branch !== taskBranch) return null;
  const projectedTarget = { repository, branch: taskBranch };
  if (target.path !== undefined) {
    if (typeof target.path !== "string" || Buffer.byteLength(target.path, "utf8") > 512 || target.path.startsWith("/") ||
        target.path.includes("\\") || /[\u0000-\u001f\u007f]/.test(target.path) ||
        target.path.split("/").some((part) => !part || part === "." || part === "..")) return null;
    projectedTarget.path = target.path;
  }
  return { rationale, tool, target: projectedTarget };
}

function projectPartialEvidence(value) {
  if (!plainObject(value)) return null;
  const repository = typeof value.repository === "string" && /^[A-Za-z0-9_.-]{1,100}\/[-A-Za-z0-9_.]{1,100}$/.test(value.repository) ? value.repository : null;
  const baseBranch = typeof value.base_branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(value.base_branch) ? value.base_branch : null;
  const taskBranch = typeof value.task_branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(value.task_branch) ? value.task_branch : null;
  const headSha = value.head_sha === null || (typeof value.head_sha === "string" && /^[0-9a-f]{40}$/.test(value.head_sha)) ? value.head_sha : undefined;
  const prNumber = value.pr_number === null || (Number.isSafeInteger(value.pr_number) && value.pr_number > 0) ? value.pr_number : undefined;
  const prUrl = prNumber === null ? value.pr_url === null ? null : undefined
    : typeof value.pr_url === "string" && value.pr_url === `https://github.com/${repository}/pull/${prNumber}` ? value.pr_url : undefined;
  const phases = new Set(["branch_created", "branch_or_commit_observed", "commit_observed", "pr_created", "audit_artifact_committed_pr_missing", "commit_without_pr", "pr_verified"]);
  if (!repository || !baseBranch || !taskBranch) return null;
  const approvalDenialDetail = projectApprovalDenialDetail(value.approval_denial_detail, repository, taskBranch);
  // Denial-only shape: no trusted progress evidence, but a validated denial detail is present
  // (for example a first-write denial before any branch was observed).
  if (value.last_completed_phase === null && value.head_sha === null && value.pr_number === null && value.pr_url === null && approvalDenialDetail) {
    return { repository, base_branch: baseBranch, task_branch: taskBranch, head_sha: null, pr_number: null, pr_url: null, last_completed_phase: null, approval_denial_detail: approvalDenialDetail };
  }
  if (headSha === undefined || prNumber === undefined || prUrl === undefined || !phases.has(value.last_completed_phase)) return null;
  const projected = { repository, base_branch: baseBranch, task_branch: taskBranch, head_sha: headSha, pr_number: prNumber, pr_url: prUrl, last_completed_phase: value.last_completed_phase };
  if (approvalDenialDetail) projected.approval_denial_detail = approvalDenialDetail;
  return projected;
}

function projectLeftoverResources(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((resource) => {
    if (!plainObject(resource) || typeof resource.repository !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[-A-Za-z0-9_.]{1,100}$/.test(resource.repository)) return [];
    if (resource.kind === "branch" && typeof resource.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(resource.name)) {
      return [{ kind: "branch", repository: resource.repository, name: resource.name }];
    }
    if (resource.kind === "pull_request" && Number.isSafeInteger(resource.number) && resource.number > 0 &&
      resource.url === `https://github.com/${resource.repository}/pull/${resource.number}` && resource.state === "open" && resource.draft === false &&
      ["pending_do_not_merge", "unverified"].includes(resource.certification_status)) {
      return [{ kind: "pull_request", repository: resource.repository, number: resource.number, url: resource.url, state: "open", draft: false, certification_status: resource.certification_status }];
    }
    if (["audit_artifact_committed_pr_missing", "commit_without_pr"].includes(resource.kind) &&
      typeof resource.base_branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(resource.base_branch) &&
      typeof resource.branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(resource.branch) &&
      typeof resource.head_sha === "string" && /^[0-9a-f]{40}$/.test(resource.head_sha) && resource.pr_missing === true &&
      resource.pr_number === null && resource.pr_url === null && typeof resource.required_pr_body_marker === "string" &&
      /^COWORK_CODEX_GATE_V1 \| run_id=CFT-[0-9]{8}-[0-9]{6}-[A-F0-9]{8} \| head_sha=[0-9a-f]{40} \| PENDING \/ DO NOT MERGE$/.test(resource.required_pr_body_marker) &&
      resource.accepted_terminal_period === true && resource.recovery_status === "manual_pr_creation_required" &&
      resource.recovery_instruction === MANUAL_PR_RECOVERY_INSTRUCTION &&
      (resource.kind !== "audit_artifact_committed_pr_missing" || (typeof resource.artifact_path === "string" && /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[^\u0000]{1,2048}$/.test(resource.artifact_path)))) {
      return [{
        kind: resource.kind, repository: resource.repository, base_branch: resource.base_branch, branch: resource.branch, head_sha: resource.head_sha,
        ...(resource.kind === "audit_artifact_committed_pr_missing" ? { artifact_path: resource.artifact_path } : {}),
        pr_missing: true, pr_number: null, pr_url: null, required_pr_body_marker: resource.required_pr_body_marker,
        accepted_terminal_period: true, recovery_status: "manual_pr_creation_required", recovery_instruction: MANUAL_PR_RECOVERY_INSTRUCTION,
      }];
    }
    return [];
  }).slice(0, 2);
}

function projectResultEnvelope(value) {
  if (value === null) return null;
  if (!plainObject(value) || Object.keys(value).sort().join("\n") !== ENVELOPE_KEYS.join("\n")) return null;
  const auditArtifact = Array.isArray(value.changes_or_artifacts)
    ? value.changes_or_artifacts.find((item) => plainObject(item) && item.kind === "audit_report" && typeof item.artifact === "string") : null;
  try {
    return parseAndValidateEnvelope(value, {
      runId: value.run_id,
      repository: value.repository,
      baseBranch: value.base_branch,
      taskBranch: value.task_branch,
      taskType: value.audit_evidence !== null || auditArtifact ? "audit" : "implementation",
      auditPath: auditArtifact?.artifact || null,
    });
  } catch {
    return null;
  }
}

function projectPublicJobReport(report) {
  const value = plainObject(report) ? report : {};
  const validValidationError = plainObject(value.validation_error) &&
    typeof value.validation_error.path === "string" && /^[A-Za-z0-9_.\[\]-]{1,120}$/.test(value.validation_error.path) &&
    typeof value.validation_error.rule === "string" && /^[a-z0-9_]{1,120}$/.test(value.validation_error.rule);
  const safeMismatch = sanitizePublicMismatch(value.validation_error?.mismatch);
  const safeValidationError = validValidationError ? {
    path: value.validation_error.path,
    rule: value.validation_error.rule,
    expected: sanitizePublicExpected(value.validation_error.expected),
    ...(safeMismatch === null ? {} : { mismatch: safeMismatch }),
  } : null;
  const projected = {
    status: typeof value.status === "string" && /^[a-z_]{1,40}$/.test(value.status) ? value.status : "blocked",
    run_id: typeof value.run_id === "string" && /^CFT-[0-9]{8}-[0-9]{6}-[A-F0-9]{8}$/.test(value.run_id) ? value.run_id : null,
    phase: typeof value.phase === "string" && /^[a-z_]{1,80}$/.test(value.phase) ? value.phase : "unknown",
    repository: typeof value.repository === "string" && /^[A-Za-z0-9_.-]{1,100}\/[-A-Za-z0-9_.]{1,100}$/.test(value.repository) ? value.repository : null,
    created_at: typeof value.created_at === "string" && value.created_at.length <= 64 ? value.created_at : null,
    updated_at: typeof value.updated_at === "string" && value.updated_at.length <= 64 ? value.updated_at : null,
    correction_resumes_used: Number.isSafeInteger(value.correction_resumes_used) && value.correction_resumes_used >= 0 ? value.correction_resumes_used : 0,
    wall_clock_limit_minutes: value.wall_clock_limit_minutes === null || (Number.isSafeInteger(value.wall_clock_limit_minutes) && value.wall_clock_limit_minutes >= 15 && value.wall_clock_limit_minutes <= 120) ? value.wall_clock_limit_minutes : null,
    code: value.code === null || (typeof value.code === "string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(value.code)) ? value.code : null,
    validation_error: safeValidationError,
    partial_evidence: projectPartialEvidence(value.partial_evidence),
    leftover_resources: projectLeftoverResources(value.leftover_resources),
  };
  if (Object.prototype.hasOwnProperty.call(value, "result")) projected.result = projectResultEnvelope(value.result);
  return projected;
}

function formatJobResult(report) {
  const publicReport = projectPublicJobReport(report);
  const status = publicReport.status;
  const code = publicReport.code || "none";
  const phase = publicReport.phase;
  const safeValidationError = publicReport.validation_error;
  const validation = safeValidationError
    ? `${safeValidationError.path}:${safeValidationError.rule};expected=${safeValidationError.expected}${safeValidationError.mismatch ? `;mismatch=${JSON.stringify(safeValidationError.mismatch)}` : ""}` : "none";
  const partial = publicReport.partial_evidence;
  const partialEvidence = partial && typeof partial.task_branch === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(partial.task_branch)
    ? `branch:${partial.task_branch};head:${typeof partial.head_sha === "string" && /^[0-9a-f]{40}$/.test(partial.head_sha) ? partial.head_sha : "none"};pr:${Number.isSafeInteger(partial.pr_number) && partial.pr_number > 0 ? partial.pr_number : "none"}`
    : "none";
  const residues = publicReport.leftover_resources.flatMap((resource) => {
    if (resource?.kind === "branch" && typeof resource.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(resource.name)) {
      return [`branch:${resource.name}`];
    }
    if (
      resource?.kind === "pull_request" && typeof resource.repository === "string" &&
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(resource.repository) &&
      Number.isSafeInteger(resource.number) && resource.number > 0 && resource.state === "open" && resource.draft === false &&
      ["pending_do_not_merge", "unverified"].includes(resource.certification_status)
    ) return [`pr:${resource.repository}#${resource.number}:open:non-draft:${resource.certification_status}`];
    if (
      ["audit_artifact_committed_pr_missing", "commit_without_pr"].includes(resource?.kind) &&
      typeof resource.repository === "string" &&
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(resource.repository) &&
      typeof resource.branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(resource.branch) &&
      typeof resource.head_sha === "string" && /^[0-9a-f]{40}$/.test(resource.head_sha) &&
      resource.pr_missing === true && resource.recovery_status === "manual_pr_creation_required"
    ) return [`${resource.kind === "audit_artifact_committed_pr_missing" ? "audit_commit" : "commit"}:${resource.repository}@${resource.branch}#${resource.head_sha}:pr=missing:recovery=manual_pr_creation_required`];
    return [];
  }).slice(0, 2).join("|") || "none";
  return {
    content: [{ type: "text", text: `Codex host job: status=${status}; code=${code}; phase=${phase}; validation_error=${validation}; partial_evidence=${partialEvidence}; leftover_resources=${residues}.` }],
    structuredContent: publicReport,
    isError: false,
  };
}

function sanitizedJobFailure(error) {
  const allowedCodes = new Set([
    "JOB_ID_INVALID",
    "JOB_INPUT_INVALID",
    "JOB_REPOSITORY_INVALID",
    "JOB_BASE_BRANCH_INVALID",
    "JOB_TASK_TYPE_INVALID",
    "JOB_OUTCOME_INVALID",
    "JOB_SCOPE_INVALID",
    "JOB_CONSTRAINTS_INVALID",
    "JOB_EXCLUSIONS_INVALID",
    "JOB_ACCEPTANCE_INVALID",
    "JOB_DELIVERABLES_INVALID",
    "JOB_WALL_CLOCK_LIMIT_INVALID",
    "JOB_ROLE_INVALID",
    "JOB_THREAD_ID_INVALID",
    "JOB_FINDINGS_INVALID",
    "JOB_NOT_FOUND",
    "JOB_NOT_RESUMABLE",
    "JOB_RESUME_LIMIT_REACHED",
    "JOB_STATE_PATH_INVALID",
    "JOB_STATE_UNSAFE",
    "JOB_STATE_INVALID",
    "JOB_STATE_WRITE_FAILED",
    "JOB_WORKER_START_FAILED",
  ]);
  const code = error instanceof PreflightError && allowedCodes.has(error.code) ? error.code : "JOB_TOOL_FAILED";
  return {
    content: [{ type: "text", text: "Codex host job request was rejected or unavailable." }],
    structuredContent: { status: "blocked", code },
    isError: true,
  };
}

function formatEvidenceResult(result) {
  return {
    content: [{ type: "text", text: result.accepted ? "GitHub review evidence: accepted." : "GitHub review evidence: not accepted." }],
    structuredContent: result,
    isError: false,
  };
}

function sanitizedEvidenceFailure() {
  return formatEvidenceResult({
    accepted: false,
    verdict: "not_accepted",
    priorities: [],
    findings: [],
    reason: "EVIDENCE_INPUT_INVALID",
  });
}

function hasOnlyKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function validIssueCommentId(id) {
  return (Number.isSafeInteger(id) && id > 0) || (typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id));
}

function mapEvent(value, allowIssueComment = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const validReviewId = (id) => (Number.isSafeInteger(id) && id > 0) || (typeof id === "string" && id.length > 0 && id.length <= 100);
  if (value.kind === "reaction") {
    if (!hasOnlyKeys(value, ["actor_login", "content", "created_at", "kind", "target_id", "target_type", "target_url"]) || typeof value.actor_login !== "string" || typeof value.created_at !== "string") throw new Error("invalid");
    return { kind: "reaction", actorLogin: value.actor_login, createdAt: value.created_at, targetType: value.target_type, targetId: value.target_id, targetUrl: value.target_url, content: value.content };
  }
  if (value.kind === "issue_comment") {
    if (
      !allowIssueComment ||
      !hasOnlyKeys(value, ["actor_login", "body", "created_at", "id", "kind", "pr_number", "pr_url", "review_comments", "url"]) ||
      !validIssueCommentId(value.id) || typeof value.actor_login !== "string" || typeof value.created_at !== "string" ||
      typeof value.url !== "string" || !Number.isSafeInteger(value.pr_number) || value.pr_number < 1 ||
      typeof value.pr_url !== "string" || typeof value.body !== "string" ||
      !Array.isArray(value.review_comments) || value.review_comments.length !== 0
    ) throw new Error("invalid");
    return {
      kind: "issue_comment",
      id: value.id,
      actorLogin: value.actor_login,
      createdAt: value.created_at,
      url: value.url,
      prNumber: value.pr_number,
      prUrl: value.pr_url,
      body: value.body,
      reviewComments: [],
    };
  }
  if (value.kind !== "review_bundle" || !hasOnlyKeys(value, ["comments", "kind", "submission"])) throw new Error("invalid");
  const submission = value.submission;
  if (!hasOnlyKeys(submission, ["actor_login", "body", "created_at", "id"]) || !validReviewId(submission.id) || typeof submission.actor_login !== "string" || typeof submission.created_at !== "string" || typeof submission.body !== "string") throw new Error("invalid");
  if (!Array.isArray(value.comments) || value.comments.length > 100) throw new Error("invalid");
  const comments = value.comments.map((comment) => {
    if (!hasOnlyKeys(comment, ["actor_login", "body", "created_at", "line", "path", "pull_request_review_id", "url"]) || !validReviewId(comment.pull_request_review_id) || typeof comment.actor_login !== "string" || typeof comment.created_at !== "string" || typeof comment.body !== "string" || typeof comment.url !== "string" || typeof comment.path !== "string" || !Number.isSafeInteger(comment.line) || comment.line < 1) throw new Error("invalid");
    return { pullRequestReviewId: comment.pull_request_review_id, actorLogin: comment.actor_login, createdAt: comment.created_at, url: comment.url, path: comment.path, line: comment.line, body: comment.body };
  });
  return { kind: "review_bundle", submission: { id: submission.id, actorLogin: submission.actor_login, createdAt: submission.created_at, body: submission.body }, comments };
}

function validShaList(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 1000 && value.every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha));
}

function mapInitialEvidenceInput(value) {
  const keys = ["current_head_sha", "event", "expected_head_sha", "head_change_events_since_ready_at", "known_commit_shas", "pr_number", "pr_url", "ready_at"];
  if (!hasOnlyKeys(value, keys) || !validShaList(value.known_commit_shas) || !Number.isSafeInteger(value.pr_number) || value.pr_number < 1 || !Number.isSafeInteger(value.head_change_events_since_ready_at) || value.head_change_events_since_ready_at < 0) throw new Error("invalid");
  return {
    context: {
      readyAt: value.ready_at,
      expectedHeadSha: value.expected_head_sha,
      currentHeadSha: value.current_head_sha,
      knownCommitShas: value.known_commit_shas,
      headChangeEventsSinceBoundary: value.head_change_events_since_ready_at,
      prNumber: value.pr_number,
      prUrl: value.pr_url,
    },
    event: mapEvent(value.event, false),
  };
}

function mapFinalEvidenceInput(value) {
  const keys = ["current_head_sha", "event", "expected_head_sha", "final_trigger_comment_id", "final_trigger_created_at", "final_trigger_url", "head_change_events_since_final_trigger", "known_commit_shas", "pr_number", "pr_url"];
  if (!hasOnlyKeys(value, keys) || !validIssueCommentId(value.final_trigger_comment_id) || !validShaList(value.known_commit_shas) || !Number.isSafeInteger(value.pr_number) || value.pr_number < 1 || !Number.isSafeInteger(value.head_change_events_since_final_trigger) || value.head_change_events_since_final_trigger < 0) throw new Error("invalid");
  return {
    context: {
      finalTriggerCommentId: value.final_trigger_comment_id,
      finalTriggerUrl: value.final_trigger_url,
      finalTriggerCreatedAt: value.final_trigger_created_at,
      expectedHeadSha: value.expected_head_sha,
      currentHeadSha: value.current_head_sha,
      knownCommitShas: value.known_commit_shas,
      headChangeEventsSinceBoundary: value.head_change_events_since_final_trigger,
      prNumber: value.pr_number,
      prUrl: value.pr_url,
    },
    event: mapEvent(value.event, true),
  };
}

function createRequestHandler(options = {}) {
  const send = options.send || ((message) => process.stdout.write(`${JSON.stringify(message)}\n`));
  const getHealthImpl = options.getHealthImpl || getHealth;
  const getRolesImpl = options.getRolesImpl || getRoles;
  const runRoundtripImpl = options.runRoundtripImpl || runRoundtrip;
  const setRoleImpl = options.setRoleImpl || setRole;
  const startJobImpl = options.startJobImpl || startJob;
  const statusJobImpl = options.statusJobImpl || statusJob;
  const resultJobImpl = options.resultJobImpl || resultJob;
  const resumeJobImpl = options.resumeJobImpl || resumeJob;
  const cancelJobImpl = options.cancelJobImpl || cancelJob;
  const response = (id, result) => send({ jsonrpc: "2.0", id, result });
  const errorResponse = (id, code, message) =>
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  async function handle(request) {
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      errorResponse(request?.id, -32600, "Invalid JSON-RPC request.");
      return;
    }
    const isNotification = !Object.prototype.hasOwnProperty.call(request, "id");
    if (request.method === "notifications/initialized") return;
    if (request.method === "initialize") {
      if (!isNotification) {
        response(request.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "cowork-codex-subagent", version: PLUGIN_VERSION },
        });
      }
      return;
    }
    if (request.method === "tools/list") {
      if (!isNotification) response(request.id, { tools: TOOLS });
      return;
    }
    if (request.method === "tools/call") {
      try {
        const toolName = request.params?.name;
        if (toolName === "preflight_health") {
          const report = await getHealthImpl();
          if (!isNotification) response(request.id, formatToolResult(report, "Codex preflight health"));
          return;
        }
        if (toolName === "preflight_codex_roundtrip") {
          const report = await runRoundtripImpl();
          if (!isNotification) response(request.id, formatToolResult(report, "Codex preflight roundtrip"));
          return;
        }
        if (toolName === "orchestration_get_roles") {
          const args = request.params?.arguments ?? {};
          if (!hasOnlyKeys(args, [])) throw new PreflightError("ROLE_INVALID");
          const report = await getRolesImpl();
          if (!isNotification) response(request.id, formatToolResult(report, "Role state"));
          return;
        }
        if (toolName === "orchestration_set_role") {
          const args = request.params?.arguments;
          if (!hasOnlyKeys(args, ["binding", "role"])) throw new PreflightError("ROLE_INVALID");
          const report = await setRoleImpl(args.role, args.binding);
          if (!isNotification) response(request.id, formatToolResult(report, "Role state update"));
          return;
        }
        if (toolName === "orchestration_codex_start") {
          const report = await startJobImpl(request.params?.arguments);
          if (!isNotification) response(request.id, formatJobResult(report));
          return;
        }
        if (toolName === "orchestration_codex_status") {
          const args = request.params?.arguments;
          if (!hasOnlyKeys(args, ["job_id"])) throw new PreflightError("JOB_INPUT_INVALID");
          const report = await statusJobImpl(args.job_id);
          if (!isNotification) response(request.id, formatJobResult(report));
          return;
        }
        if (toolName === "orchestration_codex_result") {
          const args = request.params?.arguments;
          if (!hasOnlyKeys(args, ["job_id"])) throw new PreflightError("JOB_INPUT_INVALID");
          const report = await resultJobImpl(args.job_id);
          if (!isNotification) response(request.id, formatJobResult(report));
          return;
        }
        if (toolName === "orchestration_codex_resume") {
          const args = request.params?.arguments;
          if (!hasOnlyKeys(args, ["findings", "job_id"])) throw new PreflightError("JOB_INPUT_INVALID");
          const report = await resumeJobImpl(args.job_id, args.findings);
          if (!isNotification) response(request.id, formatJobResult(report));
          return;
        }
        if (toolName === "orchestration_codex_cancel") {
          const args = request.params?.arguments;
          if (!hasOnlyKeys(args, ["job_id"])) throw new PreflightError("JOB_INPUT_INVALID");
          const report = await cancelJobImpl(args.job_id);
          if (!isNotification) response(request.id, formatJobResult(report));
          return;
        }
        if (toolName === "orchestration_validate_initial_review_evidence") {
          const { context, event } = mapInitialEvidenceInput(request.params?.arguments);
          if (!isNotification) response(request.id, formatEvidenceResult(evaluateInitialEvidence(context, event)));
          return;
        }
        if (toolName === "orchestration_validate_final_review_evidence") {
          const { context, event } = mapFinalEvidenceInput(request.params?.arguments);
          if (!isNotification) response(request.id, formatEvidenceResult(evaluateFinalEvidence(context, event)));
          return;
        }
        if (!isNotification) errorResponse(request.id, -32602, "Unknown preflight tool.");
      } catch (error) {
        if (!isNotification) {
          response(
            request.id,
            String(request.params?.name || "").startsWith("orchestration_validate_")
              ? sanitizedEvidenceFailure()
              : String(request.params?.name || "").startsWith("orchestration_codex_")
                ? sanitizedJobFailure(error)
              : String(request.params?.name || "").startsWith("orchestration_")
                ? sanitizedRoleFailure(error)
              : sanitizedToolFailure(),
          );
        }
      }
      return;
    }
    if (!isNotification) errorResponse(request.id, -32601, "Method not found.");
  }

  return { handle };
}

function startServer() {
  const { handle } = createRequestHandler();
  let queue = Promise.resolve();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      queue = queue.then(
        async () => {
          try {
            await handle(JSON.parse(line));
          } catch {
            // Parse errors never carry a reliable request id.
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } })}\n`);
          }
        },
        async () => undefined,
      );
    }
  });
}

if (require.main === module) startServer();

module.exports = {
  FINAL_EVENT_SCHEMA,
  INITIAL_EVENT_SCHEMA,
  ISSUE_COMMENT_ID_SCHEMA,
  ISSUE_COMMENT_SCHEMA,
  TOOLS,
  createRequestHandler,
  formatJobResult,
  formatEvidenceResult,
  mapFinalEvidenceInput,
  mapInitialEvidenceInput,
  projectPublicJobReport,
  sanitizedEvidenceFailure,
  sanitizedJobFailure,
  sanitizedRoleFailure,
  sanitizedToolFailure,
};
