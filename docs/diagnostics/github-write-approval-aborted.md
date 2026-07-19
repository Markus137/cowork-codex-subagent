# Diagnosis: GitHub write aborted on `create_branch`

Runs on plugin `1.2.9`, `1.3.0`, and `1.3.1` all completed read-only GitHub
inspection and then failed at the first write with `user cancelled MCP tool
call`. The worker correctly classified each result as
`GITHUB_WRITE_APPROVAL_ABORTED`, but two separate configuration-key errors kept
the intended GitHub auto-approval exception from matching the live connector.

## Reproduction

The worker retains a fail-closed global app default:

```text
apps._default.default_tools_approval_mode="writes"
```

Version `1.3.0` attempted to override GitHub under its display slug:

```text
apps.github.default_tools_approval_mode="approve"
```

Codex indexes app policy by the concrete connector id carried by tool metadata,
not by the display slug. Version `1.3.1` resolved the right id but quoted that
segment in a CLI dotted-path override:

```text
apps."connector_examplegithub123".default_tools_approval_mode="approve"
```

Codex's CLI override parser splits dotted paths itself; it does not interpret
those quote characters as TOML key syntax. A direct app-server `config/read`
therefore exposed the literal map key `"\"connector_examplegithub123\""`, while
the live GitHub tools carried `connector_examplegithub123`. The policy entry
still did not match.

In the `1.3.1` reproduction, the session reported
`approvals_reviewer="user"`; the failed `create_branch` used the same concrete
connector id as successful reads and returned `user cancelled MCP tool call`
with a zero-duration result. No content-policy or repository-denial event was
present.

## Root cause

Plugin `1.3.0` targeted a display slug, and its `1.3.1` correction serialized the
right connector id with quote characters that Codex retained literally in the
app-policy map key. In both versions the connector-specific `approve` entry was
unmatched, so the global `writes` fallback remained effective in non-interactive
`codex exec`.

## Fix in 1.3.2

The connector id is already restricted to the bare-key-safe grammar
`^connector_[A-Za-z0-9_]{1,128}$`. The worker now emits it without quote
characters in the CLI dotted path:

```text
apps.connector_examplegithub123.default_tools_approval_mode="approve"
```

The global `writes` mode remains in place for every other app. Missing,
malformed, symlinked, empty, or oversized Codex state still fails closed with
`GITHUB_CONNECTOR_ID_UNAVAILABLE` before Codex starts. The optional
`COWORK_CODEX_APPROVAL_GATE` path uses the same bare connector key.

The regression test was added before the correction and failed against `1.3.1`
because only the literal-quote form was generated. Tests now require the bare
key and explicitly reject the quoted form. The release check also reads the
effective configuration from Codex app-server and requires the app map to
contain the unquoted connector id.

## Operator action

1. Install plugin `1.3.2` or newer and reload plugins.
2. Run preflight in a new Cowork task and confirm the loaded version.
3. Start the repository job as a fresh `orchestration_codex_start`; never resume
   an earlier aborted run.
