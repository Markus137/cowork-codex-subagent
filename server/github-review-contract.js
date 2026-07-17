"use strict";

const EXPECTED_BOT_ACTOR = "chatgpt-codex-connector[bot]";
const CANONICAL_PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3"]);

function normalizeActorLogin(value) {
  if (typeof value !== "string") return null;
  const login = value.normalize("NFC").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37})(?:\[bot\])?$/.test(login)) return null;
  return login.endsWith("[bot]") ? login.slice(0, -5) : login;
}

function isExpectedBotActor(login, configuredActor = EXPECTED_BOT_ACTOR) {
  const candidate = normalizeActorLogin(login);
  const configured = normalizeActorLogin(configuredActor);
  return candidate !== null && configured !== null && candidate === configured;
}

function validInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStrictlyAfter(value, threshold) {
  return validInstant(value) && validInstant(threshold) && Date.parse(value) > Date.parse(threshold);
}

function validContext(context, timeField) {
  return Boolean(
    context &&
    typeof context.expectedHeadSha === "string" &&
    /^[0-9a-f]{40}$/i.test(context.expectedHeadSha) &&
    String(context.currentHeadSha).toLowerCase() === context.expectedHeadSha.toLowerCase() &&
    context.headChangeEventsSinceBoundary === 0 &&
    (typeof context.prNumber === "string" || Number.isSafeInteger(context.prNumber)) &&
    String(context.prNumber).length > 0 &&
    typeof context.prUrl === "string" &&
    context.prUrl.length > 0 &&
    validInstant(context[timeField]),
  );
}

function reviewPrefixMatchesExpected(prefix, context) {
  if (typeof prefix !== "string" || !/^[0-9a-f]{10,40}$/i.test(prefix)) return false;
  if (!Array.isArray(context.knownCommitShas) || context.knownCommitShas.length === 0) return false;
  const normalizedPrefix = prefix.toLowerCase();
  const known = [...new Set(context.knownCommitShas.map((sha) => String(sha).toLowerCase()))];
  if (known.some((sha) => !/^[0-9a-f]{40}$/.test(sha))) return false;
  const matches = known.filter((sha) => sha.startsWith(normalizedPrefix));
  return matches.length === 1 && matches[0] === context.expectedHeadSha.toLowerCase();
}

function extractReviewedCommitPrefix(body) {
  const scan = scanReviewedCommitMarkers(body);
  return scan.status === "canonical" ? scan.prefix : null;
}

function scanReviewedCommitMarkers(body) {
  if (typeof body !== "string") return { status: "malformed", prefix: null };
  const candidates = body.replace(/\r\n/g, "\n").split("\n").flatMap((line) => {
    if (!/reviewed commit/i.test(line)) return [];
    const plain = /^Reviewed commit: ([0-9a-fA-F]{10,40})$/.exec(line);
    const markdown = /^\*\*Reviewed commit:\*\* `([0-9a-fA-F]{10,40})`$/.exec(line);
    return [{ prefix: plain?.[1] || markdown?.[1] || null }];
  });
  if (candidates.length === 0) return { status: "absent", prefix: null };
  if (candidates.length > 1) return { status: "multiple", prefix: null };
  return candidates[0].prefix
    ? { status: "canonical", prefix: candidates[0].prefix }
    : { status: "malformed", prefix: null };
}

function canonicalPriority(body) {
  const scan = scanPriorityMarkers(body);
  return scan.status === "canonical" ? scan.priority : null;
}

function scanPriorityMarkers(body) {
  if (typeof body !== "string") return { status: "malformed", priority: null };
  const candidates = [];
  const ranges = [];
  const record = (match, canonicalPattern, tokenPattern) => {
    const token = tokenPattern.exec(match[0]);
    const canonical = canonicalPattern.exec(match[0]);
    candidates.push({
      priority: canonical ? `P${canonical[1]}` : null,
      token: token ? Number(token[1]) : null,
    });
    ranges.push([match.index, match.index + match[0].length]);
  };

  for (const match of body.matchAll(/!\[[^\]\r\n]*\](?:\([^\)\r\n]*\))?/g)) {
    if (/^!\[\s*P/i.test(match[0])) {
      record(match, /^!\[P([0-3]) Badge\](?:\([^\)\r\n]*\))?$/, /P(\d+)/i);
    }
  }
  for (const match of body.matchAll(/^[ \t]*-\s*\[[^\]\r\n]*\][^\r\n]*$/gm)) {
    if (/^[ \t]*-\s*\[\s*P/i.test(match[0])) {
      record(match, /^[ \t]*-\s*\[P([0-3])\]\s+.+$/, /P(\d+)/i);
    }
  }

  const characters = body.split("");
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index += 1) characters[index] = " ";
  }
  const residual = characters.join("");
  for (const match of residual.matchAll(/\bP(\d+)\b/gi)) {
    candidates.push({ priority: null, token: Number(match[1]) });
  }

  if (candidates.length === 0) return { status: "absent", priority: null };
  if (candidates.length > 1) return { status: "multiple", priority: null };
  const candidate = candidates[0];
  if (candidate.priority) return { status: "canonical", priority: candidate.priority };
  return {
    status: Number.isSafeInteger(candidate.token) && candidate.token > 3 ? "unknown" : "malformed",
    priority: null,
  };
}

function rejected(reason) {
  return { accepted: false, verdict: "not_accepted", priorities: [], findings: [], reason };
}

function accepted(verdict, findings = []) {
  return {
    accepted: true,
    verdict,
    priorities: findings.map((finding) => finding.priority),
    findings,
    reason: "ACCEPTED",
  };
}

function actorAndTimeMatch(event, threshold) {
  return isExpectedBotActor(event?.actorLogin) && isStrictlyAfter(event?.createdAt, threshold);
}

function validReviewId(value) {
  return (Number.isSafeInteger(value) && value > 0) || (typeof value === "string" && value.length > 0);
}

function evaluateReviewBundle(event, context, threshold) {
  if (event?.kind !== "review_bundle" || !event.submission || !Array.isArray(event.comments)) return null;
  const submission = event.submission;
  if (!actorAndTimeMatch(submission, threshold)) return null;
  const prefix = extractReviewedCommitPrefix(submission.body);
  if (!reviewPrefixMatchesExpected(prefix, context)) return null;
  if (scanPriorityMarkers(submission.body).status !== "absent") return null;
  if (!validReviewId(submission.id)) return null;
  const reviewId = String(submission.id);

  const findings = [];
  for (const comment of event.comments) {
    const priorityScan = scanPriorityMarkers(comment?.body);
    const priority = priorityScan.status === "canonical" ? priorityScan.priority : null;
    if (
      !validReviewId(comment?.pullRequestReviewId) ||
      String(comment.pullRequestReviewId) !== reviewId ||
      !actorAndTimeMatch(comment, threshold) ||
      !priority ||
      typeof comment.url !== "string" || !comment.url ||
      typeof comment.path !== "string" || !comment.path ||
      !Number.isSafeInteger(comment.line) || comment.line < 1
    ) return null;
    findings.push({
      priority,
      body: comment.body,
      url: comment.url,
      path: comment.path,
      line: comment.line,
    });
  }
  return findings;
}

function evaluateInitialEvidence(context, event) {
  if (!validContext(context, "readyAt")) return rejected("INITIAL_CONTEXT_MISMATCH");
  if (event?.kind === "reaction") {
    if (!actorAndTimeMatch(event, context.readyAt)) return rejected("INITIAL_ACTOR_OR_TIME_MISMATCH");
    const clean =
      event.targetType === "pull_request" &&
      String(event.targetId) === String(context.prNumber) &&
      event.targetUrl === context.prUrl &&
      event.content === "+1";
    return clean ? accepted("clean") : rejected("INITIAL_EVIDENCE_UNSCOPED");
  }
  const findings = evaluateReviewBundle(event, context, context.readyAt);
  return findings ? accepted(findings.length === 0 ? "clean" : "findings", findings) : rejected("INITIAL_REVIEW_BUNDLE_INVALID");
}

function validFinalContext(context) {
  return Boolean(
    validContext(context, "finalTriggerCreatedAt") &&
    (typeof context.finalTriggerCommentId === "string" || Number.isSafeInteger(context.finalTriggerCommentId)) &&
    String(context.finalTriggerCommentId).length > 0 &&
    typeof context.finalTriggerUrl === "string" &&
    context.finalTriggerUrl.length > 0,
  );
}

function evaluateFinalEvidence(context, event) {
  if (!validFinalContext(context)) return rejected("FINAL_CONTEXT_MISMATCH");
  if (event?.kind === "reaction") {
    if (!actorAndTimeMatch(event, context.finalTriggerCreatedAt)) return rejected("FINAL_ACTOR_OR_TIME_MISMATCH");
    const clean =
      event.targetType === "issue_comment" &&
      String(event.targetId) === String(context.finalTriggerCommentId) &&
      event.targetUrl === context.finalTriggerUrl &&
      event.content === "+1";
    return clean ? accepted("clean") : rejected("FINAL_EVIDENCE_UNSCOPED");
  }
  if (event?.kind === "issue_comment") {
    if (!actorAndTimeMatch(event, context.finalTriggerCreatedAt)) return rejected("FINAL_ISSUE_COMMENT_INVALID");
    if (!validIssueCommentId(event.id) || String(event.id) === String(context.finalTriggerCommentId)) {
      return rejected("FINAL_ISSUE_COMMENT_INVALID");
    }
    const canonicalPrUrl = canonicalPullRequestUrl(context);
    if (
      !validIssueCommentId(context.finalTriggerCommentId) ||
      context.finalTriggerUrl !== `${canonicalPrUrl}#issuecomment-${String(context.finalTriggerCommentId)}` ||
      !canonicalPrUrl || String(event.prNumber) !== String(context.prNumber) || event.prUrl !== canonicalPrUrl ||
      event.url !== `${canonicalPrUrl}#issuecomment-${String(event.id)}` ||
      !Array.isArray(event.reviewComments) || event.reviewComments.length !== 0 ||
      !reviewPrefixMatchesExpected(extractReviewedCommitPrefix(event.body), context) ||
      scanPriorityMarkers(event.body).status !== "absent"
    ) return rejected("FINAL_ISSUE_COMMENT_INVALID");
    return accepted("clean");
  }
  const findings = evaluateReviewBundle(event, context, context.finalTriggerCreatedAt);
  return findings ? accepted(findings.length === 0 ? "clean" : "findings", findings) : rejected("FINAL_REVIEW_BUNDLE_INVALID");
}

function validIssueCommentId(value) {
  return (Number.isSafeInteger(value) && value > 0) || (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value));
}

function canonicalPullRequestUrl(context) {
  if (!validIssueCommentId(context?.prNumber) || typeof context?.prUrl !== "string") return null;
  const match = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/([1-9][0-9]*)$/.exec(context.prUrl);
  return match && match[1] === String(context.prNumber) ? context.prUrl : null;
}

module.exports = {
  CANONICAL_PRIORITIES,
  EXPECTED_BOT_ACTOR,
  canonicalPriority,
  evaluateFinalEvidence,
  evaluateInitialEvidence,
  evaluateReviewBundle,
  extractReviewedCommitPrefix,
  isExpectedBotActor,
  normalizeActorLogin,
  reviewPrefixMatchesExpected,
  scanPriorityMarkers,
  scanReviewedCommitMarkers,
  validIssueCommentId,
  validReviewId,
};
