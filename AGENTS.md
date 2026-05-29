# debug-agent — agent context

TypeScript CLI (`debug` / `debug-agent` bins) that speaks **Cursor ACP** (`agent acp`, JSON-RPC over stdio) to run a multi-phase debug loop emulating IDE Debug Mode.

## Layout

| Path | Role |
|------|------|
| `src/acp/client.ts` | ACP client: spawn, send, notifications, permission + cursor/* handlers |
| `src/acp/types.ts` | Zod schemas for RPC payloads |
| `src/debug/controller.ts` | Phase state machine |
| `src/debug/prompts.ts` | Per-phase prompt templates + JSON extraction |
| `src/debug/log-tail.ts` | `.cursor/debug.log` JSONL reader / waiter |
| `src/mcp/chrome.ts` | Ensures `chrome-devtools` in repo `.cursor/mcp.json`; ACP uses `mcpServers: []` |
| `src/permissions.ts` | Auto-allow repo + chrome-devtools tools |
| `src/report/` | Self-contained HTML → `~/.debug-agent/reports/` |
| `src/setup/` | `debug setup` prerequisite checks |
| `src/cli.ts` | CLI entry (`debug`, subcommands `setup` / `run`) |
| `examples/todo-fixture/` | Resettable Vite todo fixture + maintainer oracle (dev-only) |
| `scripts/todo-fixture.mjs` | Fixture harness: reset, serve, run, accept |

## ACP facts (verified)

- `session/new` → `availableModes`: `agent`, `plan`, `ask` only — **no `debug`**
- Inline `mcpServers` array entries fail validation; use project `.cursor/mcp.json`
- Auth: `authenticate` + `cursor_login` (requires prior `agent login`)
- Mid-session mode: `session/set_config_option` with `configId: "mode"`

## Phase loop

`hypothesize` (plan) → `instrument` → `reproduce` → `analyze` → `apply_fix` → `verify` → (`mark_fixed` | retry) → `review` → `apply_review` → `re_verify` → `summarize`

- Instrumentation sentinel: `// DEBUG-INSTRUMENT:<runId>`
- Runtime log: `<repo>/.cursor/debug.log` (JSONL)
- Run ledger: `<repo>/.cursor/debug-runs/<runId>.json`

## Commands

```bash
npm run build
npm run typecheck
npm run smoke:acp
npm run smoke:report
npm run smoke:version
npm run publish [-- --patch|--minor|--major|--dry-run]
debug -v
debug -V
debug setup [--repo <path>]
debug upgrade [--check] [--force]
debug <repo> --bug "..." --url "http://..."
debug run <repo> --bug "..." --url "http://..."
```

- Setup: `src/setup/checks.ts`, `src/setup/run-setup.ts`
- Upgrade: `src/setup/upgrade.ts`, `src/setup/github-release.ts`
- Version: `src/version.ts` (reads `package.json`)
- Distribution: `docs/INSTALL.md`, GitHub Releases via `.github/workflows/release.yml` + `npm run publish` (`scripts/publish.mjs`); release asset is `npm pack` tarball + `SHA256SUMS.txt`

## Todo fixture (dev-only)

Resettable verification harness for debug-agent versions:

- **Seed:** `examples/todo-fixture/seed/` — committed broken todo app (5 bugs)
- **Workdir:** `.tmp/todo-fixture-workdir/` — disposable copy; target for `debug`
- **Manifest:** `examples/todo-fixture/bugs.json` — symptom text only (passed to `--bug`)
- **Oracle:** `examples/todo-fixture/maintainer/` — expected behavior + Vitest/Playwright; **not** copied into workdir
- **Harness:** `npm run fixture:*` → `scripts/todo-fixture.mjs`

`run one` resets before each bug; `run all` resets once then fixes cumulatively. Default runner builds and uses local `dist/cli.js`; set `DEBUG_BIN=debug` to use installed CLI.

Reset clears stale `.cursor/debug.log` and `.cursor/debug-runs/` from prior runs.

## Conventions

- ESM (`"type": "module"`), NodeNext, strict TS
- Do not commit `node_modules/`, `dist/`
- Keep HTML reports fully offline (no CDN assets)
- CLI name is `debug`; package/repo name is `debug-agent`

## Operational rules (this project)

- Run `npm run build` before claiming green
- Do not edit user target repos beyond what the debug loop requires
- Reports and ledgers are diagnostic artifacts; do not commit them from target repos
