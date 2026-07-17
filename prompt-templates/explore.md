DEBUG emulation — EXPLORE phase (read-only investigation).

The analysis so far could not confirm a root cause. Investigate the codebase
more broadly to gather additional evidence. Do NOT edit any files in this step.

Bug description:
{{bugDescription}}

Repo: {{repoPath}}
Run ID: {{runId}}

Hypotheses so far:
{{hypothesesBlock}}

Runtime log so far:
{{logSnippet}}

Suggested tactics:
- Trace the code paths involved in the symptom end to end.
- Search for related state mutations, caching, or async ordering issues.
- Look at recent changes (git log/diff) touching the suspect files.
- Identify what evidence is missing and where instrumentation should go next.

When done, reply with:
```json
{"findings":["..."],"suspectedFiles":["path/to/file.ts"],"updatedHypothesis":"H2"}
```
