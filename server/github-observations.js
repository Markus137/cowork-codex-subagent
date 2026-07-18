"use strict";

const { createHash } = require("node:crypto");
const { EXPECTED, normalizeAuditEvidence } = require("./result-envelope");

const MAX_OBSERVATIONS = 200;
const MAX_FETCHES = 100;
const MAX_FETCH_CONTENT_BYTES = 128 * 1024;
const MAX_TOTAL_FETCH_BYTES = 512 * 1024;
const MAX_AUDIT_REPORT_FETCHES = 8;
const MAX_AUDIT_REPORT_BYTES = 1024 * 1024;
const MAX_AUDIT_RANGE_FETCHES = 200;
const MAX_AUDIT_RANGE_BYTES = 2 * 1024 * 1024;
const MAX_PR_BODY_BYTES = 256 * 1024;
const MAX_IMPLEMENTATION_COMMIT_MESSAGE_BYTES = 2 * 1024;
const MAX_IMPLEMENTATION_COMMIT_SECTION_BYTES = 384;
const MAX_IMPLEMENTATION_COMMIT_SUBJECT_BYTES = 72;
const MAX_PENDING_IMPLEMENTATION_COMMITS = 32;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const RUN_ID_PATTERN = /^CFT-[0-9]{8}-[0-9]{6}-[A-F0-9]{8}$/;
const AUDIT_BLOCK_START = "<!-- COWORK_CODEX_AUDIT_EVIDENCE_V1";
const AUDIT_BLOCK_END = "COWORK_CODEX_AUDIT_EVIDENCE_V1 -->";
const FINAL_PR_READ_TOOLS = new Set(["fetch_pr", "get_pr_info"]);
const PENDING_MARKER_PREFIX = "COWORK_CODEX_GATE_V1 | run_id=";
const IMPLEMENTATION_COMMIT_MARKER_PREFIX = "COWORK_CODEX_IMPLEMENTATION_V1 | run_id=";
const IMPLEMENTATION_COMMIT_TOOLS = new Set(["create_commit", "create_file", "update_file"]);
const MANUAL_PR_RECOVERY_INSTRUCTION = "Open one PR from this exact unchanged branch and head to the base branch with the required marker; do not rerun or mutate work.";

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedString(value) {
  return typeof value === "string" ? value.normalize("NFC").trim() : null;
}

function normalizedSha(value) {
  const sha = normalizedString(value);
  return sha && SHA_PATTERN.test(sha) ? sha.toLowerCase() : null;
}

function exactValue(object, names) {
  if (!plainObject(object)) return null;
  const values = names
    .filter((name) => Object.prototype.hasOwnProperty.call(object, name))
    .map((name) => normalizedString(object[name]))
    .filter(Boolean);
  if (values.length === 0 || new Set(values).size !== 1) return null;
  return values[0];
}

function toolName(item) {
  const server = normalizedString(item?.server)?.toLowerCase();
  let tool = normalizedString(item?.tool)?.toLowerCase();
  if (!server || !tool) return null;
  if (server === "codex_apps") {
    if (!tool.startsWith("github.")) return null;
    return tool.slice("github.".length);
  }
  if (server !== "github") return null;
  if (tool.startsWith("github.")) tool = tool.slice("github.".length);
  return tool;
}

function textContentFrom(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const texts = parts
    .filter((part) => plainObject(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
  return texts.length ? texts.join("\n") : null;
}

function completedGithubCall(event) {
  const item = event?.type === "item.completed" ? event.item : null;
  if (!plainObject(item) || item.type !== "mcp_tool_call" || item.status !== "completed" || item.error) return null;
  const tool = toolName(item);
  if (!tool || !plainObject(item.arguments) || !plainObject(item.result)) return null;
  if (item.result.isError === true || item.result.is_error === true) return null;
  const structuredRaw = item.result.structured_content || item.result.structuredContent;
  const structured = plainObject(structuredRaw) ? structuredRaw : null;
  const textContent = textContentFrom(item.result);
  // Real Codex GitHub MCP results carry either structured_content or a text content block (or
  // both). A call with neither carries no observable evidence and is ignored.
  if (!structured && textContent === null) return null;
  return { tool, args: item.arguments, structured: structured || {}, textContent };
}

// Commit SHAs surface at different structured paths across GitHub MCP result shapes (a raw git
// commit, a contents write, or a ref update). Collect every 40-hex value at a known commit path and
// accept it only when the shapes agree; conflicting shapes are ambiguous and rejected.
const COMMIT_SHA_PATHS = [
  ["result", "sha"], ["sha"],
  ["result", "commit", "sha"], ["commit", "sha"],
  ["result", "object", "sha"], ["object", "sha"],
  ["commit_sha"], ["result", "commit_sha"],
];

function shaAtPath(root, path) {
  let node = root;
  for (const key of path) {
    if (!plainObject(node)) return null;
    node = node[key];
  }
  return normalizedSha(node);
}

function uniqueTextSha(textContent) {
  if (typeof textContent !== "string") return null;
  const matches = textContent.match(/[0-9a-f]{40}/gi);
  if (!matches) return null;
  const unique = new Set(matches.map((value) => value.toLowerCase()));
  return unique.size === 1 ? [...unique][0] : null;
}

function extractCommitSha(structured, textContent) {
  const candidates = new Set();
  for (const path of COMMIT_SHA_PATHS) {
    const sha = shaAtPath(structured, path);
    if (sha) candidates.add(sha);
  }
  if (candidates.size === 1) return [...candidates][0];
  if (candidates.size > 1) return null;
  return uniqueTextSha(textContent);
}

function startedGithubCall(event) {
  const item = event?.type === "item.started" ? event.item : null;
  if (!plainObject(item) || item.type !== "mcp_tool_call" || !plainObject(item.arguments)) return null;
  const tool = toolName(item);
  return tool ? { tool, args: item.arguments } : null;
}

function repositoryFrom(args) {
  return exactValue(args, ["repository_full_name", "repo_full_name", "repository"]);
}

function branchMatches(value, expected) {
  const branch = normalizedString(value);
  return branch === expected || branch === `refs/heads/${expected}` || branch === `heads/${expected}`;
}

function resultPullRequest(structured) {
  const candidate = plainObject(structured.pull_request) ? structured.pull_request : structured;
  if (!plainObject(candidate)) return null;
  const number = candidate.number;
  const url = normalizedString(candidate.url || candidate.html_url);
  const headSha = normalizedSha(candidate.head_sha);
  if (!Number.isSafeInteger(number) || number < 1 || !url || !headSha) return null;
  const body = typeof candidate.body === "string" && !candidate.body.includes("\u0000") &&
    Buffer.byteLength(candidate.body, "utf8") <= MAX_PR_BODY_BYTES
    ? candidate.body.normalize("NFC").replace(/\r\n?/g, "\n")
    : null;
  return {
    number,
    url,
    state: normalizedString(candidate.state)?.toLowerCase() || null,
    merged: candidate.merged,
    draft: candidate.draft,
    base: normalizedString(candidate.base),
    head: normalizedString(candidate.head),
    headSha,
    body,
  };
}

function pendingMergeMarker(runId, headSha) {
  const normalizedRunId = normalizedString(runId);
  const normalizedHeadSha = normalizedSha(headSha);
  if (!normalizedRunId || !RUN_ID_PATTERN.test(normalizedRunId) || !normalizedHeadSha) return null;
  return `COWORK_CODEX_GATE_V1 | run_id=${normalizedRunId} | head_sha=${normalizedHeadSha} | PENDING / DO NOT MERGE`;
}

function implementationCommitMessage({ runId, subject, problem, change, rationale, verification }) {
  const normalizedRunId = normalizedString(runId);
  if (!normalizedRunId || !RUN_ID_PATTERN.test(normalizedRunId)) return null;
  if (typeof subject !== "string" || subject !== subject.normalize("NFC") || subject.trim() !== subject ||
      !subject || /[\u0000-\u001f\u007f]/.test(subject) || Buffer.byteLength(subject, "utf8") > MAX_IMPLEMENTATION_COMMIT_SUBJECT_BYTES) return null;
  const sections = { Problem: problem, Change: change, Rationale: rationale, Verification: verification };
  for (const value of Object.values(sections)) {
    if (typeof value !== "string" || value !== value.normalize("NFC") || value.trim() !== value ||
        !value || /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value, "utf8") > MAX_IMPLEMENTATION_COMMIT_SECTION_BYTES) return null;
  }
  const message = [
    subject,
    "",
    `${IMPLEMENTATION_COMMIT_MARKER_PREFIX}${normalizedRunId}`,
    `Problem: ${problem}`,
    `Change: ${change}`,
    `Rationale: ${rationale}`,
    `Verification: ${verification}`,
  ].join("\n");
  if (
    Buffer.byteLength(message, "utf8") > MAX_IMPLEMENTATION_COMMIT_MESSAGE_BYTES ||
    message.includes("@") || /https?:\/\//i.test(message) ||
    message.includes("COWORK_CODEX_GATE_V1") || message.includes("COWORK_CODEX_PR_CONTEXT_V1")
  ) return null;
  return message;
}

function acceptedImplementationCommitMessage(value, runId) {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.includes("\r") ||
      Buffer.byteLength(value, "utf8") > MAX_IMPLEMENTATION_COMMIT_MESSAGE_BYTES) return null;
  const lines = value.split("\n");
  if (lines.length !== 7 || lines[1] !== "" || lines[2] !== `${IMPLEMENTATION_COMMIT_MARKER_PREFIX}${runId}`) return null;
  const prefixes = ["Problem: ", "Change: ", "Rationale: ", "Verification: "];
  const values = lines.slice(3).map((line, index) => line.startsWith(prefixes[index]) ? line.slice(prefixes[index].length) : null);
  if (values.some((item) => item === null)) return null;
  return implementationCommitMessage({ runId, subject: lines[0], problem: values[0], change: values[1], rationale: values[2], verification: values[3] }) === value
    ? value : null;
}

function validSeedImplementationCommit(value, context) {
  if (!plainObject(value) || Object.keys(value).sort().join(",") !== "branch,message,repository,runId,sha,status,tool") return null;
  const sha = normalizedSha(value.sha);
  if (
    value.status !== "branch_effective" || value.runId !== context.runId ||
    value.repository !== context.repository || value.branch !== context.taskBranch || !sha ||
    !["create_file", "update_file", "create_commit+update_ref"].includes(value.tool) ||
    acceptedImplementationCommitMessage(value.message, context.runId) !== value.message
  ) return null;
  return { ...value, sha };
}

function acceptedPendingMarkerLine(value, expected) {
  if (typeof value !== "string" || !expected) return null;
  const lines = value.normalize("NFC").replace(/\r\n?/g, "\n").split("\n");
  const candidates = lines.filter((line) => line.startsWith(PENDING_MARKER_PREFIX));
  if (candidates.length !== 1) return null;
  return candidates[0] === expected || candidates[0] === `${expected}.` ? candidates[0] : null;
}

function validSeedCertification(value, context) {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  const legacy = keys === "createdHeadSha,number,repository,runId,status,url";
  if (!legacy && keys !== "createdHeadSha,markerLine,number,repository,runId,status,url") return null;
  const createdHeadSha = normalizedSha(value.createdHeadSha);
  const canonicalMarker = pendingMergeMarker(context.runId, createdHeadSha);
  const markerLine = legacy ? canonicalMarker :
    (typeof value.markerLine === "string" && !/[\r\n]/.test(value.markerLine) ? value.markerLine.normalize("NFC") : null);
  if (
    value.status !== "pending_do_not_merge" || value.runId !== context.runId ||
    value.repository !== context.repository || !Number.isSafeInteger(value.number) || value.number < 1 ||
    value.url !== `https://github.com/${context.repository}/pull/${value.number}` || !createdHeadSha ||
    (markerLine !== canonicalMarker && markerLine !== `${canonicalMarker}.`)
  ) return null;
  return {
    status: "pending_do_not_merge",
    runId: context.runId,
    repository: context.repository,
    number: value.number,
    url: value.url,
    createdHeadSha,
    markerLine,
  };
}

function createObservationCollector(context) {
  const collectorContext = {
    runId: context.runId,
    repository: context.repository,
    baseBranch: context.baseBranch,
    taskBranch: context.taskBranch,
    taskType: context.taskType || null,
    auditPath: context.auditPath || null,
  };
  const pendingCertification = validSeedCertification(context.pendingCertification, collectorContext);
  return {
    context: collectorContext,
    count: 0,
    trustedGithubEvents: 0,
    totalFetchBytes: 0,
    auditReportFetchBytes: 0,
    auditRangeFetchBytes: 0,
    branchCreated: false,
    commitObserved: false,
    auditArtifactCommitted: false,
    auditReportWrite: null,
    headSha: null,
    pullRequest: null,
    pullRequestFetched: false,
    pendingCertification,
    pendingMarkerViolation: false,
    implementationCommitViolation: false,
    // One machine correction is offered per run for a corrigible commit-guard deviation; a prior
    // consumed correction is seeded across the correction resume so a repeat is terminal.
    implementationCorrectionUsed: context.implementationCorrectionUsed === true,
    latestImplementationCommit: validSeedImplementationCommit(context.implementationCommit, collectorContext),
    pendingImplementationCommits: [],
    fetches: [],
    auditReportFetches: [],
    auditRangeFetches: [],
  };
}

function validateImplementationCommitBeforeMutation(collector, state, event) {
  const call = startedGithubCall(event);
  if (!call) return { ok: true };
  const invalid = (rule) => ({
    ok: false,
    code: "IMPLEMENTATION_COMMIT_MESSAGE_INVALID",
    path: "implementation_commit_message",
    rule,
    expected: EXPECTED.HOST_EVIDENCE,
  });
  // A corrigible deviation names the rule and the exact expected correction instead of a silent
  // terminal block. The correctable flag is true only while the one per-run correction is unspent,
  // so a repeat of the same deviation after a correction resume is terminal.
  const correctable = (rule, expected) => ({
    ...invalid(rule),
    expected,
    correctable: !collector.implementationCorrectionUsed,
    correction: { rule, expected_action: expected },
  });
  if (call.tool === "add_comment_to_issue") return invalid("context_comment_not_authorized");
  if (call.tool === "update_pull_request" && Object.prototype.hasOwnProperty.call(call.args, "body")) {
    return {
      ok: false,
      code: "PR_BODY_MUTATION_INVALID",
      path: "pr_body.pending_marker",
      rule: "pull_request_body_update_not_authorized",
      expected: EXPECTED.HOST_EVIDENCE,
    };
  }
  if (state?.contract?.taskType !== "implementation") return { ok: true };
  if (IMPLEMENTATION_COMMIT_TOOLS.has(call.tool)) {
    if (repositoryFrom(call.args) !== collector.context.repository) return invalid("exact_repository_required");
    if (
      (call.tool === "create_file" || call.tool === "update_file") &&
      exactValue(call.args, ["branch", "branch_name"]) !== collector.context.taskBranch
    ) return invalid("exact_task_branch_required");
    if (acceptedImplementationCommitMessage(call.args.message, collector.context.runId) !== call.args.message) {
      return invalid("exact_bounded_run_commit_body_required");
    }
    if (
      collector.latestImplementationCommit?.message === call.args.message ||
      collector.pendingImplementationCommits.some((item) => item.message === call.args.message)
    ) return correctable("new_commit_requires_fresh_explanation", EXPECTED.FRESH_COMMIT_EXPLANATION);
    return { ok: true };
  }
  if (call.tool === "update_ref") {
    const sha = normalizedSha(call.args.sha);
    const structurallyValid =
      repositoryFrom(call.args) === collector.context.repository && call.args.force === false &&
      exactValue(call.args, ["branch_name"]) === collector.context.taskBranch && Boolean(sha);
    const observed = Boolean(sha) && collector.pendingImplementationCommits.some((item) => item.sha === sha);
    if (structurallyValid && observed) return { ok: true };
    // A force push, a foreign repository or branch, or a missing SHA is an out-of-scope or
    // unexplained write and stays terminal. A well-formed ref to a not-yet-observed explained
    // commit is the one corrigible case (the commit landed under an unread result shape, or the
    // SHAs were transposed) and earns one machine correction.
    if (structurallyValid) return correctable("update_ref_requires_observed_explained_commit", EXPECTED.OBSERVED_EXPLAINED_COMMIT);
    return invalid("update_ref_requires_observed_explained_commit");
  }
  if (call.tool === "create_pull_request") {
    const latest = collector?.latestImplementationCommit;
    if (!latest || latest.sha !== collector.headSha) return invalid("latest_branch_commit_must_be_explained");
    if (
      repositoryFrom(call.args) !== collector.context.repository ||
      exactValue(call.args, ["head", "head_branch"]) !== collector.context.taskBranch ||
      exactValue(call.args, ["base", "base_branch"]) !== collector.context.baseBranch || call.args.draft !== false ||
      call.args.body !== pendingMergeMarker(collector.context.runId, latest.sha)
    ) return invalid("pull_request_must_bind_latest_explained_commit");
  }
  return { ok: true };
}

function recordImplementationCommit(collector, sha, message, tool) {
  if (collector.context.taskType !== "implementation") return;
  if (!sha || acceptedImplementationCommitMessage(message, collector.context.runId) !== message) {
    collector.implementationCommitViolation = true;
    collector.latestImplementationCommit = null;
    return;
  }
  collector.latestImplementationCommit = {
    status: "branch_effective",
    runId: collector.context.runId,
    repository: collector.context.repository,
    branch: collector.context.taskBranch,
    sha,
    message,
    tool,
  };
}

function boundedPendingImplementationCommit(collector, commit) {
  collector.pendingImplementationCommits = collector.pendingImplementationCommits
    .filter((item) => item.sha !== commit.sha);
  collector.pendingImplementationCommits.push(commit);
  while (collector.pendingImplementationCommits.length > MAX_PENDING_IMPLEMENTATION_COMMITS) {
    collector.pendingImplementationCommits.shift();
  }
}

function pushBoundedFetch(collector, listName, bytesName, fetch, maximumCount, maximumBytes) {
  const list = collector[listName];
  while (list.length > 0 && (list.length >= maximumCount || collector[bytesName] + fetch.bytes > maximumBytes)) {
    const removed = list.shift();
    collector[bytesName] -= removed.bytes;
  }
  if (fetch.bytes > maximumBytes) return;
  list.push(fetch);
  collector[bytesName] += fetch.bytes;
}

function reconcileObservedAuditArtifact(collector) {
  if (!collector?.context?.auditPath || !collector.headSha || !collector.branchCreated || !collector.commitObserved) return;
  const reportFetch = collector.auditReportFetches.findLast((fetch) =>
    fetch.repository === collector.context.repository &&
    fetch.path === collector.context.auditPath &&
    fetch.ref === collector.headSha &&
    fetch.startLine === null && fetch.endLine === null
  );
  if (!reportFetch) return;
  collector.auditArtifactCommitted = true;
  collector.auditReportWrite = {
    content: reportFetch.content,
    headSha: collector.headSha,
    parsedBlock: parsedSingleAuditBlock(reportFetch.content),
  };
}

function observeGithubEvent(collector, event) {
  if (!collector) return;
  const call = completedGithubCall(event);
  if (!call) return;
  const { runId, repository, baseBranch, taskBranch, auditPath } = collector.context;
  if (repositoryFrom(call.args) !== repository) return;
  collector.count = Math.min(MAX_OBSERVATIONS, collector.count + 1);
  collector.trustedGithubEvents += 1;

  if (call.tool === "create_branch") {
    const branch = exactValue(call.args, ["branch_name", "branch"]);
    const hasSha = Object.prototype.hasOwnProperty.call(call.args, "sha");
    const hasBaseRef = Object.prototype.hasOwnProperty.call(call.args, "base_ref");
    const sourceSha = hasSha ? normalizedSha(call.args.sha) : null;
    const sourceBaseRef = hasBaseRef ? normalizedString(call.args.base_ref) : null;
    const validSource = hasSha !== hasBaseRef && (hasSha ? sourceSha !== null : sourceBaseRef === baseBranch);
    if (branch === taskBranch && validSource && normalizedString(call.structured.branch) === taskBranch) {
      collector.branchCreated = true;
      if (sourceSha) collector.headSha = sourceSha;
    }
    return;
  }

  if (call.tool === "create_file" || call.tool === "update_file") {
    const branch = exactValue(call.args, ["branch", "branch_name"]);
    const filePath = normalizedString(call.args.path);
    const commitSha = extractCommitSha(call.structured, call.textContent);
    if (branch === taskBranch && commitSha) {
      collector.branchCreated = true;
      collector.commitObserved = true;
      if (auditPath && filePath === auditPath) {
        collector.auditArtifactCommitted = true;
        const content = typeof call.args.content === "string" &&
          Buffer.byteLength(call.args.content, "utf8") <= MAX_AUDIT_REPORT_BYTES
          ? call.args.content : null;
        collector.auditReportWrite = {
          content,
          headSha: commitSha,
          parsedBlock: parsedSingleAuditBlock(content),
        };
      }
      collector.headSha = commitSha;
      recordImplementationCommit(collector, commitSha, call.args.message, call.tool);
    }
    return;
  }

  if (call.tool === "create_commit" && collector.context.taskType === "implementation") {
    const commitSha = extractCommitSha(call.structured, call.textContent);
    const message = call.args.message;
    if (!commitSha || acceptedImplementationCommitMessage(message, runId) !== message) {
      collector.implementationCommitViolation = true;
      return;
    }
    boundedPendingImplementationCommit(collector, { sha: commitSha, message, tool: call.tool });
    return;
  }

  if (call.tool === "update_ref" && collector.context.taskType === "implementation") {
    const result = plainObject(call.structured.result) ? call.structured.result : null;
    const resultObject = plainObject(result?.object) ? result.object : null;
    const requestedSha = normalizedSha(call.args.sha);
    const resultShaValues = [result?.sha, resultObject?.sha].filter((value) => value !== undefined);
    const resultRefValues = [result?.ref, result?.branch_name].filter((value) => value !== undefined);
    const richShaValid = resultShaValues.length === 0 || resultShaValues.every((value) => normalizedSha(value) === requestedSha);
    const richRefValid = resultRefValues.length === 0 || resultRefValues.every((value) => branchMatches(value, taskBranch));
    const requestedRef = exactValue(call.args, ["branch_name"]);
    const matchingCommit = collector.pendingImplementationCommits.findLast((item) => item.sha === requestedSha);
    if (
      requestedSha && call.args.force === false && requestedRef === taskBranch &&
      richShaValid && richRefValid && matchingCommit
    ) {
      collector.branchCreated = true;
      collector.commitObserved = true;
      collector.headSha = requestedSha;
      recordImplementationCommit(collector, requestedSha, matchingCommit.message, "create_commit+update_ref");
      collector.pendingImplementationCommits = collector.pendingImplementationCommits
        .filter((item) => item.sha !== requestedSha);
    } else {
      collector.implementationCommitViolation = true;
      collector.latestImplementationCommit = null;
    }
    return;
  }

  if (call.tool === "compare_commits") {
    const base = normalizedSha(call.args.base);
    const head = normalizedString(call.args.head);
    const structuredRepository = exactValue(call.structured, ["repository_full_name", "repo_full_name", "repository"]);
    const structuredBase = normalizedSha(call.structured.base);
    const structuredHead = normalizedString(call.structured.head);
    if (
      base && head === taskBranch && structuredRepository === repository &&
      structuredBase === base && structuredHead === taskBranch &&
      call.structured.status === "identical" && call.structured.ahead_by === 0 &&
      call.structured.behind_by === 0 && call.structured.total_commits === 0 &&
      Array.isArray(call.structured.files) && call.structured.files.length === 0
    ) {
      collector.branchCreated = true;
      collector.commitObserved = true;
      collector.headSha = base;
      reconcileObservedAuditArtifact(collector);
    }
    return;
  }

  if (call.tool === "create_pull_request" || FINAL_PR_READ_TOOLS.has(call.tool)) {
    const pullRequest = resultPullRequest(call.structured);
    if (!pullRequest) return;
    const argsHead = exactValue(call.args, ["head", "head_branch"]);
    const argsBase = exactValue(call.args, ["base", "base_branch"]);
    const argsNumber = call.args.pr_number;
    const argumentsMatch = call.tool === "create_pull_request"
      ? argsHead === taskBranch && argsBase === baseBranch && call.args.draft === false
      : Number.isSafeInteger(argsNumber) && argsNumber === pullRequest.number;
    if (
      argumentsMatch &&
      pullRequest.url === `https://github.com/${repository}/pull/${pullRequest.number}` &&
      pullRequest.state === "open" &&
      pullRequest.merged === false &&
      pullRequest.draft === false &&
      pullRequest.base === baseBranch &&
      pullRequest.head === taskBranch
    ) {
      collector.pullRequest = pullRequest;
      collector.headSha = pullRequest.headSha;
      if (FINAL_PR_READ_TOOLS.has(call.tool)) {
        collector.pullRequestFetched = true;
        if (pullRequest.body !== collector.pendingCertification?.markerLine) {
          collector.pendingMarkerViolation = true;
        }
      }
      if (call.tool === "create_pull_request") {
        const marker = pendingMergeMarker(runId, pullRequest.headSha);
        const argumentMarker = call.args.body === marker ? marker : null;
        const resultMarker = pullRequest.body === marker ? marker : null;
        if (argumentMarker && argumentMarker === resultMarker) {
          collector.pendingCertification = {
            status: "pending_do_not_merge",
            runId,
            repository,
            number: pullRequest.number,
            url: pullRequest.url,
            createdHeadSha: pullRequest.headSha,
            markerLine: argumentMarker,
          };
        } else {
          collector.pendingMarkerViolation = true;
          collector.pendingCertification = null;
        }
      }
    }
    return;
  }

  if (call.tool !== "fetch_file") return;
  const content = call.structured.content;
  const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : MAX_FETCH_CONTENT_BYTES + 1;
  const argsEncoding = normalizedString(call.args.encoding || "utf-8")?.toLowerCase();
  const resultEncoding = normalizedString(call.structured.encoding || "utf-8")?.toLowerCase();
  const sha = normalizedSha(call.structured.sha);
  const ref = normalizedSha(call.args.ref);
  const filePath = normalizedString(call.args.path);
  if (
    typeof content !== "string" ||
    bytes > MAX_FETCH_CONTENT_BYTES ||
    !sha || !ref || !filePath ||
    !["utf-8", "utf8"].includes(argsEncoding) ||
    !["utf-8", "utf8"].includes(resultEncoding)
  ) return;
  const startLine = call.args.start_line;
  const endLine = call.args.end_line;
  if ((startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1)) ||
      (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < 1))) return;
  const fetch = {
    repository,
    path: filePath,
    ref,
    startLine: startLine ?? null,
    endLine: endLine ?? null,
    blobSha: sha,
    content,
    bytes,
  };
  if (auditPath && filePath === auditPath && fetch.startLine === null && fetch.endLine === null) {
    pushBoundedFetch(
      collector,
      "auditReportFetches",
      "auditReportFetchBytes",
      fetch,
      MAX_AUDIT_REPORT_FETCHES,
      MAX_AUDIT_REPORT_BYTES,
    );
    reconcileObservedAuditArtifact(collector);
    return;
  }
  if (fetch.startLine !== null && fetch.endLine !== null) {
    pushBoundedFetch(
      collector,
      "auditRangeFetches",
      "auditRangeFetchBytes",
      fetch,
      MAX_AUDIT_RANGE_FETCHES,
      MAX_AUDIT_RANGE_BYTES,
    );
    return;
  }
  if (collector.fetches.length >= MAX_FETCHES || collector.totalFetchBytes + bytes > MAX_TOTAL_FETCH_BYTES) return;
  collector.totalFetchBytes += bytes;
  collector.fetches.push(fetch);
}

function hasPendingCertification(collector, pullRequest = collector?.pullRequest) {
  const certification = collector?.pendingCertification;
  return Boolean(
    !collector?.pendingMarkerViolation && pullRequest && certification &&
    certification.status === "pending_do_not_merge" &&
    certification.runId === collector.context.runId &&
    certification.repository === collector.context.repository &&
    certification.number === pullRequest.number && certification.url === pullRequest.url &&
    normalizedSha(certification.createdHeadSha) &&
    [pendingMergeMarker(certification.runId, certification.createdHeadSha), `${pendingMergeMarker(certification.runId, certification.createdHeadSha)}.`]
      .includes(certification.markerLine)
  );
}

function trustedObservation(collector, running) {
  if (!collector) return { partialEvidence: null, leftoverResources: [] };
  const pullRequest = collector.pullRequest;
  const partialEvidence = collector.branchCreated || pullRequest ? {
    repository: collector.context.repository,
    base_branch: collector.context.baseBranch,
    task_branch: collector.context.taskBranch,
    head_sha: pullRequest?.headSha || collector.headSha,
    pr_number: pullRequest?.number || null,
    pr_url: pullRequest?.url || null,
    last_completed_phase: collector.pullRequestFetched ? "pr_verified" :
      pullRequest ? "pr_created" :
      collector.commitObserved && collector.headSha ? (running ? "commit_observed" :
        collector.auditArtifactCommitted && collector.context.auditPath ? "audit_artifact_committed_pr_missing" : "commit_without_pr") :
      "branch_created",
  } : null;
  const leftoverResources = [];
  if (collector.branchCreated || pullRequest) {
    leftoverResources.push({
      kind: "branch",
      repository: collector.context.repository,
      name: collector.context.taskBranch,
    });
  }
  if (pullRequest) {
    leftoverResources.push({
      kind: "pull_request",
      repository: collector.context.repository,
      number: pullRequest.number,
      url: pullRequest.url,
      state: pullRequest.state,
      draft: pullRequest.draft,
      certification_status: hasPendingCertification(collector, pullRequest) ? "pending_do_not_merge" : "unverified",
    });
  } else if (!running && collector.commitObserved && collector.headSha) {
    const auditResidue = collector.auditArtifactCommitted && collector.context.auditPath;
    leftoverResources.push({
      kind: auditResidue ? "audit_artifact_committed_pr_missing" : "commit_without_pr",
      repository: collector.context.repository,
      base_branch: collector.context.baseBranch,
      branch: collector.context.taskBranch,
      head_sha: collector.headSha,
      ...(auditResidue ? { artifact_path: collector.context.auditPath } : {}),
      pr_missing: true,
      pr_number: null,
      pr_url: null,
      required_pr_body_marker: pendingMergeMarker(collector.context.runId, collector.headSha),
      accepted_terminal_period: true,
      recovery_status: "manual_pr_creation_required",
      recovery_instruction: MANUAL_PR_RECOVERY_INSTRUCTION,
    });
  }
  return { partialEvidence, leftoverResources };
}

function trustedPublicObservation(collector) {
  return trustedObservation(collector, false);
}

function trustedRunningObservation(collector) {
  return trustedObservation(collector, true);
}

function validateObservedPullRequest(collector, envelope) {
  if (envelope.status !== "complete") return { ok: true };
  const observed = collector?.pullRequest;
  if (!observed) return { ok: false, path: "pr_identity", rule: "successful_same_pr_fetch_or_create_required" };
  if (!collector.pullRequestFetched) {
    return { ok: false, path: "pr_identity", rule: "successful_final_same_pr_fetch_required" };
  }
  if (collector.context.taskType === "implementation") {
    if (
      collector.implementationCommitViolation || !collector.latestImplementationCommit ||
      collector.latestImplementationCommit.sha !== observed.headSha
    ) return { ok: false, path: "implementation_commit_message", rule: "final_pr_head_must_match_latest_explained_commit" };
  }
  if (
    observed.number !== envelope.pr_number ||
    observed.url !== envelope.pr_url ||
    observed.headSha !== envelope.head_sha ||
    observed.head !== envelope.task_branch ||
    observed.base !== envelope.base_branch
  ) return { ok: false, path: "pr_identity", rule: "host_observed_pr_identity_must_match_envelope" };
  if (!hasPendingCertification(collector, observed)) {
    return { ok: false, path: "pr_body.pending_marker", rule: "pending_do_not_merge_marker_required" };
  }
  return { ok: true };
}

function canonicalAuditBlock(state, envelope) {
  return {
    schema: "cowork-codex-audit-evidence/v1",
    repository: state.contract.repository,
    base_branch: state.contract.baseBranch,
    report_path: state.auditPath,
    audit_evidence: envelope.audit_evidence,
  };
}

function auditEvidenceBlock(state, envelope) {
  return `${AUDIT_BLOCK_START}\n${JSON.stringify(canonicalAuditBlock(state, envelope))}\n${AUDIT_BLOCK_END}`;
}

function parsedSingleAuditBlock(content) {
  if (typeof content !== "string") return { status: "schema_invalid", value: null, path: "audit_artifact.evidence_block", rule: "type_mismatch" };
  if (content.split(AUDIT_BLOCK_START).length !== 2 || content.split(AUDIT_BLOCK_END).length !== 2) {
    return { status: "missing_or_duplicate", value: null, path: "audit_artifact.evidence_block", rule: "report_block_missing_or_duplicate" };
  }
  const start = content.indexOf(AUDIT_BLOCK_START);
  const end = content.indexOf(AUDIT_BLOCK_END, start + AUDIT_BLOCK_START.length);
  if (start < 0 || end < 0) return { status: "missing_or_duplicate", value: null, path: "audit_artifact.evidence_block", rule: "report_block_missing_or_duplicate" };
  const raw = content.slice(start + AUDIT_BLOCK_START.length, end).trim();
  try {
    const parsed = JSON.parse(raw);
    return plainObject(parsed)
      ? { status: "ok", value: parsed }
      : { status: "schema_invalid", value: null, path: "audit_artifact.evidence_block", rule: "type_mismatch" };
  } catch {
    return { status: "json_parse_failed", value: null, path: "audit_artifact.evidence_block", rule: "json_parse_failed" };
  }
}

function exactKeys(value, expected, path) {
  if (!plainObject(value)) return { ok: false, path, rule: "type_mismatch" };
  const unknown = Object.keys(value).find((key) => !expected.includes(key));
  if (unknown) return { ok: false, path: `${path}.${unknown}`, rule: "unknown_key" };
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) return { ok: false, path: `${path}.${missing}`, rule: "required_field_missing" };
  return { ok: true };
}

function validateParsedAuditBlock(parsed, state) {
  const rootKeys = ["schema", "repository", "base_branch", "report_path", "audit_evidence"];
  let result = exactKeys(parsed, rootKeys, "audit_artifact.evidence_block");
  if (!result.ok) return result;
  const bindings = [
    ["schema", "cowork-codex-audit-evidence/v1"],
    ["repository", state.contract.repository],
    ["base_branch", state.contract.baseBranch],
    ["report_path", state.auditPath],
  ];
  for (const [key, expected] of bindings) {
    if (typeof parsed[key] !== "string") return { ok: false, path: `audit_artifact.evidence_block.${key}`, rule: "type_mismatch" };
    if (parsed[key] !== expected) return { ok: false, path: `audit_artifact.evidence_block.${key}`, rule: "value_mismatch" };
  }
  const evidencePath = "audit_artifact.evidence_block.audit_evidence";
  try {
    const auditEvidence = normalizeAuditEvidence(parsed.audit_evidence, {
      path: evidencePath,
      allowLegacyVerificationArray: false,
    });
    return {
      ok: true,
      value: {
        schema: parsed.schema,
        repository: parsed.repository,
        base_branch: parsed.base_branch,
        report_path: parsed.report_path,
        audit_evidence: auditEvidence,
      },
    };
  } catch (error) {
    const validation = error?.publicValidationError;
    return validation && typeof validation.path === "string" && typeof validation.rule === "string"
      ? { ok: false, path: validation.path, rule: validation.rule, expected: validation.expected }
      : { ok: false, path: evidencePath, rule: "strict_schema" };
  }
}

function parsedWrittenAuditBlock(collector, state) {
  if (!collector?.auditReportWrite?.content) {
    return { ok: false, code: "AUDIT_EVIDENCE_BLOCK_INVALID", path: "audit_artifact.evidence_block", rule: "report_write_missing", expected: EXPECTED.HOST_EVIDENCE };
  }
  const parsed = collector.auditReportWrite.parsedBlock || parsedSingleAuditBlock(collector.auditReportWrite.content);
  if (parsed.status === "json_parse_failed") {
    return { ok: false, code: "AUDIT_EVIDENCE_BLOCK_PARSE_FAILED", path: parsed.path, rule: parsed.rule, expected: EXPECTED.HOST_EVIDENCE };
  }
  if (parsed.status !== "ok") {
    return { ok: false, code: "AUDIT_EVIDENCE_BLOCK_INVALID", path: parsed.path, rule: parsed.rule, expected: EXPECTED.HOST_EVIDENCE };
  }
  const validation = validateParsedAuditBlock(parsed.value, state);
  return validation.ok
    ? { ok: true, value: validation.value }
    : { ok: false, code: "AUDIT_EVIDENCE_BLOCK_INVALID", path: validation.path, rule: validation.rule, expected: validation.expected || EXPECTED.HOST_EVIDENCE };
}

function validateAuditReportBeforePullRequest(collector, state, event) {
  if (state.contract.taskType !== "audit") return { ok: true };
  const call = startedGithubCall(event);
  if (!call || call.tool !== "create_pull_request") return { ok: true };
  const parsed = parsedWrittenAuditBlock(collector, state);
  if (!parsed.ok) return parsed;
  const write = collector.auditReportWrite;
  const finalHeadSha = normalizedSha(collector.headSha);
  if (!finalHeadSha) return { ok: false, code: "AUDIT_EVIDENCE_BLOCK_INVALID", path: "audit_artifact.report_fetch", rule: "final_head_missing" };
  const reportFetch = collector.auditReportFetches.findLast((fetch) =>
    fetch.repository === state.contract.repository && fetch.path === state.auditPath &&
    fetch.ref === finalHeadSha && fetch.startLine === null && fetch.endLine === null
  );
  if (!reportFetch) return { ok: false, code: "AUDIT_EVIDENCE_BLOCK_INVALID", path: "audit_artifact.report_fetch", rule: "report_fetch_missing" };
  if (reportFetch.content !== write.content) {
    return { ok: false, code: "AUDIT_EVIDENCE_BLOCK_INVALID", path: "audit_artifact.report_fetch", rule: "report_fetch_mismatch" };
  }
  const evidence = parsed.value.audit_evidence;
  for (let index = 0; index < evidence.line_evidence.length; index += 1) {
    const item = evidence.line_evidence[index];
    const found = collector.auditRangeFetches.some((fetch) =>
      fetch.repository === state.contract.repository && fetch.path === item.path &&
      fetch.ref === evidence.audited_sha.toLowerCase() && fetch.startLine === item.start_line &&
      fetch.endLine === item.end_line && fetch.content === item.snippet
    );
    if (!found) return { ok: false, code: "AUDIT_EVIDENCE_BLOCK_INVALID", path: `audit_evidence.line_evidence[${index}]`, rule: "range_fetch_missing_or_mismatch" };
  }
  return { ok: true };
}

function deepStructuralEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => deepStructuralEqual(item, right[index]));
  }
  if (!plainObject(left) || !plainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepStructuralEqual(left[key], right[key]));
}

function firstStructuralDifference(expected, observed, path) {
  if (Object.is(expected, observed)) return null;
  if (expected === null || observed === null) return { path, claimed: expected, observed };
  if (Array.isArray(expected) || Array.isArray(observed)) {
    if (!Array.isArray(expected) || !Array.isArray(observed) || expected.length !== observed.length) {
      return { path, claimed: expected, observed };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstStructuralDifference(expected[index], observed[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (plainObject(expected) || plainObject(observed)) {
    if (!plainObject(expected) || !plainObject(observed)) return { path, claimed: expected, observed };
    const expectedKeys = Object.keys(expected).sort();
    const observedKeys = Object.keys(observed).sort();
    const missing = expectedKeys.find((key) => !Object.prototype.hasOwnProperty.call(observed, key));
    if (missing) return { path: `${path}.${missing}`, claimed: expected[missing], observed: undefined };
    const unexpected = observedKeys.find((key) => !Object.prototype.hasOwnProperty.call(expected, key));
    if (unexpected) return { path: `${path}.${unexpected}`, claimed: undefined, observed: observed[unexpected] };
    for (const key of expectedKeys) {
      const difference = firstStructuralDifference(expected[key], observed[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return { path, claimed: expected, observed };
}

function boundedScalarPreview(value, path) {
  const typeSummary = Array.isArray(value) ? `array(length=${value.length})`
    : plainObject(value) ? `object(keys=${Object.keys(value).length})`
      : value === undefined ? "undefined" : value === null ? "null" : String(value);
  const raw = Buffer.from(typeSummary, "utf8");
  const secretLike = typeof value === "string" && /(?:\b(?:api[_ -]?key|password|secret|token)\b|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{16,}\.)/i.test(value);
  const sensitive = /(?:^|\.)snippet$/.test(path) || secretLike || /[\u0000-\u001f\u007f]/.test(typeSummary) || typeof value === "object";
  let prefix = typeSummary;
  let truncated = raw.length > 48;
  if (sensitive) {
    prefix = /(?:^|\.)snippet$/.test(path) && typeof value === "string"
      ? `${[...value].slice(0, 12).join("")}…`
      : `[${Array.isArray(value) ? "array" : plainObject(value) ? "object" : secretLike ? "redacted" : "escaped-control"}]`;
    truncated = true;
  } else if (truncated) {
    let bytes = 0;
    prefix = "";
    for (const character of typeSummary) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > 48) break;
      prefix += character;
      bytes += size;
    }
    prefix += "…";
  }
  const preview = JSON.stringify(prefix).slice(1, -1);
  return {
    preview,
    utf8_bytes: raw.length,
    truncated,
    sensitive,
    ...((truncated || sensitive) ? { sha256: createHash("sha256").update(raw).digest("hex") } : {}),
  };
}

function boundedMismatch(claimed, observed, path) {
  return {
    envelope: boundedScalarPreview(claimed, path),
    artifact: boundedScalarPreview(observed, path),
  };
}

function validateObservedAuditEvidence(collector, state, envelope) {
  if (envelope.status !== "complete" || state.contract.taskType !== "audit") return { ok: true };
  const reportFetches = collector.auditReportFetches.filter((fetch) =>
    fetch.repository === state.contract.repository &&
    fetch.path === state.auditPath &&
    fetch.ref === envelope.head_sha &&
    fetch.startLine === null &&
    fetch.endLine === null
  );
  if (reportFetches.length < 1) {
    return { ok: false, path: "audit_artifact.report_fetch", rule: "report_fetch_missing" };
  }
  const parsedReport = parsedSingleAuditBlock(reportFetches.at(-1).content);
  if (parsedReport.status === "missing_or_duplicate") {
    return { ok: false, path: "audit_artifact.evidence_block", rule: "report_block_missing_or_duplicate" };
  }
  if (parsedReport.status === "json_parse_failed") {
    return { ok: false, path: parsedReport.path, rule: parsedReport.rule };
  }
  if (parsedReport.status !== "ok") {
    return { ok: false, path: parsedReport.path, rule: parsedReport.rule };
  }
  const structuralValidation = validateParsedAuditBlock(parsedReport.value, state);
  if (!structuralValidation.ok) return structuralValidation;
  const observedAuditEvidence = structuralValidation.value.audit_evidence;
  if (envelope.audit_evidence !== null && !deepStructuralEqual(envelope.audit_evidence, observedAuditEvidence)) {
    const difference = firstStructuralDifference(
      envelope.audit_evidence,
      observedAuditEvidence,
      "audit_artifact.evidence_block.audit_evidence",
    );
    return {
      ok: false,
      path: difference.path,
      rule: "report_block_mismatch",
      mismatch: boundedMismatch(difference.claimed, difference.observed, difference.path),
    };
  }
  for (let index = 0; index < observedAuditEvidence.line_evidence.length; index += 1) {
    const evidence = observedAuditEvidence.line_evidence[index];
    const matchingFetch = collector.auditRangeFetches.some((fetch) =>
      fetch.repository === state.contract.repository &&
      fetch.path === evidence.path &&
      fetch.ref === observedAuditEvidence.audited_sha &&
      fetch.startLine === evidence.start_line &&
      fetch.endLine === evidence.end_line &&
      fetch.content === evidence.snippet
    );
    if (!matchingFetch) {
      return { ok: false, path: `audit_evidence.line_evidence[${index}]`, rule: "range_fetch_missing_or_mismatch" };
    }
  }
  return { ok: true, auditEvidence: observedAuditEvidence };
}

module.exports = {
  AUDIT_BLOCK_END,
  AUDIT_BLOCK_START,
  MAX_FETCHES,
  MAX_OBSERVATIONS,
  MANUAL_PR_RECOVERY_INSTRUCTION,
  acceptedPendingMarkerLine,
  acceptedImplementationCommitMessage,
  auditEvidenceBlock,
  completedGithubCall,
  createObservationCollector,
  observeGithubEvent,
  pendingMergeMarker,
  implementationCommitMessage,
  trustedPublicObservation,
  trustedRunningObservation,
  validateAuditReportBeforePullRequest,
  validateImplementationCommitBeforeMutation,
  validateObservedAuditEvidence,
  validateObservedPullRequest,
};
