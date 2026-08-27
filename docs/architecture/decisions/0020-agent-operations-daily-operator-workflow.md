# ADR 0020: Agent Operations Daily Operator Workflow

- Status: Accepted
- Date: 2026-08-27

## Context

Agent Operations can autonomously run repository-bound read-only Worker →
Reviewer Jobs, but the Phase 21 surface still represented progress with an
in-memory session. The operator could leave the HTTP request, yet a web-process
restart could lose the continuation trigger, Needs Me supplied no domain
action, and completion or escalation required manual checking.

## Decision

Introduce a small local daily-use workflow:

- a durable Operator Run marks only Jobs explicitly submitted through the
  Operator and records pending, running, completed, Needs Me, failed, or
  cancelled status;
- one in-process runner resumes pending or running Operator Runs serially;
- orchestration reconstructs its next action from existing Attempt, Plan,
  Dispatch, exact Observation, outcome, Review, and Escalation records;
- bounded Human Guidance resolves an eligible escalation while preserving it,
  then enters only a fresh Worker Attempt and immutable Plan;
- Running, Needs Me, Done, and Job detail present truthful product stages and
  keep provider identifiers secondary;
- a provider-neutral `OperatorNotifier` emits only `job_completed` and
  `needs_human` intents;
- a Telegram adapter performs notification-only delivery through dedicated
  Operator configuration;
- a durable delivery claim supplies one attempt per Job completion or
  Escalation and prevents refresh/restart spam.

## Recovery rule

Recovery continues only from durable boundaries:

- an Attempt without a Plan may receive its first Plan;
- a Plan without a Dispatch may receive its one Dispatch;
- an accepted Dispatch is observed and never resent;
- a submitting or uncertain Dispatch becomes Needs Me;
- captured exact results reconcile outcome and Attempt state locally;
- a completed Worker may receive its first Reviewer;
- persisted `REVISION_REQUIRED` may create one fresh Worker within budget;
- persisted Reviewer `PASS` may reconcile Job completion;
- unresolved Escalations stop continuation.

This is deliberately not distributed claiming. One machine and one active
Operator Run are the supported boundary.

## Product rule

The operator supervises Agent Operations. The operator does not supervise
individual agents or shuttle messages between them.

Normal vocabulary is Job, Working, Needs Me, and Done. Attempt, Plan, Dispatch,
and exact turn identifiers remain available only under secondary runtime
details.

## State rule

Notifications never own orchestration state. AO durable state remains
authoritative if Telegram is absent, fails, or is disabled. A delivery record is
claimed before transport invocation; restart never retries that event
implicitly, avoiding duplicate notifications at the cost of a possible missed
message if the process terminates between claim and delivery.

## Boundary

```text
AO Web / CLI
      ↓
AO Application + local runner
      ↓
AO Core / Contracts
      ↓
State store and runtime adapters

AO Application → OperatorNotifier
                       ↑
              Telegram adapter
```

Telegram types and credentials do not enter AO core. Telegram never reads or
mutates Job state.

## Non-decisions

This decision does not add Telegram interactive approvals, repository writes,
production deployment, public authentication, multi-machine operation,
scheduling, priorities, worker leases, a general queue, concurrent Jobs,
automatic CortextOS startup, or retry of uncertain Dispatches.
