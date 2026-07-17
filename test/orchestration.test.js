"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { PLUGIN_VERSION, PreflightError } = require("../server/bridge");
const { TOOLS, createRequestHandler } = require("../server/index");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function sourceFiles(directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "outputs") return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : [absolute];
  });
}

test("manifest, skills, and server expose one version", async () => {
  const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
  assert.equal(manifest.version, PLUGIN_VERSION);
  for (const skill of ["skills/codex-orchestration/SKILL.md", "skills/codex-preflight/SKILL.md"]) {
    assert.match(read(skill), new RegExp(`version: ${PLUGIN_VERSION.replaceAll(".", "\\.")}`));
  }
  assert.match(read("README.md"), new RegExp(`Version ${PLUGIN_VERSION.replaceAll(".", "\\.")}`));
  const messages = [];
  const { handle } = createRequestHandler({ send: (message) => messages.push(message) });
  await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(messages[0].result.serverInfo.version, PLUGIN_VERSION);
});

test("MCP surface has preflight, role state, narrow host jobs, and read-only evidence validators", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    "preflight_health",
    "preflight_codex_roundtrip",
    "orchestration_get_roles",
    "orchestration_set_role",
    "orchestration_codex_start",
    "orchestration_codex_status",
    "orchestration_codex_result",
    "orchestration_codex_resume",
    "orchestration_codex_cancel",
    "orchestration_validate_initial_review_evidence",
    "orchestration_validate_final_review_evidence",
  ]);
  assert.equal(fs.existsSync(path.join(root, "server", "review.js")), false);
  assert.equal(fs.existsSync(path.join(root, "test", "review.test.js")), false);
  const start = TOOLS.find((tool) => tool.name === "orchestration_codex_start");
  assert.deepEqual(start.inputSchema.properties.task_type, {
    type: "string",
    enum: ["implementation", "audit"],
  });
  assert.equal(start.inputSchema.required.includes("task_type"), true);
  assert.deepEqual(start.inputSchema.properties.wall_clock_limit_minutes, {
    type: "integer", minimum: 15, maximum: 120, default: 45,
  });
  assert.equal(start.inputSchema.required.includes("wall_clock_limit_minutes"), false);
});

test("all job status outcomes retain structuredContent at RPC level while actual tool failures remain errors", async () => {
  const id = "CFT-20260715-141500-937C1AD8";
  const repository = "ExampleOrg/synthetic-audit";
  const report = (status) => ({
    status,
    run_id: id,
    phase: status === "blocked" ? "result_validation" : status,
    repository,
    created_at: "2026-07-15T14:15:00.000Z",
    updated_at: "2026-07-15T14:16:00.000Z",
    correction_resumes_used: 0,
    code: status === "blocked" ? "AUDIT_EVIDENCE_UNVERIFIED" : status === "incomplete" ? "JOB_TIMEOUT" : "JOB_CANCELLED",
    validation_error: { path: "audit_artifact.report_fetch", rule: "report_fetch_missing", expected: "raw secret expected value" },
    partial_evidence: {
      repository, base_branch: "main", task_branch: "sol/cft-20260715-141500-937c1ad8",
      head_sha: "2".repeat(40), pr_number: 937, pr_url: `https://github.com/${repository}/pull/937`,
      last_completed_phase: "pr_verified", nested_secret: "must-not-enter-structured-content",
    },
    leftover_resources: [
      { kind: "branch", repository, name: "sol/cft-20260715-141500-937c1ad8", nested_secret: "must-not-enter-structured-content" },
      { kind: "pull_request", repository, number: 937, url: `https://github.com/${repository}/pull/937`, state: "open", draft: false, certification_status: "pending_do_not_merge", nested_secret: "must-not-enter-structured-content" },
    ],
    internal_secret: "must-not-enter-text",
  });
  const reports = [report("blocked"), report("incomplete"), report("cancelled"), report("blocked"), report("cancelled")];
  const messages = [];
  const { handle } = createRequestHandler({
    send: (message) => messages.push(message),
    startJobImpl: () => reports[0],
    statusJobImpl: () => reports[1],
    resultJobImpl: () => reports[2],
    resumeJobImpl: () => reports[3],
    cancelJobImpl: () => reports[4],
  });
  const calls = [
    ["orchestration_codex_start", {}],
    ["orchestration_codex_status", { job_id: id }],
    ["orchestration_codex_result", { job_id: id }],
    ["orchestration_codex_resume", { job_id: id, findings: [{ body: "x", url: "https://example.test", path: "x", line: 1 }] }],
    ["orchestration_codex_cancel", { job_id: id }],
  ];
  for (let index = 0; index < calls.length; index += 1) {
    await handle({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: calls[index][0], arguments: calls[index][1] } });
  }
  assert.equal(messages.length, 5);
  for (let index = 0; index < messages.length; index += 1) {
    assert.equal(messages[index].result.isError, false);
    assert.notEqual(messages[index].result.structuredContent, reports[index]);
    assert.deepEqual(messages[index].result.structuredContent.validation_error, {
      path: "audit_artifact.report_fetch",
      rule: "report_fetch_missing",
      expected: "value satisfying the documented validation rule",
    });
    assert.match(messages[index].result.content[0].text, /validation_error=audit_artifact\.report_fetch:report_fetch_missing/);
    assert.match(messages[index].result.content[0].text, /pr:ExampleOrg\/synthetic-audit#937:open:non-draft:pending_do_not_merge/);
    assert.doesNotMatch(messages[index].result.content[0].text, /must-not-enter-text/);
    assert.doesNotMatch(messages[index].result.content[0].text, /raw secret expected value/);
    assert.equal(JSON.stringify(messages[index].result.structuredContent).includes("internal_secret"), false);
    assert.equal(JSON.stringify(messages[index].result.structuredContent).includes("must-not-enter-structured-content"), false);
    assert.equal(JSON.stringify(messages[index].result.structuredContent).includes("raw secret expected value"), false);
    assert.deepEqual(messages[index].result.structuredContent.leftover_resources.map(({ kind }) => kind), ["branch", "pull_request"]);
  }

  const failureMessages = [];
  const { handle: failHandle } = createRequestHandler({
    send: (message) => failureMessages.push(message),
    statusJobImpl: () => { throw new PreflightError("JOB_NOT_FOUND"); },
    resultJobImpl: () => { throw new PreflightError("JOB_STATE_INVALID"); },
    cancelJobImpl: () => { throw new Error("internal secret"); },
  });
  await failHandle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "orchestration_codex_status", arguments: {} } });
  await failHandle({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "orchestration_codex_status", arguments: { job_id: id } } });
  await failHandle({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "orchestration_codex_result", arguments: { job_id: id } } });
  await failHandle({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "orchestration_codex_cancel", arguments: { job_id: id } } });
  assert.deepEqual(failureMessages.map((message) => message.result.isError), [true, true, true, true]);
  assert.deepEqual(failureMessages.map((message) => message.result.structuredContent.code), [
    "JOB_INPUT_INVALID", "JOB_NOT_FOUND", "JOB_STATE_INVALID", "JOB_TOOL_FAILED",
  ]);
  assert.equal(JSON.stringify(failureMessages).includes("internal secret"), false);
});

test("one-way implementation uses one Cowork-native host job and GitHub MCP only", () => {
  const skill = read("skills/codex-orchestration/SKILL.md");
  assert.match(skill, /Call `orchestration_codex_start` exactly once/);
  assert.match(skill, /does not rely on a Cowork subagent/);
  assert.match(skill, /cannot supply a model,\s+executable, cwd, flags, environment, local path, callback, or shell command/);
  assert.match(skill, /repository_transport=GITHUB_MCP_ONLY/);
  assert.match(skill, /Fable must not create a bootstrap\s+branch, placeholder commit, task file, local checkout, or pull request/);
  assert.match(skill, /deterministic task branch `sol\/<lowercase-run-id>`/);
  assert.match(skill, /Only after SOL accepts V2, SOL personally creates the pull request directly\s+with `draft=false`/);
  assert.match(skill, /verify that it is open and non-draft/);
  for (const field of ["repository", "base_branch", "task_branch", "head_sha", "pr_number", "pr_url"]) {
    assert.match(skill, new RegExp(`\`${field}\``));
  }
});

test("task type, audit delivery, automatic permission review, and effective state are explicit", () => {
  const skill = read("skills/codex-orchestration/SKILL.md");
  const readme = read("README.md");
  for (const text of [skill, readme]) {
    assert.match(text, /task_type|`implementation` or[\s\S]+`audit`/);
    assert.match(text, /\.github\/audits\/<(?:lowercase-)?run-id>\.md/);
    assert.match(text, /same-SHA line evidence|same SHA/);
    assert.match(text, /`verification` (?:is|as)\s+exactly one non-empty string/);
    assert.match(text, /array containing exactly one non-empty\s+string|array containing exactly one non-empty string/);
    assert.match(text, /never exposes the legacy array|never exposes the legacy\s+array/);
    assert.match(text, /automatic approval\s+reviewer|automatic permission\s+reviewer|on-request automatic approval\s+reviewer/i);
    assert.match(text, /runtime safety\s+(?:reviewer|control)/);
    assert.match(text, /not Fable, SOL, Terra|not Fable,\s+SOL, Terra/);
    assert.match(text, /inner blocked\/no-PR outcome cannot|restrictive inner state wins/);
  }
  assert.match(skill, /approval_policy="on-request"/);
  assert.match(skill, /approvals_reviewer="auto_review"/);
  assert.match(skill, /GITHUB_WRITE_APPROVAL_ABORTED/);
  assert.match(skill, /No PR or null delivery can never become\s+`ready_for_quality_gate`/);
  assert.doesNotMatch(skill, /open a draft pull request|make the pull request ready for review/);
});

test("orchestration is the default for substantial repository-backed tasks while Fable stays mechanical", () => {
  const skill = read("skills/codex-orchestration/SKILL.md");
  const frontmatter = skill.slice(0, skill.indexOf("---", 4) + 3);
  for (const trigger of [
    "research", "analysis", "comparison", "planning", "implementation",
    "repository-backed", "document", "content", "connector-assisted",
  ]) assert.match(frontmatter, new RegExp(trigger, "i"));
  assert.match(frontmatter, /even when the user does not mention Codex,\s+agents/);
  assert.match(frontmatter, /Do\s+not use for general fileless work without a target repository/);
  assert.match(skill, /Treat every substantial repository-backed task stated directly by the user as\s+a request to run this workflow/);
  assert.match(skill, /minimum mechanical reads\s+needed to assemble a bounded source pack/);
  assert.match(skill, /Do not synthesize, rank, infer,\s+select a conclusion/);
  assert.match(skill, /start exactly one host-side SOL job/);
  assert.match(skill, /SOL remains\s+the senior manager, delegates substantive work to Terra, reviews Terra V1/);
  assert.match(skill, /Fable must not research beyond the mechanical source-pack collection above,\s+analyze, recommend, plan, draft the substantive artifact, implement, repair,\s+review/);
  assert.match(skill, /general fileless\s+research, analysis, planning, document, content, or connector request without\s+a concrete target repository, do not start the GitHub mutation job/);
  assert.match(skill, /Never invent or request a dummy coordination repository/);
  assert.match(skill, /do not take over the\s+substantive work as a fallback/);
  assert.match(skill, /current host bridge is repository-scoped/);
  assert.match(skill, /For truly\s+fileless substantive work without a concrete target repository, do not call\s+`orchestration_codex_start`/);
  assert.doesNotMatch(skill, /SOL still delegates to Terra when the collaboration runtime supports it/);
  assert.match(skill, /Directly answer only short follow-up questions,\s+installation instructions, status or confirmation requests, greetings, and\s+safety-critical clarifications/);
});

test("trigger eval fixture covers realistic should and should-not cases", () => {
  const evaluations = JSON.parse(read("test/fixtures/orchestration-trigger-evals.json"));
  assert.equal(evaluations.should_trigger.length, 15);
  assert.equal(evaluations.should_not_trigger.length, 17);
  const all = [...evaluations.should_trigger, ...evaluations.should_not_trigger];
  assert.equal(new Set(all.map(({ id }) => id)).size, all.length);
  for (const entry of all) {
    assert.deepEqual(Object.keys(entry).sort(), ["id", "prompt"]);
    assert.equal(typeof entry.prompt, "string");
    assert.ok(entry.prompt.length >= 6);
  }
  assert.deepEqual(evaluations.should_trigger.map(({ id }) => id), [
    "repo_research", "repo_analysis", "repo_comparison", "repo_planning",
    "repo_implementation", "repo_review", "repo_document", "repo_content",
    "repo_connector", "repo_explicit", "repo_research_en", "repo_planning_en",
    "repo_implementation_en", "repo_document_en", "repo_connector_en",
  ]);
  assert.deepEqual(evaluations.should_not_trigger.map(({ id }) => id), [
    "fileless_research", "fileless_analysis", "fileless_comparison",
    "fileless_planning", "fileless_document", "fileless_connector", "greeting",
    "installation", "status", "confirmation", "short_followup",
    "safety_clarification", "fileless_research_en", "fileless_connector_en",
    "installation_en", "status_en", "short_followup_en",
  ]);
});

test("task-type fixture and skill distinguish discovery from known changes", () => {
  const evaluations = JSON.parse(read("test/fixtures/task-type-classification-evals.json"));
  assert.deepEqual(Object.keys(evaluations).sort(), ["audit", "implementation"]);
  assert.equal(evaluations.audit.length, 3);
  assert.equal(evaluations.implementation.length, 3);
  const all = [...evaluations.audit, ...evaluations.implementation];
  assert.equal(new Set(all.map(({ id }) => id)).size, all.length);
  const skill = read("skills/codex-orchestration/SKILL.md");
  assert.match(skill, /Use `audit` for inspect, review, verify, diagnose, or fix-if-found/);
  assert.match(skill, /Use\s+`implementation` when the user requested a known concrete repository\s+change/);
  assert.match(skill, /host rejects a missing value/);
  assert.match(skill, /draft one real audit deliverable/);
  assert.match(skill, /After SOL accepts V2, SOL must always commit one real audit deliverable\s+personally on the deterministic task branch/);
  assert.match(skill, /Only\s+after a mechanically established defect may the audit also change in-scope\s+product files/);
  assert.match(skill, /When\s+no defect is mechanically established, do not change product files/);
});

test("default behavior is encoded in the existing orchestration skill, not a competing skill", () => {
  const skillDirectories = fs.readdirSync(path.join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, "skills", entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(skillDirectories, ["codex-orchestration", "codex-preflight"]);
});

test("SOL-to-Terra is required and fails closed when runtime support is absent", () => {
  const skill = read("skills/codex-orchestration/SKILL.md");
  assert.match(skill, /allowed_agent_hierarchy=SOL>TERRA/);
  assert.match(skill, /collaboration subagent\s+capability/);
  assert.match(skill, /If either capability is absent,\s+return `blocked` without implementing/);
  assert.match(skill, /Never pretend that a single-agent\s+run was SOL-to-Terra delegation/);
  assert.match(skill, /at least one concrete\s+and testable revision request/);
});

test("GitHub mailbox machine is bounded and exact", () => {
  const machine = JSON.parse(read("skills/codex-orchestration/references/github-mailbox-state-machine.json"));
  assert.deepEqual(machine.states, [
    "IMPLEMENTATION_PENDING",
    "INITIAL_AUTO_REVIEW_PENDING",
    "OPTIONAL_CORRECTION",
    "FINAL_REVIEW_REQUESTED",
    "STOPPED",
  ]);
  assert.deepEqual(machine.limits, {
    initial_codex_jobs: 1,
    implementation_context_comment_writes: 0,
    initial_manual_review_comments: 0,
    correction_resumes_max: 1,
    certification_comments: 1,
    final_review_comments: 1,
    poll_interval_seconds_min: 60,
    review_retries: 0,
  });
  assert.equal(machine.final_trigger.body, "@codex review");
  assert.equal(machine.final_trigger.standalone_exact, true);
  assert.equal(machine.correction.finding_copy, "byte-for-byte");
  assert.equal(machine.review_match.configured_actor_login, "chatgpt-codex-connector[bot]");
  assert.equal(machine.review_match.review_commit_prefix_min_length, 10);
  assert.equal(machine.review_match.review_commit_prefix_must_match_exactly_one_known_pr_commit, true);
  assert.equal(machine.review_match.current_pr_head_must_equal_recorded_full_head_sha, true);
  assert.equal(machine.review_match.head_change_events_after_stage_boundary_max, 0);
  assert.equal(machine.wall_clock.manager_target_minutes, undefined);
  assert.equal(machine.review_match.zero_comment_review_bundle, "clean_only_with_valid_submission_and_true_priority_absence");
  assert.deepEqual(machine.review_match.priority_scan_statuses, ["absent", "canonical", "malformed", "unknown", "multiple"]);
  assert.equal(machine.review_match.noncanonical_priority_status, "reject");
  assert.equal(machine.review_match.malformed_or_multiple_reviewed_commit_material, "reject");
  assert.equal(machine.review_match.reaction_authority_source, "github_issues_or_reaction_api_not_browser_dom_or_inference");
  assert.equal(machine.review_match.missing_issues_read_or_authoritative_reaction_data, "blocked_or_incomplete_no_pass");
  assert.equal(machine.review_match.plugin_can_grant_github_permission, false);
  assert.deepEqual(machine.review_match.finding_priorities, ["P0", "P1", "P2", "P3"]);
  assert.deepEqual(machine.initial_review.allowed_event_kinds, ["reaction", "review_bundle"]);
  assert.deepEqual(machine.initial_review.rejected_event_kinds, ["issue_comment"]);
  assert.deepEqual(machine.final_trigger.allowed_response_event_kinds, ["reaction", "review_bundle", "issue_comment"]);
  assert.equal(machine.final_trigger.strict_clean_issue_comment.review_comments, "explicit_empty_array");
  assert.equal(machine.final_trigger.strict_clean_issue_comment.reassuring_prose, "not_evidence");
  assert.equal(machine.final_trigger.issue_comment_findings, "reject_without_authoritative_raw_inline_mapping_no_synthesis");
  assert.equal(machine.final_trigger.temporary_eyes_reaction, "ignore");
  assert.equal(machine.final_trigger["unscoped_pull_request_+1"], "reject");
  assert.equal(machine.certification.actor, "Fable");
  assert.equal(machine.certification.body_template, "COWORK_CODEX_GATE_V1 | run_id=<RUN_ID> | head_sha=<FINAL_40_HEX> | PASS");
  assert.equal(machine.certification.requires_final_validator_clean, true);
  assert.equal(machine.certification.requires_unchanged_final_head, true);
  assert.equal(machine.certification.post_failure, "incomplete");
  assert.equal(machine.certification.non_clean_or_blocked, "no_pass_pending_remains");
  assert.deepEqual(machine.implementation_commit_explanation.commit_tools, ["create_file", "update_file", "create_commit"]);
  assert.deepEqual(machine.implementation_commit_explanation.line_order, [
    "subject", "blank", "header", "Problem", "Change", "Rationale", "Verification",
  ]);
  assert.deepEqual(machine.implementation_commit_explanation.sections, ["Problem", "Change", "Rationale", "Verification"]);
  assert.equal(machine.implementation_commit_explanation.low_level_branch_effective_after, "successful_update_ref_exact_task_branch_name_sha_force_false");
  assert.equal(machine.implementation_commit_explanation.host_proof, "final_pr_head_equals_last_branch_effective_explained_commit");
  assert.equal(machine.implementation_commit_explanation.no_op_resume, "existing_valid_branch_effective_seed_allowed");
  assert.equal(machine.implementation_commit_explanation.fresh_correction, "new_valid_branch_effective_message_replaces_seed");
  assert.equal(machine.implementation_commit_explanation.quality_gate_evidence, false);
  assert.equal(machine.pending_marker.final_read_body_match, "byte_exact_original_marker_only_line");
});

test("Bug 14 observations are dated and the bundled fixture is the current local reference, not a guarantee", () => {
  for (const file of ["README.md", "skills/codex-orchestration/SKILL.md", "skills/codex-orchestration/references/quality-gate.md"]) {
    const text = read(file);
    assert.match(text, /2026-07-16/);
    assert.match(text, /final-issue-comment-template-pr4\.json/);
    assert.match(text, /not (?:a )?guarantee|never as a guarantee|not a promise/i);
    assert.match(text, /reported|not inspected/i);
  }
});

test("PENDING and Fable-only PASS certification rules are exact and fail closed", () => {
  const skill = read("skills/codex-orchestration/SKILL.md");
  const readme = read("README.md");
  for (const text of [skill, readme]) {
    assert.match(text, /COWORK_CODEX_GATE_V1 \| run_id=<RUN_ID> \| head_sha=<CREATED_40_HEX> \| PENDING \/ DO NOT MERGE/);
    assert.match(text, /COWORK_CODEX_GATE_V1 \| run_id=<RUN_ID> \| head_sha=<FINAL_40_HEX> \| PASS/);
    assert.match(text, /historical PR[- ]body|historical PR\nbody|historical PR body/i);
    assert.match(text, /post(?:ing)? fail|post failure/i);
    assert.match(text, /Codex[\s\S]{0,20}SOL[\s\S]{0,20}Terra[\s\S]{0,20}never post PASS/i);
    assert.match(text, /toggles? draft|draft toggle/i);
    assert.match(text, /closes?|close_pr/i);
    assert.match(text, /merges?|merge_pr/i);
    assert.match(text, /deletes?|delete_pr_or_branch/i);
  }
});

test("initial automatic and final exact reviews reject stale or changed heads", () => {
  const skill = read("skills/codex-orchestration/SKILL.md");
  assert.match(skill, /Do not post an initial `@codex review` comment/);
  assert.match(skill, /chatgpt-codex-connector\[bot\]/);
  assert.match(skill, /P0–P3 finding/);
  assert.match(skill, /bot `\+1` \(`👍`\) reaction directly on that exact pull request/);
  assert.match(skill, /match exactly one known PR commit SHA/);
  assert.match(skill, /forward that immutable block exactly\s+once through `orchestration_codex_resume`/);
  assert.match(skill, /rejects a second resume/);
  assert.match(skill, /complete body is exactly:/);
  assert.match(skill, /Never post it\s+twice/);
  assert.match(skill, /A head that changes away and later returns still fails closed/);
  assert.match(skill, /There is no second correction, second final trigger, third review/);
});

test("no reverse Fable route, local Git route, Actions route, or API-key route exists", () => {
  const skill = read("skills/codex-orchestration/SKILL.md");
  for (const invariant of [
    "NO_CLAUDE_MCP",
    "NO_FABLE_CALL",
    "NO_CLAUDE_COMMAND",
    "NO_LOCAL_GIT",
    "NO_GITHUB_ACTIONS",
    "NO_OPENAI_API_KEY",
  ]) assert.match(skill, new RegExp(invariant));
  assert.match(skill, /Codex never starts, invokes, or messages Fable/);
  assert.match(skill, /Never run `git`, clone,\s+create a worktree/);
  assert.match(skill, /Never merge the pull request/);

  const all = sourceFiles().map((file) => fs.readFileSync(file, "utf8")).join("\n").toLowerCase();
  for (const forbidden of [
    ["claude", "-fable", "-opt-in"].join(""),
    ["claude", " mcp", " serve"].join(""),
    ["reverse", "_allowed"].join(""),
    ["orchestration", "_codex", "_review"].join(""),
    ["codex", " exec", " review"].join(""),
  ]) assert.equal(all.includes(forbidden), false, forbidden);
});

test("official GitHub/cloud sources and bounded Steipete rationale are documented", () => {
  const rationale = read("skills/codex-orchestration/references/quality-gate.md");
  assert.match(rationale, /developers\.openai\.com\/codex\/cloud/);
  assert.match(rationale, /developers\.openai\.com\/codex\/cloud\/code-review/);
  assert.match(rationale, /github\.com\/openai\/codex/);
  assert.match(rationale, /github\.com\/openai\/codex-plugin-cc/);
  assert.match(rationale, /github\.com\/steipete\/agent-scripts/);
  assert.match(rationale, /do not copy Steipete's default yolo\/full-access/);
  assert.match(rationale, /unbounded "until clean" loop/);
});

test("prose preserves the real two-part GitHub review bundle contract", () => {
  const readme = read("README.md");
  const skill = read("skills/codex-orchestration/SKILL.md");
  const rationale = read("skills/codex-orchestration/references/quality-gate.md");
  assert.match(readme, /review submission body holds[\s\S]+separate inline comment bodies hold[\s\S]+pull_request_review_id/);
  assert.match(skill, /Do not concatenate submission\s+and comment bodies/);
  assert.match(rationale, /review submission body carries[\s\S]+separate bot inline comments\s+link back through the same `pull_request_review_id`/);
  for (const text of [readme, skill, rationale]) assert.match(text, /body, URL, path, and line/i);
});

test("final envelope includes remote identity and review evidence", () => {
  const skill = read("skills/codex-orchestration/SKILL.md");
  for (const field of [
    "run_id",
    "repository",
    "base_branch",
    "task_branch",
    "head_sha",
    "pr_number",
    "pr_url",
    "work_summary",
    "resources_consulted",
    "changes_or_artifacts",
    "tests_and_verification",
    "quality_gate",
    "review_findings.forwarded",
    "review_findings.resolved",
    "review_findings.still_open",
    "risks_or_blockers",
    "next_action",
  ]) assert.match(skill, new RegExp(field.replaceAll(".", "\\.")));
  assert.match(skill, /Fable may mechanically\s+merge, display, and summarize/);
  assert.match(skill, /must not repair code, judge a\s+finding, invent evidence/);
});

test("plugin source does not add project Codex configuration", () => {
  assert.equal(fs.existsSync(path.join(root, ".codex", "config.toml")), false);
});

test("README documents cancellation observation limits without authorizing cleanup", () => {
  const readme = read("README.md");
  assert.match(readme, /cancellation race can omit GitHub observations/);
  assert.match(readme, /never auto-deletes/);
  assert.match(readme, /inspect the\s+deterministic task branch explicitly before any cleanup decision/);
});
