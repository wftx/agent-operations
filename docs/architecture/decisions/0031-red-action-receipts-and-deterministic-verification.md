# ADR 0031: Red Action Receipts and Deterministic Verification

## Status

Accepted

## Decision

Every executed bounded repository restore records one immutable receipt. The
receipt binds the human approval, Project, logical repository, checkout,
approved paths, execution time, branch and HEAD before and after, file hashes,
final Git status, and the absence or presence of commit, push, and deploy
effects.

Exact repository verification is an application capability. It reads through
the existing bounded Git adapter and may complete a ready Job without a Worker
Attempt when the Job is fully represented by exact branch, HEAD, status, and
hash assertions tied to a passed Red action receipt. It creates no Plan,
Dispatch, or provider submission.

Historical completed restore actions are not rewritten. A missing receipt may
be reconciled into a new immutable record only when the current repository
identity, branch, HEAD, status, and hashes still match the durable completed
action result.

## Consequences

Provider availability cannot invalidate deterministic repository evidence.
Semantic questions still require Worker and Reviewer execution. Receipt and
verification records remain independent of physical machine paths except for
the existing installation scoped checkout binding.
