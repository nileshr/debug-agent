# debug-agent

CLI debugger that runs a multi-phase debug loop on your codebase: hypothesize → instrument → reproduce → analyze → fix → verify → review → HTML report.

Uses **Cursor ACP** (`agent acp`) today. **Codex and other ACP agents** are on the roadmap.

## Requirements

- Node.js 20+
- [Cursor CLI](https://cursor.com/docs/cli): `agent` on PATH
- `agent login` (or `CURSOR_API_KEY`)
- Chrome (when verifying in the browser via `--url`)

## Install

**From source (dev):**

```bash
git clone https://github.com/nileshr/debug-agent.git
cd debug-agent
npm install
npm run build
npm link
```

**From a release tarball** — see [docs/INSTALL.md](./docs/INSTALL.md).

Verify the install:

```bash
debug setup
debug -v
```

## Run

From the repo you want to debug (defaults to the current directory):

```bash
cd /path/to/your/repo
debug run "Save button opens a blank modal" --url "http://localhost:3000"
```

Or pass the repo explicitly:

```bash
debug /path/to/your/repo \
  --bug "Save button opens a blank modal" \
  --url "http://localhost:3000"
```

- `--url` — browser verification (Chrome DevTools MCP). Omit for CLI/shell verification.
- Report opens by default at `~/.debug-agent/reports/run-<id>.html` (`--no-open` to skip).
- Agent prefs: `~/.debug-agent/config.json` (optional repo override in `<repo>/.debug-agent/config.json`).

Other useful commands:

```bash
debug setup --repo .                  # check current repo + MCP
debug config show                       # view saved model / browser prefs
debug upgrade                           # update from latest release
debug resume                            # continue an interrupted run
```

The `debug-agent` bin is an alias for the same CLI.

## More

- [docs/INSTALL.md](./docs/INSTALL.md) — releases, offline install, upgrade
- [AGENTS.md](./AGENTS.md) — architecture and maintainer details

MIT
