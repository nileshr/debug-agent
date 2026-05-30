DEBUG emulation — ANALYZE phase.

Hypotheses:
{{hypothesesBlock}}

Read {{debugLogPath}} entries since ts={{sinceTs}}.

Log snippet:
{{logSnippet}}

Identify which hypothesis is CONFIRMED. Propose a precise minimal fix (file, line range, code). Do NOT apply the fix yet.

End with:
```json
{"confirmedHypothesis":"H1","fixProposal":"description","files":["path"]}
```
