# ADR 0008: First Live Agent Operations Execution Rehearsal

- Status: Accepted; live execution safely blocked
- Date: 2026-08-21

## Context

Phases 4–10 established runtime, durable-state, work, planning, preflight, dispatch, observation, and outcome boundaries without Agent Operations contacting a live runtime. CortextOS does not yet expose trustworthy per-Dispatch completion correlation across its persistent provider sessions.

The first live exercise must validate the complete AO path without introducing repository risk, automatic monitoring, or outcome inference. A repository-bound rehearsal is inappropriate because current runtime inventory cannot prove a live runtime's effective checkout directory.

## Decision

Prepare one development-only, repository-free execution path using:

```text
manual Dispatch
      +
one explicit weak runtime observation
      +
explicit human outcome confirmation
```

The rehearsal uses a unique nonce and a harmless instruction that forbids tools, file changes, shell commands, Git, and external services. The nonce is only a human-verification aid and never becomes exact infrastructure correlation.

Execution requires both `--execute` and the literal `--confirm LIVE_REHEARSAL`. Preview is the default and evaluates the gate before opening AO durable state. Candidate selection requires an already-running, configured, explicitly enabled, known provider plus affirmative read-only idle/queue safety evidence. The harness never starts or configures a runtime.

The actual submission flows through the AO state store, `JobLifecycleService`, `ExecutionPlanningService`, `ExecutionPreflightService`, `ManualDispatchService`, and the real CortextOS execution adapter. It does not call daemon IPC directly. Existing Dispatch states are respected, so accepted work is observed without redispatch, and submitting, uncertain, or rejected work stops without retry.

At most one external submission is permitted. Runtime observation is explicit and bounded. Success and failure remain separate human commands through `ExecutionOutcomeService`; exact evidence is not fabricated. Success uses the deliberate human override while exact correlation is unavailable. Job completion is another separate command.

## Result

On 2026-08-21, read-only discovery found the default CortextOS runtime inventory unavailable: the daemon was not running, framework agent configuration was unavailable to the adapter, and zero configured/running agents were reported. No safe candidate existed, so the authorized live submission was correctly blocked.

The harness and fake execution path were completed for later use. No daemon or agent was started, no configuration or credentials were changed, no durable live rehearsal record was created, and the number of external submissions remained zero.

## Consequences

- The development command can preview safely without creating AO state or contacting a runtime.
- A later live run can occur only after an existing runtime supplies affirmative safety evidence and current Preflight passes.
- Durable rehearsal history will be retained once an execution occurs.
- Weak evidence cannot automatically complete an Attempt or Job.
- Exactly-once behavior is inherited from the durable Dispatch boundary and reinforced by the harness's single-project/single-Job guard.

## Non-Decisions

Phase 11 does not establish production runtime policy, exact provider correlation, automatic monitoring or outcomes, queue/worker architecture, retry policy, repository-bound execution, Git mutation, scheduling, notifications, tool auditing, or autonomous polling.
