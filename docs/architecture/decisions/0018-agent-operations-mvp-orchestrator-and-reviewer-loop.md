# ADR 0018: Agent Operations MVP Orchestrator and Reviewer Loop

- Status: Accepted
- Date: 2026-08-27

## Context

Agent Operations can now dispatch exactly correlated, policy-isolated,
repository-bound read-only Codex work through a bounded repository reader. The
remaining operating burden is manual: a human moves each Worker result to a
Reviewer, decides whether feedback warrants another attempt, and records the
eventual outcome.

The first useful autonomous slice must remove that copy/paste loop without
turning an LLM prompt into the workflow authority or expanding repository,
network, shell, Git, or scheduling permissions.

## Decision

Agent Operations owns an explicitly invoked, synchronous, one-Job orchestration
service with two durable execution roles:

- the Worker performs the repository-read-only Job;
- the Reviewer independently evaluates the bounded Worker result against the
  original Job and acceptance criteria;
- the AO orchestrator owns lifecycle, immutable Plans, one-shot Dispatches,
  exact evidence, attempt and review limits, review persistence, revision,
  escalation, and completion eligibility;
- the human receives durable Escalations only when AO reaches a boundary it
  cannot safely resolve.

Reviewer decisions use a small validated contract: `PASS`,
`REVISION_REQUIRED`, or `ESCALATE`. A revision always creates a fresh Worker
Attempt, Execution Plan, Dispatch, and provider turn. An immutable Plan is never
resent. Phase 20 permits at most two Worker Attempts and one Reviewer execution
per Worker Attempt. Optional Reviewer feedback is trimmed and normalized:
blank feedback is absent for `PASS` or `ESCALATE`, while
`REVISION_REQUIRED` requires concrete non-empty corrective guidance.

The existing dedicated Codex app-server is reused, but Worker and Reviewer have
distinct AO role identities, Attempts, Plans, Dispatches, and fresh
policy-isolated turns. This is smaller and safer than introducing new agents or
credentials while keeping the histories unambiguous.

Exact correlated turn records may persist at most 16,384 characters of visible
final assistant text. They do not persist hidden reasoning or full transcripts.
Both roles receive only `repository.list`, `repository.read`, and
`repository.search` under `read-only / deny / empty`; skill/package lookup,
plugins, apps, MCP, shell, Git, network, hooks, memory, and multi-agent tools are
disabled.

A Worker Attempt completes as soon as its exact provider turn completes with a
usable bounded result. That lifecycle state records execution completion, not
semantic acceptance. A later `REVISION_REQUIRED` review leaves the prior Worker
Attempt completed and creates a fresh Worker Attempt. Worker failure is reserved
for execution failure, inability to execute, or a missing or unusable result.

For an explicitly opted-in repository-read-only Job, AO may complete the Job
only after accepted Worker and Reviewer Dispatches, exact completion and policy
evidence for both, bounded results, and Reviewer `PASS`. Every other outcome
stops or escalates conservatively.

## Critical rules

An LLM does not own durable orchestration state. Agent Operations does.

Automatic revision always creates a new Attempt and never resends an immutable
Plan or Dispatch.

## Consequences

Ordinary bounded read-only work can run Worker → Reviewer → revision or
completion without manual result shuttling. The initial service remains
explicitly invoked and synchronously observes each exact execution within a
bounded duration. It has no queue, scheduler, background poller, or automatic
Dispatch retry.

## Initial live result and hardening

The first live MVP invocation autonomously executed one Worker and one Reviewer
with exact correlation and no shell, Git, write, or network access. Both results
were substantively correct, but the Reviewer emitted a `PASS` object containing
`"feedback": ""`. The original parser rejected that optional empty field and AO
truthfully created a `reviewer_uncertain` Escalation after two submissions.

Phase 20B normalizes optional blank feedback to absence and aligns the Reviewer
prompt with that contract. It also records the Worker as completed immediately
after exact bounded result capture, so later Reviewer uncertainty cannot leave a
provider turn falsely represented as still running. The historical failed
Reviewer and Escalation remain unchanged.

The second live MVP invocation completed autonomously after the Phase 20B
hardening. AO created one Worker Attempt and one Reviewer Attempt, each with a
fresh immutable Plan, accepted Dispatch, policy-isolated thread, and exact
turn-completion evidence. The Worker produced the correct authoritative
`RuntimeExecutionPolicy` source and dimensions. The Reviewer independently
returned a valid `PASS`; AO persisted the review and runtime-evidence outcomes,
completed both Attempts, and automatically completed the explicitly opted-in
read-only Job. It used two submissions, no Dispatch retry or revision, six
bounded repository-reader operations, and no shell, Git, repository write,
network, skill, plugin, app, or MCP operation. No human copied results or
constructed a retry prompt.

## Non-decisions

This decision does not add repository writes, worktrees, branches, commits,
pull requests, shell access, Git mutation, network access, provider parity,
queue polling, scheduling, multi-machine coordination, SaaS concerns,
production role taxonomy, Telegram notifications, or dashboard work.
