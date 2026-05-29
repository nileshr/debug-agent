# Installing debug-agent on other machines

The CLI commands are **`debug`** and **`debug-agent`** (same binary).

## Requirements (target machine)

- Node.js 20+
- Cursor CLI: `agent` on PATH
- `agent login` (or `CURSOR_API_KEY`)
- Google Chrome (for reproduction)
- Network for `npx chrome-devtools-mcp@latest` on first run

Run after install:

```bash
debug setup
debug -v
debug -V
```

---

## Option A — npm registry (recommended for teams)

Publish once (from this repo):

```bash
npm run build
npm publish   # public npm, or private registry (@scope/debug-agent if name is taken)
```

If the public name `debug-agent` is already taken on npm, use a scoped package (`@your-org/debug-agent`) and update `name` in `package.json` before publishing.

On each machine:

```bash
npm install -g debug-agent
debug setup
```

Upgrade later:

```bash
debug upgrade
# or
npm install -g debug-agent@latest
```

Check only:

```bash
debug upgrade --check
```

---

## Option B — Offline tarball (no registry)

On a machine with the repo (or CI):

```bash
npm run build
npm pack
# creates debug-agent-0.1.0.tgz
```

Copy `debug-agent-*.tgz` to the target machine, then:

```bash
npm install -g ./debug-agent-0.1.0.tgz
debug setup
```

Upgrade: copy a newer `.tgz` and run `npm install -g ./debug-agent-x.y.z.tgz` again.

---

## Option C — Git clone (dev / internal)

```bash
git clone <your-repo-url> debug-agent
cd debug-agent
npm install
npm run build
npm link    # puts `debug` and `debug-agent` on PATH
debug setup
```

Upgrade on that machine:

```bash
debug upgrade
# runs: git pull --ff-only && npm install && npm run build
```

---

## Option D — Run without global install

```bash
npx debug-agent setup          # after publish to npm
# or from clone:
node /path/to/debug-agent/dist/cli.js setup
```

---

## Version and upgrade commands

| Command | Purpose |
|---------|---------|
| `debug -v` / `debug -V` / `debug --version` | Print installed version |
| `debug upgrade` | Upgrade by install type (npm global / git / local dev) |
| `debug upgrade --check` | Compare with npm registry only |
| `debug upgrade --force` | Reinstall even if versions match |
| `debug upgrade --tag beta` | Use npm dist-tag |

---

## What gets published

`npm pack` / `npm publish` include only:

- `dist/` (compiled JS)
- `README.md`, `AGENTS.md`, `docs/`

Source (`src/`) is not shipped; `prepack` runs `npm run build` automatically.

---

## Troubleshooting installs

| Issue | Fix |
|-------|-----|
| `debug: command not found` | Ensure global npm bin is on PATH (`npm bin -g`) |
| `upgrade` says not on npm | Use tarball (Option B) or publish (Option A) |
| Old `bugfix` command | `npm unlink -g bugfix` then install `debug-agent` |
| Permission errors on `-g` | Use `nvm` or fix npm prefix, avoid `sudo` when possible |
