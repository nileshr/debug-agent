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

## Option A — GitHub release (recommended)

Releases ship an npm-style `.tgz` tarball plus `SHA256SUMS.txt` on [GitHub Releases](https://github.com/nileshr/debug-agent/releases).

### Install from latest release

```bash
# Replace VERSION with the tag (e.g. 0.1.1)
curl -fsSL -o debug-agent-VERSION.tgz \
  "https://github.com/nileshr/debug-agent/releases/latest/download/debug-agent-VERSION.tgz"
npm install -g ./debug-agent-VERSION.tgz
debug setup
```

Or download the `.tgz` from the release page in a browser, then:

```bash
npm install -g ./debug-agent-VERSION.tgz
debug setup
```

### Upgrade later

```bash
debug upgrade
# or
debug upgrade --check
```

---

## Option B — Offline tarball (no GitHub access)

Copy `debug-agent-*.tgz` from a release (or from `npm pack` on a dev machine) to the target machine:

```bash
npm install -g ./debug-agent-0.1.1.tgz
debug setup
```

Upgrade: copy a newer `.tgz` and run `npm install -g ./debug-agent-x.y.z.tgz` again.

---

## Option C — Git clone (dev / internal)

```bash
git clone https://github.com/nileshr/debug-agent.git
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
node /path/to/debug-agent/dist/cli.js setup
```

---

## Publishing a release (maintainers)

From a clean checkout on `main`:

```bash
npm run publish              # tag + push current package.json version
npm run publish -- --patch   # bump patch, commit, tag, push
npm run publish -- --dry-run # validate without pushing
```

This pushes a `v*` git tag. GitHub Actions builds the project, runs `npm pack`, and creates a release with:

- `debug-agent-x.y.z.tgz` — install with `npm install -g`
- `SHA256SUMS.txt` — checksum for the tarball

Requires `gh`-less CI only: the workflow uses `GITHUB_TOKEN` automatically. Local `npm run publish` needs git push access.

Accidental `npm publish` is blocked (`prepublishOnly`).

---

## Version and upgrade commands

| Command | Purpose |
|---------|---------|
| `debug -v` / `debug -V` / `debug --version` | Print installed version |
| `debug upgrade` | Upgrade by install type (GitHub release / git / local dev) |
| `debug upgrade --check` | Compare with latest GitHub release |
| `debug upgrade --force` | Reinstall even if versions match |

---

## What gets shipped in release tarballs

`npm pack` / release assets include only:

- `dist/` (compiled JS)
- `README.md`, `AGENTS.md`, `docs/`

Source (`src/`) is not shipped; CI runs `npm run build` before packing.

---

## Troubleshooting installs

| Issue | Fix |
|-------|-----|
| `debug: command not found` | Ensure global npm bin is on PATH (`npm bin -g`) |
| `upgrade` says no GitHub release | Publish a release (`npm run publish`) or install from tarball (Option B) |
| Old `bugfix` command | `npm unlink -g bugfix` then install `debug-agent` |
| Permission errors on `-g` | Use `nvm` or fix npm prefix, avoid `sudo` when possible |
| `zsh: permission denied: debug` after `npm link` | Run `npm run build` (sets execute bit on `dist/cli.js`), or `chmod +x dist/cli.js` |
