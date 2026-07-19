# Diagnosis: GitHub write aborted on `create_branch`

Runs on plugin `1.2.9` and, after upgrade, `1.3.0` both reached the first GitHub
write and failed with `user cancelled MCP tool call`. The worker correctly
classified the result as `GITHUB_WRITE_APPROVAL_ABORTED`, but the repeated
`1.3.0` failure disproved the original stale-plugin-only diagnosis.

## Reproduction

The `1.3.0` worker emitted these CLI overrides:

- global app default: `apps._default.default_tools_approval_mode="writes"`
- intended GitHub exception: `apps.github.default_tools_approval_mode="approve"`

Codex does not resolve that exception from the display slug `github`. Its app
policy evaluator indexes the app configuration by the concrete connector id
carried by tool metadata, such as `connector_examplegithub123`.

Successful GitHub reads and the failed `create_branch` carried the same concrete
connector id. Because `apps.github` did not match it, the GitHub exception was
ignored and the global `writes` mode remained effective. A non-read-only tool in
`writes` mode requested approval inside non-interactive `codex exec`; no approval
request event was exposed and the call completed in zero milliseconds as
`user cancelled MCP tool call`.

## Root cause

Plugin `1.3.0` configured approval policy under the GitHub display slug instead
of Codex's concrete connector id. Its unit test asserted only that the incorrect
string was present, not that Codex could resolve it for the live connector.

## Fix in 1.3.1

Before spawning the job, the worker now reads the concrete GitHub connector id
from the bounded Codex desktop state file, validates it against a narrow
`connector_...` grammar, and emits the quoted connector-specific override:

```text
apps."connector_examplegithub123".default_tools_approval_mode="approve"
```

The global `writes` mode remains in place for every other app. Missing,
malformed, symlinked, empty, or oversized Codex state fails closed with
`GITHUB_CONNECTOR_ID_UNAVAILABLE` before Codex starts. The optional
`COWORK_CODEX_APPROVAL_GATE` path uses the same resolved connector id.

Regression tests cover the previously red slug/id mismatch, connector-state
validation, optional-gate targeting, and the fail-closed no-spawn outcome.

## Operator action

1. Install plugin `1.3.1` or newer and reload plugins.
2. Run preflight in a new Cowork task.
3. Start the repository job as a fresh `orchestration_codex_start`; never resume
   an earlier aborted run.
