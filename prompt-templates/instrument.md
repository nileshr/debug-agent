DEBUG emulation — INSTRUMENT phase.

Run ID: {{runId}}
Hypotheses:
{{hypothesesBlock}}

Add minimal JSONL logging to: {{debugLogPath}}

Each log line MUST be one JSON object:
{"hypothesis":"H#","file":"relative/path","line":N,"value":<any>,"ts":<unix-ms>}

Wrap EVERY instrumentation edit with sentinel comment:
// DEBUG-INSTRUMENT:{{runId}}

Do not change program behavior beyond logging. Track files you touch.

When done, reply with:
```json
{"filesTouched":["path/to/file.ts"]}
```
