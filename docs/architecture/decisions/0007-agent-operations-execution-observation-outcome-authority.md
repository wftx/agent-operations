# ADR 0007: Agent Operations Execution Observation and Outcome Authority

- Status: Accepted
- Date: 2026-08-21

## Context

Agent Operations can durably submit one immutable Execution Plan and record runtime acceptance. Acceptance proves only that the runtime accepted an injection. It does not prove that a turn completed, that output belongs to the Dispatch, that the Attempt succeeded, or that the Job's desired outcome was achieved.

CortextOS discovery found provider-local signals but no trustworthy end-to-end `inject-agent` correlation:

- Claude Code has a persistent PTY, transcript/session files, a Stop hook, and a session identifier in status-line input. The Stop hook writes only an agent-level idle timestamp; injection returns no Claude turn/message identifier.
- Codex app-server exposes structured thread IDs, turn IDs, `turn/started`, `turn/completed`, item output, and errors internally. `inject-agent` acknowledges before a queued turn is assigned an ID, and an injection may steer an existing turn or queue a new turn, so the IPC caller cannot correlate its Dispatch to a later turn.
- OpenCode stores session, message, part, and `step-finish` rows and CortextOS reads them for context usage. PTY injection has no stable mapping to those IDs.
- Hermes exposes a persistent REPL prompt and session database continuity, but CortextOS has no structured per-injection completion event or identifier.
- Daemon status, crash state, heartbeat, FastChecker, bus events, output buffers, and idle flags are agent/session-level diagnostics. They do not identify one Dispatch.

Adding an optional correlation ID only to injection would not solve completion correlation because it would not survive each provider's transport to a trustworthy completion event. A complete generic enhancement would require provider-specific message-envelope and event work and is therefore not a tiny Phase 10 core change.

## Decision

Separate three concepts:

```text
Execution Observation
Completion Evidence
Attempt Outcome Decision
```

An Execution Observation is append-only, bounded, linked to an accepted Dispatch and Attempt, and records source, stable source-event identity, kind, correlation quality, time, and optional concise message/output reference or summary. Raw transcripts, ANSI streams, and unbounded provider output are not stored.

Correlation is explicit:

```text
exact            trusted evidence names this Dispatch
runtime-session  attributable to the persistent runtime session only
agent-level      attributable only to the agent
uncorrelated     diagnostic evidence without execution attribution
```

Only a `turn-completed` observation with `exact` correlation and the matching Dispatch identity is exact completion evidence. Session-level output, generic idle, runtime running state, and unrelated events are not exact evidence. Stable observation identity is derived from Dispatch, source, and source event ID so repeated explicit observations deduplicate without comparing free-form text.

The current CortextOS observer intentionally emits only agent-level or uncorrelated observations. Daemon running/stopped/crashed state and post-acceptance Claude/Codex idle flags are useful diagnostics, but they cannot make an Attempt completion-ready. OpenCode and Hermes do not receive fabricated idle events. No CortextOS core change is made.

Runtime-turn completion is not Attempt success. Output availability is not Job success. Phase 10 outcome authority remains human:

- Success requires an explicit human command and, by default, exact turn-completion evidence. A deliberate human override is available for providers whose observer cannot produce exact evidence.
- Failure requires an explicit human command and reason. Crash evidence may be referenced but does not automatically fail the Attempt.
- The outcome decision is persisted before the existing `JobLifecycleService` transition. If local lifecycle persistence lags, repeating the same decision reconciles it without changing evidence or performing runtime work.
- A completed or failed Attempt does not automatically complete or fail the Job. Job completion remains a separate explicit lifecycle command.

Unknown is a valid state. Accepted Dispatch plus runtime unavailable, weak idle, unrelated output, or no completion signal remains unresolved.

## Critical rule

Agent Operations must not mark an Attempt successful solely because a persistent runtime becomes idle or finishes producing output.

## Consequences

- AO preserves exact evidence when a future provider observer can supply it without overstating current CortextOS capabilities.
- Weak observations remain operationally useful and visibly weak.
- Repeated observations are append-only and deduplicated by trusted source identity.
- Human outcome authority and evidence provenance survive restart.
- Runtime crashes remain evidence, not automatic lifecycle policy.
- Provider-specific parsing stays outside AO core.
- Per-Dispatch correlation remains the principal architectural gap for a live end-to-end rehearsal.

## Non-decisions

Phase 10 does not define autonomous outcome determination, observer loops, queues, scheduling, retries, redispatch, Git-result validation, test-result ingestion, artifact collection, full logs, token/cost accounting, notifications, automated Job completion, or multi-machine observation.
