# debug-agent

ACP debugger that **emulates** Cursor IDE Debug Mode: hypothesize → instrument → reproduce in Chrome → fix → verify → review → HTML report.

Native Debug Mode is not available over ACP (`agent`, `plan`, `ask` only). This CLI reproduces that workflow via `agent acp`, `chrome-devtools-mcp`, and `.cursor/debug.log`.

## Quick start

```bash
# Once
agent login
cd ~/work/debug-agent && npm install && npm run build && npm link

# Verify environment
debug setup
debug setup --repo /path/to/your/repo

# Run debugger on a bug (app must be running at --url)
debug /path/to/your/repo \
  --bug "Save button opens a blank modal" \
  --url "http://localhost:3000"
```

Report (auto-opens by default): `~/.debug-agent/reports/run-<id>.html`

The `debug-agent` bin is an alias for the same CLI.

## Requirements

- Cursor CLI: `agent` on PATH
- `agent login` (or `CURSOR_API_KEY`)
- Node 20+
- Chrome (for `chrome-devtools-mcp`)

Adds `chrome-devtools` to `<repo>/.cursor/mcp.json` on first run if missing.

## Commands

| Command | Purpose |
|---------|---------|
| `debug setup` | Check Node, CLI, auth, Chrome, MCP, ACP |
| `debug run <repo> --bug ... --url ...` | Explicit run |
| `debug <repo> --bug ... --url ...` | Same as `run` (default) |

### Setup flags

| Flag | Purpose |
|------|---------|
| `--repo <path>` | Check target `.cursor/mcp.json` |
| `--skip-acp-probe` | Skip live ACP session |
| `--json` | JSON output |

### Run flags

| Flag | Purpose |
|------|---------|
| `--no-open` | Print `file://` link only |
| `--no-report` | Skip HTML report |
| `--max-cycles 5` | Cap verify/fix retries |
| `--model "composer-2.5[fast=true]"` | ACP model |

## Smoke tests

```bash
npm run smoke:acp
npm run smoke:report
npm run setup
```

## More detail

See [AGENTS.md](./AGENTS.md).

MIT
