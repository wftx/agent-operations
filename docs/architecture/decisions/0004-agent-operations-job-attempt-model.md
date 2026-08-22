# ADR 0004: Agent Operations Job and Attempt Model

- Status: Accepted
- Date: 2026-08-21

## Context

Agent Operations can observe runtimes and repositories and persist its own project, logical repository, checkout, association, and observation state. It needs a durable representation of requested work before any execution boundary can be designed.

Conflating a desired outcome with one effort to achieve it would erase retry history and make a runtime failure look like permanent work failure. Phase 7 must model work while remaining unable to dispatch or perform it.

## Decision

Agent Operations separates:

```text
Job = one durable desired outcome
Attempt = one explicit effort associated with that job
```

Job IDs use `job:<uuid>` and attempt IDs use `attempt:<uuid>`. Titles and repository paths are never identities. Every job belongs to one durable AO project. A job may target one logical repository ID and may name a preferred runtime agent ID. It never stores a checkout path or a CortextOS implementation object.

An attempt belongs to exactly one job, receives a deterministic per-job sequence, and records the actual runtime agent selected for that effort. The actual runtime may differ from the job preference without rewriting earlier attempts.

## Lifecycles

Persisted job states are:

```text
draft -> ready -> completed
   \       \
    -> cancelled
```

`in_progress` is a read-model state derived when a job has an active attempt. It is not duplicated on the job. There is no job-level `failed` state in Phase 7. A failed attempt leaves the job `ready`; explicit cancellation ends abandoned work, and explicit completion requires at least one completed attempt.

Persisted attempt states are:

```text
created -> running -> completed
   |          |----> failed
   |          \----> cancelled
   \---------------> cancelled
```

Completed, failed, and cancelled attempts are terminal. At most one `created` or `running` attempt may exist per job. A later attempt is a new record with the next sequence; execution systems must never rewrite a historical attempt to represent a retry.

## Lifecycle ownership and concurrency

AO core exposes explicit lifecycle operations and validates transitions, project/repository/runtime associations, cancellation, and completion policy. Persistence enforces structural integrity, unique IDs, per-job sequence uniqueness, one active attempt, and optimistic revision checks. SQLite assigns attempt sequences inside a transaction. The in-memory adapter mirrors these observable rules.

Repository targeting uses the durable logical repository. A later execution layer will resolve that identity to an installation-local checkout binding. Job preferred runtime and attempt actual runtime use AO stable agent IDs. Because Phase 6 has no standalone durable runtime-agent entity, association validation uses the project's configured runtime IDs.

## Consequences

- Failed attempts preserve history without terminally failing a job.
- A successful later attempt can support explicit job completion.
- Active progress has one source of truth: attempt state.
- Revisions reject stale transitions without introducing leases or distributed coordination.
- Removing a project association later does not rewrite historical job or attempt assignment.

## Non-decisions

Phase 7 does not define queue semantics, worker claiming, leases, scheduling, retries, backoff, dispatch, prompt construction, Git worktrees, branches, approval gates, artifact storage, logs, token usage, costs, notifications, or remote execution.
