"use strict";

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_STRING_BYTES = 12 * 1024;
const MAX_LIST_ITEMS = 100;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/;
const STATUSES = new Set(["complete", "blocked", "incomplete"]);
const EXPECTED = Object.freeze({
  AUDIT_VERIFICATION: "one non-empty string (legacy final-envelope input may be an array containing exactly one non-empty string)",
  COMPLETE_DELIVERY: "non-null task branch, full 40-hex head SHA, positive PR number, and canonical PR URL",
  ENVELOPE_OBJECT: "object with exactly the 18 documented top-level fields",
  FULL_SHA: "full 40-hex SHA string",
  FULL_SHA_OR_NULL: "null or a full 40-hex SHA string",
  GENERIC_VALIDATION: "value satisfying the documented validation rule",
  HOST_EVIDENCE: "host-observed GitHub evidence satisfying the named rule",
  INTEGER: "integer",
  NON_EMPTY_STRING: "non-empty string",
  NON_EMPTY_EXACT_STRING: "non-empty byte-exact string",
  FRESH_COMMIT_EXPLANATION: "a distinct explained commit body with a fresh Problem, Change, Rationale, and Verification for this commit",
  OBSERVED_EXPLAINED_COMMIT: "an explained commit whose host-observed result SHA is bound to the task branch with force=false",
  NULL_OR_NON_EMPTY_STRING: "null or a non-empty string",
  NULL_OR_POSITIVE_INTEGER: "null or a positive integer",
  OBJECT: "object",
  POSITIVE_INTEGER: "positive integer",
  POSITIVE_INTEGER_OR_NULL: "positive integer or null",
  REASON_CODE: "null for complete; otherwise an uppercase reason-code string",
  REPOSITORY_PATH: "non-empty repository-relative path without dot segments or backslashes",
  STATUS: "one of complete, blocked, or incomplete",
  STRING_LIST: "array (0 to 100 items) of non-empty strings",
  TASK_BRANCH_OR_NULL: "null or a non-empty Git ref string",
});
const AUDIT_LINE_EVIDENCE_EXAMPLE = Object.freeze({
  path: "path/in/repository",
  start_line: 1,
  end_line: 1,
  snippet: "byte-exact source range",
});
const AUDIT_EVIDENCE_EXAMPLE = Object.freeze({
  audited_sha: "0000000000000000000000000000000000000000",
  scope: Object.freeze(["Audited scope."]),
  findings: Object.freeze(["Mechanically established finding or explicit clean result."]),
  verification: "Exact verification performed.",
  line_evidence: Object.freeze([AUDIT_LINE_EVIDENCE_EXAMPLE]),
});

function scalarDefinition(expected, example, contract = expected) {
  const valueType = [EXPECTED.NULL_OR_NON_EMPTY_STRING, EXPECTED.FULL_SHA_OR_NULL, EXPECTED.TASK_BRANCH_OR_NULL].includes(expected)
    ? "string_or_null"
    : expected === EXPECTED.REASON_CODE ? "string_or_null"
      : [EXPECTED.NULL_OR_POSITIVE_INTEGER, EXPECTED.POSITIVE_INTEGER_OR_NULL].includes(expected) ? "integer_or_null"
        : [EXPECTED.INTEGER, EXPECTED.POSITIVE_INTEGER].includes(expected) ? "integer" : "string";
  return Object.freeze({ type: "scalar", valueType, expected, contract, example });
}

function frozenChildren(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, definition]) => [key, definition])));
}

function describedFields(children) {
  const entries = Object.entries(children).map(([name, definition]) => `${name} (${definition.expected})`);
  return entries.length < 2 ? entries.join("") : `${entries.slice(0, -1).join(", ")}, and ${entries.at(-1)}`;
}

function objectDefinition(children, example, { nullable = false, notes = "" } = {}) {
  const frozen = frozenChildren(children);
  const shape = `object with exactly ${describedFields(frozen)}`;
  const expected = nullable ? `null or an ${shape}` : shape;
  return Object.freeze({ type: nullable ? "nullable_object" : "object", expected, contract: notes ? `${expected}; ${notes}` : expected, children: frozen, example });
}

function objectListDefinition(children, example, { minimum = 0, notes = "" } = {}) {
  const frozen = frozenChildren(children);
  const expected = `array (${minimum} to ${MAX_LIST_ITEMS} items) of objects with exactly ${describedFields(frozen)}`;
  return Object.freeze({ type: "object_list", expected, contract: notes ? `${expected}; ${notes}` : expected, minimum, maximum: MAX_LIST_ITEMS, children: frozen, example });
}

function stringListDefinition(example) {
  return Object.freeze({
    type: "string_list",
    expected: EXPECTED.STRING_LIST,
    contract: EXPECTED.STRING_LIST,
    minimum: 0,
    maximum: MAX_LIST_ITEMS,
    item: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "list item"),
    example,
  });
}

const AUDIT_LINE_EVIDENCE_DEFINITION = objectListDefinition({
  path: scalarDefinition(EXPECTED.REPOSITORY_PATH, AUDIT_LINE_EVIDENCE_EXAMPLE.path),
  start_line: scalarDefinition(EXPECTED.POSITIVE_INTEGER, AUDIT_LINE_EVIDENCE_EXAMPLE.start_line),
  end_line: scalarDefinition(EXPECTED.POSITIVE_INTEGER, AUDIT_LINE_EVIDENCE_EXAMPLE.end_line, "positive integer greater than or equal to start_line"),
  snippet: scalarDefinition(EXPECTED.NON_EMPTY_EXACT_STRING, AUDIT_LINE_EVIDENCE_EXAMPLE.snippet),
}, Object.freeze([AUDIT_LINE_EVIDENCE_EXAMPLE]), { minimum: 1 });

const AUDIT_EVIDENCE_DEFINITION = objectDefinition({
  audited_sha: scalarDefinition(EXPECTED.FULL_SHA, AUDIT_EVIDENCE_EXAMPLE.audited_sha),
  scope: stringListDefinition(AUDIT_EVIDENCE_EXAMPLE.scope),
  findings: stringListDefinition(AUDIT_EVIDENCE_EXAMPLE.findings),
  verification: Object.freeze({ ...scalarDefinition(EXPECTED.NON_EMPTY_STRING, AUDIT_EVIDENCE_EXAMPLE.verification), inputCompatibility: "legacy_single_string_array" }),
  line_evidence: AUDIT_LINE_EVIDENCE_DEFINITION,
}, null, {
  nullable: true,
  notes: "new model output requires null; for a complete audit the host derives and hydrates this object from the verified report block; a legacy non-null object is accepted only when it exactly matches host evidence",
});

// One programmatic source drives the accepted top-level keys and the runtime
// contract sent to SOL. Keep validation details here instead of duplicating a
// hand-written field list in job-worker.js.
const RESULT_ENVELOPE_SCHEMA = Object.freeze({
  run_id: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "CURRENT_RUN_ID", "non-empty string (max 64 UTF-8 bytes) equal to the current run id"),
  status: scalarDefinition(EXPECTED.STATUS, "blocked"),
  reason_code: scalarDefinition(EXPECTED.REASON_CODE, "EXAMPLE_ONLY"),
  repository: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "OWNER/REPO", "non-empty string (max 201 UTF-8 bytes) equal to the requested OWNER/REPO"),
  base_branch: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "main", "non-empty string (max 200 UTF-8 bytes) equal to the requested base branch"),
  task_branch: scalarDefinition(EXPECTED.TASK_BRANCH_OR_NULL, null, "null or the exact non-empty task Git ref (max 200 characters)"),
  head_sha: scalarDefinition(EXPECTED.FULL_SHA_OR_NULL, null),
  pr_number: scalarDefinition(EXPECTED.NULL_OR_POSITIVE_INTEGER, null),
  pr_url: scalarDefinition(EXPECTED.NULL_OR_NON_EMPTY_STRING, null, "null or a non-empty URL string; complete requires the canonical https://github.com/OWNER/REPO/pull/NUMBER URL"),
  work_summary: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "Summary of completed work."),
  resources_consulted: objectListDefinition({
    resource: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "repository path or GitHub resource"),
    evidence: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "What was observed."),
  }, Object.freeze([Object.freeze({ resource: "repository path or GitHub resource", evidence: "What was observed." })])),
  changes_or_artifacts: objectListDefinition({
    artifact: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "repository-relative artifact path"),
    kind: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "modified_file", "non-empty string (max 80 UTF-8 bytes)"),
    evidence: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "What changed."),
  }, Object.freeze([Object.freeze({ artifact: "repository-relative artifact path", kind: "modified_file", evidence: "What changed." })])),
  audit_evidence: Object.freeze({ ...AUDIT_EVIDENCE_DEFINITION, auditExample: AUDIT_EVIDENCE_EXAMPLE }),
  tests_and_verification: stringListDefinition(Object.freeze(["Verification performed and result."])),
  SOL_to_Terra_evidence: objectDefinition({
    sol_revision: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "Concrete V1 revision request."),
    sol_v2_review: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "V2 acceptance review."),
    terra_v1: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "Terra V1 result."),
    terra_v2: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "Terra V2 result."),
  }, Object.freeze({ sol_revision: "Concrete V1 revision request.", sol_v2_review: "V2 acceptance review.", terra_v1: "Terra V1 result.", terra_v2: "Terra V2 result." })),
  finding_dispositions: objectListDefinition({
    url: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "canonical same-repository blob URL", "canonical same-repository blob URL at an allowed SHA"),
    path: scalarDefinition(EXPECTED.REPOSITORY_PATH, "path/in/repository"),
    line: scalarDefinition(EXPECTED.POSITIVE_INTEGER_OR_NULL, null),
    disposition: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "verified"),
    evidence: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "Disposition evidence."),
  }, Object.freeze([]), {
    notes: 'disposition must be a non-empty string, for example "fixed", "rejected", or "not_applicable"',
  }),
  risks_or_blockers: stringListDefinition(Object.freeze([])),
  next_action: scalarDefinition(EXPECTED.NON_EMPTY_STRING, "Next caller action."),
});
const RESULT_ENVELOPE_CONTRACT = RESULT_ENVELOPE_SCHEMA;
const SOL_TERRA_KEYS = Object.freeze(Object.keys(RESULT_ENVELOPE_SCHEMA.SOL_to_Terra_evidence.children).sort());
const ENVELOPE_KEYS = Object.freeze(Object.keys(RESULT_ENVELOPE_CONTRACT).sort());
function schemaStrings(definition) {
  if (!definition || typeof definition !== "object") return [];
  const own = [definition.expected, definition.contract].filter((value) => typeof value === "string");
  const nested = definition.children ? Object.values(definition.children).flatMap(schemaStrings) : [];
  const item = definition.item ? schemaStrings(definition.item) : [];
  return [...own, ...nested, ...item];
}
const SAFE_PUBLIC_EXPECTED = new Set([
  ...Object.values(EXPECTED),
  ...Object.values(RESULT_ENVELOPE_CONTRACT).flatMap(schemaStrings),
]);

function sanitizePublicExpected(value) {
  return typeof value === "string" && SAFE_PUBLIC_EXPECTED.has(value) ? value : EXPECTED.GENERIC_VALIDATION;
}

function expectedForEnvelopePath(path) {
  if (typeof path !== "string") return EXPECTED.GENERIC_VALIDATION;
  const root = path.match(/^[A-Za-z0-9_]+/)?.[0];
  return sanitizePublicExpected(RESULT_ENVELOPE_SCHEMA[root]?.expected);
}

function resultEnvelopeContractText() {
  const fields = Object.entries(RESULT_ENVELOPE_CONTRACT)
    .map(([name, definition]) => `- ${name}: ${definition.contract}`)
    .join("\n");
  return `The result envelope has exactly ${ENVELOPE_KEYS.length} top-level fields and no others:\n${fields}`;
}

function resultEnvelopeExampleText(taskType = "implementation") {
  const example = Object.fromEntries(Object.entries(RESULT_ENVELOPE_SCHEMA).map(([name, definition]) => [name, definition.example]));
  if (taskType === "audit") {
    example.changes_or_artifacts = [{
      artifact: ".github/audits/<lowercase-run-id>.md",
      kind: "audit_report",
      evidence: "The committed substantive audit report.",
    }];
  }
  return JSON.stringify(example);
}

function validateSchemaShape(value, definition, path, options = {}) {
  if (definition.type === "scalar") {
    const legacy = options.allowLegacyAuditVerification === true && definition.inputCompatibility === "legacy_single_string_array" &&
      Array.isArray(value) && value.length === 1 && typeof value[0] === "string";
    const valid = definition.valueType === "string" ? typeof value === "string"
      : definition.valueType === "string_or_null" ? value === null || typeof value === "string"
        : definition.valueType === "integer" ? Number.isSafeInteger(value)
          : definition.valueType === "integer_or_null" ? value === null || Number.isSafeInteger(value) : false;
    if (!valid && !legacy) invalid(path, "type_mismatch", definition.expected);
    return;
  }
  if (definition.type === "string_list") {
    if (!Array.isArray(value)) invalid(path, "type_mismatch", definition.expected);
    if (value.length < definition.minimum || value.length > definition.maximum) invalid(path, "value_out_of_range", definition.expected);
    value.forEach((item, index) => validateSchemaShape(item, definition.item, `${path}[${index}]`, options));
    return;
  }
  if (definition.type === "object_list") {
    if (!Array.isArray(value)) invalid(path, "type_mismatch", definition.expected);
    if (value.length < definition.minimum || value.length > definition.maximum) invalid(path, "value_out_of_range", definition.expected);
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      hasExactKeys(item, Object.keys(definition.children).sort(), itemPath, definition.expected);
      for (const [key, child] of Object.entries(definition.children)) validateSchemaShape(item[key], child, `${itemPath}.${key}`, options);
    });
    return;
  }
  if (definition.type === "object" || definition.type === "nullable_object") {
    if (definition.type === "nullable_object" && value === null) return;
    hasExactKeys(value, Object.keys(definition.children).sort(), path, definition.expected);
    for (const [key, child] of Object.entries(definition.children)) validateSchemaShape(value[key], child, `${path}.${key}`, options);
    return;
  }
  invalid(path, "strict_schema", definition.expected);
}

function validateEnvelopeStructure(value) {
  hasExactKeys(value, ENVELOPE_KEYS, "envelope", EXPECTED.ENVELOPE_OBJECT);
  for (const [key, definition] of Object.entries(RESULT_ENVELOPE_SCHEMA)) {
    validateSchemaShape(value[key], definition, key, { allowLegacyAuditVerification: true });
  }
}

const SAFE_PUBLIC_OBSERVED = new Set([
  "array_length_mismatch",
  "different_boolean",
  "different_integer",
  "different_nullability",
  "different_string",
  "missing_field",
  "unexpected_field",
]);

function sanitizePublicObserved(value) {
  return typeof value === "string" && SAFE_PUBLIC_OBSERVED.has(value) ? value : null;
}

function sanitizePublicValidationPreview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (!["preview,sensitive,truncated,utf8_bytes", "preview,sensitive,sha256,truncated,utf8_bytes"].includes(keys)) return null;
  if (typeof value.preview !== "string" || value.preview.length > 1024 || /[\u0000-\u001f\u007f]/.test(value.preview)) return null;
  if (!Number.isSafeInteger(value.utf8_bytes) || value.utf8_bytes < 0 || value.utf8_bytes > MAX_STRING_BYTES) return null;
  if (typeof value.truncated !== "boolean" || typeof value.sensitive !== "boolean") return null;
  const mustHash = value.truncated || value.sensitive;
  if (mustHash !== Object.prototype.hasOwnProperty.call(value, "sha256")) return null;
  if (mustHash && (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256))) return null;
  return {
    preview: value.preview,
    utf8_bytes: value.utf8_bytes,
    truncated: value.truncated,
    sensitive: value.sensitive,
    ...(mustHash ? { sha256: value.sha256 } : {}),
  };
}

function sanitizePublicMismatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "artifact,envelope") return null;
  const envelope = sanitizePublicValidationPreview(value.envelope);
  const artifact = sanitizePublicValidationPreview(value.artifact);
  if (!envelope || !artifact) return null;
  const mismatch = { envelope, artifact };
  return Buffer.byteLength(JSON.stringify(mismatch), "utf8") <= 512 ? mismatch : null;
}

class EnvelopeError extends Error {
  constructor(code = "CODEX_RESULT_ENVELOPE_INVALID", path = "envelope", rule = "strict_schema", expected = expectedForEnvelopePath(path), observed = null) {
    super(code);
    this.name = "EnvelopeError";
    this.code = code;
    const safeObserved = sanitizePublicObserved(observed);
    this.publicValidationError = {
      path,
      rule,
      expected: sanitizePublicExpected(expected),
      ...(safeObserved === null ? {} : { observed: safeObserved }),
    };
  }
}

function invalid(path, rule, expected = expectedForEnvelopePath(path), observed = null) {
  throw new EnvelopeError("CODEX_RESULT_ENVELOPE_INVALID", path, rule, expected, observed);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected, path = "envelope", shapeExpected = EXPECTED.OBJECT) {
  if (!isPlainObject(value)) invalid(path, "type_mismatch", shapeExpected);
  const keys = Object.keys(value).sort();
  const unknown = keys.find((key) => !expected.includes(key));
  if (unknown) invalid(`${path}.${unknown}`, "unknown_key", shapeExpected);
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) invalid(`${path}.${missing}`, "required_field_missing", shapeExpected);
  return true;
}

function stringValue(value, { nullable = false, maximum = MAX_STRING_BYTES, path = "envelope", expected: schemaExpected = null } = {}) {
  if (nullable && value === null) return null;
  const expected = schemaExpected || (nullable ? EXPECTED.NULL_OR_NON_EMPTY_STRING : EXPECTED.NON_EMPTY_STRING);
  if (typeof value !== "string") invalid(path, "type_mismatch", expected);
  if (value.includes("\u0000")) invalid(path, "value_out_of_range", expected);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximum) invalid(path, "value_out_of_range", expected);
  return normalized;
}

function exactSnippet(value, path, expected = EXPECTED.NON_EMPTY_EXACT_STRING) {
  if (typeof value !== "string") invalid(path, "type_mismatch", expected);
  if (!value || value.includes("\u0000") || Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
    invalid(path, "value_out_of_range", expected);
  }
  return value;
}

function stringList(value, path, definition = null) {
  const schema = definition || stringListDefinition(Object.freeze([]));
  if (!Array.isArray(value)) invalid(path, "type_mismatch", schema.expected);
  if (value.length < schema.minimum || value.length > schema.maximum) invalid(path, "value_out_of_range", schema.expected);
  return value.map((item, index) => stringValue(item, { path: `${path}[${index}]`, expected: schema.item.expected }));
}

function auditVerificationValue(value, path, allowLegacyArray) {
  if (Array.isArray(value)) {
    if (!allowLegacyArray) invalid(path, "type_mismatch", EXPECTED.NON_EMPTY_STRING);
    if (value.length !== 1) invalid(path, "value_out_of_range", EXPECTED.AUDIT_VERIFICATION);
    return stringValue(value[0], { path: `${path}[0]` });
  }
  return stringValue(value, { path });
}

function objectList(value, path, definition, normalize) {
  if (!Array.isArray(value)) invalid(path, "type_mismatch", definition.expected);
  if (value.length < definition.minimum || value.length > definition.maximum) invalid(path, "value_out_of_range", definition.expected);
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    hasExactKeys(item, Object.keys(definition.children).sort(), itemPath, definition.expected);
    return normalize(item, itemPath);
  });
}

function nullableRef(value, path) {
  const ref = stringValue(value, { nullable: true, maximum: 200, path });
  if (ref !== null && (!REF_PATTERN.test(ref) || ref.includes("..") || ref.endsWith("/"))) invalid(path, "value_out_of_range", EXPECTED.TASK_BRANCH_OR_NULL);
  return ref;
}

function nullableSha(value, path, expected = EXPECTED.FULL_SHA_OR_NULL) {
  const sha = stringValue(value, { nullable: true, maximum: 40, path, expected });
  if (sha !== null && !SHA_PATTERN.test(sha)) invalid(path, "value_out_of_range", expected);
  return sha?.toLowerCase() ?? null;
}

function repositoryPath(value, errorPath = "finding_dispositions[].path") {
  const filePath = stringValue(value, { maximum: 2_048, path: errorPath });
  const segments = filePath.split("/");
  if (filePath.startsWith("/") || filePath.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    invalid(errorPath, "repository_relative_path_required", EXPECTED.REPOSITORY_PATH);
  }
  return filePath;
}

function canonicalFileUrl(repository, sha, filePath, line) {
  const encodedPath = filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const base = `https://github.com/${repository}/blob/${sha}/${encodedPath}`;
  return line === null ? base : `${base}#L${line}`;
}

function normalizeAuditEvidence(value, options = {}) {
  const path = options.path || "audit_evidence";
  const allowLegacyVerificationArray = options.allowLegacyVerificationArray !== false;
  const auditSchema = RESULT_ENVELOPE_SCHEMA.audit_evidence;
  const lineSchema = auditSchema.children.line_evidence;
  hasExactKeys(value, Object.keys(auditSchema.children).sort(), path, auditSchema.expected);
  validateSchemaShape(value, auditSchema, path, { allowLegacyAuditVerification: allowLegacyVerificationArray });
  const lineEvidence = objectList(value.line_evidence, `${path}.line_evidence`, lineSchema, (item, itemPath) => {
    if (!Number.isSafeInteger(item.start_line)) invalid(`${itemPath}.start_line`, "type_mismatch", lineSchema.children.start_line.expected);
    if (!Number.isSafeInteger(item.end_line)) invalid(`${itemPath}.end_line`, "type_mismatch", lineSchema.children.end_line.expected);
    if (item.start_line < 1) invalid(`${itemPath}.start_line`, "value_out_of_range", lineSchema.children.start_line.expected);
    if (item.end_line < item.start_line) invalid(`${itemPath}.end_line`, "value_out_of_range", lineSchema.children.end_line.contract);
    return {
      path: repositoryPath(item.path, `${itemPath}.path`),
      start_line: item.start_line,
      end_line: item.end_line,
      snippet: exactSnippet(item.snippet, `${itemPath}.snippet`, lineSchema.children.snippet.expected),
    };
  });
  const normalized = {
    audited_sha: nullableSha(value.audited_sha, `${path}.audited_sha`, auditSchema.children.audited_sha.expected),
    scope: stringList(value.scope, `${path}.scope`, auditSchema.children.scope),
    findings: stringList(value.findings, `${path}.findings`, auditSchema.children.findings),
    verification: auditVerificationValue(value.verification, `${path}.verification`, allowLegacyVerificationArray),
    line_evidence: lineEvidence,
  };
  if (!normalized.audited_sha) invalid(`${path}.audited_sha`, "required_for_audit", auditSchema.children.audited_sha.expected);
  if (lineEvidence.length < 1) invalid(`${path}.line_evidence`, "value_out_of_range", lineSchema.expected);
  return normalized;
}

function normalizeEnvelope(value, context) {
  validateEnvelopeStructure(value);
  const runId = stringValue(value.run_id, { maximum: 64, path: "run_id" });
  const repository = stringValue(value.repository, { maximum: 201, path: "repository" });
  const baseBranch = stringValue(value.base_branch, { maximum: 200, path: "base_branch" });
  if (runId !== context.runId) invalid("run_id", "value_mismatch", RESULT_ENVELOPE_CONTRACT.run_id.expected);
  if (repository !== context.repository) invalid("repository", "value_mismatch", RESULT_ENVELOPE_CONTRACT.repository.expected);
  if (baseBranch !== context.baseBranch) invalid("base_branch", "value_mismatch", RESULT_ENVELOPE_CONTRACT.base_branch.expected);
  const status = stringValue(value.status, { maximum: 32, path: "status" });
  if (!STATUSES.has(status)) invalid("status", "value_out_of_range", EXPECTED.STATUS);
  let reasonCode = value.reason_code;
  if (reasonCode !== null) {
    reasonCode = stringValue(reasonCode, { maximum: 80, path: "reason_code" });
    if (!REASON_PATTERN.test(reasonCode)) invalid("reason_code", "value_out_of_range", EXPECTED.REASON_CODE);
  }
  if (status === "complete" && reasonCode !== null) invalid("reason_code", "must_be_null_for_complete", EXPECTED.REASON_CODE);
  if (status !== "complete" && reasonCode === null) invalid("reason_code", "required_for_non_complete", EXPECTED.REASON_CODE);

  const taskBranch = nullableRef(value.task_branch, "task_branch");
  const headSha = nullableSha(value.head_sha, "head_sha");
  const prNumber = value.pr_number;
  if (prNumber !== null && !Number.isSafeInteger(prNumber)) invalid("pr_number", "type_mismatch", EXPECTED.NULL_OR_POSITIVE_INTEGER);
  if (Number.isSafeInteger(prNumber) && prNumber < 1) invalid("pr_number", "value_out_of_range", EXPECTED.NULL_OR_POSITIVE_INTEGER);
  const prUrl = stringValue(value.pr_url, { nullable: true, maximum: 2_048, path: "pr_url" });
  const expectedTaskBranch = context.taskBranch;
  if (taskBranch !== null && taskBranch !== expectedTaskBranch) invalid("task_branch", "value_mismatch", EXPECTED.TASK_BRANCH_OR_NULL);
  if (status === "complete") {
    if (!taskBranch || !headSha || prNumber === null || !prUrl || taskBranch === baseBranch) invalid("delivery", "complete_delivery_required", EXPECTED.COMPLETE_DELIVERY);
    if (prUrl !== `https://github.com/${repository}/pull/${prNumber}`) invalid("pr_url", "canonical_pr_url_required", RESULT_ENVELOPE_CONTRACT.pr_url.contract);
  }

  const resourcesSchema = RESULT_ENVELOPE_SCHEMA.resources_consulted;
  const resourcesConsulted = objectList(value.resources_consulted, "resources_consulted", resourcesSchema, (item, path) => ({
    resource: stringValue(item.resource, { path: `${path}.resource`, expected: resourcesSchema.children.resource.expected }),
    evidence: stringValue(item.evidence, { path: `${path}.evidence`, expected: resourcesSchema.children.evidence.expected }),
  }));
  const changesSchema = RESULT_ENVELOPE_SCHEMA.changes_or_artifacts;
  const changesOrArtifacts = objectList(value.changes_or_artifacts, "changes_or_artifacts", changesSchema, (item, path) => ({
    artifact: stringValue(item.artifact, { path: `${path}.artifact`, expected: changesSchema.children.artifact.expected }),
    kind: stringValue(item.kind, { maximum: 80, path: `${path}.kind`, expected: changesSchema.children.kind.expected }),
    evidence: stringValue(item.evidence, { path: `${path}.evidence`, expected: changesSchema.children.evidence.expected }),
  }));
  let auditEvidence = null;
  if (value.audit_evidence !== null) {
    auditEvidence = normalizeAuditEvidence(value.audit_evidence, { path: "audit_evidence", allowLegacyVerificationArray: true });
  }
  const hostAuditEvidence = context.hostAuditEvidence
    ? normalizeAuditEvidence(context.hostAuditEvidence, { path: "audit_evidence", allowLegacyVerificationArray: false })
    : null;
  const effectiveAuditEvidence = hostAuditEvidence || auditEvidence;
  if (context.taskType !== "audit" && auditEvidence !== null) invalid("audit_evidence", "must_be_null_for_non_audit", RESULT_ENVELOPE_SCHEMA.audit_evidence.expected);
  if (status === "complete" && context.taskType === "audit") {
    const pathMatches = changesOrArtifacts
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.artifact === context.auditPath);
    if (pathMatches.length !== 1) {
      invalid("changes_or_artifacts", "exactly_one_audit_path_artifact_required", RESULT_ENVELOPE_SCHEMA.changes_or_artifacts.expected);
    }
    if (effectiveAuditEvidence === null && context.allowHostDerivedAuditEvidence !== true) {
      invalid("audit_evidence", "host_derived_audit_evidence_required", RESULT_ENVELOPE_SCHEMA.audit_evidence.expected);
    }
  }
  const findingSchema = RESULT_ENVELOPE_SCHEMA.finding_dispositions;
  const findingDispositions = objectList(value.finding_dispositions, "finding_dispositions", findingSchema, (item, path) => {
    if (item.line !== null && (!Number.isSafeInteger(item.line) || item.line < 1)) {
      invalid(`${path}.line`, "null_or_positive_integer_required", findingSchema.children.line.expected);
    }
    const filePath = repositoryPath(item.path, `${path}.path`);
    const url = stringValue(item.url, { maximum: 2_048, path: `${path}.url` });
    const allowedShas = [...new Set([headSha, effectiveAuditEvidence?.audited_sha].filter(Boolean))];
    if (allowedShas.length === 0) invalid(`${path}.url`, "full_allowed_sha_required", findingSchema.children.url.contract);
    const deferHostAuditUrl = context.taskType === "audit" && context.allowHostDerivedAuditEvidence === true && effectiveAuditEvidence === null;
    if (!deferHostAuditUrl && !allowedShas.some((sha) => url === canonicalFileUrl(repository, sha, filePath, item.line))) {
      invalid(`${path}.url`, item.line === null ? "canonical_unanchored_file_url_required" : "canonical_exact_line_anchor_required", findingSchema.children.url.contract);
    }
    return {
      url,
      path: filePath,
      line: item.line,
      disposition: stringValue(item.disposition, { maximum: 80, path: `${path}.disposition` }),
      evidence: stringValue(item.evidence, { path: `${path}.evidence` }),
    };
  });
  const solSchema = RESULT_ENVELOPE_SCHEMA.SOL_to_Terra_evidence;
  hasExactKeys(value.SOL_to_Terra_evidence, SOL_TERRA_KEYS, "SOL_to_Terra_evidence", solSchema.expected);
  const solToTerraEvidence = Object.fromEntries(SOL_TERRA_KEYS.map((key) => [key, stringValue(value.SOL_to_Terra_evidence[key], { path: `SOL_to_Terra_evidence.${key}`, expected: solSchema.children[key].expected })]));

  return {
    run_id: runId,
    status,
    reason_code: reasonCode,
    repository,
    base_branch: baseBranch,
    task_branch: taskBranch,
    head_sha: headSha,
    pr_number: prNumber,
    pr_url: prUrl,
    work_summary: stringValue(value.work_summary, { path: "work_summary" }),
    resources_consulted: resourcesConsulted,
    changes_or_artifacts: changesOrArtifacts,
    audit_evidence: effectiveAuditEvidence,
    tests_and_verification: stringList(value.tests_and_verification, "tests_and_verification", RESULT_ENVELOPE_SCHEMA.tests_and_verification),
    SOL_to_Terra_evidence: solToTerraEvidence,
    finding_dispositions: findingDispositions,
    risks_or_blockers: stringList(value.risks_or_blockers, "risks_or_blockers", RESULT_ENVELOPE_SCHEMA.risks_or_blockers),
    next_action: stringValue(value.next_action, { path: "next_action" }),
  };
}

function parseAndValidateEnvelope(raw, context) {
  if (!context || typeof context !== "object") invalid("context", "type_mismatch", EXPECTED.OBJECT);
  let value = raw;
  if (typeof raw === "string") {
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_RESULT_BYTES) invalid("envelope", "value_out_of_range", EXPECTED.OBJECT);
    try {
      value = JSON.parse(raw);
    } catch {
      invalid("envelope", "json_parse_failed", EXPECTED.OBJECT);
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid("envelope", "json_serialization_failed", EXPECTED.OBJECT);
  }
  if (typeof serialized !== "string") invalid("envelope", "type_mismatch", EXPECTED.OBJECT);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) invalid("envelope", "value_out_of_range", EXPECTED.OBJECT);
  return normalizeEnvelope(value, context);
}

function envelopeContext(state) {
  return {
    runId: state.id,
    repository: state.contract.repository,
    baseBranch: state.contract.baseBranch,
    taskBranch: state.taskBranch,
    taskType: state.contract.taskType,
    auditPath: state.auditPath || null,
  };
}

function outcomeForEnvelope(envelope, requestKind = "start") {
  if (envelope.status === "complete") {
    return { status: "complete", phase: requestKind === "resume" ? "correction_complete" : "ready_for_quality_gate", code: null };
  }
  if (envelope.reason_code === "NULL_DIFF_NO_DELIVERY") {
    return { status: "blocked", phase: "blocked", code: envelope.reason_code };
  }
  return { status: envelope.status, phase: envelope.status, code: envelope.reason_code };
}

module.exports = {
  ENVELOPE_KEYS,
  EXPECTED,
  EnvelopeError,
  MAX_RESULT_BYTES,
  RESULT_ENVELOPE_CONTRACT,
  RESULT_ENVELOPE_SCHEMA,
  SOL_TERRA_KEYS,
  expectedForEnvelopePath,
  normalizeAuditEvidence,
  outcomeForEnvelope,
  parseAndValidateEnvelope,
  envelopeContext,
  resultEnvelopeContractText,
  resultEnvelopeExampleText,
  sanitizePublicExpected,
  sanitizePublicObserved,
  sanitizePublicValidationPreview,
  sanitizePublicMismatch,
};
