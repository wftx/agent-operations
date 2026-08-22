# ADR 0006: Agent Operations Manual Dispatch Boundary

- Status: Accepted
- Date: 2026-08-21

## Context

Agent Operations can prepare and preflight immutable Execution Plans but cannot submit them. The first effectful boundary must preserve exactly-once local intent, distinguish rejection from acknowledgement ambiguity, and avoid claiming that an Attempt is running before a runtime accepts it.

Repository inspection found several CortextOS surfaces. Bus messaging durably queues an inbox file but does not prove the runtime consumed it. `notify-agent` similarly writes signal and inbox files. Direct `AgentManager`, `AgentProcess`, FastChecker, and PTY imports expose unstable internals. The existing daemon `inject-agent` IPC command is the narrowest established operator surface: it synchronously invokes structured injection and returns success or `NOT_FOUND`, `NOT_RUNNING`, `DEDUPED`, or `INVALID_INPUT`.

## Decision

Introduce:

```text
Durable Execution Dispatch
RuntimeExecutionAdapter
Explicit ManualDispatchService
```

A Dispatch is one external submission intent for one immutable Execution Plan. It is not a Job, Attempt, Plan version, queue item, or generic event. Its identity is `dispatch:<uuid>`. Its deterministic idempotency key is `dispatch-plan:<plan-id>`. SQLite structurally permits only one Dispatch per Plan and one record per idempotency key.

The lifecycle is:

```text
prepared -> submitting -> accepted
                      \-> rejected
                      \-> uncertain
```

`prepared` proves AO has not crossed the external boundary. `submitting` is durably recorded immediately before the call and means submission may be in progress or may have occurred. `accepted`, `rejected`, and `uncertain` are terminal in Phase 9. Rejected or uncertain Plans are never resubmitted; a human creates a new Attempt and Plan when another effort is appropriate.

The mutation-capable `RuntimeExecutionAdapter` is separate from the read-only `AgentRuntimeAdapter`. AO sends only Dispatch ID, deterministic idempotency key, runtime agent ID, Plan ID, and the provider-neutral input envelope. Results distinguish accepted, rejected, and uncertain, with optional external reference and message.

Manual dispatch checks for an existing Dispatch first so repeated accepted, rejected, submitting, or uncertain requests cannot cause another call. A new or still-prepared Dispatch runs a fresh Preflight. A blocking Preflight produces no new Dispatch and no external effect. AO creates `prepared`, transitions it to `submitting`, calls the adapter once, then persists the result. Only after `accepted` is durable does AO transition the Attempt from `created` to `running`.

An accepted Dispatch with a still-created Attempt is a possible crash state. `reconcileAcceptedDispatch` performs only the missing local lifecycle transition and never calls the runtime. Rejected and uncertain Dispatches leave the Attempt created. A thrown adapter error after submission begins is uncertain.

There is no distributed transaction between SQLite and an external runtime:

- Crash before the external call leaves `prepared` or `submitting`; `prepared` may be claimed once, while `submitting` blocks resubmission.
- Rejection followed by a crash before persistence is indistinguishable from acceptance loss and remains `submitting`/uncertain.
- Acceptance followed by a crash before persistence likewise remains `submitting`/uncertain and is never retried automatically.
- Durable acceptance followed by a crash before the Attempt transition is repaired explicitly with local reconciliation.

The CortextOS execution adapter wraps `inject-agent` over daemon IPC. A positive IPC response means the runtime session accepted the text injection, not that work completed. Explicit daemon errors are rejection. Connection refusal before a request can be sent is rejection. Timeout, malformed acknowledgement, disconnect, or any error after submission may have begun is uncertain. CortextOS returns no stable message/request identifier, so `externalReference` remains absent. Input mapping passes the plain instruction without prompt wrapping. No CortextOS core change is required.

## Repository context safety

Repository-bound dispatch requires proof that the current runtime working directory equals the selected checkout. AO adds an optional current `workingDirectory` observation and Preflight blocks with `runtime-working-directory-unavailable` or `runtime-checkout-mismatch` when proof is absent or different.

Current CortextOS daemon status does not expose the active process launch directory. Reading `config.json` would not prove the running process still uses that value because configuration may change after launch. Therefore repository-bound real CortextOS dispatch remains disabled. The smallest recommended upstream addition is a read-only effective launch-directory field in structured daemon status, sourced from the running `AgentProcess`, which the CortextOS read adapter can canonicalize and expose. Repository-free Plans may use the existing IPC surface now.

## Critical safety rule

An uncertain external submission must never be automatically retried.

## Human boundary

The default demonstration uses only fake execution adapters. The optional real developer command requires a Plan ID plus both `--execute` and literal `--confirm DISPATCH`. Domain code assumes that explicit caller is authorized; Phase 9 does not add a durable approval model.

## Consequences

- One Plan has one durable external-submission intent.
- Positive acceptance precedes the Attempt's running state.
- Crash ambiguity remains visible and fail-closed.
- Local reconciliation never risks a duplicate external call.
- Provider-specific transport stays outside AO core.
- Repository-bound real execution remains safely unavailable until working-directory proof exists.

## Non-decisions

Phase 9 does not define workers, queues, leases, autonomous scheduling, retry/backoff, Git mutation, worktrees, branch policy, completion detection, runtime cancellation, output ingestion, artifacts, notifications, formal approval records, or multi-machine execution.
