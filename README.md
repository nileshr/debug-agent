# debug-agent

CLI debugger that runs a multi-phase debug loop on your codebase: hypothesize → instrument → reproduce → analyze → fix → verify → review → HTML report.

Works with **any ACP agent** via presets — Cursor (`agent acp`, the default), Claude Code (`claude-agent-acp`), Codex (`codex-acp`), Gemini CLI (`gemini --experimental-acp`), or a custom command. Pick with `--agent <preset>` or `acp.preset` in config.

The loop itself has three autonomy levels (`--autonomy`):

- `static` — the classic fixed phase flow.
- `guided` (default) — a deterministic orchestrator handles hinges: retries steps whose
  structured result was missing, inserts a read-only `explore` step when
  analysis is inconclusive, and pauses to ask you questions when it can't
  proceed confidently (exit code 3; continue with `debug resume --answer "..."`).
  Set `models.orchestrator` (or `--orchestrator-model`) to let an LLM make
  those hinge decisions instead of heuristics.
- `autonomous` — an LLM decides after every step (guardrails still enforce
  budgets, legal transitions, and verify-before-finish; every decision is
  recorded with its rationale in the HTML report).

Exit codes: `0` fixed · `1` error · `2` partial · `3` waiting on your answers.

## Requirements

- Node.js 22.5+
- An ACP agent on PATH — by default the [Cursor CLI](https://cursor.com/docs/cli)
  (`agent` + `agent login` / `CURSOR_API_KEY`); for other presets, that agent's
  own install + auth (e.g. `ANTHROPIC_API_KEY` for `--agent claude`)
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
debug resume --answer "..."             # answer a waiting run's questions (exit code 3)
debug run . --agent claude --bug "..."  # use another ACP agent preset
debug run . --autonomy guided --bug "..."  # dynamic loop with heuristics
```

The `debug-agent` bin is an alias for the same CLI.

## More

- [docs/INSTALL.md](./docs/INSTALL.md) — releases, offline install, upgrade
- [AGENTS.md](./AGENTS.md) — architecture and maintainer details

MIT
