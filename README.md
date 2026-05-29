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

## Todo fixture (maintainer harness)

Dev-only resettable Vite React todo app for verifying debug-agent against known bugs.

```bash
# Prepare disposable workdir from seed
npm run fixture:reset

# Manual inspection (http://localhost:5199)
npm run fixture:serve

# List seeded bugs and symptom text
npm run fixture:list

# Run debug-agent on one bug (fresh reset each time)
npm run fixture:run:one -- add-todo

# Run all bugs in order (--interactive pauses between bugs)
npm run fixture:run:all
npm run fixture:run:all:auto

# Maintainer acceptance (fails on broken baseline, passes when fixed)
npm run fixture:accept
```

| Path | Role |
|------|------|
| `examples/todo-fixture/seed/` | Committed broken app |
| `.tmp/todo-fixture-workdir/` | Disposable copy passed to `debug` |
| `examples/todo-fixture/bugs.json` | Symptom-only manifest for `--bug` |
| `examples/todo-fixture/maintainer/` | Expected behavior + Vitest/Playwright oracle |
| `scripts/todo-fixture.mjs` | reset / serve / run / accept |

Override debugger binary: `DEBUG_BIN=debug npm run fixture:run:one -- add-todo` (default uses local `dist/cli.js`).

See [examples/todo-fixture/README.md](./examples/todo-fixture/README.md).

## Version and upgrade

```bash
debug -v
debug -V
debug upgrade --check
debug upgrade
```

## Install on other computers

See **[docs/INSTALL.md](./docs/INSTALL.md)** for GitHub releases, offline `.tgz`, git clone, and `npm link`.

Quick install from latest release:

```bash
# See https://github.com/nileshr/debug-agent/releases for VERSION
curl -fsSL -o debug-agent-VERSION.tgz \
  "https://github.com/nileshr/debug-agent/releases/latest/download/debug-agent-VERSION.tgz"
npm install -g ./debug-agent-VERSION.tgz
```

Quick tarball from source:

```bash
npm run build && npm pack
# copy debug-agent-*.tgz to target machine:
npm install -g ./debug-agent-0.1.1.tgz
```

## More detail

See [AGENTS.md](./AGENTS.md).

MIT
