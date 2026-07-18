#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { readLoginMode, removeApiKeyEnvironment, resolveCodexExecutable, terminateWithEscalation } = require("./bridge");
const {
  DEFAULT_WALL_CLOCK_LIMIT_MINUTES,
  MAX_WALL_CLOCK_LIMIT_MINUTES,
  MIN_WALL_CLOCK_LIMIT_MINUTES,
  mutateJob,
  readJob,
  resolveJobsPath,
  validateJobId,
  validateThreadId,
} = require("./jobs");
const {
  envelopeContext,
  EXPECTED,
  MAX_RESULT_BYTES,
  outcomeForEnvelope,
  parseAndValidateEnvelope,
  resultEnvelopeContractText,
  resultEnvelopeExampleText,
} = require("./result-envelope");
const {
  MANUAL_PR_RECOVERY_INSTRUCTION,
  createObservationCollector,
  observeGithubEvent,
  pendingMergeMarker,
  trustedPublicObservation,
  trustedRunningObservation,
  validateAuditReportBeforePullRequest,
  validateImplementationCommitBeforeMutation,
  validateObservedAuditEvidence,
  validateObservedPullRequest,
} = require("./github-observations");

const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = DEFAULT_WALL_CLOCK_LIMIT_MINUTES * 60 * 1000;
const PROGRESS_HEARTBEAT_MS = 60 * 1000;
const GITHUB_WRITE_TOOLS = new Set([
  "create_blob",
  "create_branch",
  "create_commit",
  "create_file",
  "create_pull_request",
  "create_tree",
  "update_file",
  "update_pull_request",
  "update_ref",
]);
const APPROVAL_WRITE_ALLOWLIST = Object.freeze([...GITHUB_WRITE_TOOLS].sort());
const APPROVAL_REREQUEST_PREFIX = "COWORK_CODEX_APPROVAL_REREQUEST_V1";

function safeWorkerEnvironment(source = process.env) {
  const environment = removeApiKeyEnvironment(source);
  for (const name of Object.keys(environment)) {
    if (/CLAUDE|ANTHROPIC/i.test(name)) delete environment[name];
  }
  return environment;
}

function bulletList(items) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function workerResultEnvelopeInstructions(taskType) {
  return "Return JSON only, with no Markdown fence or prose before or after it.\n" +
    `${resultEnvelopeContractText()}\n` +
    `Canonical type-shape example for a ${taskType} task (illustrative values are not evidence and must be replaced, not copied):\n` +
    `${resultEnvelopeExampleText(taskType)}\n`;
}

function approvalRerequestInstruction(state) {
  return `After one GITHUB_WRITE_APPROVAL_DENIED result, the same write access may be requested exactly once more in the same turn. Before that second request, emit this exact machine explanation: ${APPROVAL_REREQUEST_PREFIX} | run_id=${state.id} | task_branch=${state.taskBranch} | allowed_tools=${APPROVAL_WRITE_ALLOWLIST.join(",")} | attempt=2/2. After a second denial, fail closed without another request. Timeouts and aborts are never retried.\n`;
}

function buildStartPrompt(state) {
  const { contract, roles } = state;
  return `You are SOL, the sole senior manager for run ${state.id}.\n\n` +
    approvalRerequestInstruction(state) + "\n" +
    `Repository: ${contract.repository}\nBase branch: ${contract.baseBranch}\nTask branch (exact): ${state.taskBranch}\nTask type: ${contract.taskType}\n` +
    `Outcome: ${contract.outcome}\nScope: ${contract.scope}\n\n` +
    `Constraints:\n${bulletList(contract.constraints)}\n\n` +
    `Exclusions:\n${bulletList(contract.exclusions)}\n\n` +
    `Acceptance checks:\n${bulletList(contract.acceptanceChecks)}\n\n` +
    `Deliverables:\n${bulletList(contract.deliverables)}\n\n` +
    `Runtime selectors: SOL=${roles.SOL}; Terra=${roles.Terra}.\n` +
    "You must use the Codex collaboration capability to delegate substantive read-only inspection, analysis, and drafting to exactly one Terra subagent. " +
    "Remain the sole manager. Terra produces V1 through read-only GitHub MCP; you review V1 and issue at least one concrete, testable revision; Terra produces V2; you review V2. Terra must not perform GitHub mutations. After you accept V2, Terra returns the exact accepted content or change plan to you and stops. You, SOL, must personally perform every GitHub mutation and every final proof read in this main thread so the host can observe them. Never delegate a GitHub mutation, final exact-range fetch, final report self-fetch, or final PR read to Terra. Only after you accept V2 may you create the pull request directly with draft=false. " +
    "The automatic approval reviewer is a Codex runtime safety control only: it is not Fable, SOL, Terra, a productive subagent, or a manager cycle, and it must never do task work. " +
    "If collaboration subagents or GitHub MCP are absent, return blocked without implementing.\n\n" +
    `HARD TRANSPORT BOUNDARY: GITHUB_MCP_ONLY. Use only GitHub MCP tools to inspect the remote repository and, only after the delivery rule below permits it, create exactly task branch ${state.taskBranch} from ${contract.baseBranch}, commit, open the pull request directly with draft=false, and verify it is open and non-draft. ` +
    "Never run a shell command, local Git, clone, worktree, local repository read/write, GitHub Action, or OpenAI API-key workflow. Never merge.\n" +
    `AUTHORIZED GITHUB MUTATIONS: only create_branch for ${state.taskBranch} from ${contract.baseBranch}; create_blob/create_tree/create_commit as needed for that branch; create_file/update_file only on that branch and within the agreed scope${contract.taskType === "audit" ? ` or exact audit path ${state.auditPath}` : ""}; update_ref only for that branch with force=false; create_pull_request only from that branch to ${contract.baseBranch} with draft=false and the required pending marker below; and non-closing, non-retargeting PR metadata updates for that same PR. ` +
    "Never mutate the base/default branch directly. Never merge, delete, force-update, close, retarget, release, deploy, alter workflows, secrets, variables, keys, tokens, credentials, collaborators, permissions, admin/settings, webhooks, or security controls. If the exact target is ambiguous, stop blocked.\n" +
    "HARD ONE-WAY BOUNDARY: NO_CLAUDE_MCP, NO_FABLE_CALL, NO_CLAUDE_COMMAND, NO_ANTHROPIC_API. " +
    "Never start, invoke, message, or use Claude/Fable as a model, tool, command, reviewer, subagent, fallback, API, SDK, endpoint, proxy, or message target. Return the result passively to the caller.\n\n" +
    (contract.taskType === "audit"
      ? `AUDIT DELIVERY: Product code must remain unchanged when the audit finds no defect. An audit may create ${state.taskBranch} for its real artifact. Create one substantive Markdown audit artifact at exactly ${state.auditPath}. It must record the audited repository, base branch, full audited base/head SHA, scope, findings, verification, and exact source lines or ranges with short snippets re-read from that same SHA. This report is the real audit deliverable, not a fake code change. Do not create any other coordination or placeholder file. The report machine block, not the final model envelope, carries {audited_sha,scope,findings,verification,line_evidence}: audited_sha is the full 40-hex audited SHA; scope and findings are arrays of non-empty strings; verification is exactly one non-empty string, not an array or object; line_evidence is an array of {path,start_line,end_line,snippet} entries matching that same re-read SHA. The final model envelope must return audit_evidence:null. The host derives and hydrates audit_evidence only after independently validating the committed report, exact ranges, final head, and PR identity. Embed exactly one machine block in the report using these exact sentinels and compact JSON on one line: <!-- COWORK_CODEX_AUDIT_EVIDENCE_V1, then {\"schema\":\"cowork-codex-audit-evidence/v1\",\"repository\":\"${contract.repository}\",\"base_branch\":\"${contract.baseBranch}\",\"report_path\":\"${state.auditPath}\",\"audit_evidence\":<the exact final report audit-evidence object>}, then COWORK_CODEX_AUDIT_EVIDENCE_V1 -->. Produce that JSON with JSON.stringify semantics; quotes, backslashes, tabs, Unicode, and line breaks inside snippets must be escaped, never hand-concatenated. The pre-PR proof sequence is mandatory and ordered: (1) fetch every cited exact range with github.fetch_file at ref=audited_sha with exact start_line/end_line and UTF-8; (2) after all report changes are final, self-fetch the complete report at the exact final head_sha with UTF-8 and no range; (3) only then create the open non-draft PR; (4) read it with github.get_pr_info at that exact final head SHA; github.fetch_pr is accepted only as the host-explicitly-allowlisted equivalent; (5) only then return. Do not mutate report or product files after the self-fetch.\n`
      : `IMPLEMENTATION DELIVERY: Inspect first. Do not create ${state.taskBranch} until Terra V1 and SOL's review establish a concrete justified repository change within scope. Never create an audit, coordination, placeholder, or empty-commit artifact merely to manufacture a pull-request diff. If there is no justified repository change, create no branch and return blocked with reason_code NULL_DIFF_NO_DELIVERY.\n`) +
    (contract.taskType === "audit" ? "AUDIT SNIPPET IDENTITY: Every snippet must equal the corresponding UTF-8 github.fetch_file range content exactly. Do not trim, normalize Unicode, convert LF/CR/CRLF, or add/remove a final newline.\n" : "") +
    (contract.taskType === "audit" ? "AUDIT FIX-IF-FOUND: Always create the report. Change in-scope product files only after mechanically establishing a defect and document both defect and change; otherwise leave product files unchanged.\n" : "") +
    "For line evidence, cite the exact line on which the referenced element or value begins, not an enclosing section, div, container, or nearby line. Re-read the exact remote SHA before finalizing evidence.\n" +
    `SOL MAIN-THREAD OWNERSHIP: after accepting Terra V2, you personally execute the accepted delivery with GitHub MCP in this main thread. For an audit, personally re-fetch every cited range at audited_sha, create ${state.taskBranch}, write the accepted files, self-fetch the complete report at the final head SHA, create the PR, and perform the final github.get_pr_info read. For an implementation, personally create the branch, write the accepted changes, create the PR, and perform the final PR read. If PR creation is denied after a commit, personally call github.compare_commits with base=<the candidate full head SHA> and head=${state.taskBranch}; only an identical zero-delta result binds that SHA to the exact leftover branch. For an audit residue, also personally fetch the complete ${state.auditPath || "audit report"} at that exact SHA.\n` +
    `PR PENDING MARKER: derive the lowercase full 40-hex SHA from the latest successful commit already made on ${state.taskBranch} before calling create_pull_request. The entire create_pull_request body must be exactly this one canonical line and no other bytes: COWORK_CODEX_GATE_V1 | run_id=${state.id} | head_sha=<that already-known task-branch commit SHA> | PENDING / DO NOT MERGE. Do not add a title, summary, blank line, Markdown, prefix, suffix, trailing whitespace, or punctuation to the body. The host compatibility validator can read the historical terminal-period variant, but every new create must emit only the canonical no-period body. The successful create result and every final github.get_pr_info result must preserve the same originally observed body exactly; after a correction its marker SHA remains the original created-head SHA, not the new final head. github.fetch_pr is accepted only because the host explicitly allowlists it as an equivalent final read. This marker remains PENDING; Codex, SOL, and Terra must never post PASS.\n` +
    (contract.taskType === "implementation"
      ? `IMPLEMENTATION COMMIT EXPLANATION: Every github.create_file, github.update_file, or low-level github.create_commit call must put the explanation inside the already necessary commit message; never post a separate PR context comment. Use exactly seven lines and no final newline: a concise non-empty subject of at most 72 UTF-8 bytes; one blank line; COWORK_CODEX_IMPLEMENTATION_V1 | run_id=${state.id}; then exactly Problem: <what made the change necessary>; Change: <what the accepted Terra V2 changed>; Rationale: <why it is the bounded solution>; Verification: <how the exact remote result was checked, explicitly naming the checked scope>. Each section value is NFC, trimmed, non-empty, single-line, and at most 384 UTF-8 bytes; the complete message is at most 2048 UTF-8 bytes and contains no control character, @, URL, COWORK_CODEX_GATE_V1, or COWORK_CODEX_PR_CONTEXT_V1. For low-level writes, create_commit is not branch-effective until a successful update_ref binds that exact observed commit SHA to ${state.taskBranch} with force=false. Before PR creation and again at the final PR read, the visible PR head must equal the last branch-effective commit carrying this valid run-bound explanation. Every later correction commit must carry a fresh explanation for that correction.\n`
      : "") +
    "If an app/MCP mutation is denied by automatic approval review, return blocked with reason_code GITHUB_WRITE_APPROVAL_DENIED. If review times out, return incomplete with GITHUB_WRITE_APPROVAL_TIMEOUT. If it is aborted or returns `user cancelled MCP tool call`, return blocked with GITHUB_WRITE_APPROVAL_ABORTED. A genuinely active reviewer request leaves the host job running; never fabricate an approval_pending result.\n\n" +
    workerResultEnvelopeInstructions(contract.taskType) +
    "For every finding_dispositions item, line is either a positive integer or null. Its URL must be the canonical same-repository blob URL for its exact path at either the final head_sha or, for audits only, audit_evidence.audited_sha; every other SHA is forbidden. A positive line requires the exact #L<line> anchor and null requires no fragment. Before every complete return, successfully read the open non-draft pull request with github.get_pr_info so the host can verify repository, base, task branch, head SHA, number, URL, and original PENDING body marker independently; github.fetch_pr is accepted only as the host-explicitly-allowlisted equivalent. For audits, this PR identity read occurs only after the complete report self-fetch at the exact final head SHA. A complete result requires the exact repository/base/task branch plus a full 40-hex head_sha, positive pr_number, and canonical https://github.com/OWNER/REPO/pull/NUMBER URL. Do not include credentials, process output, hidden reasoning, local paths, PIDs, or internal thread/session identifiers.";
}

function buildResumePrompt(state) {
  const immutable = JSON.stringify(state.request.findings);
  return `Continue the same SOL run ${state.id}. This is the only permitted correction resume.\n` +
    approvalRerequestInstruction(state) +
    "The following GitHub Codex-review findings are immutable evidence. Preserve each body, URL, path, and line byte-for-byte; do not rephrase, filter, rank, accept, or reject them:\n" +
    `${immutable}\n\n` +
    "Verify the findings and give the same Terra hierarchy at most one focused read-only correction package. Terra must not mutate GitHub. After accepting Terra's corrected V2, you personally apply every GitHub mutation and perform every final proof read in this main thread against the same repository, PR, base, and task branch. Run focused checks remotely where supported. Never merge.\n" +
    "The HARD TRANSPORT and ONE-WAY boundaries from the first turn remain unchanged: no shell/local Git/local files/Actions/API key; no Claude/Fable/Anthropic call, command, MCP, model, reviewer, fallback, endpoint, proxy, or message target.\n" +
    (state.contract.taskType === "implementation"
      ? `Every correction commit must use the same seven-line COWORK_CODEX_IMPLEMENTATION_V1 | run_id=${state.id} commit-message contract from the first turn, with fresh Problem, Change, Rationale, and scope-bearing Verification values for this correction. Do not post a PR context comment. The final PR head must equal the last branch-effective commit carrying that valid run-bound explanation.\n`
      : "") +
    workerResultEnvelopeInstructions(state.contract.taskType) +
    "Return that strict final envelope with the new full head_sha, canonical PR identity, and one finding_dispositions entry with evidence for every forwarded finding. Use a canonical same-repository blob URL at the final head_sha or, for audits only, audit_evidence.audited_sha, with exact #L<line> for positive lines; use null and no fragment only when the referenced element is absent. For an audit, the SOL-owned final order is mandatory: personally re-fetch every exact same-audited-SHA range, apply the accepted mutations, self-fetch the complete report at the exact new final head SHA without a range, read the open non-draft PR with github.get_pr_info at that same head, then return; github.fetch_pr is only the host-explicitly-allowlisted equivalent. Do not mutate after the sequence starts. The returned PR body must still contain exactly once the original created-head PENDING / DO NOT MERGE marker even though the PR head is now new. Codex, SOL, and Terra must never post PASS. The automatic approval reviewer remains only a runtime safety control and is not a productive agent or manager cycle. Do not include internal thread/session identifiers.";
}

function buildAutoReviewPolicy(state) {
  const auditRule = state.contract.taskType === "audit"
    ? `The only authorized out-of-product-scope path is the substantive audit report at exactly ${state.auditPath}.`
    : "No audit, coordination, placeholder, or empty-delivery file is authorized.";
  const commitMessageRule = state.contract.taskType === "implementation"
    ? `Every create_file, update_file, and create_commit message must contain the exact bounded seven-line COWORK_CODEX_IMPLEMENTATION_V1 | run_id=${state.id} explanation contract; low-level update_ref may bind only an observed explained commit to the exact task branch with force=false; the PR head must equal the latest such branch-effective commit; `
    : "";
  const contextCommentRule = state.contract.taskType === "implementation"
    ? "No add_comment_to_issue mutation is authorized in a SOL job. "
    : "";
  const expectedWriteAllowlist = `The explicit expected write-tool allowlist is exactly ${APPROVAL_WRITE_ALLOWLIST.join(", ")}; every listed write is permitted only for delivery in repository ${state.contract.repository} on deterministic task branch ${state.taskBranch}, with create_pull_request targeting base ${state.contract.baseBranch}. `;
  return `Additional run-specific constraints (apply in addition to the built-in guardian policy): approval review is a runtime safety function, never a task agent. ` +
    expectedWriteAllowlist + approvalRerequestInstruction(state) +
    `Only consider reversible, task-branch-scoped GitHub mutations for exact repository ${state.contract.repository}, base ${state.contract.baseBranch}, and task branch ${state.taskBranch} that are directly authorized by the retained user contract. ` +
    `The only candidates are create_branch for that exact branch/base; create_blob/create_tree/create_commit needed for it; create_file/update_file on that branch within scope; update_ref with branch_name equal to that exact branch and force=false; create_pull_request from that branch to that base with draft=false and a body consisting of exactly the canonical line COWORK_CODEX_GATE_V1 | run_id=${state.id} | head_sha=<that lowercase full 40-hex commit SHA> | PENDING / DO NOT MERGE and no other bytes, where the marker SHA is the latest successful task-branch commit SHA already known before the PR call; ${commitMessageRule}and non-closing, non-retargeting PR metadata updates for that same PR. ${contextCommentRule}Deny a terminal period on new creation, extra text, blank lines, duplicates, mixed variants, any other suffix or punctuation, trailing whitespace, or Markdown decoration. ` +
    `${auditRule} ` +
    "Deny wrong repo/branch, direct base mutation, shell/local files, non-GitHub tools, merge, delete, force, close, retarget, release, deploy, workflows, secrets, variables, credentials, collaborators, permissions, admin/settings, webhooks, security-control changes, exfiltration, or ambiguous targets. Fail closed.";
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function buildCodexArgs(state, workspace) {
  const autoReviewPolicy = buildAutoReviewPolicy(state);
  const shared = [
    "--json",
    "--strict-config",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--model", state.roles.SOL,
    "-c", 'sandbox_mode="read-only"',
    "-c", 'approval_policy="on-request"',
    "-c", 'approvals_reviewer="auto_review"',
    "-c", 'apps._default.default_tools_approval_mode="writes"',
    "-c", 'apps._default.approvals_reviewer="auto_review"',
    "-c", 'apps.github.default_tools_approval_mode="writes"',
    "-c", 'apps.github.approvals_reviewer="auto_review"',
    "-c", `auto_review.policy=${tomlString(autoReviewPolicy)}`,
  ];
  if (state.request.kind === "resume") {
    return ["exec", "resume", ...shared, state.internal.threadId, "-"];
  }
  return ["exec", ...shared, "--sandbox", "read-only", "-C", workspace, "-"];
}

function policyViolation(event) {
  if (event?.type !== "item.started") return null;
  const item = event.item;
  if (!item || typeof item !== "object") return null;
  if (["command_execution", "file_change", "web_search"].includes(item.type)) return "NON_GITHUB_TOOL_BLOCKED";
  if (["agent_message", "reasoning", "todo_list", "collab_tool_call"].includes(item.type)) return null;
  if (item.type !== "mcp_tool_call") return "NON_GITHUB_TOOL_BLOCKED";
  const server = String(item.server || "");
  const tool = String(item.tool || "");
  const githubAppTool = server === "codex_apps" && tool.startsWith("github.");
  const githubMcpTool = server === "github";
  return githubAppTool || githubMcpTool ? null : "NON_GITHUB_MCP_BLOCKED";
}

function normalizedApprovalTool(event) {
  const server = String(event?.item?.server || "").normalize("NFC").trim().toLowerCase();
  let tool = String(event?.item?.tool || "").normalize("NFC").trim().toLowerCase();
  if (server === "codex_apps") {
    if (!tool.startsWith("github.")) return null;
    tool = tool.slice("github.".length);
  } else if (server === "github") {
    if (tool.startsWith("github.")) tool = tool.slice("github.".length);
  } else return null;
  return GITHUB_WRITE_TOOLS.has(tool) ? tool : null;
}

function sanitizedTargetPath(value) {
  const pathValue = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!pathValue || Buffer.byteLength(pathValue, "utf8") > 512 || pathValue.startsWith("/") ||
      pathValue.includes("\\") || /[\u0000-\u001f\u007f]/.test(pathValue) ||
      pathValue.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return pathValue;
}

function containsSuspiciousSecretLiteral(value) {
  if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z0-9 ]+-----)/.test(value)) return true;
  const candidates = value.match(/[A-Za-z0-9_+/=-]{32,}/g) || [];
  return candidates.some((candidate) =>
    [/[a-z]/, /[A-Z]/, /[0-9]/, /[_+/=-]/].filter((pattern) => pattern.test(candidate)).length >= 3);
}

function sanitizedDenialRationale(error) {
  const explicit = typeof error?.rationale === "string" ? error.rationale :
    (typeof error?.reason === "string" ? error.reason : null);
  let value = explicit || (typeof error?.message === "string" ? error.message : "");
  value = value.normalize("NFC").trim();
  const reasonMatch = value.match(/\breason:\s*(.+)$/i);
  if (!explicit && reasonMatch) value = reasonMatch[1].trim();
  const generic = /^(?:automatic approval denied this request|auto-review denied this request|request (?:denied|rejected)|this action was rejected due to unacceptable risk)[.!]?$/i;
  if (!value || generic.test(value) || Buffer.byteLength(value, "utf8") > 1024 ||
      containsSuspiciousSecretLiteral(value) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
      /(?:token|credential|authorization|password|secret)\s*[:=]/i.test(value) ||
      /(?:^|\s)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\/.test(value) ||
      /(?:session|thread)[_-]?id\s*[:=]/i.test(value)) return "runtime_emitted_no_rationale";
  return value;
}

function approvalFailureObservation(event, state) {
  if (event?.type !== "item.completed" || event.item?.type !== "mcp_tool_call" || event.item?.status !== "failed") return null;
  const tool = normalizedApprovalTool(event);
  if (!tool) return null;
  const message = String(event.item?.error?.message || "").normalize("NFC").trim().toLowerCase();
  if (!message) return null;
  let code = null;
  if (/\b(?:timed out|timeout)\b/.test(message)) code = "GITHUB_WRITE_APPROVAL_TIMEOUT";
  else if (message === "user cancelled mcp tool call" || /\b(?:aborted|cancelled|canceled)\b/.test(message)) code = "GITHUB_WRITE_APPROVAL_ABORTED";
  else if (/\b(?:denied|rejected)\b/.test(message)) code = "GITHUB_WRITE_APPROVAL_DENIED";
  if (!code) return null;
  const args = event.item.arguments && typeof event.item.arguments === "object" ? event.item.arguments : {};
  const target = { repository: state.contract.repository, branch: state.taskBranch };
  const safePath = sanitizedTargetPath(args.path);
  if (safePath) target.path = safePath;
  const detail = code === "GITHUB_WRITE_APPROVAL_DENIED"
    ? { rationale: sanitizedDenialRationale(event.item.error), tool, target } : null;
  return { code, detail, signature: `${tool}|${target.repository}|${target.branch}|${safePath || ""}` };
}

function classifyMcpApprovalFailure(event) {
  const state = { contract: { repository: "" }, taskBranch: "" };
  return approvalFailureObservation(event, state)?.code || null;
}

function mutationValidationError(guard) {
  return {
    path: guard.path,
    rule: guard.rule,
    expected: guard.expected || EXPECTED.HOST_EVIDENCE,
  };
}

function createApprovalRetryTracker() {
  const states = new Map();
  return {
    started(signature) {
      const current = states.get(signature);
      if (current === "denied_once") { states.set(signature, "retry_started"); return true; }
      if (current === "retry_started" || current === "denied_twice" || current === "terminated") return false;
      states.set(signature, "started");
      return true;
    },
    denied(signature) {
      const current = states.get(signature);
      states.set(signature, current === "retry_started" ? "denied_twice" : "denied_once");
    },
    // Timeouts and aborts are never retried: the write fails closed on any further attempt.
    terminated(signature) {
      states.set(signature, "terminated");
    },
    succeeded(signature) {
      const current = states.get(signature);
      if (current === "terminated") return false;
      const recovered = current === "retry_started";
      states.set(signature, "recovered");
      return recovered;
    },
  };
}

function updateState(jobId, mutate, environment) {
  return mutateJob(jobId, (current) => ["complete", "blocked", "incomplete", "cancelled"].includes(current.status) ? current : mutate(current), { environment });
}

const PHASE_RANK = new Map([
  ["branch_created", 1], ["commit_observed", 2], ["commit_without_pr", 2],
  ["audit_artifact_committed_pr_missing", 2], ["pr_created", 3], ["pr_verified", 4],
]);

function mergeTerminalObservation(current, fresh) {
  const persisted = current?.publicEvidence && typeof current.publicEvidence === "object" ? current.publicEvidence : null;
  const observed = fresh?.partialEvidence && typeof fresh.partialEvidence === "object" ? fresh.partialEvidence : null;
  let partialEvidence = persisted || observed;
  if (persisted && observed) {
    const advanced = (PHASE_RANK.get(observed.last_completed_phase) || 0) >= (PHASE_RANK.get(persisted.last_completed_phase) || 0)
      ? observed : persisted;
    const other = advanced === observed ? persisted : observed;
    partialEvidence = { ...other, ...advanced };
  }
  const candidates = [...(current?.leftoverResources || []), ...(fresh?.leftoverResources || [])]
    .filter((resource) => resource && typeof resource === "object" && !Array.isArray(resource));
  const contractRepository = current?.contract?.repository || null;
  const contractBranch = current?.taskBranch || null;
  const expectedRepository = contractRepository || partialEvidence?.repository || null;
  const expectedBranch = contractBranch || partialEvidence?.task_branch || null;
  const branches = candidates.filter((resource) =>
    resource.kind === "branch" && typeof resource.repository === "string" &&
    typeof resource.name === "string" && (!expectedRepository || resource.repository === expectedRepository) &&
    (!expectedBranch || resource.name === expectedBranch)
  ).sort((left, right) => `${left.repository}/${left.name}`.localeCompare(`${right.repository}/${right.name}`));
  const partialEvidenceIsContractBound = partialEvidence?.repository === expectedRepository &&
    partialEvidence?.task_branch === expectedBranch;
  const hasObservedBranchPhase = partialEvidenceIsContractBound &&
    (PHASE_RANK.get(partialEvidence?.last_completed_phase) || 0) >= PHASE_RANK.get("branch_created");
  const branch = branches[0] || (hasObservedBranchPhase && expectedRepository && expectedBranch
    ? { kind: "branch", repository: expectedRepository, name: expectedBranch }
    : null);
  const pullRequests = candidates.filter((resource) =>
    resource.kind === "pull_request" && typeof resource.repository === "string" &&
    Number.isSafeInteger(resource.number) && resource.number > 0 &&
    resource.url === `https://github.com/${resource.repository}/pull/${resource.number}` &&
    resource.state === "open" && resource.draft === false &&
    ["pending_do_not_merge", "unverified"].includes(resource.certification_status) &&
    (!expectedRepository || resource.repository === expectedRepository)
  ).sort((left, right) => {
    const leftEvidence = left.number === partialEvidence?.pr_number && left.url === partialEvidence?.pr_url ? 0 : 1;
    const rightEvidence = right.number === partialEvidence?.pr_number && right.url === partialEvidence?.pr_url ? 0 : 1;
    if (leftEvidence !== rightEvidence) return leftEvidence - rightEvidence;
    const leftCertification = left.certification_status === "pending_do_not_merge" ? 0 : 1;
    const rightCertification = right.certification_status === "pending_do_not_merge" ? 0 : 1;
    if (leftCertification !== rightCertification) return leftCertification - rightCertification;
    return `${left.repository}/${String(left.number).padStart(20, "0")}/${left.url}`
      .localeCompare(`${right.repository}/${String(right.number).padStart(20, "0")}/${right.url}`);
  });
  if (branch && pullRequests.length > 0) {
    const pullRequest = pullRequests[0];
    return {
      partialEvidence,
      leftoverResources: [
        { kind: "branch", repository: branch.repository, name: branch.name },
        {
          kind: "pull_request",
          repository: pullRequest.repository,
          number: pullRequest.number,
          url: pullRequest.url,
          state: "open",
          draft: false,
          certification_status: pullRequest.certification_status,
        },
      ],
    };
  }
  const commitResidues = candidates.filter((resource) => {
    if (!["audit_artifact_committed_pr_missing", "commit_without_pr"].includes(resource.kind)) return false;
    if (resource.repository !== expectedRepository || resource.base_branch !== current?.contract?.baseBranch || resource.branch !== expectedBranch) return false;
    if (typeof resource.head_sha !== "string" || !/^[0-9a-f]{40}$/.test(resource.head_sha) || resource.pr_missing !== true) return false;
    if (resource.pr_number !== null || resource.pr_url !== null || resource.accepted_terminal_period !== true) return false;
    if (resource.recovery_status !== "manual_pr_creation_required" || resource.recovery_instruction !== MANUAL_PR_RECOVERY_INSTRUCTION) return false;
    if (resource.required_pr_body_marker !== pendingMergeMarker(current.id, resource.head_sha)) return false;
    return resource.kind !== "audit_artifact_committed_pr_missing" ||
      (current?.contract?.taskType === "audit" && resource.artifact_path === current.auditPath);
  }).sort((left, right) => {
    const leftAudit = left.kind === "audit_artifact_committed_pr_missing" ? 0 : 1;
    const rightAudit = right.kind === "audit_artifact_committed_pr_missing" ? 0 : 1;
    if (leftAudit !== rightAudit) return leftAudit - rightAudit;
    const leftHead = left.head_sha === partialEvidence?.head_sha ? 0 : 1;
    const rightHead = right.head_sha === partialEvidence?.head_sha ? 0 : 1;
    return leftHead !== rightHead ? leftHead - rightHead : left.head_sha.localeCompare(right.head_sha);
  });
  if (!branch) return { partialEvidence, leftoverResources: [] };
  const leftoverResources = [{ kind: "branch", repository: branch.repository, name: branch.name }];
  if (commitResidues.length > 0) {
    const residue = commitResidues[0];
    leftoverResources.push({
      kind: residue.kind,
      repository: residue.repository,
      base_branch: residue.base_branch,
      branch: residue.branch,
      head_sha: residue.head_sha,
      ...(residue.kind === "audit_artifact_committed_pr_missing" ? { artifact_path: residue.artifact_path } : {}),
      pr_missing: true,
      pr_number: null,
      pr_url: null,
      required_pr_body_marker: residue.required_pr_body_marker,
      accepted_terminal_period: true,
      recovery_status: "manual_pr_creation_required",
      recovery_instruction: MANUAL_PR_RECOVERY_INSTRUCTION,
    });
  }
  return { partialEvidence, leftoverResources };
}

function finalizeTerminalJob(jobId, patch, observations, environment) {
  return updateState(jobId, (current) => {
    const merged = mergeTerminalObservation(current, trustedPublicObservation(observations));
    const publicEvidence = patch.publicCode === "GITHUB_WRITE_APPROVAL_DENIED" && observations?.approvalDenialDetail
      ? { ...(merged.partialEvidence || {}), approval_denial_detail: observations.approvalDenialDetail }
      : merged.partialEvidence;
    return {
      ...current,
      ...patch,
      publicEvidence,
      leftoverResources: merged.leftoverResources,
      prCertification: observations?.pendingCertification ?? current.prCertification,
      implementationCommit: observations?.latestImplementationCommit ?? null,
      updatedAt: new Date().toISOString(),
    };
  }, environment);
}

function timeoutMsForState(state) {
  const stored = state?.contract?.wallClockLimitMinutes;
  const minutes = Number.isSafeInteger(stored) &&
    stored >= MIN_WALL_CLOCK_LIMIT_MINUTES && stored <= MAX_WALL_CLOCK_LIMIT_MINUTES
    ? stored : DEFAULT_WALL_CLOCK_LIMIT_MINUTES;
  return minutes * 60 * 1000;
}

function createProgressPublisher(jobId, state, observations, options = {}) {
  const environment = options.environment || process.env;
  const mutateJobImpl = options.mutateJobImpl || mutateJob;
  const nowImpl = options.nowImpl || Date.now;
  const basePhase = state.request.kind === "resume" ? "correction" : "implementation";
  let lastTrustedEventCount = 0;
  let lastSnapshot = null;
  let lastPublishedAt = null;
  return () => {
    if (observations.trustedGithubEvents <= lastTrustedEventCount) return false;
    lastTrustedEventCount = observations.trustedGithubEvents;
    const observed = trustedRunningObservation(observations);
    const phase = observed.partialEvidence?.last_completed_phase || basePhase;
    const snapshot = JSON.stringify({ phase, evidence: observed.partialEvidence, resources: observed.leftoverResources });
    const now = nowImpl();
    if (lastPublishedAt !== null && snapshot === lastSnapshot && now - lastPublishedAt < PROGRESS_HEARTBEAT_MS) return false;
    let published = false;
    mutateJobImpl(jobId, (current) => {
      if (current.status !== "running") return current;
      const merged = mergeTerminalObservation(current, observed);
      published = true;
      return {
        ...current,
        phase: merged.partialEvidence?.last_completed_phase || phase,
        updatedAt: new Date(now).toISOString(),
        publicEvidence: merged.partialEvidence,
        leftoverResources: merged.leftoverResources,
        prCertification: observations.pendingCertification,
        implementationCommit: observations.latestImplementationCommit,
      };
    }, { environment });
    if (published) {
      lastSnapshot = snapshot;
      lastPublishedAt = now;
    }
    return published;
  };
}

async function runWorker(jobId, options = {}) {
  const environment = options.environment || process.env;
  validateJobId(jobId);
  let state = readJob(jobId, { environment });
  if (state.status !== "queued") return;
  const observations = createObservationCollector({
    runId: state.id,
    repository: state.contract.repository,
    baseBranch: state.contract.baseBranch,
    taskBranch: state.taskBranch,
    taskType: state.contract.taskType,
    auditPath: state.auditPath,
    pendingCertification: state.prCertification,
    implementationCommit: state.implementationCommit,
  });
  const resolved = (options.resolveExecutable || resolveCodexExecutable)(environment);
  if (!resolved) {
    finalizeTerminalJob(jobId, { status: "blocked", phase: "blocked", publicCode: "CODEX_NOT_FOUND" }, observations, environment);
    return;
  }
  let loginMode = "unknown";
  try {
    loginMode = await (options.readLoginMode || readLoginMode)(resolved.executable, {
      environment: safeWorkerEnvironment(environment),
      spawnImpl: options.loginSpawnImpl,
      timeoutMs: options.loginTimeoutMs,
    });
  } catch {
    loginMode = "unknown";
  }
  if (loginMode !== "chatgpt") {
    finalizeTerminalJob(jobId, { status: "blocked", phase: "blocked", publicCode: "CHATGPT_LOGIN_REQUIRED" }, observations, environment);
    return;
  }
  const workspace = path.join(resolveJobsPath(environment), `.${jobId}-workspace`);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  state = updateState(jobId, (current) => ({
    ...current,
    status: "running",
    phase: current.request.kind === "resume" ? "correction" : "implementation",
    updatedAt: new Date().toISOString(),
  }), environment);
  if (state.status !== "running") return;

  const args = buildCodexArgs(state, workspace);
  const prompt = state.request.kind === "resume" ? buildResumePrompt(state) : buildStartPrompt(state);
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs ?? timeoutMsForState(state);
  let child;
  let finalMessage = null;
  let observedThreadId = null;
  let turnCompleted = false;
  let violation = null;
  let violationValidationError = null;
  let observedApprovalFailure = null;
  const approvalRetryTracker = createApprovalRetryTracker();
  const startedWriteSignatures = new Map();
  const publishProgress = createProgressPublisher(jobId, state, observations, {
    environment,
    mutateJobImpl: options.mutateJobImpl,
    nowImpl: options.nowImpl,
  });
  let buffer = "";
  let lineOverflow = false;

  try {
    child = spawnImpl(resolved.executable, args, {
      cwd: workspace,
      env: safeWorkerEnvironment(environment),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    finalizeTerminalJob(jobId, { status: "blocked", phase: "blocked", publicCode: "CODEX_START_FAILED" }, observations, environment);
    return;
  }

  let terminationPromise = null;
  const stopChild = () => {
    if (!terminationPromise) {
      terminationPromise = terminateWithEscalation(child, 2_000).catch(() => undefined);
    }
  };
  const onTermination = () => stopChild();
  process.once("SIGTERM", onTermination);
  process.once("SIGINT", onTermination);
  const cancellationPoll = setInterval(() => {
    try {
      if (readJob(jobId, { environment }).status === "cancelled") stopChild();
    } catch {
      violation = "JOB_STATE_INVALID";
      stopChild();
    }
  }, options.cancelPollMs || 250);
  cancellationPoll.unref?.();
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  const timer = setTimeoutImpl(() => {
    violation = "JOB_TIMEOUT";
    stopChild();
  }, timeoutMs);

  child.stdout?.setEncoding?.("utf8");
  child.stdout?.on?.("data", (chunk) => {
    if (violation) return;
    buffer += String(chunk);
    if (Buffer.byteLength(buffer, "utf8") > MAX_JSONL_LINE_BYTES && !buffer.includes("\n")) {
      lineOverflow = true;
      violation = "CODEX_STREAM_LIMIT";
      stopChild();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
        lineOverflow = true;
        violation = "CODEX_STREAM_LIMIT";
        stopChild();
        break;
      }
      let event;
      try { event = JSON.parse(line); } catch {
        violation = "CODEX_PROTOCOL_ERROR";
        stopChild();
        break;
      }
      const startedTool = event?.type === "item.started" && event.item?.type === "mcp_tool_call"
        ? normalizedApprovalTool(event) : null;
      if (startedTool && APPROVAL_WRITE_ALLOWLIST.includes(startedTool)) {
        const args = event.item.arguments && typeof event.item.arguments === "object" ? event.item.arguments : {};
        const safePath = sanitizedTargetPath(args.path);
        const signature = `${startedTool}|${state.contract.repository}|${state.taskBranch}|${safePath || ""}`;
        if (!approvalRetryTracker.started(signature)) {
          // A non-retryable re-request (a third denial, or any retry after a timeout/abort).
          // Stop without a fresh violation so the already-observed approval-failure code drives
          // the terminal status (timeout -> incomplete; denial/abort -> blocked).
          observedApprovalFailure = observedApprovalFailure || "GITHUB_WRITE_APPROVAL_DENIED";
          stopChild();
          break;
        }
        // Remember the exact started signature so a later failed/completed event that omits
        // arguments is correlated to the same write instead of a recomputed empty-path signature.
        startedWriteSignatures.set(startedTool, signature);
      }
      const blocked = policyViolation(event);
      if (blocked) {
        violation = blocked;
        stopChild();
        break;
      }
      // Fail closed on an invalid mutation at item.started, before the write can execute.
      // A denial has no side effect and is classified from the failed completion below, so a
      // well-formed but denied write still reports GITHUB_WRITE_APPROVAL_DENIED; an approved
      // invalid write is never allowed to land on the task branch.
      const implementationCommitGuard = validateImplementationCommitBeforeMutation(observations, state, event);
      if (!implementationCommitGuard.ok) {
        violation = implementationCommitGuard.code;
        violationValidationError = mutationValidationError(implementationCommitGuard);
        stopChild();
        break;
      }
      const auditGuard = validateAuditReportBeforePullRequest(observations, state, event);
      if (!auditGuard.ok) {
        violation = auditGuard.code;
        violationValidationError = {
          path: auditGuard.path,
          rule: auditGuard.rule,
          expected: auditGuard.expected || EXPECTED.HOST_EVIDENCE,
          ...(auditGuard.mismatch ? { mismatch: auditGuard.mismatch } : {}),
        };
        stopChild();
        break;
      }
      observeGithubEvent(observations, event);
      try {
        publishProgress();
      } catch {
        violation = "JOB_STATE_INVALID";
        stopChild();
        break;
      }
      const approvalFailure = approvalFailureObservation(event, state);
      if (approvalFailure) {
        observedApprovalFailure = approvalFailure.code;
        const failedTool = normalizedApprovalTool(event);
        const signature = (failedTool && startedWriteSignatures.get(failedTool)) || approvalFailure.signature;
        if (approvalFailure.code === "GITHUB_WRITE_APPROVAL_DENIED") {
          observations.approvalDenialDetail = approvalFailure.detail;
          approvalRetryTracker.denied(signature);
        } else {
          // Timeouts and aborts are never retried; block any further attempt on this write.
          approvalRetryTracker.terminated(signature);
        }
      } else if (event?.type === "item.completed" && event.item?.type === "mcp_tool_call" && event.item?.status === "completed") {
        const tool = normalizedApprovalTool(event);
        if (tool && APPROVAL_WRITE_ALLOWLIST.includes(tool)) {
          const args = event.item.arguments && typeof event.item.arguments === "object" ? event.item.arguments : {};
          const recomputed = `${tool}|${state.contract.repository}|${state.taskBranch}|${sanitizedTargetPath(args.path) || ""}`;
          const signature = startedWriteSignatures.get(tool) || recomputed;
          if (approvalRetryTracker.succeeded(signature)) {
            observedApprovalFailure = null;
            observations.approvalDenialDetail = null;
          }
        }
      }
      if (event.type === "thread.started") {
        try {
          observedThreadId = validateThreadId(event.thread_id);
        } catch {
          violation = "CODEX_PROTOCOL_ERROR";
          stopChild();
          break;
        }
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        if (Buffer.byteLength(event.item.text, "utf8") > MAX_RESULT_BYTES) {
          violation = "CODEX_RESULT_LIMIT";
          stopChild();
          break;
        }
        finalMessage = event.item.text;
      }
      if (event.type === "turn.completed") turnCompleted = true;
    }
  });

  try { child.stdin?.end?.(prompt); } catch { violation = "CODEX_INPUT_FAILED"; stopChild(); }
  const exitCode = await new Promise((resolve) => {
    let settled = false;
    const done = (code) => { if (!settled) { settled = true; resolve(code); } };
    child.once?.("error", () => done(null));
    child.once?.("exit", (code) => done(code));
  });
  clearTimeoutImpl(timer);
  clearInterval(cancellationPoll);
  process.removeListener("SIGTERM", onTermination);
  process.removeListener("SIGINT", onTermination);

  if (lineOverflow || violation) {
    const status = violation === "JOB_TIMEOUT" ? "incomplete" : "blocked";
    const publicCode = violation || "CODEX_STREAM_LIMIT";
    finalizeTerminalJob(jobId, {
      status,
      phase: publicCode.startsWith("AUDIT_EVIDENCE_BLOCK_") ? "result_validation" : status,
      publicCode,
      validationError: violationValidationError,
      result: null,
    }, observations, environment);
    return;
  }
  const expectedThread = state.request.kind === "resume" ? state.internal.threadId : null;
  if (exitCode !== 0 || !turnCompleted || !finalMessage || !observedThreadId || (expectedThread && observedThreadId !== expectedThread)) {
    const code = observedApprovalFailure || "CODEX_RUN_FAILED";
    const status = code === "GITHUB_WRITE_APPROVAL_TIMEOUT" ? "incomplete" : "blocked";
    finalizeTerminalJob(jobId, { status, phase: status, publicCode: code, result: null }, observations, environment);
    return;
  }
  let envelope;
  try {
    envelope = parseAndValidateEnvelope(finalMessage, {
      ...envelopeContext(state),
      allowHostDerivedAuditEvidence: state.contract.taskType === "audit",
    });
  } catch (error) {
    const code = observedApprovalFailure || "CODEX_RESULT_ENVELOPE_INVALID";
    const status = code === "GITHUB_WRITE_APPROVAL_TIMEOUT" ? "incomplete" : "blocked";
    finalizeTerminalJob(jobId, {
      status,
      phase: code === "CODEX_RESULT_ENVELOPE_INVALID" ? "result_validation" : status,
      publicCode: code,
      validationError: error?.publicValidationError || { path: "envelope", rule: "strict_schema", expected: EXPECTED.ENVELOPE_OBJECT },
      result: null,
      internal: { threadId: observedThreadId },
    }, observations, environment);
    return;
  }
  const identityValidation = validateObservedPullRequest(observations, envelope);
  const auditValidation = identityValidation.ok ? validateObservedAuditEvidence(observations, state, envelope) : { ok: true };
  if (!identityValidation.ok || !auditValidation.ok) {
    const validation = identityValidation.ok ? auditValidation : identityValidation;
    finalizeTerminalJob(jobId, {
      status: "blocked",
      phase: "result_validation",
      publicCode: identityValidation.ok ? "AUDIT_EVIDENCE_UNVERIFIED" : "GITHUB_PR_IDENTITY_UNVERIFIED",
      validationError: {
        path: validation.path,
        rule: validation.rule,
        expected: validation.expected || EXPECTED.HOST_EVIDENCE,
        ...(validation.mismatch ? { mismatch: validation.mismatch } : {}),
      },
      result: null,
      internal: { threadId: observedThreadId },
    }, observations, environment);
    return;
  }
  if (envelope.status === "complete" && state.contract.taskType === "audit") {
    try {
      envelope = parseAndValidateEnvelope(finalMessage, {
        ...envelopeContext(state),
        hostAuditEvidence: auditValidation.auditEvidence,
      });
    } catch (error) {
      finalizeTerminalJob(jobId, {
        status: "blocked",
        phase: "result_validation",
        publicCode: "AUDIT_EVIDENCE_UNVERIFIED",
        validationError: error?.publicValidationError || { path: "audit_evidence", rule: "host_hydration_failed", expected: EXPECTED.HOST_EVIDENCE },
        result: null,
        internal: { threadId: observedThreadId },
      }, observations, environment);
      return;
    }
  }
  if (observedApprovalFailure && envelope.status !== "complete") {
    if (envelope.reason_code === observedApprovalFailure) {
      const outcome = outcomeForEnvelope(envelope, state.request.kind);
      finalizeTerminalJob(jobId, {
        status: outcome.status,
        phase: outcome.phase,
        publicCode: outcome.code,
        result: envelope,
        validationError: null,
        internal: { threadId: observedThreadId },
      }, observations, environment);
      return;
    }
    const status = observedApprovalFailure === "GITHUB_WRITE_APPROVAL_TIMEOUT" ? "incomplete" : "blocked";
    finalizeTerminalJob(jobId, {
      status,
      phase: status,
      publicCode: observedApprovalFailure,
      result: null,
      validationError: null,
      internal: { threadId: observedThreadId },
    }, observations, environment);
    return;
  }
  const outcome = outcomeForEnvelope(envelope, state.request.kind);
  finalizeTerminalJob(jobId, {
    status: outcome.status,
    phase: outcome.phase,
    publicCode: outcome.code,
    result: envelope,
    validationError: null,
    internal: { threadId: observedThreadId },
  }, observations, environment);
}

if (require.main === module) {
  runWorker(process.argv[2]).catch(() => {
    try {
      const jobId = process.argv[2];
      mutateJob(jobId, (state) => state.status === "cancelled" ? state : ({
        ...state,
        status: "blocked",
        phase: "blocked",
        publicCode: "JOB_WORKER_FAILED",
        result: null,
        updatedAt: new Date().toISOString(),
      }));
    } catch {
      // The host MCP reports the existing sanitized state if it is still readable.
    }
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_JSONL_LINE_BYTES,
  MAX_RESULT_BYTES,
  APPROVAL_REREQUEST_PREFIX,
  APPROVAL_WRITE_ALLOWLIST,
  GITHUB_WRITE_TOOLS,
  PROGRESS_HEARTBEAT_MS,
  buildAutoReviewPolicy,
  buildCodexArgs,
  buildResumePrompt,
  buildStartPrompt,
  workerResultEnvelopeInstructions,
  policyViolation,
  approvalFailureObservation,
  approvalRerequestInstruction,
  classifyMcpApprovalFailure,
  containsSuspiciousSecretLiteral,
  createApprovalRetryTracker,
  createProgressPublisher,
  mergeTerminalObservation,
  runWorker,
  safeWorkerEnvironment,
  timeoutMsForState,
};
