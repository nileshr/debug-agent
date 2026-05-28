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

## ACP facts (verified)

- `session/new` → `availableModes`: `agent`, `plan`, `ask` only — **no `debug`**
- Inline `mcpServers` array entries fail validation; use project `.cursor/mcp.json`
- Auth: `authenticate` + `cursor_login` (requires prior `agent login`)
- Mid-session mode: `session/set_config_option` with `optionId: "mode"`

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
debug setup [--repo <path>]
debug <repo> --bug "..." --url "http://..."
debug run <repo> --bug "..." --url "http://..."
```

Setup checks: `src/setup/checks.ts`, `src/setup/run-setup.ts`.

## Conventions

- ESM (`"type": "module"`), NodeNext, strict TS
- Do not commit `node_modules/`, `dist/`
- Keep HTML reports fully offline (no CDN assets)
- CLI name is `debug`; package/repo name is `debug-agent`

## Operational rules (this project)

- Run `npm run build` before claiming green
- Do not edit user target repos beyond what the debug loop requires
- Reports and ledgers are diagnostic artifacts; do not commit them from target repos
