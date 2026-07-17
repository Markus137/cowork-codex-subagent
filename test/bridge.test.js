"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  INITIAL_MARKER,
  MAX_STATUS_STREAM_BYTES,
  PLUGIN_VERSION,
  RECALL_TOKEN,
  REPLY_MARKER,
  createRollingTextBuffer,
  getHealth,
  readLoginMode,
  removeApiKeyEnvironment,
  runRoundtrip,
  sanitizeLoginMode,
  terminateWithEscalation,
} = require("../server/bridge");
const { createRequestHandler } = require("../server/index");

function createMockSpawn(options = {}) {
  const received = [];
  const killSignals = [];
  let replyThreadId;
  let initialPrompt;
  let replyPrompt;
  let mcpStarts = 0;
  const originalThreadId = "thread-mock-private";
  const replyText = options.replyText || `${REPLY_MARKER} ${RECALL_TOKEN}`;
  const configuredReplyThreadId = Object.prototype.hasOwnProperty.call(options, "replyThreadId")
    ? options.replyThreadId
    : originalThreadId;
  const spawnImpl = (executable, args, spawnOptions) => {
    assert.equal(executable, "/mock/codex");
    assert.deepEqual(args, ["mcp-server"]);
    mcpStarts += 1;
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.env.OPENAI_API_KEY, undefined);
    assert.equal(spawnOptions.env.AZURE_OPENAI_ENDPOINT, undefined);
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => undefined;
    child.stderr = { resume: () => undefined };
    child.stdin = {
      writable: true,
      write(line) {
        const message = JSON.parse(line);
        received.push(message);
        if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
        let result;
        if (message.method === "initialize") {
          result = { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} };
        } else if (message.method === "tools/list") {
          result = { tools: [{ name: "codex" }, { name: "codex-reply" }] };
        } else if (message.method === "tools/call" && message.params.name === "codex") {
          initialPrompt = message.params.arguments.prompt;
          assert.equal(message.params.arguments.sandbox, "read-only");
          assert.equal(message.params.arguments["approval-policy"], "never");
          result = {
            content: [{ type: "text", text: INITIAL_MARKER }],
            structuredContent: { threadId: originalThreadId },
          };
        } else if (message.method === "tools/call" && message.params.name === "codex-reply") {
          replyPrompt = message.params.arguments.prompt;
          replyThreadId = message.params.arguments.threadId;
          const structuredContent = configuredReplyThreadId === undefined ? {} : { threadId: configuredReplyThreadId };
          result = { content: [{ type: "text", text: replyText }], structuredContent };
        } else {
          throw new Error("Unexpected mock request");
        }
        queueMicrotask(() => {
          child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        });
      },
    };
    child.kill = (signal) => {
      killSignals.push(signal);
      if (!options.hungChild && child.exitCode === null) {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0, null));
      }
      return true;
    };
    return child;
  };
  return {
    getInitialPrompt: () => initialPrompt,
    getMcpStarts: () => mcpStarts,
    getReplyPrompt: () => replyPrompt,
    getReplyThreadId: () => replyThreadId,
    killSignals,
    received,
    spawnImpl,
  };
}

function createStatusSpawn({ stdout = "", stderr = "" } = {}) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      if (child.exitCode === null) {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0, null));
      }
      return true;
    };
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return child;
  };
  return { calls, spawnImpl };
}

function baseRoundtripOptions(mock, extra = {}) {
  return {
    spawnImpl: mock.spawnImpl,
    environment: {
      PATH: "/mock",
      OPENAI_API_KEY: "must-not-be-forwarded",
      AZURE_OPENAI_ENDPOINT: "must-not-be-forwarded",
    },
    readLoginMode: async () => "chatgpt",
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex", source: "PATH" }),
    timeouts: { initializeMs: 500, toolsMs: 500, turnMs: 500, shutdownMs: 10 },
    ...extra,
  };
}

test("roundtrip proves same-session recall without retaining token, thread id, or content", async () => {
  const mock = createMockSpawn();
  let temporaryDirectory;
  const report = await runRoundtrip(
    baseRoundtripOptions(mock, {
      createTemporaryDirectory: async () => {
        temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cowork-codex-subagent-"));
        return temporaryDirectory;
      },
    }),
  );

  assert.deepEqual(report, { status: "passed", checks: { initial: "passed", reply: "passed" } });
  assert.equal(mock.getReplyThreadId(), "thread-mock-private");
  assert.equal(mock.getInitialPrompt().includes(RECALL_TOKEN), true);
  assert.equal(mock.getReplyPrompt().includes(RECALL_TOKEN), false);
  assert.equal(fs.existsSync(temporaryDirectory), false);
  const reportText = JSON.stringify(report);
  assert.equal(reportText.includes("thread-mock-private"), false);
  assert.equal(reportText.includes(RECALL_TOKEN), false);
  assert.equal(reportText.includes("content"), false);
  assert.deepEqual(
    mock.received.filter((message) => message.method === "tools/call").map((message) => message.params.name),
    ["codex", "codex-reply"],
  );
  const initialize = mock.received.find((message) => message.method === "initialize");
  assert.equal(initialize.params.clientInfo.version, PLUGIN_VERSION);
});

test("roundtrip rejects a reply without structuredContent.threadId", async () => {
  const mock = createMockSpawn({ replyThreadId: undefined });
  const report = await runRoundtrip(baseRoundtripOptions(mock));
  assert.deepEqual(report, {
    status: "failed",
    code: "REPLY_THREAD_ID_MISSING",
    checks: { initial: "passed", reply: "failed" },
  });
});

test("roundtrip rejects a reply whose structuredContent.threadId differs", async () => {
  const mock = createMockSpawn({ replyThreadId: "different-thread" });
  const report = await runRoundtrip(baseRoundtripOptions(mock));
  assert.deepEqual(report, {
    status: "failed",
    code: "REPLY_THREAD_ID_MISMATCH",
    checks: { initial: "passed", reply: "failed" },
  });
});

test("roundtrip rejects a contextless reply that cannot reproduce the recall token", async () => {
  const mock = createMockSpawn({ replyText: REPLY_MARKER });
  const report = await runRoundtrip(baseRoundtripOptions(mock));
  assert.deepEqual(report, {
    status: "failed",
    code: "REPLY_CHALLENGE_FAILED",
    checks: { initial: "passed", reply: "failed" },
  });
});

test("non-ChatGPT login modes fail before a temporary directory or MCP child starts", async () => {
  for (const loginMode of ["api-key-not-permitted", "unknown"]) {
    let temporaryDirectoryRequested = false;
    const mock = createMockSpawn();
    const report = await runRoundtrip(
      baseRoundtripOptions(mock, {
        readLoginMode: async () => loginMode,
        createTemporaryDirectory: async () => {
          temporaryDirectoryRequested = true;
          throw new Error("must not be called");
        },
      }),
    );
    assert.deepEqual(report, {
      status: "failed",
      code: "CHATGPT_LOGIN_REQUIRED",
      checks: { initial: "not-run", reply: "not-run" },
    });
    assert.equal(temporaryDirectoryRequested, false);
    assert.equal(mock.getMcpStarts(), 0);
  }
});

test("credential and OpenAI/Azure routing variables are removed while runtime variables survive", () => {
  const safe = removeApiKeyEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8",
    NORMAL_VALUE: "preserved",
    OPENAI_API_KEY: "secret",
    SESSION_TOKEN: "secret",
    SUPER_SECRET: "secret",
    DB_PASSWORD: "secret",
    CLOUD_CREDENTIAL: "secret",
    OPENAI_BASE_URL: "route",
    OPENAI_ENDPOINT: "route",
    OPENAI_ORG: "route",
    OPENAI_PROJECT: "route",
    AZURE_OPENAI_BASE_URL: "route",
    AZURE_OPENAI_ENDPOINT: "route",
    AZURE_ORG: "route",
    AZURE_PROJECT: "route",
  });
  assert.deepEqual(safe, {
    PATH: "/bin",
    HOME: "/home/test",
    TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8",
    NORMAL_VALUE: "preserved",
  });
});

test("status reader accepts a ChatGPT login written only to stderr and Health becomes ok", async () => {
  const status = createStatusSpawn({ stderr: "Logged in using ChatGPT\n" });
  const loginMode = await readLoginMode("/mock/codex", { spawnImpl: status.spawnImpl, timeoutMs: 100 });
  assert.equal(loginMode, "chatgpt");
  assert.deepEqual(status.calls[0].args, ["login", "status"]);

  const health = await getHealth({
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex", source: "PATH" }),
    readVersion: async () => "0.144.0",
    readLoginMode: async () =>
      readLoginMode("/mock/codex", {
        spawnImpl: createStatusSpawn({ stderr: "Logged in using ChatGPT\n" }).spawnImpl,
        timeoutMs: 100,
      }),
  });
  assert.deepEqual(health, {
    status: "ok",
    codexPath: "codex",
    version: "0.144.0",
    loginMode: "chatgpt",
  });
});

test("bounded status buffers drain sensitive stderr without leaking it into Health or tool reports", async () => {
  const sensitiveLine = "SENSITIVE-STDERR-DO-NOT-REPORT";
  const status = createStatusSpawn({
    stderr: `${sensitiveLine}\nLogged in using ChatGPT\n`,
  });
  const health = await getHealth({
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex", source: "PATH" }),
    readVersion: async () => "0.144.0",
    readLoginMode: async () =>
      readLoginMode("/mock/codex", { spawnImpl: status.spawnImpl, timeoutMs: 100 }),
  });
  assert.equal(JSON.stringify(health).includes(sensitiveLine), false);

  const messages = [];
  const { handle } = createRequestHandler({
    send: (message) => messages.push(message),
    getHealthImpl: async () => health,
  });
  await handle({
    jsonrpc: "2.0",
    id: "health-43",
    method: "tools/call",
    params: { name: "preflight_health", arguments: {} },
  });
  assert.equal(messages[0].id, "health-43");
  assert.equal(JSON.stringify(messages[0]).includes(sensitiveLine), false);

  const rolling = createRollingTextBuffer();
  rolling.append(Buffer.alloc(MAX_STATUS_STREAM_BYTES + 1, 97));
  rolling.append("tail");
  assert.equal(rolling.byteLength() <= MAX_STATUS_STREAM_BYTES, true);
  assert.equal(rolling.text().endsWith("tail"), true);
});

test("termination escalates from SIGTERM to SIGKILL for a hung child", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  await terminateWithEscalation(child, 5);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("temporary directory cleanup still runs when client.stop throws", async () => {
  let temporaryDirectory;
  const report = await runRoundtrip({
    environment: { PATH: "/mock" },
    resolveExecutable: () => ({ executable: "/mock/codex", sanitizedPath: "codex", source: "PATH" }),
    readLoginMode: async () => "chatgpt",
    createTemporaryDirectory: async () => {
      temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cowork-codex-subagent-"));
      return temporaryDirectory;
    },
    createClient: () => ({
      start: async () => {
        throw new Error("private implementation failure");
      },
      stop: async () => {
        throw new Error("private cleanup failure");
      },
    }),
  });
  assert.equal(report.status, "failed");
  assert.equal(fs.existsSync(temporaryDirectory), false);
});

test("tool failures retain the original JSON-RPC id and redact the thrown error", async () => {
  const messages = [];
  const { handle } = createRequestHandler({
    send: (message) => messages.push(message),
    runRoundtripImpl: async () => {
      throw new Error("raw stderr, prompt, and token must not leave the server");
    },
  });
  await handle({
    jsonrpc: "2.0",
    id: "request-42",
    method: "tools/call",
    params: { name: "preflight_codex_roundtrip", arguments: {} },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "request-42");
  assert.equal(messages[0].result.isError, true);
  assert.equal(messages[0].result.structuredContent.code, "PREFLIGHT_TOOL_FAILED");
  assert.equal(JSON.stringify(messages[0]).includes("raw stderr"), false);
});

test("login status is classified without returning its raw content", () => {
  assert.equal(sanitizeLoginMode("Logged in with ChatGPT"), "chatgpt");
  assert.equal(sanitizeLoginMode("Logged in with an API key"), "api-key-not-permitted");
  assert.equal(sanitizeLoginMode("Not logged in"), "not-logged-in");
});
