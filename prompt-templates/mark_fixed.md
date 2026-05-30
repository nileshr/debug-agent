DEBUG emulation — MARK FIXED (cleanup instrumentation) — REQUIRED.

The bug fix is verified. You MUST remove all debug instrumentation before this phase ends.

Remove ALL lines/edits containing:
// DEBUG-INSTRUMENT:{{runId}}

Search the repo for `DEBUG-INSTRUMENT:{{runId}}` and delete every match (comments, blocks, and any debug-only logging tied to this run).

Delete {{debugLogPath}} if it only contains debug instrumentation data.
Do not revert the actual bug fix.

{{cleanupRetryNote}}

Sentinels still detected in repo: {{sentinelCountRemaining}} (must be 0 when done).

Reply with:
```json
{"cleaned":true,"sentinelsRemoved":<number>}
```
