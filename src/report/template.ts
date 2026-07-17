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

function lifecycleClass(status: string): string {
  if (status === "running") return "lifecycle-running";
  if (status === "interrupted") return "lifecycle-interrupted";
  if (status === "failed") return "lifecycle-failed";
  return "lifecycle-completed";
}

function hypothesisStatusClass(status: string): string {
  if (status === "confirmed") return "hyp-confirmed";
  if (status === "rejected") return "hyp-rejected";
  if (status === "inconclusive") return "hyp-inconclusive";
  return "hyp-pending";
}

function phaseStatusClass(status: string): string {
  if (status === "completed") return "phase-completed";
  if (status === "running") return "phase-running";
  if (status === "skipped") return "phase-skipped";
  return "phase-pending";
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

function formatTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function renderReportHtml(report: FinalReport): string {
  const dataJson = JSON.stringify(report).replace(/</g, "\\u003c");

  const isInProgress =
    report.runLifecycleStatus === "running" ||
    report.runLifecycleStatus === "interrupted";

  const confirmed = report.confirmedHypothesisId;
  const addressedCount = report.review.comments.filter((c) => c.addressed).length;
  const reviewTotal = report.review.comments.length;

  const hypothesesRows = report.hypotheses
    .map((h) => {
      const isConfirmed = h.id === confirmed || h.status === "confirmed";
      const rowClass = isConfirmed ? "hyp-row-confirmed" : "";
      return `<tr class="${rowClass}">
        <td>${esc(h.id)}${isConfirmed ? ' <span class="badge badge-confirmed">confirmed</span>' : ""}</td>
        <td>${h.rank}</td>
        <td>${esc(h.statement)}</td>
        <td>${esc(h.file ?? "—")}${h.line != null ? `:${h.line}` : ""}</td>
        <td><span class="pill ${hypothesisStatusClass(h.status)}">${esc(h.status)}</span></td>
      </tr>`;
    })
    .join("");

  const reproSteps = report.reproduction.steps
    .map((s) => `<li>${esc(s)}</li>`)
    .join("");

  const reviewRows = report.review.comments
    .map((c) => {
      const badge = c.addressed
        ? '<span class="badge badge-addressed">addressed</span>'
        : '<span class="badge badge-pending">open</span>';
      return `<tr class="${c.addressed ? "review-addressed" : "review-open"}">
        <td>${esc(c.id)}</td>
        <td>${esc(c.text)}</td>
        <td>${badge}</td>
      </tr>`;
    })
    .join("");

  const risks = (report.summary.risks ?? [])
    .map((r) => `<li>${esc(r)}</li>`)
    .join("");
  const followUps = (report.summary.followUps ?? [])
    .map((f) => `<li>${esc(f)}</li>`)
    .join("");

  const bugSummaryLead =
    report.summary.bugSummary?.trim() || report.bugDescription;

  const summaryNarrative = [
    report.summary.rootCause
      ? `<p><strong>Root cause</strong></p><p>${esc(report.summary.rootCause)}</p>`
      : "",
    report.summary.fixExplanation
      ? `<p><strong>Fix</strong></p><p>${esc(report.summary.fixExplanation)}</p>`
      : "",
  ]
    .filter(Boolean)
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

  const phaseTimeline = (report.phaseTimeline ?? [])
    .map((p) => {
      const isCurrent = p.phase === report.currentPhase && isInProgress;
      const timing =
        p.startedAt != null
          ? `<span class="phase-time">${esc(formatTs(p.startedAt))}${p.completedAt != null ? ` → ${esc(formatTs(p.completedAt))}` : ""}</span>`
          : "";
      return `<div class="phase-step ${phaseStatusClass(p.status)}${isCurrent ? " phase-current" : ""}">
        <span class="phase-name">${esc(p.phase)}</span>
        <span class="pill ${phaseStatusClass(p.status)}">${esc(p.status)}</span>
        ${timing}
        ${p.error ? `<span class="phase-error">${esc(p.error)}</span>` : ""}
      </div>`;
    })
    .join("");

  const decisionTimeline = (report.decisionTimeline ?? [])
    .map((d) => {
      const target =
        d.nextStepId != null ? ` → <code>${esc(d.nextStepId)}</code>` : "";
      const overridden = d.overridden
        ? `<div class="decision-overridden">vetoed: <code>${esc(d.overridden.action)}${d.overridden.nextStepId ? ` → ${esc(d.overridden.nextStepId)}` : ""}</code> — ${esc(d.overridden.reason)}</div>`
        : "";
      const model = d.modelId ? ` · ${esc(d.modelId)}` : "";
      return `<div class="decision-item">
        <div class="decision-meta">
          <span class="pill decision-${esc(d.decidedBy)}">${esc(d.decidedBy)}</span>
          <span class="decision-step">after <code>${esc(d.afterStep)}</code></span>
          <span class="decision-action">${esc(d.action)}${target}${model}</span>
        </div>
        ${d.rationale ? `<div class="decision-rationale">${esc(d.rationale)}</div>` : ""}
        ${overridden}
      </div>`;
    })
    .join("");

  const lifecycleBanner =
    report.runLifecycleStatus && report.runLifecycleStatus !== "completed"
      ? `<div class="banner ${lifecycleClass(report.runLifecycleStatus)}">
          Run is <strong>${esc(report.runLifecycleStatus)}</strong>
          ${report.currentPhase ? ` · current phase: <code>${esc(report.currentPhase)}</code>` : ""}
          ${isInProgress ? " · report reflects progress so far" : ""}
        </div>`
      : "";

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
    --confirmed: #166534;
    --rejected: #6b7280;
    --pending: #92400e;
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
  .session-id {
    font-size: 0.8rem;
    color: var(--muted);
    margin: 0 0 12px;
    word-break: break-all;
  }
  .session-id code {
    font-size: 0.85rem;
    color: var(--text);
    font-weight: 500;
  }
  .lead-summary {
    font-size: 1rem;
    margin: 12px 0 0;
    line-height: 1.55;
  }
  .meta { font-size: 0.875rem; color: var(--muted); margin: 4px 0; }
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px 16px;
    margin-top: 12px;
    font-size: 0.875rem;
  }
  .meta-grid dt { color: var(--muted); font-weight: 500; margin: 0; }
  .meta-grid dd { margin: 0 0 8px; }
  .status-fixed { color: var(--fixed); font-weight: 600; }
  .status-partial { color: var(--partial); font-weight: 600; }
  .status-abandoned { color: var(--abandoned); font-weight: 600; }
  .banner {
    padding: 10px 14px;
    margin-bottom: 16px;
    border: 1px solid var(--border);
    font-size: 0.875rem;
  }
  .lifecycle-running { background: #eff6ff; border-color: #93c5fd; }
  .lifecycle-interrupted { background: #fffbeb; border-color: #fcd34d; }
  .lifecycle-failed { background: #fef2f2; border-color: #fca5a5; }
  .lifecycle-completed { background: #f0fdf4; border-color: #86efac; }
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
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  tr.hyp-row-confirmed { background: #f0fdf4; }
  tr.review-open { background: #fffbeb; }
  tr.review-addressed { background: #f9fafb; }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border: 1px solid var(--border);
    font-size: 0.75rem;
    text-transform: lowercase;
  }
  .hyp-confirmed { border-color: #86efac; color: var(--confirmed); background: #f0fdf4; }
  .hyp-rejected { border-color: #d1d5db; color: var(--rejected); }
  .hyp-pending { border-color: #fcd34d; color: var(--pending); }
  .hyp-inconclusive { border-color: #c4b5fd; color: #6d28d9; }
  .badge {
    display: inline-block;
    font-size: 0.65rem;
    padding: 1px 6px;
    margin-left: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .badge-confirmed { background: #dcfce7; color: var(--confirmed); }
  .badge-addressed { background: #dcfce7; color: var(--confirmed); }
  .badge-pending { background: #fef3c7; color: var(--pending); }
  .phase-timeline { display: flex; flex-direction: column; gap: 6px; }
  .phase-step {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-left: 3px solid var(--border);
    font-size: 0.85rem;
  }
  .phase-step.phase-current { border-left-color: var(--accent); background: #eff6ff; }
  .phase-step.phase-completed { border-left-color: #86efac; }
  .phase-step.phase-running { border-left-color: var(--accent); }
  .phase-step.phase-pending { border-left-color: #e5e7eb; opacity: 0.75; }
  .phase-name { font-weight: 500; min-width: 7rem; font-family: ui-monospace, monospace; font-size: 0.8rem; }
  .phase-time { font-size: 0.72rem; color: var(--muted); }
  .phase-error { font-size: 0.72rem; color: var(--abandoned); }
  code { font-size: 0.8rem; background: var(--bg); padding: 1px 4px; }
  ul { margin: 0; padding-left: 1.25rem; }
  .summary-block { white-space: pre-wrap; font-size: 0.9rem; }
  .caption { font-size: 0.75rem; color: var(--muted); margin-top: 8px; }
  .section-stats { font-size: 0.8rem; color: var(--muted); margin-bottom: 10px; }
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
  .decision-list { display: flex; flex-direction: column; gap: 10px; max-height: 520px; overflow: auto; }
  .decision-item {
    border-left: 3px solid var(--accent);
    padding: 8px 12px;
    background: var(--bg);
    font-size: 0.85rem;
  }
  .decision-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 4px; }
  .decision-rationale { color: var(--muted); }
  .decision-overridden { color: var(--abandoned); font-size: 0.8rem; margin-top: 4px; }
  .pill.decision-static { background: #eef2ff; color: #3730a3; }
  .pill.decision-heuristic { background: #ecfeff; color: #155e75; }
  .pill.decision-llm { background: #f5f3ff; color: #6d28d9; }
  .pill.decision-user { background: #f0fdf4; color: #166534; }
  .pill.decision-guardrail_override { background: #fef2f2; color: #991b1b; }
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
  ${lifecycleBanner}
  <header>
    <p class="session-id">Session ID: <code>${esc(report.session.sessionId)}</code>${report.session.resumed ? " · resumed session" : ""}</p>
    <h1>Bug fix report — ${esc(report.runId)}</h1>
    <p class="meta">
      Outcome: <span class="${statusClass(report.status)}">${esc(report.status)}</span>
      · Model: ${esc(report.model)}
      · ${(report.elapsedMs / 1000).toFixed(1)}s elapsed
    </p>
    <p class="lead-summary">${esc(bugSummaryLead)}</p>
    <dl class="meta-grid">
      <div><dt>Verify cycles</dt><dd>${report.cycles}</dd></div>
      <div><dt>Review cycles</dt><dd>${report.reviewCycles}</dd></div>
      <div><dt>Confirmed hypothesis</dt><dd>${confirmed ? `<code>${esc(confirmed)}</code>` : "—"}</dd></div>
      <div><dt>Review comments</dt><dd>${reviewTotal ? `${addressedCount}/${reviewTotal} addressed` : "none"}</dd></div>
    </dl>
    <p class="meta">Repo: <code>${esc(report.repoPath)}</code></p>
    <p class="meta">Verify: ${esc(report.verifyMode)}${report.url ? ` · ${esc(report.url)}` : ""}</p>
    ${
      report.bugDescription !== bugSummaryLead
        ? `<p class="meta">Reported bug: ${esc(report.bugDescription)}</p>`
        : ""
    }
  </header>

  <section><h2>Summary</h2>
    <p class="lead-summary" style="margin-top:0">${esc(bugSummaryLead)}</p>
    ${summaryNarrative || `<p class="meta">No structured summary from the agent yet.</p>`}
    ${
      report.hypotheses.length
        ? `<h3 style="font-size:0.85rem;color:var(--muted);margin:16px 0 8px">Hypotheses considered</h3>
    ${confirmed ? `<p class="section-stats">Confirmed: <code>${esc(confirmed)}</code></p>` : ""}
    <table><thead><tr><th>ID</th><th>Rank</th><th>Statement</th><th>Location</th><th>Status</th></tr></thead>
    <tbody>${hypothesesRows}</tbody></table>`
        : ""
    }
    ${risks ? `<h3 style="font-size:0.85rem;color:var(--muted)">Risks</h3><ul>${risks}</ul>` : ""}
    ${followUps ? `<h3 style="font-size:0.85rem;color:var(--muted)">Follow-ups</h3><ul>${followUps}</ul>` : ""}
  </section>

  ${
    report.reproduction.steps.length
      ? `<section><h2>Reproduction</h2>
    <p class="meta">${report.reproduction.mode === "browser" && report.reproduction.url ? esc(report.reproduction.url) : "CLI / shell verification"}</p>
    <ol>${reproSteps}</ol></section>`
      : ""
  }

  ${
    report.fix.rootCause || report.fix.explanation
      ? `<section><h2>Detailed fix</h2>
    ${report.fix.rootCause ? `<p><strong>Root cause</strong></p><p>${esc(report.fix.rootCause)}</p>` : ""}
    ${report.fix.explanation ? `<p><strong>What changed</strong></p><p>${esc(report.fix.explanation)}</p>` : ""}
    ${report.fix.diffStat ? `<p class="meta">${esc(report.fix.diffStat)}</p>` : ""}</section>`
      : ""
  }

  ${
    report.review.comments.length
      ? `<section><h2>Review</h2>
    <p class="section-stats">${addressedCount} of ${reviewTotal} comment(s) addressed · ${report.reviewCycles} review cycle(s)</p>
    <table><thead><tr><th>ID</th><th>Comment</th><th>Status</th></tr></thead>
    <tbody>${reviewRows}</tbody></table></section>`
      : `<section><h2>Review</h2><p class="meta">No review comments.</p></section>`
  }

  ${
    phaseTimeline
      ? `<section><h2>Phase timeline</h2>
    <div class="phase-timeline">${phaseTimeline}</div>
    <p class="caption">Phase status from run state DB${isInProgress ? " (run in progress)" : ""}</p></section>`
      : ""
  }

  ${
    decisionTimeline
      ? `<section><h2>Decisions</h2>
    <div class="decision-list">${decisionTimeline}</div>
    <p class="caption">Every loop-control decision with who made it (static policy, heuristic, LLM orchestrator, user, or a guardrail override) and why.</p></section>`
      : ""
  }

  <section><h2>Agent session</h2>
    <p class="session-id" style="margin-bottom:12px">Session ID: <code>${esc(report.session.sessionId)}</code></p>
    <p class="meta"><strong>debug resume</strong></p>
    <pre class="resume-cmd">${esc(report.session.debugResumeCommand)}</pre>
    <p class="meta"><strong>debug report</strong></p>
    <pre class="resume-cmd">debug report ${JSON.stringify(report.repoPath)} --run ${esc(report.runId)}</pre>
    <p class="meta"><strong>agent resume</strong></p>
    <pre class="resume-cmd">${esc(report.session.agentResumeCommand)}</pre>
    <p class="caption">Use debug resume to continue an interrupted run; debug report regenerates this HTML at any time.</p>
  </section>

  ${
    traceEntries
      ? `<section><h2>Agent trace</h2>
    <div class="trace-list">${traceEntries}</div>
    <p class="caption">Structured timeline of agent messages, tools, todos, and subagent tasks during the run.</p></section>`
      : ""
  }
</div>
<script>window.__RUN__ = ${dataJson};</script>
</body>
</html>`;
}
