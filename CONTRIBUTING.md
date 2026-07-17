# Contributing

Thanks for your interest in Cowork Codex Subagent. Contributions of all sizes
are welcome — bug reports, fixtures, documentation, and code.

## Running the tests

The whole point of the suite is that it is **cheap to run**. It uses only the
Node.js built-in test runner and local mocks:

- **no network**
- **no GitHub**
- **no Codex / no ChatGPT login**
- **no third-party dependencies to install**

It finishes in **under a second** (currently 147 tests). That means you can run
it on every save and get an honest signal without waiting on — or paying for —
an external service.

Requirements: **Node.js 18+** (the suite is developed against Node 22). Then:

```bash
# run everything
node --test

# run a single file
node --test test/jobs.test.js

# watch mode while iterating
node --test --watch
```

There is nothing to build and nothing to configure. If a test needs GitHub or
Codex behavior, it uses a fixture in `test/fixtures/` or an injected mock, never
a live call.

## Repository layout

| Path | What lives there |
|---|---|
| `server/` | The MCP host: bridge, job worker, result-envelope schema, GitHub evidence validators. This is the substance of the plugin — change it deliberately and with tests. |
| `skills/codex-orchestration/` | The orchestration skill, its references, and evals. |
| `skills/codex-preflight/` | The preflight skill. |
| `test/` | Node built-in test files (`*.test.js`) and `test/fixtures/` regression data. |
| `.claude-plugin/` | `plugin.json` and `marketplace.json`. |

## Guidelines

- **Keep the suite green and offline.** Any change to `server/` should come with
  tests, and those tests must not reach the network, GitHub, or Codex. Add or
  extend a fixture instead.
- **Fixtures capture structure, not identity.** Repository names in fixtures are
  neutral placeholders (for example `example-org/web-template`). Don't add real
  private repository names, absolute local paths (a home directory or a
  machine temp path), usernames, tokens, or other personal data.
- **Prefer small, focused changes.** The validation logic, fetch observation,
  envelope schema, and evidence serialization are hard-won; don't refactor them
  as a side effect of an unrelated change.
- **Match the surrounding style.** No formatter or linter config ships with the
  repo — read the neighboring code and follow its conventions.

## Reporting issues

Please include the plugin version (`.claude-plugin/plugin.json`), your Node.js
version, and the exact failing command or observed behavior. For behavior that
depends on the live GitHub/Codex service, a captured fixture of the metadata
shape is the most useful thing you can attach.
