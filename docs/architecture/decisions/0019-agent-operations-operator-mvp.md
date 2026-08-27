# ADR 0019: Agent Operations Operator MVP

- Status: Accepted
- Date: 2026-08-27

## Context

The first autonomous Worker → Reviewer Job completed without human message
shuttling. Agent Operations can enforce a repository-bound read-only policy,
create fresh immutable execution records, correlate exact provider turns,
independently review a Worker result, revise within a fixed budget, escalate,
and automatically complete an explicitly eligible Job after `PASS`.

The remaining usability problem is operational. Creating and observing that
workflow still requires development scripts, internal IDs, and knowledge of
Plans and Dispatches. Those are useful implementation records, not an
appropriate daily operator interface.

## Decision

Introduce a small local Operator MVP with:

- one repository task-intake form;
- an Agent Operations application/service boundary shared by web and CLI;
- Jobs, Running, Needs Me, and Done views;
- a Job detail story that presents Worker results, Reviewer decisions and
  feedback, revision attempts, and durable Escalations;
- manual, read-only page refreshes;
- one explicit Run command as the only path into orchestration.

Normal task intake accepts a configured Project and repository, a free-text
task, and free-text acceptance criteria. It always selects the narrow MVP
policy: filesystem `read-only`, network `deny`, environment `empty`, bounded
repository reading enabled, at most two Worker Attempts, one Reviewer pass per
Worker Attempt, and automatic read-only completion only after Reviewer `PASS`.
The Operator does not offer a write mode or policy editor.

The web request starts an application-level in-memory run session and returns
without waiting for a tens-of-seconds provider workflow. This is deliberately
not a queue. Only one orchestration may be active through a service instance.
The durable AO Job, Attempts, Plans, Dispatches, observations, reviews, and
Escalations remain authoritative; the session only describes local progress.
Unexpected orchestration failures are converted into a durable Needs Me
Escalation when possible.

## Product rule

The operator interacts with Jobs and decisions. Attempt, Plan, Dispatch, and
exact provider-turn identifiers remain available only in secondary runtime
details. Visible results are bounded final Worker text, Reviewer summary and
feedback, escalation context, and lifecycle status. Hidden reasoning and full
provider transcripts are neither requested nor presented.

## Boundary

The dependency direction is:

```text
AO Web / CLI
      ↓
AO Application Service
      ↓
AO Core / Contracts
      ↓
State Store and Runtime Adapters
```

Web presentation code imports only the application boundary. The local server
composition root may instantiate SQLite, Git, CortextOS execution, observation,
and inventory adapters. Browser code never opens SQLite, daemon sockets, or a
shell. GET, status refresh, and Preview are read-only and cannot Dispatch;
`runOperatorJob` is the sole execution entry.

## Deployment

The MVP binds a separate Agent Operations web server to `127.0.0.1`. It is
local development mission control, while the existing CortextOS dashboard
remains runtime diagnostics and the engine room. The web UI is not the runtime.

## Non-decisions

This decision does not add production authentication, Netlify deployment, a
public API, Telegram or other notifications, repository writes, worktrees, Git
mutation, queues, scheduling, automatic job polling, multi-machine operation,
multi-tenancy, billing, or SaaS onboarding.
