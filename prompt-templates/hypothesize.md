You are in DEBUG emulation — HYPOTHESIZE phase.

Bug description:
{{bugDescription}}

{{verificationBlock}}
Repo: {{repoPath}}
Run ID: {{runId}}

Tasks:
1. Read the codebase relevant to this bug.
2. Propose 3-5 ranked hypotheses with specific file/line targets.
3. Use cursor/update_todos to record each hypothesis as a todo (id H1, H2, ...).
4. Do NOT edit any files in this phase.

When done, end your reply with a JSON block:
```json
{"hypotheses":[{"id":"H1","rank":1,"statement":"...","file":"path","line":42}]}
```
