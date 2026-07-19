# Diagnosis: GitHub write aborted on `create_branch`

Run `CFT-20260718-210417-C274078F` reached the first GitHub write and failed with
`user cancelled MCP tool call`, which the worker correctly classifies as
`GITHUB_WRITE_APPROVAL_ABORTED`.

## Verified repository state

The repository copy inspected here is plugin version `1.3.0`. Version `1.3.0`
is the release that removed the default LLM approval reviewer for GitHub writes
and marks Bug 8 obsolete by removal.

The current worker behavior is:

- `COWORK_CODEX_APPROVAL_GATE` unset, empty, or any value other than `1`, `true`,
  or `on`: GitHub write tools get `apps.github.default_tools_approval_mode="approve"`.
- `COWORK_CODEX_APPROVAL_GATE=1|true|on`: the legacy reviewer is restored with
  `approvals_reviewer="auto_review"` and GitHub writes are routed through
  `apps.github.default_tools_approval_mode="writes"`.
- User Codex configuration is ignored by the worker via `--strict-config` and
  `--ignore-user-config`.

## Host evidence from this container

- `COWORK_CODEX_APPROVAL_GATE` is not set in the current shell.
- No `~/.codex/config.toml` exists in this container.
- No shell-profile or local `~/.codex`/`~/.claude` hit for
  `COWORK_CODEX_APPROVAL_GATE`, `approval_policy`, `apps.github`,
  `default_tools_approval_mode`, or `approvals_reviewer` was found.
- Network access to GitHub from this container returned `CONNECT tunnel failed,
  response 403`, so the live `main` branch, GitHub App installation page,
  ChatGPT Codex settings, and ChatGPT Desktop UI could not be verified here.

## Root-cause conclusion

With version `1.3.0` installed and the approval gate unset, the plugin does not
install an LLM approval reviewer for GitHub writes. A `user cancelled MCP tool
call` at the first `create_branch` therefore points outside the plugin's removed
Bug-8 gate: either the actual runtime used a stale installed plugin/config with
`COWORK_CODEX_APPROVAL_GATE` enabled, or the ChatGPT/Codex host surfaced its own
GitHub-write permission dialog and that dialog was dismissed or expired.

## Minimal remediation checklist

1. On the machine that launched the failed run, inspect the installed plugin copy
   (not only this source checkout) and confirm its `.claude-plugin/plugin.json`
   version is `1.3.0` or newer.
2. In the same launch environment, ensure `COWORK_CODEX_APPROVAL_GATE` is unset.
3. Remove or neutralize any host-level Codex approval override that affects the
   ChatGPT Desktop/Codex integration.
4. In ChatGPT Desktop, verify whether GitHub write tools show a native approval
   dialog; if they do, approve the dialog or disable that host-level prompt for
   the Codex GitHub app according to the app settings.
5. In GitHub App settings, verify that the ChatGPT/Codex app has access to
   `Markus137/peripheral`.
6. In chatgpt.com Codex settings, verify that `Markus137/peripheral` is connected
   and code review/automatic reviews are enabled if required by the workflow.
7. Restart the `peripheral` job as a fresh `orchestration_codex_start`; do not
   resume the aborted job.
