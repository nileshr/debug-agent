# debug-agent

Bug-fix CLI that drives **Cursor `agent acp`** through an emulated Debug Mode loop: hypothesize → instrument → reproduce in Chrome → fix → verify → review → HTML report.

Native Cursor Debug Mode is **not** available over ACP (only `agent`, `plan`, `ask`). This tool reproduces that workflow with prompts and `chrome-devtools-mcp`.

## Quick start

```bash
# Once
agent login
cd ~/work/debug-agent && npm install && npm run build && npm link

# Per bug (app must be running at --url)
bugfix /path/to/your/repo \
  --bug "Save button opens a blank modal" \
  --url "http://localhost:3000"
```

When the run finishes, open the HTML report (auto-opens by default):

`~/.debug-agent/reports/run-<id>.html`

## Requirements

- Cursor CLI: `agent` on PATH
- `agent login` (or `CURSOR_API_KEY`)
- Node 20+
- Chrome (for `chrome-devtools-mcp`)

On first run, `chrome-devtools` is added to `<repo>/.cursor/mcp.json` if missing.

## Common flags

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
```

## More detail

See [AGENTS.md](./AGENTS.md) for architecture, phase loop, and contributor notes.

MIT
