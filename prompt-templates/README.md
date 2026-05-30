# Phase prompt templates

These files are the default prompts injected for each debug-loop phase. You can override them without rebuilding debug-agent.

## Override locations (first match wins)

1. `<repo>/.debug-agent/prompts/<phase>.md` — per-repository
2. `~/.debug-agent/prompts/<phase>.md` — global user override
3. Bundled copy shipped with the package (`prompt-templates/`)

## Placeholders

Use `{{name}}` in templates. Available variables depend on the phase; common ones:

| Placeholder | Description |
|-------------|-------------|
| `{{bugDescription}}` | User bug text |
| `{{repoPath}}` | Target repo path |
| `{{runId}}` | Run identifier |
| `{{verificationBlock}}` | CLI vs browser verify instructions |
| `{{hypothesesBlock}}` | Formatted hypothesis list |
| `{{debugLogPath}}` | Path to `.debug-agent/debug.log` |
| `{{logSnippet}}` | Recent log JSON (analyze phase) |
| `{{sinceTs}}` | Log filter timestamp |
| `{{reproduceBody}}` / `{{verifyBody}}` | Full reproduce/verify text (mode-specific) |

Copy a file from this directory to `~/.debug-agent/prompts/` and edit. Re-run `debug` to pick up changes.
