"use strict";

const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_VERSION = "1.2.9";
const FALLBACK_CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";
const ROLE_STATE_VERSION = 1;
const ROLE_STATE_ENV = "COWORK_CODEX_PREFLIGHT_ROLES_PATH";
const ROLE_NAMES = Object.freeze(["Fable", "SOL", "Terra"]);
const DEFAULT_ROLES = Object.freeze({
  Fable: "fable",
  SOL: "gpt-5.6-sol",
  Terra: "gpt-5.6-terra",
});
const MAX_ROLE_BINDING_LENGTH = 128;
const INITIAL_MARKER = "PREFLIGHT_INITIAL_OK";
const REPLY_MARKER = "PREFLIGHT_REPLY_OK";
const RECALL_TOKEN = "CXPREFLIGHT_V2_RECALL_7KQ";
const INITIAL_RESPONSE = INITIAL_MARKER;
const REPLY_RESPONSE = `${REPLY_MARKER} ${RECALL_TOKEN}`;
const INITIAL_PROMPT =
  `This is a deterministic preflight. Memorize this internal recall token for the next turn: ${RECALL_TOKEN}. ` +
  "Do not read, write, list, or inspect files. Reply with exactly PREFLIGHT_INITIAL_OK and nothing else.";
const REPLY_PROMPT =
  "Continue the same deterministic preflight. Do not read, write, list, or inspect files. " +
  "Reply with exactly PREFLIGHT_REPLY_OK, followed by one space and the internal recall token from the immediately preceding turn, and nothing else.";
const MAX_STATUS_STREAM_BYTES = 64 * 1024;

const DEFAULT_TIMEOUTS = Object.freeze({
  versionMs: 5_000,
  initializeMs: 10_000,
  toolsMs: 10_000,
  turnMs: 75_000,
  shutdownMs: 2_000,
});

class PreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreflightError";
    this.code = code;
  }
}

function removeApiKeyEnvironment(source = process.env) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    const credentialName = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(normalized);
    const openAiOrAzureRouting =
      /(?:^|_)(OPENAI|AZURE)(?:_|$)/.test(normalized) &&
      /(BASE_?URL|ENDPOINT|ORG(?:ANIZATION)?(?:_ID)?|PROJECT(?:_ID)?)/.test(normalized);
    if (credentialName || openAiOrAzureRouting) delete environment[name];
  }
  return environment;
}

function defaultRoleState() {
  return { version: ROLE_STATE_VERSION, roles: { ...DEFAULT_ROLES } };
}

function resolveRoleStatePath(environment = process.env) {
  const override = environment[ROLE_STATE_ENV];
  if (!override) {
    return path.join(os.homedir(), ".config", "cowork-codex-subagent", "roles.json");
  }
  if (
    typeof override !== "string" ||
    !path.isAbsolute(override) ||
    path.normalize(override) !== override ||
    path.basename(override) !== "roles.json"
  ) {
    throw new PreflightError("ROLE_STATE_PATH_INVALID");
  }
  return override;
}

function validateRole(role) {
  if (typeof role !== "string" || !ROLE_NAMES.includes(role)) {
    throw new PreflightError("ROLE_INVALID");
  }
  return role;
}

function validateRoleBinding(binding) {
  if (typeof binding !== "string") throw new PreflightError("ROLE_BINDING_INVALID");
  const normalized = binding.normalize("NFC");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new PreflightError("ROLE_BINDING_INVALID");
  }
  return normalized;
}

function validateRoleState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== ROLE_STATE_VERSION) {
    throw new PreflightError("ROLE_STATE_INVALID");
  }
  const roles = value.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    throw new PreflightError("ROLE_STATE_INVALID");
  }
  const keys = Object.keys(roles);
  if (keys.length !== ROLE_NAMES.length || keys.some((name) => !ROLE_NAMES.includes(name))) {
    throw new PreflightError("ROLE_STATE_INVALID");
  }
  const sanitized = {};
  for (const name of ROLE_NAMES) sanitized[name] = validateRoleBinding(roles[name]);
  return { version: ROLE_STATE_VERSION, roles: sanitized };
}

function assertSafeRoleStateTarget(filePath) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new PreflightError("ROLE_STATE_UNSAFE");
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    if (error?.code !== "ENOENT") throw new PreflightError("ROLE_STATE_UNSAFE");
  }
}

function assertSafeRoleStateDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PreflightError("ROLE_STATE_UNSAFE");
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    if (error?.code !== "ENOENT") throw new PreflightError("ROLE_STATE_UNSAFE");
  }
}

function getRoles(options = {}) {
  const filePath = resolveRoleStatePath(options.environment || process.env);
  assertSafeRoleStateDirectory(path.dirname(filePath));
  assertSafeRoleStateTarget(filePath);
  if (!fs.existsSync(filePath)) return { status: "ok", ...defaultRoleState() };
  let descriptor;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    if (!fs.fstatSync(descriptor).isFile()) throw new PreflightError("ROLE_STATE_UNSAFE");
    return { status: "ok", ...validateRoleState(JSON.parse(fs.readFileSync(descriptor, "utf8"))) };
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    if (error?.code === "ELOOP") throw new PreflightError("ROLE_STATE_UNSAFE");
    throw new PreflightError("ROLE_STATE_INVALID");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeRoleStateAtomically(filePath, state) {
  const directory = path.dirname(filePath);
  assertSafeRoleStateDirectory(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeRoleStateDirectory(directory);
  fs.chmodSync(directory, 0o700);
  assertSafeRoleStateTarget(filePath);
  const temporaryPath = path.join(directory, `.roles-${randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the sanitized write failure.
      }
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the sanitized write failure.
    }
    if (error instanceof PreflightError) throw error;
    throw new PreflightError("ROLE_STATE_WRITE_FAILED");
  }
}

function setRole(role, binding, options = {}) {
  const validatedRole = validateRole(role);
  const validatedBinding = validateRoleBinding(binding);
  const environment = options.environment || process.env;
  const filePath = resolveRoleStatePath(environment);
  const current = getRoles({ environment });
  const next = {
    version: ROLE_STATE_VERSION,
    roles: { ...current.roles, [validatedRole]: validatedBinding },
  };
  writeRoleStateAtomically(filePath, next);
  return {
    status: "ok",
    version: ROLE_STATE_VERSION,
    role: validatedRole,
    binding: validatedBinding,
    roles: { ...next.roles },
  };
}

function createRollingTextBuffer(maxBytes = MAX_STATUS_STREAM_BYTES) {
  let data = Buffer.alloc(0);
  return {
    append(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (incoming.length >= maxBytes) {
        data = incoming.subarray(incoming.length - maxBytes);
        return;
      }
      const retainedLength = Math.max(0, maxBytes - incoming.length);
      const retained = data.length > retainedLength ? data.subarray(data.length - retainedLength) : data;
      data = Buffer.concat([retained, incoming]);
    },
    byteLength() {
      return data.length;
    },
    text() {
      return data.toString("utf8");
    },
  };
}

function isExecutable(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.accessSync(filePath, fs.constants.X_OK) === undefined;
  } catch {
    return false;
  }
}

function resolvePathExecutable(environment = process.env) {
  const pathValue = environment.PATH || "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "codex");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function resolveCodexExecutable(environment = process.env) {
  const pathExecutable = resolvePathExecutable(environment);
  if (pathExecutable) {
    return { executable: pathExecutable, sanitizedPath: "codex", source: "PATH" };
  }
  if (isExecutable(FALLBACK_CODEX_PATH)) {
    return {
      executable: FALLBACK_CODEX_PATH,
      sanitizedPath: FALLBACK_CODEX_PATH,
      source: "ChatGPT-app-fallback",
    };
  }
  return null;
}

function sanitizeVersion(text) {
  const match = /(?:^|\s)codex(?:-cli)?\s+([0-9A-Za-z.+_-]+)/.exec(text || "");
  return match ? match[1] : null;
}

function sanitizeLoginMode(text) {
  const normalized = String(text || "").toLowerCase();
  if (/not\s+logged\s+in|not\s+authenticated|logged\s+out/.test(normalized)) {
    return "not-logged-in";
  }
  if (/chatgpt|openai\s+account|subscription/.test(normalized)) return "chatgpt";
  if (/api[ -]?key|access[ -]?token/.test(normalized)) return "api-key-not-permitted";
  return "unknown";
}

function isChildRunning(child) {
  return Boolean(child) && child.exitCode === null && !child.signalCode;
}

function waitForChildExit(child, milliseconds) {
  if (!isChildRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("exit", finish);
      child.removeListener?.("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    child.once?.("exit", finish);
    child.once?.("error", finish);
  });
}

async function terminateWithEscalation(child, timeoutMs = DEFAULT_TIMEOUTS.shutdownMs) {
  if (!isChildRunning(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await waitForChildExit(child, timeoutMs);
  if (!isChildRunning(child)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await waitForChildExit(child, timeoutMs);
}

async function readCodexStatusOutput(executable, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUTS.versionMs;
  let child;
  try {
    child = spawnImpl(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: removeApiKeyEnvironment(options.environment),
    });
  } catch {
    return "";
  }

  const stdout = createRollingTextBuffer();
  const stderr = createRollingTextBuffer();
  child.on?.("error", () => undefined);
  child.stdout?.on?.("data", (chunk) => stdout.append(chunk));
  child.stderr?.on?.("data", (chunk) => stderr.append(chunk));
  try {
    await waitForChildExit(child, timeoutMs);
  } finally {
    await terminateWithEscalation(child, timeoutMs);
  }
  return `${stdout.text()}\n${stderr.text()}`;
}

async function readVersion(executable, options = {}) {
  return sanitizeVersion(await readCodexStatusOutput(executable, ["--version"], options));
}

async function readLoginMode(executable, options = {}) {
  return sanitizeLoginMode(await readCodexStatusOutput(executable, ["login", "status"], options));
}

async function getHealth(options = {}) {
  const resolved = (options.resolveExecutable || resolveCodexExecutable)(options.environment || process.env);
  if (!resolved) {
    return { status: "unavailable", codexPath: null, version: null, loginMode: "unknown" };
  }
  const [version, loginMode] = await Promise.all([
    (options.readVersion || readVersion)(resolved.executable, {
      spawnImpl: options.spawnImpl,
      environment: options.environment,
      timeoutMs: options.versionMs,
    }),
    (options.readLoginMode || readLoginMode)(resolved.executable, {
      spawnImpl: options.spawnImpl,
      environment: options.environment,
      timeoutMs: options.versionMs,
    }),
  ]);
  return {
    status: version && loginMode === "chatgpt" ? "ok" : "unavailable",
    codexPath: resolved.sanitizedPath,
    version,
    loginMode,
  };
}

class CodexMcpClient {
  constructor(executable, options = {}) {
    this.executable = executable;
    this.spawnImpl = options.spawnImpl || spawn;
    this.environment = removeApiKeyEnvironment(options.environment);
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) };
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  async start() {
    if (this.child) return;
    try {
      this.child = this.spawnImpl(this.executable, ["mcp-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: this.environment,
      });
    } catch {
      throw new PreflightError("CODEX_START_FAILED");
    }
    if (!this.child || !this.child.stdin || !this.child.stdout) {
      throw new PreflightError("CODEX_START_FAILED");
    }
    this.child.stdout.setEncoding?.("utf8");
    this.child.stdout.on("data", (chunk) => this.#onStdout(String(chunk)));
    this.child.stderr?.resume?.();
    this.child.once("error", () => this.#rejectPending("CODEX_CONNECTION_FAILED"));
    this.child.once("exit", () => this.#rejectPending("CODEX_CONNECTION_CLOSED"));
  }

  async initialize() {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "cowork-codex-subagent", version: PLUGIN_VERSION },
      },
      this.timeouts.initializeMs,
    );
    if (!result || typeof result !== "object") throw new PreflightError("CODEX_INITIALIZE_FAILED");
    this.notify("notifications/initialized", {});
    return result;
  }

  async assertRequiredTools() {
    const result = await this.request("tools/list", {}, this.timeouts.toolsMs);
    const names = new Set(
      Array.isArray(result?.tools) ? result.tools.map((tool) => tool?.name).filter(Boolean) : [],
    );
    if (!names.has("codex") || !names.has("codex-reply")) {
      throw new PreflightError("CODEX_TOOLS_UNAVAILABLE");
    }
  }

  request(method, params, timeoutMs) {
    if (!this.child?.stdin?.writable) return Promise.reject(new PreflightError("CODEX_CONNECTION_FAILED"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PreflightError("CODEX_REQUEST_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PreflightError("CODEX_CONNECTION_FAILED"));
      }
    });
  }

  notify(method, params) {
    if (!this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // Notifications have no outcome that needs reporting.
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.#rejectPending("CODEX_CONNECTION_CLOSED");
    await terminateWithEscalation(child, this.timeouts.shutdownMs);
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        this.#onMessage(JSON.parse(line));
      } catch {
        this.#rejectPending("CODEX_PROTOCOL_ERROR");
      }
    }
  }

  #onMessage(message) {
    if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new PreflightError("CODEX_REQUEST_FAILED"));
      return;
    }
    pending.resolve(message.result);
  }

  #rejectPending(code) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new PreflightError(code));
    }
    this.pending.clear();
  }
}

function resultContainsOnlyText(result, expected) {
  const textBlocks = Array.isArray(result?.content)
    ? result.content.filter((block) => block?.type === "text" && typeof block.text === "string")
    : [];
  return textBlocks.length === 1 && textBlocks[0].text === expected;
}

function readThreadId(result, missingCode) {
  const threadId = result?.structuredContent?.threadId;
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 256) {
    throw new PreflightError(missingCode);
  }
  return threadId;
}

function safeFailureReport(code, initial, reply) {
  return { status: "failed", code: code || "PREFLIGHT_FAILED", checks: { initial, reply } };
}

async function createSecureTemporaryDirectory(makeTempDirectory = fs.promises.mkdtemp) {
  const directory = await makeTempDirectory(path.join(os.tmpdir(), "cowork-codex-subagent-"));
  await fs.promises.chmod(directory, 0o700);
  return directory;
}

async function runRoundtrip(options = {}) {
  const environment = options.environment || process.env;
  const resolveExecutable = options.resolveExecutable || resolveCodexExecutable;
  const resolved = resolveExecutable(environment);
  if (!resolved) return safeFailureReport("CODEX_NOT_FOUND", "not-run", "not-run");

  let loginMode = "unknown";
  try {
    loginMode = await (options.readLoginMode || readLoginMode)(resolved.executable, {
      spawnImpl: options.spawnImpl,
      environment,
      timeoutMs: options.loginMs || options.timeouts?.versionMs,
    });
  } catch {
    loginMode = "unknown";
  }
  if (loginMode !== "chatgpt") {
    return safeFailureReport("CHATGPT_LOGIN_REQUIRED", "not-run", "not-run");
  }

  let temporaryDirectory;
  let client;
  let initial = "not-run";
  let reply = "not-run";
  try {
    temporaryDirectory = await (options.createTemporaryDirectory || createSecureTemporaryDirectory)();
    const createClient =
      options.createClient ||
      ((executable, clientOptions) => new CodexMcpClient(executable, clientOptions));
    client = createClient(resolved.executable, {
      spawnImpl: options.spawnImpl,
      environment,
      timeouts: options.timeouts,
    });
    await client.start();
    await client.initialize();
    await client.assertRequiredTools();

    initial = "failed";
    const firstResult = await client.request(
      "tools/call",
      {
        name: "codex",
        arguments: {
          prompt: INITIAL_PROMPT,
          "approval-policy": "never",
          sandbox: "read-only",
          cwd: temporaryDirectory,
        },
      },
      client.timeouts.turnMs,
    );
    const threadId = readThreadId(firstResult, "INITIAL_THREAD_ID_MISSING");
    if (!resultContainsOnlyText(firstResult, INITIAL_RESPONSE)) {
      throw new PreflightError("INITIAL_CHALLENGE_FAILED");
    }
    initial = "passed";

    reply = "failed";
    const secondResult = await client.request(
      "tools/call",
      {
        name: "codex-reply",
        arguments: { threadId, prompt: REPLY_PROMPT },
      },
      client.timeouts.turnMs,
    );
    const replyThreadId = readThreadId(secondResult, "REPLY_THREAD_ID_MISSING");
    if (replyThreadId !== threadId) throw new PreflightError("REPLY_THREAD_ID_MISMATCH");
    if (!resultContainsOnlyText(secondResult, REPLY_RESPONSE)) {
      throw new PreflightError("REPLY_CHALLENGE_FAILED");
    }
    reply = "passed";
    return { status: "passed", checks: { initial, reply } };
  } catch (error) {
    return safeFailureReport(error instanceof PreflightError ? error.code : "PREFLIGHT_FAILED", initial, reply);
  } finally {
    try {
      if (client) await client.stop();
    } catch {
      // The report is intentionally independent of child-cleanup diagnostics.
    } finally {
      if (temporaryDirectory) {
        await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

module.exports = {
  CodexMcpClient,
  DEFAULT_ROLES,
  DEFAULT_TIMEOUTS,
  FALLBACK_CODEX_PATH,
  INITIAL_MARKER,
  MAX_STATUS_STREAM_BYTES,
  MAX_ROLE_BINDING_LENGTH,
  PLUGIN_VERSION,
  RECALL_TOKEN,
  REPLY_MARKER,
  PreflightError,
  ROLE_NAMES,
  ROLE_STATE_ENV,
  ROLE_STATE_VERSION,
  createRollingTextBuffer,
  createSecureTemporaryDirectory,
  getHealth,
  getRoles,
  readLoginMode,
  readVersion,
  removeApiKeyEnvironment,
  resolveCodexExecutable,
  resultContainsOnlyText,
  runRoundtrip,
  sanitizeLoginMode,
  setRole,
  terminateWithEscalation,
};
