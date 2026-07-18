---
name: codex-preflight
description: >
  This skill should be used when the user asks to "run a Codex preflight",
  "check Codex MCP health", "verify the ChatGPT Codex login", or "test a
  Codex roundtrip" before relying on Codex in Cowork.
version: 1.2.12
---

# Codex Preflight

Use the installed `codex-preflight` MCP server only for a safe readiness check.

1. Call `preflight_health` to establish whether the locally installed Codex
   executable is available and which existing login mode it will use.
2. Call `preflight_codex_roundtrip` only when the user wants an authenticated
   readiness test. It starts a temporary read-only Codex session and removes
   its temporary directory after the test.
3. Report only the returned status and check outcomes. Do not request, set,
   reveal, or troubleshoot API keys, access tokens, prompts, model output,
   thread identifiers, or stderr.
4. Treat a failed preflight as an environment issue. Do not modify any project
   file, retry with broader permissions, or switch authentication methods.

The roundtrip is deliberately deterministic: it validates a first session and
a same-thread reply that recalls an internal value from the first turn, without
retaining that value, the thread identifier, or either response.
