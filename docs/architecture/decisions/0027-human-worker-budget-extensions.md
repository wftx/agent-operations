# ADR 0027: Human Worker Budget Extensions

- Status: Accepted
- Date: 2026-08-31

## Context

The automatic orchestration budget permits two Worker executions. When the
second Reviewer returns `REVISION_REQUIRED`, Agent Operations correctly stops
in Needs Me, but the Operator surface previously exposed only cancellation.
The human could not authorize a bounded continuation without replacing the Job
or weakening the original budget.

## Decision

Add a durable Worker budget extension that grants exactly one additional Worker
execution for one unresolved escalation. The extension is valid only when:

- the effective Worker execution budget is exhausted;
- the escalation points to a completed Worker Attempt and its persisted
  `REVISION_REQUIRED` Review;
- no Attempt is active and no Dispatch is uncertain;
- the Operator Run is in Needs Me.

Authorization, optional Human Guidance, escalation resolution, and Operator Run
resumption are one atomic state transition. The escalation has at most one
extension. A duplicate request therefore cannot grant another execution or
create another continuation.

The automatic maximum remains two. Read models separately report automatic
capacity, human extensions, total authorized capacity, and capacity consumed.
Orchestration always creates a fresh Worker Attempt, Plan, and Dispatch. It
never reuses or resends historical execution state.

## Operator behavior

Needs Me presents Reviewer feedback, optional guidance, and **Authorize 1 More
Attempt + Continue** only when the durable state permits the transition. Page
load and refresh are read only. If the new Reviewer again requests revision
after the additional execution is consumed, the Job returns to Needs Me and
requires another explicit human authorization.

Other Needs Me states remain distinct. Human approval, ordinary guidance,
recoverable execution observation, and terminal conditions expose only their
truthful actions. Cancel Job remains separate when cancellation is safe.

## Consequences

Historical Attempts, Reviews, Plans, Dispatches, and the exhausted automatic
budget remain visible. The extension is auditable and bounded, but the human may
grant another single extension after a later revision. Agent Operations still
has no unlimited retry mode and does not continue merely because a page is
opened.
