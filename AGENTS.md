# debug-agent — agent context

TypeScript CLI (`debug` / `debug-agent` bins) that speaks **Cursor ACP** (`agent acp`, JSON-RPC over stdio) to run a multi-phase debug loop emulating IDE Debug Mode.

## Layout

| Path | Role |
|------|------|
| `src/acp/client.ts` | ACP client: spawn, send, notifications, permission + cursor/* handlers |
| `src/acp/types.ts` | Zod schemas for RPC payloads |
| `src/debug/controller.ts` | Phase state machine |
| `src/debug/prompts.ts` | Per-phase prompt templates + JSON extraction |
| `src/debug/repo-paths.ts` | Repo-local `.debug-agent/` paths (config, log, ledgers) |
| `src/debug/log-tail.ts` | `.debug-agent/debug.log` JSONL reader / waiter |
| `src/config/` | Agent prefs: models (planner/fixer/reviewer), browser MCP; global + repo overrides |
| `src/mcp/browser.ts` | Ensures selected browser MCP in repo `.cursor/mcp.json`; ACP uses `mcpServers: []` |
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
- Resume: `session/load` with `{ sessionId, cwd, mcpServers }` — CLI flag `--session <id>`

## Phase loop

`hypothesize` (plan) → `instrument` → `reproduce` → `analyze` → `apply_fix` → `verify` → (`mark_fixed` | retry) → `review` → `apply_review` → `re_verify` → `summarize`

- Instrumentation sentinel: `// DEBUG-INSTRUMENT:<runId>`
- Runtime log: `<repo>/.debug-agent/debug.log` (JSONL)
- Run ledger: `<repo>/.debug-agent/debug-runs/<runId>.json`
- Run state DB: `~/.debug-agent/state.db` (SQLite: per-phase status + ledger snapshot for crash resume)
- Agent config: `~/.debug-agent/config.json` (global); optional `<repo>/.debug-agent/config.json` (overrides global)
- Cursor MCP stays in `<repo>/.cursor/mcp.json` (ACP requirement)
- Default models: planner `claude-opus-4-8-thinking-high`, fixer `composer-2.5[fast=true]`, reviewer `gpt-5.4-xhigh`
- Browser MCP: `playwright` (default) or `chrome-devtools`; only one is written to `.cursor/mcp.json`
- Phase prompts: bundled `prompt-templates/`; overrides in `~/.debug-agent/prompts/` or `<repo>/.debug-agent/prompts/`
- Run logs: `~/.debug-agent/logs/YYYY-MM-DD/<id>-<ts>.log` (share for issue reports)

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
debug run <repo> --session <sessionId> --bug "..."   # resume ACP session only (no phase DB)
debug resume [repo] [--run <id>]                     # resume interrupted run (phase + ledger + session)
debug report [repo] [--run <id>] [--no-open]         # HTML report from state DB (works mid-run)
debug runs [--repo <path>] [--status interrupted]    # list runs from state DB
debug config [show|init|set]                         # agent model + browser MCP prefs
debug config init -y                                 # non-interactive defaults
debug run --confirm-plan                             # pause after hypothesize for approval
```

First run with no config files opens an interactive picker (TTY); saves `~/.debug-agent/config.json`. Per-phase ACP model switches: hypothesize → planner, review → reviewer, else → fixer.

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

Reset clears stale `<repo>/.debug-agent/` from prior runs.

## Conventions

- ESM (`"type": "module"`), NodeNext, strict TS
- Do not commit `node_modules/`, `dist/`
- Keep HTML reports fully offline (no CDN assets)
- CLI name is `debug`; package/repo name is `debug-agent`

## Operational rules (this project)

- Run `npm run build` before claiming green
- Do not edit user target repos beyond what the debug loop requires
- Reports and ledgers are diagnostic artifacts; do not commit them from target repos

## Learned User Preferences

- Uses multitask mode and background subagents for parallelizable work
- When dogfooding debug-agent on itself, omit `--url` — CLI/shell verification is preferred over browser
- Prefer positional bug prompts (`debug run "save fails"`) and optional flags over requiring `--bug` and `--url`
- Local dev iteration: bump version, `npm run build`, then `npm link` to refresh the global `debug` bin
- Todo fixture harness is maintainer-only dev tooling — do not expose fixture orchestration as public CLI subcommands
- Fixture bugs should have browser-observable symptoms even when maintainer tests define precise acceptance

## Learned Workspace Facts

- This repo has no root `vite.config.*` — `debug run` without `--url` defaults to CLI verify mode (shell), not browser
- Verify mode: `--url` or `vite.config.*` → browser (Playwright MCP by default); neither → CLI (shell commands, no browser MCP setup)
- ACP session: one `session/new` (or `session/load`) per debug run; all phases use `session/prompt` on the same sessionId (mode/model change per phase)
- `tsc` emits `dist/cli.js` as non-executable (644); build runs `chmod +x dist/cli.js` — required for `npm link` or zsh reports `permission denied: debug`
- Distribution is GitHub Releases (`npm pack` tarball + `SHA256SUMS.txt`), not npm registry; `debug upgrade` installs from release assets
- CLI shorthand `debug <repo> --bug …` is rewritten to `debug run …` before parsing — do not reintroduce duplicate Commander options on root + `run`
- HTML reports include a structured agent trace timeline; CLI shows a rolling live stream of the last few agent messages per phase
- Todo fixture oracle and acceptance tests live in `examples/todo-fixture/maintainer/` and are never copied into the disposable workdir
