"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_ROLES,
  MAX_ROLE_BINDING_LENGTH,
  ROLE_STATE_ENV,
  ROLE_STATE_VERSION,
  getRoles,
  setRole,
} = require("../server/bridge");
const { TOOLS, createRequestHandler } = require("../server/index");

async function withRoleState(run) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cowork-role-state-test-"));
  const filePath = path.join(directory, "roles.json");
  const environment = { [ROLE_STATE_ENV]: filePath };
  try {
    await run({ directory, environment, filePath });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

test("defaults are runtime selectors and do not create state until a change", async () => {
  await withRoleState(async ({ environment, filePath }) => {
    assert.deepEqual(getRoles({ environment }), {
      status: "ok",
      version: ROLE_STATE_VERSION,
      roles: { ...DEFAULT_ROLES },
    });
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(DEFAULT_ROLES.Fable, "fable");
  });
});

test("one role persists atomically with mode 0600 and leaves other roles unchanged", async () => {
  await withRoleState(async ({ directory, environment, filePath }) => {
    const report = setRole("Fable", "opus", { environment });
    assert.deepEqual(report, {
      status: "ok",
      version: ROLE_STATE_VERSION,
      role: "Fable",
      binding: "opus",
      roles: { ...DEFAULT_ROLES, Fable: "opus" },
    });
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.deepEqual(getRoles({ environment }).roles, { ...DEFAULT_ROLES, Fable: "opus" });
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
});

test("unknown roles and unsafe runtime selectors are rejected", async () => {
  await withRoleState(async ({ environment, filePath }) => {
    for (const [role, binding, code] of [
      ["Reviewer", "opus", "ROLE_INVALID"],
      ["Fable", "", "ROLE_BINDING_INVALID"],
      ["Fable", "Claude Opus 5", "ROLE_BINDING_INVALID"],
      ["Fable", "gpt-x --write", "ROLE_BINDING_INVALID"],
      ["Fable", "\"gpt-x\"", "ROLE_BINDING_INVALID"],
      ["Fable", "vendor/model", "ROLE_BINDING_INVALID"],
      ["Fable", "vendor\\model", "ROLE_BINDING_INVALID"],
      ["Fable", "line\nbreak", "ROLE_BINDING_INVALID"],
      ["Fable", "x".repeat(MAX_ROLE_BINDING_LENGTH + 1), "ROLE_BINDING_INVALID"],
    ]) {
      assert.throws(
        () => setRole(role, binding, { environment }),
        (error) => error?.code === code,
      );
    }
    assert.equal(fs.existsSync(filePath), false);

    const valid = "vendor:gpt.next_v2-terra";
    assert.equal(setRole("Terra", valid, { environment }).binding, valid);
  });
});

test("the override must be an absolute normalized roles.json path and symlink targets are rejected", async () => {
  assert.throws(
    () => getRoles({ environment: { [ROLE_STATE_ENV]: "relative/roles.json" } }),
    (error) => error?.code === "ROLE_STATE_PATH_INVALID",
  );
  assert.throws(
    () => getRoles({ environment: { [ROLE_STATE_ENV]: "/tmp/not-roles-state.json" } }),
    (error) => error?.code === "ROLE_STATE_PATH_INVALID",
  );

  await withRoleState(async ({ directory, environment, filePath }) => {
    const target = path.join(directory, "target.json");
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    fs.symlinkSync(target, filePath);
    assert.throws(
      () => getRoles({ environment }),
      (error) => error?.code === "ROLE_STATE_UNSAFE",
    );
  });

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cowork-role-parent-link-test-"));
  try {
    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "linked");
    fs.mkdirSync(realDirectory, { mode: 0o700 });
    fs.symlinkSync(realDirectory, linkedDirectory);
    assert.throws(
      () => getRoles({ environment: { [ROLE_STATE_ENV]: path.join(linkedDirectory, "roles.json") } }),
      (error) => error?.code === "ROLE_STATE_UNSAFE",
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("state files with arbitrary role keys are rejected", async () => {
  await withRoleState(async ({ environment, filePath }) => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: ROLE_STATE_VERSION, roles: { ...DEFAULT_ROLES, Attacker: "value" } }),
      { mode: 0o600 },
    );
    assert.throws(
      () => getRoles({ environment }),
      (error) => error?.code === "ROLE_STATE_INVALID",
    );
  });
});

test("MCP tool schemas are narrow and get/set calls expose no path", async () => {
  const getTool = TOOLS.find((tool) => tool.name === "orchestration_get_roles");
  const setTool = TOOLS.find((tool) => tool.name === "orchestration_set_role");
  assert.deepEqual(getTool.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  assert.deepEqual(setTool.inputSchema.properties.role.enum, ["Fable", "SOL", "Terra"]);
  assert.deepEqual(setTool.inputSchema.required, ["role", "binding"]);
  assert.equal(setTool.inputSchema.properties.binding.pattern, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
  assert.equal(setTool.inputSchema.additionalProperties, false);

  await withRoleState(async ({ environment, filePath }) => {
    const messages = [];
    const { handle } = createRequestHandler({
      send: (message) => messages.push(message),
      getRolesImpl: async () => getRoles({ environment }),
      setRoleImpl: async (role, binding) => setRole(role, binding, { environment }),
    });
    await handle({ jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} });
    assert.deepEqual(
      messages[0].result.tools.map((tool) => tool.name),
      [
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
      ],
    );
    await handle({
      jsonrpc: "2.0",
      id: "set-role",
      method: "tools/call",
      params: { name: "orchestration_set_role", arguments: { role: "Terra", binding: "gpt-next-terra" } },
    });
    assert.equal(messages[1].result.isError, false);
    assert.equal(messages[1].result.structuredContent.roles.Terra, "gpt-next-terra");
    assert.equal(JSON.stringify(messages[1]).includes(filePath), false);

    await handle({
      jsonrpc: "2.0",
      id: "get-roles",
      method: "tools/call",
      params: { name: "orchestration_get_roles", arguments: {} },
    });
    assert.equal(messages[2].result.structuredContent.roles.Terra, "gpt-next-terra");
    assert.equal(JSON.stringify(messages[2]).includes(filePath), false);

    await handle({
      jsonrpc: "2.0",
      id: "path-injection",
      method: "tools/call",
      params: {
        name: "orchestration_set_role",
        arguments: { role: "SOL", binding: "safe", path: "/tmp/attacker" },
      },
    });
    assert.equal(messages[3].result.isError, true);
    assert.equal(messages[3].result.structuredContent.code, "ROLE_INVALID");
    assert.equal(getRoles({ environment }).roles.SOL, DEFAULT_ROLES.SOL);
  });
});
