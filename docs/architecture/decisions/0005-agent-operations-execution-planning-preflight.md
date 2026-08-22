# ADR 0005: Agent Operations Execution Planning and Preflight

- Status: Accepted
- Date: 2026-08-21

## Context

Agent Operations can durably represent Jobs and Attempts but cannot execute them. Before adding execution, AO needs a deterministic boundary that resolves abstract work to stable runtime and installation-local checkout identities, then evaluates current conditions without causing effects.

## Decision

Agent Operations introduces:

```text
Execution Plan = immutable resolved intent for one Attempt
Execution Preflight = current read-only validation of that Plan
```

Exactly one Plan may be created for an Attempt. A wrong Plan is not edited or versioned; later work uses a new Attempt. The Plan records `plan:<uuid>`, Job, Attempt, project, current AO installation, actual Attempt runtime, optional logical repository and checkout binding identities, a version-1 plain-text input envelope, preparation-time Job and Attempt revisions, and creation time.

The Attempt's actual runtime assignment is authoritative. A Job preference cannot replace it during preparation. Repository-free Jobs retain no repository or checkout identity. For a repository Job, preparation considers only checkout bindings belonging to the current AO installation. One binding is selected automatically, zero blocks preparation, and multiple require an explicit binding ID. Absolute paths remain owned by checkout bindings and are not copied onto Plans. Persisting installation identity prevents a Plan prepared on one installation from silently resolving against another machine.

The input envelope is exactly `{ version: 1, instruction: string }`. The trimmed instruction must be non-empty. It contains no provider configuration, template, tools, environment, attachments, model parameters, or secrets.

Preparation snapshots Job and Attempt revisions. Phase 8 preflight occurs before dispatch and requires exact revision equality, a ready Job, and a created Attempt. Any intervening lifecycle transition therefore blocks the pre-dispatch check. A future legitimate dispatch may transition the Attempt after a passing preflight; Phase 8 does not define post-dispatch preflight semantics.

Preflight reads current durable state, the current runtime adapter, and a current repository inspection. It does not rely on historical observations and does not persist new observations. Runtime inventory must be available, the runtime must remain associated and observable with a known provider, and its state must be `running`. Starting, stopped, degraded, unknown, missing, or unavailable conditions block.

Repository plans must retain a binding that matches Plan installation and repository. Current inspection must find an available Git checkout whose observed logical repository identity equals the Plan repository. Missing paths, non-repositories, degraded/unavailable observation, and identity mismatch block. Dirty working trees and detached HEADs produce warnings because Phase 8 defines no read/write or branch policy. Warnings do not block; any blocking finding makes `dispatchable` false. `dispatchable` is informational current-state evaluation only.

SQLite schema v3 and the in-memory store support create and read operations only. A unique Attempt association enforces one Plan per Attempt. No update, transition, or delete operation exists.

## Security and safety boundary

Phase 8 contains no execution port and no code path capable of sending the Plan to an agent runtime. Preflight cannot start, stop, message, or otherwise mutate a runtime; it cannot mutate Git; and it cannot change AO durable state.

## Consequences

- Historical execution intent is stable and auditable.
- Installation-local checkout ambiguity is explicit.
- Runtime and repository facts are observed live and fail closed.
- Durable Plan detail remains separate from immediately stale live Preflight results.
- Phase 9 can design the first effectful port against a narrow, prevalidated input.

## Non-decisions

Phase 8 does not define dispatch, agent input injection, workers, queues, leases, scheduling, retry policy, approvals, Git mutation, branch/worktree policy, prompt templating, provider options, artifacts, logs, costs, notifications, secrets, or cancellation of live execution.
