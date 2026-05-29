import type { FinalReport, TraceKind } from "../debug/types.js";
import { traceKindLabel } from "../debug/trace.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusClass(status: string): string {
  if (status === "fixed") return "status-fixed";
  if (status === "partial") return "status-partial";
  return "status-abandoned";
}

function traceKindClass(kind: TraceKind): string {
  return `trace-${kind}`;
}

function formatTraceTime(ts: number, startedAt: string): string {
  const startMs = Date.parse(startedAt);
  const offsetSec = Math.max(0, (ts - startMs) / 1000);
  if (offsetSec < 60) return `+${offsetSec.toFixed(1)}s`;
  const mins = Math.floor(offsetSec / 60);
  const secs = Math.floor(offsetSec % 60);
  return `+${mins}m${secs.toString().padStart(2, "0")}s`;
}

export function renderReportHtml(report: FinalReport): string {
  const dataJson = JSON.stringify(report).replace(/</g, "\\u003c");

  const hypothesesRows = report.hypotheses
    .map(
      (h) =>
        `<tr><td>${esc(h.id)}</td><td>${h.rank}</td><td>${esc(h.statement)}</td><td>${esc(h.file ?? "—")}${h.line != null ? `:${h.line}` : ""}</td><td><span class="pill">${esc(h.status)}</span></td></tr>`,
    )
    .join("");

  const reproSteps = report.reproduction.steps
    .map((s) => `<li>${esc(s)}</li>`)
    .join("");

  const reviewRows = report.review.comments
    .map(
      (c) =>
        `<tr><td>${esc(c.id)}</td><td>${esc(c.text)}</td><td>${c.addressed ? "yes" : "no"}</td></tr>`,
    )
    .join("");

  const risks = (report.summary.risks ?? [])
    .map((r) => `<li>${esc(r)}</li>`)
    .join("");
  const followUps = (report.summary.followUps ?? [])
    .map((f) => `<li>${esc(f)}</li>`)
    .join("");

  const filesTouched = report.instrumentation.filesTouched
    .map((f) => `<li><code>${esc(f)}</code></li>`)
    .join("");

  const traceEntries = (report.trace ?? [])
    .filter((e) => e.kind !== "phase" || e.text.startsWith("Started"))
    .map(
      (e) =>
        `<div class="trace-item ${traceKindClass(e.kind)}">
          <div class="trace-meta">
            <span class="trace-time">${esc(formatTraceTime(e.ts, report.startedAt))}</span>
            <span class="trace-phase">${esc(e.phase)}</span>
            <span class="trace-kind">${esc(traceKindLabel(e.kind))}</span>
          </div>
          <div class="trace-text">${esc(e.text)}</div>
        </div>`,
    )
    .join("");

  const traceByPhase = (report.trace ?? []).reduce<Record<string, number>>(
    (acc, e) => {
      if (e.phase) acc[e.phase] = (acc[e.phase] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const tracePhaseSummary = Object.entries(traceByPhase)
    .map(([phase, count]) => `<span class="pill">${esc(phase)} · ${count}</span>`)
    .join(" ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Debug run ${esc(report.runId)}</title>
<style>
  :root {
    --bg: #f6f6f4;
    --surface: #fff;
    --text: #1a1a1a;
    --muted: #5c5c5c;
    --border: #e2e2de;
    --accent: #2563eb;
    --fixed: #166534;
    --partial: #b45309;
    --abandoned: #991b1b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding: 24px;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  header {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 20px 24px;
    margin-bottom: 20px;
  }
  h1 { font-size: 1.35rem; margin: 0 0 8px; font-weight: 600; }
  .meta { font-size: 0.875rem; color: var(--muted); }
  .status-fixed { color: var(--fixed); font-weight: 600; }
  .status-partial { color: var(--partial); font-weight: 600; }
  .status-abandoned { color: var(--abandoned); font-weight: 600; }
  section {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  section h2 {
    font-size: 0.95rem;
    margin: 0 0 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    font-weight: 600;
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border: 1px solid var(--border);
    font-size: 0.75rem;
  }
  code { font-size: 0.8rem; background: var(--bg); padding: 1px 4px; }
  ul { margin: 0; padding-left: 1.25rem; }
  .summary-block { white-space: pre-wrap; font-size: 0.9rem; }
  .caption { font-size: 0.75rem; color: var(--muted); margin-top: 8px; }
  .trace-list { display: flex; flex-direction: column; gap: 10px; max-height: 520px; overflow: auto; }
  .trace-item {
    border-left: 3px solid var(--border);
    padding: 8px 12px;
    background: var(--bg);
    font-size: 0.85rem;
  }
  .trace-item.trace-tool { border-left-color: #7c3aed; }
  .trace-item.trace-todo { border-left-color: #0891b2; }
  .trace-item.trace-task { border-left-color: #ca8a04; }
  .trace-item.trace-plan { border-left-color: #059669; }
  .trace-item.trace-phase { border-left-color: var(--accent); }
  .trace-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.72rem;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .trace-time { font-variant-numeric: tabular-nums; }
  .trace-phase { text-transform: uppercase; letter-spacing: 0.03em; }
  .trace-kind {
    border: 1px solid var(--border);
    padding: 0 6px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .trace-text { white-space: pre-wrap; word-break: break-word; }
  .trace-summary { margin-bottom: 12px; }
  .resume-cmd {
    margin: 4px 0 12px;
    padding: 10px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    font-size: 0.8rem;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Bug fix report — ${esc(report.runId)}</h1>
    <p class="meta">
      Status: <span class="${statusClass(report.status)}">${esc(report.status)}</span>
      · Model: ${esc(report.model)}
      · ${(report.elapsedMs / 1000).toFixed(1)}s
      · ${report.cycles} cycle(s)
    </p>
    <p class="meta">Repo: <code>${esc(report.repoPath)}</code></p>
    <p class="meta">Verify: ${esc(report.verifyMode)}${report.url ? ` · ${esc(report.url)}` : ""}</p>
  </header>

  <section><h2>Agent session</h2>
    <p class="meta">Session ID: <code>${esc(report.session.sessionId)}</code>${report.session.resumed ? " · resumed" : " · new"}</p>
    <p class="meta"><strong>debug resume:</strong></p>
    <pre class="resume-cmd">${esc(report.session.debugResumeCommand)}</pre>
    <p class="meta"><strong>agent resume:</strong></p>
    <pre class="resume-cmd">${esc(report.session.agentResumeCommand)}</pre>
    <p class="caption">Use the debug command to re-run the emulated loop with prior agent context; use agent resume for direct Cursor CLI access.</p>
  </section>

  ${
    report.summary.bugSummary
      ? `<section><h2>Bug summary</h2><p>${esc(report.summary.bugSummary)}</p></section>`
      : ""
  }

  ${
    report.hypotheses.length
      ? `<section><h2>Hypotheses</h2>
    <table><thead><tr><th>ID</th><th>Rank</th><th>Statement</th><th>Location</th><th>Status</th></tr></thead>
    <tbody>${hypothesesRows}</tbody></table>
    <p class="caption">Hypothesis ledger from debug run</p></section>`
      : ""
  }

  ${
    report.instrumentation.filesTouched.length ||
    report.instrumentation.sentinelCountBefore > 0
      ? `<section><h2>Instrumentation</h2>
    <p>Sentinels before cleanup: ${report.instrumentation.sentinelCountBefore} · after: ${report.instrumentation.sentinelCountAfter}</p>
    ${filesTouched ? `<ul>${filesTouched}</ul>` : ""}</section>`
      : ""
  }

  ${
    report.reproduction.steps.length
      ? `<section><h2>Reproduction</h2><p>${report.reproduction.mode === "browser" && report.reproduction.url ? esc(report.reproduction.url) : "CLI / shell"}</p><ol>${reproSteps}</ol></section>`
      : ""
  }

  ${
    report.fix.rootCause
      ? `<section><h2>Fix</h2>
    <p><strong>Root cause:</strong> ${esc(report.fix.rootCause)}</p>
    <p>${esc(report.fix.explanation)}</p>
    ${report.fix.diffStat ? `<p class="meta">${esc(report.fix.diffStat)}</p>` : ""}</section>`
      : ""
  }

  ${
    report.review.comments.length
      ? `<section><h2>Review</h2>
    <table><thead><tr><th>ID</th><th>Comment</th><th>Addressed</th></tr></thead>
    <tbody>${reviewRows}</tbody></table></section>`
      : ""
  }

  ${
    traceEntries
      ? `<section><h2>Agent trace</h2>
    ${tracePhaseSummary ? `<div class="trace-summary">${tracePhaseSummary}</div>` : ""}
    <div class="trace-list">${traceEntries}</div>
    <p class="caption">Structured timeline of agent messages, tools, todos, and subagent tasks during the run.</p></section>`
      : ""
  }

  <section><h2>Summary</h2>
    <div class="summary-block" id="summary-json"></div>
    ${risks ? `<h3 style="font-size:0.85rem;color:var(--muted)">Risks</h3><ul>${risks}</ul>` : ""}
    ${followUps ? `<h3 style="font-size:0.85rem;color:var(--muted)">Follow-ups</h3><ul>${followUps}</ul>` : ""}
  </section>
</div>
<script>
window.__RUN__ = ${dataJson};
(function () {
  var r = window.__RUN__;
  var el = document.getElementById("summary-json");
  if (el && r.summary) {
    el.textContent = [
      "Root cause: " + r.summary.rootCause,
      "",
      "Fix: " + r.summary.fixExplanation
    ].join("\\n");
  }
})();
</script>
</body>
</html>`;
}
