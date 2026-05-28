# debug-agent — agent context

TypeScript CLI that speaks **Cursor ACP** (`agent acp`, JSON-RPC over stdio) to run a multi-phase bug-fix loop emulating IDE Debug Mode.

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
| `src/cli.ts` | `bugfix` entrypoint |
| `scripts/smoke-*.mjs` | ACP + report smoke tests |

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
bugfix <repo> --bug "..." --url "http://..."
```

## Conventions

- ESM (`"type": "module"`), NodeNext, strict TS
- Do not commit `node_modules/`, `dist/`
- Keep HTML reports fully offline (no CDN assets)
- Minimize scope when fixing bugs in this repo

## Operational rules (this project)

- Run `npm run build` before claiming green
- Do not edit user target repos beyond what the agent loop requires
- Reports and ledgers are diagnostic artifacts; do not commit them from target repos
