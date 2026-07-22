# Design: Debug Loop v2 — Runtime-Agnostic Adapters + Orchestrated Step Engine

Status: **Proposed** (design approved, implementation not started)
Owner: debug-agent maintainers
Scope: architecture for the next major evolution of the debug loop. No code changes ship with this document.

---

## 1. Context & problem statement

debug-agent drives an external AI coding agent through a fixed debugging workflow
(an emulation of "Cursor Debug Mode"): hypothesize → instrument → reproduce → analyze →
apply_fix → verify → mark_fixed → review → apply_review → re_verify → summarize.

Today this works only with Cursor's `agent acp`, and the loop is a hard-coded state machine.
Five coupling pains motivate v2:

1. **Controller monolith.** `DebugLoopController` (`src/debug/controller.ts`) fuses four
   responsibilities: ACP transport, loop control (`runPhaseLoop` switch at
   `src/debug/controller.ts:304`), result parsing (`parsePhaseResult`), and persistence wiring.
   There is no interface between the loop and the agent — `this.client` is a concrete
   `AcpClient` constructed in the controller's constructor.
2. **Fixed linear state machine.** Phases and transitions live in a `switch`
   (`controller.ts:320`). Adding or reordering steps means editing the `Phase` union
   (`src/debug/types.ts:114`), `DEBUG_PHASES` (`src/debug/phases.ts:4`), the `run_phases`
   seeding (`src/debug/run-store.ts:186`), and the template map in `src/debug/prompt-loader.ts`.
   The loop cannot skip steps for a trivial fix, insert exploration for a hard bug, or bail out
   and ask the user.
3. **Cursor/ACP semantics leak into the loop.** Mode strings `plan`/`agent`,
   `cursor/update_todos` → `ledger.todos` (`CursorUpdateTodosParams` imported into
   `controller.ts`), `cursor/ask_question` auto-skip, and per-phase `setModel` via Cursor's
   `session/set_config_option` all assume one specific agent.
4. **Stringly-typed step results.** Every phase depends on the agent ending its reply with a
   fenced ```json block that `extractJsonFromText` (`src/debug/prompts.ts:236`) scrapes out of
   the accumulated stream buffer.
5. **Browser MCP couples to `.cursor/mcp.json`.** ACP `session/new` rejects inline `mcpServers`
   for Cursor, so `ensureBrowserMcpConfig` (`src/mcp/browser.ts:37`) writes a Cursor-specific
   config file into the user's repo.

### Goals

1. **Runtime abstraction**: one `AgentRuntime` interface, two first-class implementations —
   **generalized ACP** (any ACP agent: Cursor `agent acp`, claude-agent-acp / 
   `@zed-industries/claude-code-acp`, codex-acp, `gemini --experimental-acp`) and **Flue**
   (in-process, `@flue/runtime`). The interface must not preclude future adapters
   (Claude Agent SDK, raw pi SDK).
2. **De-Cursor the loop**: no `cursor/*` method names, mode strings, or `.cursor/` file
   assumptions outside a Cursor-specific preset.
3. **Orchestrated dynamic loop**: declarative step catalog + policy, an auditable decision
   point after every step (`advance | retry | insert | skip_to | ask_user | abort`), and
   engine-enforced guardrails the LLM can never override.
4. **Typed step results**: schema-per-step (zod); native structured output where the runtime
   supports it, fenced-JSON extraction as a fallback — one engine code path, tagged by source.
5. **Backward compatibility**: `autonomy: "static"` reproduces today's transitions exactly;
   early refactor phases are behavior-neutral and verified by the todo-fixture oracle.

### Non-goals (for now)

Claude Agent SDK / raw pi adapters (they slot in later as additional `AgentRuntime`
implementations), multi-bug batching, parallel step execution, container sandboxes for
untrusted repos, a web UI.

---

## 2. Architecture overview

```
                       ┌────────────────────────────────────────────────┐
                       │ src/cli.ts  (run / resume / runs / report)     │
                       └──────────────────────┬─────────────────────────┘
                                              │ ResolvedConfig v2 (runtime, autonomy, models, presets)
                       ┌──────────────────────▼─────────────────────────┐
                       │ DebugRun (thin controller, src/debug/run.ts)   │
                       │  wires: config → runtime → engine → report     │
                       └───────┬──────────────────────────┬─────────────┘
                               │                          │
              ┌────────────────▼─────────────┐   ┌────────▼──────────────────────┐
              │ LoopEngine (src/engine/)     │   │ AgentRuntime (src/runtime/)   │
              │  ┌────────────────────────┐  │   │  interface + capability flags │
              │  │ StepCatalog (declar.)  │  │   ├───────────────┬───────────────┤
              │  │ StepPolicy (edges,     │  │   │ AcpRuntime    │ FlueRuntime   │
              │  │  gates, budgets)       │  │   │  presets:     │  local()      │
              │  ├────────────────────────┤  │   │  cursor/      │  sandbox on   │
              │  │ Orchestrator           │──┼──►│  claude/      │  real repo,   │
              │  │  heuristic fast-path   │  │   │  codex/gemini │  native       │
              │  │  + LLM decide() via    │  │   │  json-extract │  structured   │
              │  │    runtime.oneShot     │  │   │  fallback     │  results      │
              │  ├────────────────────────┤  │   └──────┬────────┴──────┬────────┘
              │  │ Guardrails (engine-    │  │          │ stdio JSON-RPC│ in-process
              │  │  enforced, not LLM)    │  │      ┌───▼───────┐  ┌────▼───────┐
              │  └────────────────────────┘  │      │ any ACP   │  │ @flue/     │
              └───────┬──────────────────────┘      │ agent     │  │ runtime    │
                      │ ledger + decisions          └───────────┘  └────────────┘
        ┌─────────────▼──────────────┐
        │ RunLedger v2 + RunStore v2 │──► HTML report (decision + step timelines)
        │ (runs, run_steps,          │──► <repo>/.debug-agent/debug-runs/<id>.json
        │  decisions; user_version=2)│
        └────────────────────────────┘
```

The key inversion vs today: transport, loop control, result parsing, and persistence become
four modules; the controller is reduced to wiring.

---

## 3. The `AgentRuntime` adapter interface

Future home: `src/runtime/types.ts`.

```ts
import type { z } from "zod";

export type ModelRole = "planner" | "fixer" | "reviewer" | "orchestrator";
export type StepMode = "plan" | "execute"; // abstract; adapters map or no-op

export interface RuntimeCapabilities {
  /** Runtime can switch between a read-only/planning mode and an editing mode. */
  modes: boolean;
  /** Runtime can switch model mid-session (per step). */
  modelSwitching: boolean;
  /** Runtime returns schema-validated results natively (no fenced-JSON scraping). */
  structuredOutput: boolean;
  /** Runtime emits native plan/todo progress events. */
  planEvents: boolean;
  /** How MCP servers are provided: inline at session create, via a config file, or unsupported. */
  mcp: "inline" | "file" | "none";
  /** Runtime/agent can surface questions to the user mid-prompt. */
  askUser: boolean;
  /** Sessions can be resumed after process restart. */
  sessionResume: boolean;
  /** Cheap one-shot LLM calls for orchestrator decisions. */
  oneShot: boolean;
}

export type RuntimeEvent =
  | { type: "text"; text: string }                       // streamed agent output
  | { type: "tool"; name: string; detail?: string }      // tool activity (trace)
  | { type: "plan"; entries: PlanEntry[] }               // replaces cursor/update_todos
  | { type: "question"; question: AgentQuestion;         // replaces cursor/ask_question auto-skip
      respond: (answer: QuestionAnswer | null) => void } // null => skip
  | { type: "permission"; request: PermissionRequest;    // surfaced for trace only;
      decision: PermissionDecision };                    // decided by the policy hook

export interface PlanEntry {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

/** Runtime-agnostic permission shape (adapters translate ACP options / Flue tool gates). */
export interface PermissionRequest {
  toolName?: string;
  kind?: "read" | "edit" | "execute" | "fetch" | "mcp" | "other";
  paths?: string[];
}
export type PermissionDecision = "allow" | "allow_always" | "deny" | "cancel";

export interface McpServerSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface RuntimeFactoryOptions {
  repoPath: string;                 // the real repo — all runtimes operate here
  mcpServers: McpServerSpec[];      // desired servers (browser MCP); adapter picks strategy
  permissionPolicy: (req: PermissionRequest) => PermissionDecision;
  onEvent: (ev: RuntimeEvent) => void;
  env?: Record<string, string>;
}

export interface StepPromptRequest<T = unknown> {
  text: string;
  /** Exit contract for this step. Adapter returns validated data when possible. */
  resultSchema?: z.ZodType<T>;
  /** Abstract mode hint; ignored when !capabilities.modes. */
  mode?: StepMode;
  /** Concrete model id resolved from the step's ModelRole; ignored when !modelSwitching. */
  model?: string;
  timeoutMs?: number;
}

export interface StepPromptResult<T = unknown> {
  stopReason: "end_turn" | "cancelled" | "refusal" | "error" | "unknown";
  /** Validated result, or null if unparsable/invalid. */
  data: T | null;
  /** Where data came from — recorded in the ledger for auditability. */
  dataSource: "structured" | "json_extraction" | "none";
  rawText: string;                  // accumulated stream for this prompt
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface RuntimeSession {
  readonly sessionId: string;
  /** Opaque token persisted in the ledger; enables resumeSession across restarts. */
  resumeToken(): string | null;
  prompt<T>(req: StepPromptRequest<T>): Promise<StepPromptResult<T>>;
  cancel(): Promise<void>;
}

export interface AgentRuntime {
  readonly kind: "acp" | "flue";    // widens to an open string union later (sdk, pi, …)
  start(): Promise<void>;           // spawn subprocess / init in-process harness
  stop(): Promise<void>;
  /** Valid after start(); ACP fills it from initialize + session/new responses. */
  capabilities(): RuntimeCapabilities;
  createSession(): Promise<RuntimeSession>;
  resumeSession(token: string): Promise<RuntimeSession>;
  /**
   * Cheap single-turn structured call for orchestrator decisions.
   * ACP: dedicated read-only side session; Flue: tool-less one-shot agent.
   */
  oneShot<T>(promptText: string, schema: z.ZodType<T>, opts?: { model?: string }): Promise<T | null>;
}
```

### Design notes

- **Typed step-result channel.** The engine always passes `resultSchema`. Adapters with
  `structuredOutput` (Flue) enforce it natively. The ACP adapter runs `extractJsonFromText`
  (moved from `src/debug/prompts.ts:236` to `src/runtime/json-extract.ts`) over the prompt's
  accumulated text, then `schema.safeParse`. Either way the engine receives
  `{ data, dataSource }` and the controller-side `parsePhaseResult` switch disappears.
- **Graceful degradation.** `setMode`/`setModel` become per-prompt *hints* rather than
  imperative session methods, so a runtime without modes simply ignores them. Today's
  `client.setMode(sessionId, "plan")` at `controller.ts:322` becomes `mode: "plan"` on the
  hypothesize step definition. One warning is printed per run per ignored capability.
- **Unified events.** `onStdoutChunk` / `onTrace` / `onUpdateTodos` collapse into a single
  `onEvent` callback. The controller's todo handler becomes a generic `plan` event consumer, so
  `CursorUpdateTodosParams` no longer leaks outside the ACP adapter.
- **Orchestrator LLM placement — through the runtime adapter (`oneShot`), not a direct
  provider call.** debug-agent's core advantage is "bring your agent, no separate API keys"; a
  direct Anthropic/pi call would introduce a second credential system. Cost stays low because
  (a) the heuristic fast-path makes LLM decisions rare, (b) the decision side-session is created
  once per run on the cheapest configured model (`models.orchestrator`) in a read-only mode when
  available, and (c) it receives a compact ledger digest, not the transcript. If `oneShot` is
  unavailable or fails, the engine falls back to the deterministic default — decisions are never
  blocked on the LLM.

### Capability / degradation matrix

| Capability          | ACP: Cursor | ACP: claude-agent-acp | ACP: gemini/codex | Flue | Degradation when `false` |
|---------------------|-------------|------------------------|-------------------|------|--------------------------|
| `modes`             | yes (plan/agent) | yes (session modes) | varies (discovered) | no | prompt-level "do not edit" guard (already in templates) |
| `modelSwitching`    | yes (`set_config_option`) | varies (`session/set_model`) | varies | no (per-agent config) | run uses `models.fixer`; requested role logged as unsupported |
| `structuredOutput`  | no → json-extract | no → json-extract | no → json-extract | yes | fenced-JSON extraction fallback |
| `planEvents`        | yes (`cursor/update_todos`) | yes (ACP `plan` update) | yes (ACP `plan` update) | no (initially) | `{{runtimeNotes}}` drops "record as todos" instruction |
| `mcp`               | file (`.cursor/mcp.json`) | inline | inline | inline (`connectMcpServer`) | `none` → browser verify unavailable; CLI verify only |
| `askUser`           | yes (`cursor/ask_question`) | no | no | no | agent questions never surface; orchestrator ask_user uses CLI path regardless |
| `sessionResume`     | yes (`session/load`) | varies (`loadSession` cap) | varies | needs verification | resume = fresh session + ledger-rendered prompts |
| `oneShot`           | yes (side session) | yes (side session) | yes (side session) | yes (tool-less agent) | guided/autonomous decisions fall back to heuristics |

---

## 4. Generalized ACP runtime (`src/runtime/acp/`)

What changes vs today's `AcpClient` (`src/acp/client.ts`):

### 4.1 Agent presets (`src/runtime/acp/presets.ts`)

```ts
export interface AcpAgentPreset {
  id: "cursor" | "claude" | "codex" | "gemini" | "custom";
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Try this auth methodId if initialize advertises authMethods. */
  preferredAuthMethod?: string;                 // cursor: "cursor_login"
  /** Map abstract StepMode → this agent's mode ids (else fuzzy-match availableModes). */
  modeMap?: Partial<Record<StepMode, string>>;  // cursor: { plan: "plan", execute: "agent" }
  /** MCP strategy override; default "auto" = try inline, fall back to file. */
  mcpStrategy?: "inline" | "file" | "auto";
  mcpFilePath?: (repoPath: string) => string;   // cursor: <repo>/.cursor/mcp.json
  /** Enable cursor/* extension handlers. */
  extensions?: "cursor" | "none";
  /** Mode/model setter transport: official ACP methods vs Cursor set_config_option. */
  configTransport?: "acp" | "cursor_config_option";
}
```

Presets ship for:

| Preset | Command | Notes |
|---|---|---|
| `cursor` | `agent acp` | today's behavior, preserved byte-for-byte (auth `cursor_login`, `set_config_option`, `.cursor/mcp.json`, `cursor/*` handlers) |
| `claude` | `npx -y @zed-industries/claude-code-acp` | standard ACP modes/plan updates |
| `codex`  | `codex-acp` | |
| `gemini` | `gemini --experimental-acp` | |
| `custom` | from config (`acp.command` / `acp.args`) | for any other ACP agent |

### 4.2 Initialize / authenticate

Today `authenticate("cursor_login")` is unconditional with a swallowed error. New flow: parse
`initialize.authMethods`; attempt `session/new` first; on an auth-required JSON-RPC error, call
`authenticate` with `preset.preferredAuthMethod` if advertised, else the first advertised
method, else surface a preset-specific user-facing error ("run `agent login`" /
"run `claude setup-token`" / …). `agentCapabilities.loadSession` gates `sessionResume`;
prompt/MCP capabilities feed `RuntimeCapabilities`.

### 4.3 Modes and models as discovered capabilities

The `session/new` response already carries `modes.availableModes` and `models.availableModels`
(parsed by `src/acp/types.ts:61-82`, currently ignored by the loop). v2 reads them to fill
capability flags. Mode switching uses official `session/set_mode {sessionId, modeId}`; model
switching uses `session/set_model` when models were advertised. The Cursor preset keeps
`session/set_config_option` with configId `mode`/`model` via
`configTransport: "cursor_config_option"`. If neither is advertised, the capability is `false`,
hints are ignored, and the requested role is logged as unsupported.

### 4.4 `cursor/*` extensions become capability-gated handlers

Registered only when `extensions === "cursor"`:

| Today (hard-coded) | v2 |
|---|---|
| `cursor/update_todos` → `ledger.todos` | → `plan` RuntimeEvent |
| `cursor/create_plan` → auto-accept | → accept + `plan` event |
| `cursor/task` → auto-complete | → `tool` trace event |
| `cursor/ask_question` → auto-skip | → `question` event (skip remains the non-interactive default, now traced) |

For all agents, the standard ACP `session/update` with `sessionUpdate: "plan"` maps to the same
`plan` event — this is how claude-agent-acp and gemini report todo/plan progress.

### 4.5 MCP strategy

`mcpStrategy: "auto"`: pass `mcpServers` inline to `session/new`; if the call errors or the
preset declares inline unsupported (Cursor), fall back to the file strategy at
`preset.mcpFilePath(repoPath)`. `ensureBrowserMcpConfig` (`src/mcp/browser.ts:37`) generalizes
to `writeMcpFile(path, spec)` under `src/runtime/acp/mcp-file.ts`; entries debug-agent adds are
tagged and can be removed at run end (see Open Questions).

### 4.6 Permission mapping

The ACP spec gives each permission option a `kind` (`allow_once | allow_always | reject_once |
reject_always`); today's code matches Cursor's literal `optionId` strings `allow-once` /
`allow-always` (`src/permissions.ts:63-74`). v2: the policy hook returns a
`PermissionDecision`; the adapter selects the advertised option whose `kind` matches (fallback:
fuzzy optionId match, then first option). The policy logic itself (repo-scoped writes,
browser-MCP allowlist in `decidePermission`) is already runtime-agnostic and moves to
`src/runtime/permissions.ts` unchanged.

### 4.7 What stays

The hand-rolled JSON-RPC framing, request timeout handling, zod response schemas, stderr/exit
surfacing, and `resolveSpawnCwd` are protocol-level, not Cursor-level — they stay.

---

## 5. Flue runtime (`src/runtime/flue/adapter.ts`)

> **STATUS UPDATE (implementation, July 2026): deferred by decision.**
> A probe of the real `@flue/runtime@1.0.0-beta.9` package found two material
> deviations from the assumptions below:
>
> 1. **No public in-process embedding API.** A `FlueHarness` (and therefore
>    `session()`/`prompt()`) is only supplied by a Flue runner to code running
>    *inside* a Flue workflow action (`context.harness`). The shipped docs are
>    explicit: "application code does not name or initialize workflow
>    harnesses." Bootstrapping a harness inside debug-agent's own process
>    requires `@flue/runtime/internal` (`configureFlueRuntime`, `NodeRuntime`),
>    which the package marks "not part of the public API."
> 2. **Structured results are Valibot-only.** The runtime hard-asserts
>    `~standard.vendor === "valibot"` on `result:` and tool schemas, so zod
>    schemas cannot pass through Standard Schema (a loose-valibot wrapper +
>    zod post-validation would be needed).
>
> Decision: ship the runtime-agnostic architecture with the generalized ACP
> adapter only for now. The `AgentRuntime` interface, the `runtime: "flue"`
> config value, and this section are kept so a Flue adapter can land once Flue
> exposes a public embedding surface. The nearest-term alternative satisfying
> the same "in-process, multi-provider" goal is a pi adapter
> (`@earendil-works/pi-coding-agent` SDK — the layer Flue itself builds on),
> which has a public `AgentSession` API that maps 1:1 onto `AgentRuntime`.

The original design assumptions (kept for when the adapter lands):

Flue (flueframework.com, the Astro team) is a TypeScript agent harness built on pi's provider
layer (`@earendil-works/pi-ai`): `defineAgent`, sessions, `defineTool`, MCP connections,
sandboxes, durable session streams, structured results.

- **Packaging**: `@flue/runtime` (+ `@flue/runtime/node` for the `local()` sandbox) as an
  **optional peerDependency**, loaded via dynamic `import()` inside `FlueRuntime.start()`.
  `runtime: "flue"` without the package installed → actionable error from `debug setup`. The
  core dependency footprint (chalk/commander/ora/zod) is unchanged for ACP users.
- **Agent + sandbox**: one `defineAgent` config assembled at runtime with `sandbox: local()`
  and `cwd: repoPath`. The local sandbox operates directly on the host filesystem and shell —
  exactly the "debug the user's real repo" requirement. (Flue's virtual sandbox is unsuitable;
  container sandboxes are future work for untrusted repos.) The instructions field carries a
  compact preamble: debug-agent role, sentinel conventions, the `.debug-agent/debug.log`
  contract.
- **Session mapping**: **one Flue session per debug run**, mirroring the ACP session-per-run
  model. This preserves conversational context across steps, which the prompt templates assume
  ("see prior analysis"). `resumeToken` = Flue session identity; Flue's durable streams should
  make `resumeSession` real, but the exact reattach API needs verification (Open Question Q3).
- **Structured results — native**: pass the step's schema to the prompt's result option. Flue
  documents Valibot; zod ≥3.24 implements Standard Schema, so the zod schema may pass through
  directly. If Flue's result option turns out to be Valibot-only, the fallback design is a
  `submit_step_result` `defineTool` whose input schema is generated from the step's zod schema
  (via `zod-to-json-schema`) and whose handler captures the payload; the step preamble
  instructs the agent to call it once at the end. Either way `dataSource: "structured"`, and a
  missing/invalid result maps to `data: null` plus one engine-driven retry. Fenced-JSON
  scraping disappears entirely on Flue.
- **Modes**: `capabilities.modes = false`. Plan-mode steps (hypothesize, review) get an
  injected "Do NOT edit files in this step" guard — already present in the templates, so
  degradation is near-free.
- **Model switching**: per-agent config in Flue, so `modelSwitching = false` initially; the run
  uses `models.fixer`. The orchestrator uses a **second, tool-less `defineAgent`** on
  `models.orchestrator` with a result schema — the cleanest `oneShot` implementation of the two
  runtimes.
- **Browser verification**: `connectMcpServer("playwright", { command: "npx", args:
  ["-y", "@playwright/mcp@latest"] })`; tools appear as `mcp__playwright__*`. Nothing is
  written into the user's repo. The permission policy's browser-MCP prefix matching gains the
  `mcp__<server>__` pattern.
- **Provider credentials**: Flue rides pi's provider layer, so users need provider API keys
  (e.g. `ANTHROPIC_API_KEY`) — surfaced by runtime-aware `debug setup` checks. Model ids are
  provider-scoped (`anthropic/claude-sonnet-4-6`), which motivates per-runtime model config
  (§9).

---

## 6. Loop engine (`src/engine/`)

### 6.1 StepCatalog

```ts
// src/engine/catalog.ts
export type GateId = "verified" | "clean" | "reviewed";

export interface StepDefinition<Out = unknown> {
  id: string;                       // "hypothesize" | "instrument" | … | "explore"
  title: string;
  promptTemplate: string;           // template file stem: "hypothesize" → hypothesize.md
  mode?: StepMode;                  // "plan" for hypothesize/review; "execute" otherwise
  modelRole: ModelRole;
  /** Exit contract; also rendered into the prompt as {{resultSchemaJson}} so prompt and
      parser cannot drift. */
  resultSchema?: z.ZodType<Out>;
  /** Entry contract: returns missing-precondition messages (empty = ok). */
  preconditions?: (ledger: RunLedger) => string[];
  /** Reducer replacing controller.parsePhaseResult — writes validated result into the ledger. */
  applyResult?: (ledger: RunLedger, data: Out | null, ctx: StepRunContext) => void;
  /** Side effects around the prompt (sentinel counts, logSinceTs, waitForDebugLog). */
  beforePrompt?: (ctx: StepRunContext) => Promise<void>;
  afterPrompt?: (ctx: StepRunContext) => Promise<void>;
  costHint: "cheap" | "moderate" | "expensive";
  /** Gates this step can satisfy when its success predicate holds. */
  satisfies?: GateId[];             // verify/re_verify → "verified"; mark_fixed → "clean"
  succeeded?: (ledger: RunLedger, res: StepPromptResult) => boolean;
  maxAttempts?: number;             // mark_fixed: 3 (today's 2 retries)
}
```

The built-in catalog contains today's 11 steps plus one new insertable step, **`explore`**
(read-only investigation with a free-form findings schema, insertable by the orchestrator when
analysis is inconclusive). Today's hard-coded phase logic maps 1:1 onto catalog hooks:

| Today (controller.ts) | v2 catalog slot |
|---|---|
| `sentinelCountBefore` snapshot before instrument | `instrument.beforePrompt` |
| `waitForDebugLog` / `readDebugLogSince` after reproduce | `reproduce.afterPrompt` |
| sentinel recount + ≤2 retries in `runMarkFixedPhase` | `mark_fixed.succeeded` + `maxAttempts: 3` |
| `parsePhaseResult` switch cases | per-step `applyResult` with real zod schemas |
| `parseVerified` | `verify.resultSchema` (`{ verified: boolean, reason?: string }`) + `succeeded` |

Step result schemas (`HypothesizeResultSchema`, `VerifyResultSchema`, `ReviewResultSchema`,
`RunSummarySchema`, …) are colocated in `src/engine/step-schemas.ts` — a single source of truth
for both the prompt (`{{resultSchemaJson}}`) and the parser.

### 6.2 StepPolicy — legal transitions, gates, budgets

```ts
// src/engine/policy.ts
export interface StepPolicy {
  entryStep: string;                                  // "hypothesize"
  /** Deterministic edge used by static mode and as the heuristic default. */
  defaultNext: Record<string, (ledger: RunLedger) => string | "done">;
  /** Orchestrator's menu: every transition the LLM may legally pick. */
  allowedNext: Record<string, string[]>;
  /** Steps that may be inserted out-of-band (menu for action:"insert"). */
  insertable: string[];                               // ["explore", "reproduce", "instrument"]
  /** Gates that must be satisfied before entering a step. Engine-enforced. */
  gatesBefore: Record<string, GateId[]>;              // summarize: ["verified", "clean"]
  budgets: {
    maxCycles: number;              // verify→analyze loops (today 5)
    maxReviewCycles: number;        // re_verify loops (today effectively unbounded → cap 3)
    maxTotalSteps: number;          // absolute step count (default 30)
    maxInsertedSteps: number;       // anti-insert-loop (default 4)
    maxAttemptsPerStep: number;     // default 2 unless the step overrides
    maxWallClockMs?: number;
  };
}
```

`defaultNext` encodes today's switch **exactly** — including the verify hinge
(`verified || cycles >= maxCycles ? mark_fixed : analyze`), the review hinge on
`reviewComments.length`, the re_verify hinge on unaddressed comments, and the pre-summarize
sentinel check. This is the **static-mode contract**, and it is unit-testable without any
agent process.

### 6.3 Orchestrator decision point

```ts
// src/engine/orchestrator.ts
export type OrchestratorDecision =
  | { action: "advance";  nextStepId: string; rationale: string }
  | { action: "retry";    rationale: string; promptAddendum?: string }
  | { action: "insert";   stepId: string; rationale: string }      // returns to interrupted flow after
  | { action: "skip_to";  nextStepId: string; rationale: string }  // e.g. trivial fix: skip review
  | { action: "ask_user"; questions: UserQuestion[]; rationale: string }
  | { action: "abort";    rationale: string };

export interface DecisionInput {
  stepJustRan: string;
  attempt: number;
  lastResult: { ok: boolean; dataSource: string; digest: string };  // digest ≈ 1–2 KB summary
  ledgerDigest: LedgerDigest;       // hypothesis statuses, cycles, sentinels, review state
  budgetsRemaining: BudgetSnapshot;
  legalActions: OrchestratorDecision["action"][];
  legalNextSteps: string[];
}

export interface DecisionRecord {                       // appended to ledger.decisions
  seq: number;
  ts: number;
  afterStep: string;
  decidedBy: "static" | "heuristic" | "llm" | "user" | "guardrail_override";
  decision: OrchestratorDecision;
  overridden?: { original: OrchestratorDecision; reason: string };  // when the engine vetoes the LLM
  modelId?: string;
  latencyMs?: number;
}
```

**Decision procedure per autonomy level** (`autonomy: static | guided | autonomous`):

1. **static** — always `defaultNext(ledger)`; `decidedBy: "static"`. Byte-identical behavior to
   today; zero extra LLM calls; remains the default until the orchestrator phase ships (and
   available indefinitely).
2. **guided** (intended default eventually) — heuristic fast-path: when `defaultNext` is
   unambiguous and the step succeeded, take it (`decidedBy: "heuristic"`, no LLM call). Invoke
   `runtime.oneShot` **only at ambiguous hinges**: verify failed, result unparsable
   (`dataSource: "none"`), same step failed twice, analyze produced no confirmed hypothesis, or
   budgets near exhaustion. That is ~2–4 LLM calls in a typical run.
3. **autonomous** — LLM decision after every step (heuristics only as fallback on LLM failure).

This is how the loop gains the requested autonomy: **skip** (`skip_to` past review for a
trivial verified fix), **more exploration** (`insert: "explore"` when analysis is
inconclusive), and **bail out** (`ask_user` when the bug description or repro is too unclear
to proceed).

**Guardrails are enforced by the engine, never delegated to the LLM**
(`src/engine/guardrails.ts`):

- LLM output is validated against `OrchestratorDecisionSchema` (zod) *and* the menu:
  `nextStepId ∈ allowedNext[step]`, `insert.stepId ∈ insertable`, insert count
  `< maxInsertedSteps`, retry count `< maxAttemptsPerStep`. An illegal decision is replaced by
  `defaultNext` and recorded as `decidedBy: "guardrail_override"` with both decisions kept.
- `gatesBefore` hard-blocks: `summarize`/`done` require the `verified` gate (or the explicit
  budget-exhausted partial escape matching today's `cycles >= maxCycles`) and the `clean`
  (no-sentinels) gate — replacing today's ad-hoc pre-summarize check.
- `maxTotalSteps` / `maxWallClockMs` exhaustion → `ask_user` (interactive) or `abort` with
  `status: "partial"`.
- A `skip_to` may skip `review`, never `verify` — expressed purely in `allowedNext`, no
  special-casing.

The orchestrator prompt (`prompt-templates/orchestrate.md`, overridable like every other
template) renders the `DecisionInput` and demands a single JSON object matching the decision
schema.

### 6.4 Engine loop (replaces `runPhaseLoop`)

```
while (true):
  step = catalog[current]
  enforce gatesBefore + preconditions          (violation → guardrail decision)
  render prompt (template + ledger vars + userAnswers + promptAddendum)
  res = session.prompt({ text, resultSchema, mode: step.mode, model: resolve(step.modelRole) })
  step.applyResult(ledger, res.data); step.afterPrompt(ctx)
  persist: run_steps row + ledger checkpoint   (crash-resume point)
  decision = orchestrator.decide(…)            (per autonomy level)
  record DecisionRecord; persist               (same transaction as the step row)
  switch decision.action:
    advance | skip_to → current = next
    retry             → same step, attempt++
    insert            → push return-address; current = inserted   (single-level, bounded)
    ask_user          → persist waiting state; exit(3)
    abort             → finalize partial
    (done sentinel)   → break
```

---

## 7. User escalation (`ask_user`)

- **Interactive TTY, process attached**: print questions and read answers inline
  (same pattern as today's `--confirm-plan` flow in `src/debug/plan-confirm.ts`), append to
  `ledger.userAnswers`, continue in-process. No pause needed.
- **Non-interactive / user defers**: persist `ledger.pendingQuestions`, set run status
  `waiting_on_user` (new lifecycle status), print the questions plus the resume command, exit
  with code **3** (distinct from 0 fixed / 1 error / 2 partial). Resume with
  `debug resume --run <id> --answer "text"` (repeatable, positional by question order) or
  `--answers-file answers.json`; a bare interactive `debug resume` with pending questions
  prompts inline. Answers are recorded as `DecisionRecord { decidedBy: "user" }` and injected
  into subsequent prompts via a `{{userAnswersBlock}}` template variable.
- **Agent-initiated questions** (runtime `askUser` capability, e.g. `cursor/ask_question`):
  surfaced as `question` events. Interactive → relayed to the terminal with the question's
  options; non-interactive → auto-skip exactly as today, but the skip is now traced in the
  ledger. Orchestrator-initiated `ask_user` always uses the CLI path above — native ask-user is
  deliberately *not* used for orchestrator questions, keeping behavior uniform across runtimes.

---

## 8. Persistence: ledger v2, store migration, resume, report

### RunLedger v2 (`src/debug/types.ts`)

- `phase: Phase` → `currentStepId: string` (+ `nextStepId?`). The `Phase` union survives only
  as the set of built-in catalog ids; `DEBUG_PHASES` (`src/debug/phases.ts:4`) is replaced by
  `catalog.stepIds`.
- New fields: `ledgerVersion: 2`, `runtime: "acp" | "flue"`, `agentPreset?`, `resumeToken?`,
  `autonomy`, `stepHistory: StepExecutionRecord[]`
  (`{seq, stepId, attempt, startedAt, endedAt, dataSource, ok, inserted}`),
  `decisions: DecisionRecord[]`, `pendingQuestions?`, `userAnswers: []`, `budgetsUsed`.
- `parseLedger` (`src/debug/run-store.ts`) upgrades v1 ledgers on read:
  `currentStepId = phase`, `stepHistory` synthesized from the old phase timeline,
  `runtime: "acp"`, `agentPreset: "cursor"`.

### RunStore v2 (SQLite, `PRAGMA user_version = 2` migration)

- `runs`: add `runtime`, `agent_preset`, `autonomy`, `resume_token` columns;
  `current_phase`/`next_phase` keep their column names but mean current/next *step*.
- Pre-seeded `run_phases` (`run-store.ts:184-193`) → new append-only **`run_steps`** table:
  `(run_id, seq, step_id, attempt, status, started_at, completed_at, error, data_source)`.
  Rows are appended as executed because the step list is dynamic; the report computes "pending"
  rows by diffing executed steps against the catalog's nominal path.
- New **`decisions`** table `(run_id, seq, after_step, decided_by, action, next_step,
  rationale, overridden_json, ts)` for the report's decision-timeline query.
- Migration copies existing `run_phases` rows into `run_steps` (seq from `DEBUG_PHASES` order);
  `run_phases` is left in place read-only so older builds sharing `~/.debug-agent/state.db`
  don't break.
- `run_status` gains `waiting_on_user`; `findLatestInterrupted` also matches it.

### Resume semantics with a dynamic step list

The resume point is `runs.next_step`, written with every decision (as `recordPhaseComplete`
does today). On resume the engine (a) restores `stepHistory`/`decisions`/budget counters so
guardrails keep their memory across restarts, (b) restores the insertion return-address if the
run died mid-inserted-step, (c) re-runs only the *decision* if the crash landed between step
completion and decision persistence (both writes share a transaction, so normally it doesn't).
ACP resume additionally calls `session/load` with the stored `resumeToken`; runtimes without
`sessionResume` get a fresh session and rely on the ledger-rendered prompts, which are written
to be self-sufficient.

### Report additions (`src/report/`)

`FinalReportSchema` gains `decisionTimeline: DecisionRecord[]`, a dynamic `stepTimeline`
(entries carry `inserted`/`attempt`) replacing the fixed phase timeline, `runtime`/
`agentPreset`, and per-step `dataSource` badges. The HTML report gets a "Decisions" section
rendering `decidedBy` + rationale per hop — the audit-trail requirement made visible.

---

## 9. Prompts & config evolution

### Templates (`prompt-templates/`, loader `src/debug/prompt-loader.ts`)

- Template file = `<stepId>.md`, derived from the catalog (no more hand-maintained
  `PHASE_TEMPLATE_FILES` map). The 3-tier override (repo `.debug-agent/prompts/` →
  `~/.debug-agent/prompts/` → bundled) is unchanged.
- New files: `orchestrate.md`, `explore.md`, and a dedicated `re_verify.md` (today re_verify
  reuses verify's body).
- New template variables:
  - `{{resultSchemaJson}}` — generated from the step's zod schema (via `zod-to-json-schema`),
    replacing hand-maintained JSON examples in every template.
  - `{{resultInstruction}}` — "end with a fenced JSON block" vs "submit via the structured
    result channel", filled per runtime capability.
  - `{{userAnswersBlock}}`, `{{decisionAddendum}}` (orchestrator's retry addendum),
    `{{runtimeNotes}}` (capability-conditional guidance, e.g. the "record hypotheses as todos"
    line only when `planEvents`).

### Config v2 (`src/config/`)

```jsonc
{
  "version": 2,
  "runtime": "acp",                    // "acp" | "flue"
  "autonomy": "static",                // "static" | "guided" | "autonomous"
  "models": {                          // top-level = ACP-compat alias; per-runtime nesting wins
    "planner": "…", "fixer": "…", "reviewer": "…", "orchestrator": "…"
  },
  "acp": {
    "preset": "cursor",                // cursor | claude | codex | gemini | custom
    "command": null, "args": null, "env": {},
    "mcpStrategy": "auto",
    "models": { /* optional runtime-scoped override */ }
  },
  "flue": {
    "sandbox": "local",
    "models": { /* provider-scoped ids: anthropic/claude-… */ }
  },
  "browserMcp": "playwright",
  "budgets": { "maxCycles": 5, "maxInsertedSteps": 4, "maxTotalSteps": 30 }
}
```

- Model roles nest per runtime (model-id namespaces are incompatible: Cursor slugs vs
  `anthropic/...`), with the top-level block as fallback/alias.
- v1 configs auto-upgrade on read (`runtime: "acp"`, `preset: "cursor"`,
  `autonomy: "static"`, `orchestrator` defaults to the fixer model); `debug config init`
  writes v2.
- CLI additions: `--runtime`, `--agent <preset>`, `--autonomy`, `--orchestrator-model`.
  `modelForPhase` (`src/config/resolve.ts:108`) becomes `modelForRole(step.modelRole)`.
- `debug setup` becomes runtime-aware: ACP checks agent binary + auth probe per preset; Flue
  checks the package is installed + a provider key is present.

---

## 10. Phased implementation plan

Every phase is independently shippable. The todo-fixture oracle
(`npm run fixture:run:one` + `fixture:accept`, `scripts/todo-fixture.mjs`) is the cross-phase
regression harness; there is currently no unit-test suite, so phases 2 and 4 introduce targeted
unit tests where the design makes logic agent-free.

| Phase | Scope | Main files created / modified | Risks | Verification |
|---|---|---|---|---|
| **P0** | This design doc | + `docs/DESIGN-loop-v2.md` | — | review |
| **P1** | **Extract `AgentRuntime`, zero behavior change.** Interface in `src/runtime/types.ts`; `AcpRuntime` wraps the existing `AcpClient` verbatim (Cursor-only); controller consumes only the interface; events unified; `parsePhaseResult` moves behind `StepPromptResult.data` with json-extraction in the adapter | + `src/runtime/{types,acp/adapter,json-extract,permissions}.ts`; ~ `controller.ts`, `permissions.ts` (move), `prompts.ts` | subtle stream-buffer accumulation/reset semantics must be preserved exactly | `npm run typecheck`, `smoke:acp`, `smoke:report`, fixture run with comparable ledgers |
| **P2** | **Engine extraction, static mode only.** StepCatalog + step schemas + StepPolicy encoding today's switch; LoopEngine replaces `runPhaseLoop`; RunStore v2 migration; ledger v2 with upgrade-on-read; static `DecisionRecord`s written; report reads either timeline shape | + `src/engine/{catalog,step-schemas,policy,engine,guardrails}.ts`; ~ `controller.ts` (thin), `run-store.ts`, `types.ts`, `phases.ts` (deprecate), `report/*` | DB migration on a shared `~/.debug-agent/state.db`; resuming pre-migration interrupted runs | typecheck; unit-test `defaultNext` against a recorded transition-trace fixture; `fixture:run:all`; `debug resume` on a v1 run |
| **P3** | **Generalized ACP.** Presets, capability discovery, auth negotiation, official `set_mode`/`set_model` + Cursor `set_config_option` fallback, generic `plan` updates, inline-MCP-with-file-fallback, permission `kind` mapping; config v2 `acp` block + `--agent` | + `src/runtime/acp/{presets,mcp-file}.ts`; ~ adapter, `src/acp/types.ts`, `src/mcp/browser.ts` (split), `src/config/*`, `src/setup/checks.ts`, templates (`{{runtimeNotes}}`) | real agents deviate from spec (Cursor `set_model` quirk precedent); auth flows differ; inline MCP support uneven | `smoke:acp` parameterized per preset; fixture vs Cursor (regression) + manual fixture runs vs claude-agent-acp and gemini; `debug setup` per preset |
| **P4** | **Orchestrator + autonomy + ask_user.** `oneShot` on AcpRuntime (decision side-session), heuristic fast-path, guided/autonomous knobs, `orchestrate.md` + `explore.md`, guardrail veto logic, `waiting_on_user` lifecycle + `resume --answer`, decision timeline in the report, exit code 3 | + `src/engine/orchestrator.ts`, `escalation.ts`; + templates; ~ `engine.ts`, `cli.ts`, `run-store.ts`, `report/*` | LLM decision quality; cost creep in autonomous mode; decision-schema drift | unit tests: guardrails veto illegal decisions (mock LLM); fixture in `static` (must match P2), then `guided`; a forced-failure fixture bug exercising retry/insert/ask_user |
| **P5** | **Flue adapter.** Optional `@flue/runtime` dep + dynamic import; `local()` sandbox on repoPath; session-per-run; native structured results (or `submit_step_result` tool); `connectMcpServer` browser MCP; runtime-aware setup checks; `flue` config block | + `src/runtime/flue/adapter.ts`; ~ `package.json` (optional peer), `setup/checks.ts`, `config/*`, `permissions.ts` (`mcp__` prefix) | Flue API still moving (1.0 beta); zod ↔ Standard-Schema/Valibot interop; session-resume semantics unverified | typecheck with and without flue installed; fixture with `--runtime flue` (CLI verify, then browser verify); oracle accept |
| **P6** | **Cleanup + docs.** Remove `Phase` hard-coding remnants; `.cursor` handling fully behind the cursor preset; README/AGENTS/INSTALL updates; flip default `autonomy` to `guided` in a separate, revertable commit | ~ many (deletions), docs | default-flip user surprise | full fixture matrix (2 runtimes × static/guided), smoke suite |

**Backward-compat story**: P1–P2 are pure refactors gated on identical fixture outcomes;
config/ledger/DB all upgrade on read with explicit versions; `autonomy: "static"` remains
available indefinitely as the deterministic, zero-extra-cost mode; the Cursor preset preserves
every current quirk (`cursor_login`, `set_config_option`, `.cursor/mcp.json`, `cursor/*`
handlers).

---

## 11. Testing strategy

- **Transition-trace unit tests** (new, P2): `defaultNext` and the guardrail layer are pure
  functions over the ledger — record a phase-transition trace from a P1 fixture run and assert
  static mode reproduces it exactly. No agent process needed.
- **Guardrail veto tests** (P4): feed a mock LLM returning illegal decisions (skip verify,
  insert loops, out-of-menu steps) and assert `guardrail_override` substitution.
- **Fixture matrix** (`examples/todo-fixture` + oracle): per phase as listed above, growing to
  {runtime: acp-cursor, acp-claude, flue} × {autonomy: static, guided} by P6.
- **Per-preset smoke** (`scripts/smoke-acp.mjs` parameterized): initialize/authenticate/
  session-new handshake per ACP preset, asserting capability discovery.

---

## 12. Alternatives considered

- **Direct provider call for the orchestrator** (Anthropic/pi API): rejected — introduces a
  second credential system and breaks "bring your ACP agent, no API keys". `runtime.oneShot`
  keeps decisions inside the user's existing auth, with a deterministic fallback.
- **Agent self-directed loop via control tools** (give the debugging agent `advance_phase` /
  `bail_out` tools and make the loop a thin executor): maximally autonomous, but unpredictable,
  hard to audit, and hard to enforce budgets against; rejected in favor of the orchestrator +
  engine-enforced guardrails. The `RuntimeEvent`/decision design doesn't preclude adding this
  later for runtimes with strong custom-tool support.
- **Up-front dynamic plan, revised at checkpoints**: cheaper than per-step decisions but reacts
  poorly to mid-run surprises (exactly the debugging case); the guided mode's heuristic
  fast-path achieves the same cost profile with better reactivity.
- **Session-per-step on Flue**: cleaner isolation but discards conversational context the
  prompt templates rely on; rejected in favor of session-per-run (matching ACP).
- **Keeping fixed phases + hook points**: least work, but cannot express skip/insert/bail — the
  core ask.

---

## 13. Open questions

1. **Orchestrator default on ACP**: is a cheap agent-side model acceptable as the default
   `models.orchestrator`, or should guided mode ship heuristics-only until a model is
   explicitly configured?
2. **Flue result schemas** — RESOLVED: strictly Valibot (`~standard.vendor === "valibot"`
   asserted at runtime in 1.0.0-beta.9); pass-through of zod schemas is not possible.
3. **Flue session resume** — MOOT for now: the Flue adapter is deferred (see §5 status
   update) because 1.0-beta exposes no public in-process embedding API.
4. **Shared state DB across versions**: is readable-but-degraded acceptable for older builds
   after the v2 migration, or do we fork-on-migrate a copy of `state.db`?
5. **MCP file cleanup**: should the ACP file strategy remove the browser-MCP entry from
   `.cursor/mcp.json` at run end (new behavior), or keep today's leave-in-place behavior for
   the Cursor preset?
6. **Exit code 3** (`waiting_on_user`): any scripts/CI consuming the current 0/1/2 exit codes
   that need notice?

---

## 14. Appendix: today → v2 file map

| Concern | Today | v2 |
|---|---|---|
| Loop driver | `src/debug/controller.ts` (`runPhaseLoop` switch) | `src/engine/engine.ts` + thin `src/debug/run.ts` |
| Phase set | `src/debug/types.ts:114`, `src/debug/phases.ts:4` | `src/engine/catalog.ts` (StepCatalog) |
| Agent transport | `src/acp/client.ts` (concrete, Cursor-only) | `src/runtime/types.ts` + `src/runtime/acp/`, `src/runtime/flue/` |
| Result parsing | `extractJsonFromText` + `parsePhaseResult` | `resultSchema` per step; adapter-side extraction/native structured output |
| Transitions | hard-coded `switch` | `StepPolicy.defaultNext` (static) + orchestrator decisions |
| Prompt templates | `PHASE_TEMPLATE_FILES` map | catalog-derived `<stepId>.md`, same 3-tier override |
| Persistence | `run_phases` pre-seeded | append-only `run_steps` + `decisions` tables |
| Permissions | Cursor optionId strings | `PermissionDecision` mapped by ACP option `kind` |
| Browser MCP | `.cursor/mcp.json` always | inline-first, file fallback per preset; Flue `connectMcpServer` |
