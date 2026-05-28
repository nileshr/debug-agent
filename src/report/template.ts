import type { FinalReport } from "../debug/types.js";

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
    <p class="meta">URL: ${esc(report.url)}</p>
    <p class="meta">Session: ${esc(report.sessionId)}</p>
  </header>

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
      ? `<section><h2>Reproduction</h2><p>${esc(report.reproduction.url)}</p><ol>${reproSteps}</ol></section>`
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
