# ADR 0021: Late Execution Reconciliation After Observation Timeout

- Status: Accepted
- Date: 2026-08-28

## Context

An accepted provider turn can outlive Agent Operations' bounded observation
window. The resulting `observation_timeout` means only that AO stopped waiting;
it is not evidence that the provider turn failed. Resending the immutable Plan
would risk duplicate work, while leaving a later exact completion unused would
force the operator to copy results between the Worker and Reviewer manually.

## Decision

Add one explicit Needs Me action, **Check Execution Again**, for a narrowly
eligible observation timeout. The action:

- requires the unresolved timeout to identify a running Worker Attempt, its
  immutable Plan, and an accepted Dispatch with an exact external reference;
- invokes only the provider-neutral execution observation adapter for that
  existing reference and never invokes the execution Dispatch adapter;
- deduplicates observations through the existing append-only evidence key;
- trusts terminal evidence only when exact Dispatch correlation, external turn
  reference, repository checkout/root, `read-only / deny / empty` policy, and
  bounded repository-reader capability evidence all match the durable Plan and
  Dispatch;
- imports exact late completion into the existing Worker Attempt, durably
  resolves the historical timeout with an explanation, and resumes the same
  Operator Run at the Reviewer boundary;
- imports exact late failure into the existing Attempt, resolves the timeout
  ambiguity, and creates a fresh Needs Me runtime-failure escalation;
- leaves the timeout active when the turn is still running, missing, unrelated,
  malformed, or otherwise untrustworthy.

The escalation resolution and Operator Run resumption are one SQLite
transaction. Repeating the reconciliation is idempotent: it neither appends
duplicate evidence nor creates another outcome or provider submission.

## Continuation rule

After late Worker completion, the ordinary durable orchestrator reconstructs
the next step and may create exactly the first Reviewer Attempt, Plan, and
Dispatch. Reviewer `PASS` retains the existing narrow read-only automatic
completion rule. Any malformed, uncertain, failed, or non-PASS Reviewer result
returns to Needs Me; Worker budget is never replenished by reconciliation.

## Product rule

The action says that it checks the existing accepted execution and does not
resend the task. The resolved escalation remains in Job history with its
resolution explanation. Provider identifiers stay in secondary runtime detail.

## Non-decisions

This decision does not add background polling, automatic reconciliation on
restart, Dispatch retry, a new Worker instruction, a new Job, broader runtime
authority, repository writes, shell or Git access, network access, or Telegram
interaction. Automatic restart reconciliation remains deferred so application
startup cannot silently continue provider work.
