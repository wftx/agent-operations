# ADR 0011: Exact Codex Execution Correlation and Test Isolation

- Status: Accepted
- Date: 2026-08-24

## Context

The first live Agent Operations Dispatch established the manual execution boundary but exposed two unrelated ways that ambient state could undermine trust. Root tests launched compiled CLI children without a test instance and their no-op `reload-crons` notifications resolved to the live `~/.cortextos/default/daemon.sock`. Separately, the live Dispatch acknowledgement proved only that text reached a persistent Codex runtime; later running and idle signals could not identify the resulting provider turn.

Phase 14 hardens both boundaries without adding autonomy. Observation remains explicitly invoked, and lifecycle outcome authority remains human.

## Decision: Test Isolation

Every Vitest worker creates a unique temporary root and makes it the process `HOME`, `USERPROFILE`, `CTX_ROOT`, and `AGENT_OPERATIONS_STATE_DIR`. It also sets a unique `CTX_INSTANCE_ID`. The root IPC resolver detects Vitest, requires `CTX_ROOT`, rejects any test root inside that worker's home-state `.cortextos` directory, and resolves only the temporary socket. Outside Vitest, production socket semantics are unchanged.

The compiled concurrent-cron regression now supplies its child processes with an explicit temporary home, state root, and instance. A temporary daemon fixture receives all 40 expected `reload-crons` requests. Absence of an isolated socket fails locally; no resolver falls back to a user daemon. Parallel worker roots yield distinct socket paths.

The same test environment redirects Agent Operations' default SQLite directory, preventing default writes to a real `~/.agent-operations` tree. Individual integration fixtures may still create their own temporary sockets and state roots.

## Decision: Correlation-Safe Codex Injection

The existing generic `inject-agent` IPC request gains optional `requireNewTurn` and `correlationId` fields. Existing callers that omit them retain the previous injection and steering behavior. No Agent Operations types enter CortextOS core.

When correlation-safe mode is requested for a Codex runtime, `AgentProcess` first proves that the runtime can start a new turn, then persists `last_message_injected.flag`, and only then asks the Codex app-server adapter to create the turn. Marker failure prevents submission. An already active or queued turn produces a positive `RUNTIME_BUSY` rejection before external submission. This path never calls `turn/steer` and protects the accepted turn from later generic steering until its structured terminal event.

Codex `turn/start` returns the provider-generated turn identity without waiting for completion. CortextOS returns the provider, persistent thread ID, and turn ID in its IPC acknowledgement. The AO adapter encodes those identifiers as an opaque provider-owned reference:

```text
cortextos:codex-turn:v1:<thread-id>:<turn-id>
```

AO core stores this string in the existing optional Dispatch `externalReference`. AO core neither parses Codex identifiers nor acquires a provider dependency. No schema migration is required.

## Structured Provider Record

Correlation-safe turns have one bounded CortextOS-owned record at:

```text
$CTX_ROOT/state/<agent>/codex-turns/<thread-id>/<turn-id>.json
```

The record contains provider identity, status, bounded error text, and timestamps. It contains no transcript or unbounded model output. `turn/started`, `turn/completed`, and non-retrying structured error events maintain the record for the exact turn. A record-persistence failure after `turn/start` is ambiguous and keeps the runtime fail-closed until native idle/terminal evidence or timeout.

The caller correlation ID is also passed as Codex `clientUserMessageId` and retained in the local record. Codex does not document that field as an idempotency or lookup contract, so Phase 14 does not use it to recover or retry an acknowledgement-lost submission.

## Exact Observation

The CortextOS observer parses only its provider-owned opaque reference and loads only the matching thread/turn record. Exact evidence requires all of the following:

- a trusted external reference persisted from Dispatch acceptance;
- the Codex provider;
- a valid and matching structured thread/turn record;
- an explicit native status.

A matching `completed` record produces `kind = turn-completed`, `correlation = exact`, and the accepted Dispatch ID. Matching in-progress records produce exact running evidence. Failed or interrupted records produce exact runtime-failure evidence with the native terminal status preserved in the event identity and message. Missing, malformed, wrong-thread, and wrong-turn records fail closed as unknown and uncorrelated.

Generic daemon running and idle observations remain agent-level evidence. Thread identity, timestamp proximity, idle transitions, output text, nonce matches, and the most recent turn are never treated as exact.

Exact turn completion does not mean the requested work succeeded. It creates completion evidence only; it does not complete the Attempt or Job. Human success or failure remains authoritative.

## Persistence and Atomicity

The opaque external reference survives Agent Operations database close and reopen, and the structured provider record survives process memory loss. Together they support later explicit observation without an in-memory map.

There is still no distributed transaction between SQLite and Codex. If Codex may have created a turn but AO loses the acknowledgement before persisting its reference, the Dispatch remains uncertain and is never retried automatically. The synchronous turn identity and `clientUserMessageId` narrow the crash window but do not establish exactly-once delivery.

## Provider Capability

Only Codex advertises `exact-turn-correlation`. Claude, OpenCode, and Hermes retain `session-resume` only and do not simulate unsupported correlation.

## Historical Compatibility

The Phase 13 live Dispatch has no exact turn reference. Its observations remain agent-level, its exact-evidence flag remains false, and its completed outcome remains a human override. Historical records are not rewritten.

## Safety

> A correlation-safe AO Dispatch must not steer an unrelated active Codex turn.

The exact observer is read-only and explicitly invoked. Phase 14 adds no interval, worker, cron, scheduler, background polling, automatic outcome, automatic retry, queue, repository execution, or live Dispatch.

## Runtime Permission Discovery

Current CortextOS Codex thread and turn requests explicitly select `approvalPolicy: never` with `danger-full-access`/`dangerFullAccess`. Locally generated Codex app-server protocol types also support read-only and workspace-write sandboxes, explicit writable roots, network denial, named permission profiles, and alternative approval policies. The current CortextOS request handler does not implement interactive app-server approval requests, and Phase 14 does not change these permissions. A per-rehearsal-agent permission profile or explicit workspace-write/read-only turn policy is a Phase 15 concern.

## Non-Decisions

Phase 14 does not define autonomous outcome decisions, runtime sandbox enforcement, Git or repository-bound execution, provider correlation for Claude/OpenCode/Hermes, full transcript persistence, queues, workers, retries, schedules, automatic monitoring, or production deployment.
