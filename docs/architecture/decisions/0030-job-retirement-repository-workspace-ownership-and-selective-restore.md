# ADR 0030: Job Retirement, Repository Workspace Ownership, and Selective Restore

## Status

Accepted.

## Context

Historical proof Jobs remained visible as live Needs Me or Ready for Approval work after their operational purpose ended. One such Job could also retain the single global isolated workspace claim and block unrelated repositories. Separately, discarding exact uncommitted tracked files in a human checkout did not fit the isolated write Job model because it is destructive and acts on the primary checkout.

## Decision

Agent Operations records retirement as durable disposition metadata layered over the original Job. Retirement preserves the Job, Attempts, Plans, Dispatches, exact turns, observations, reviews, escalations, guidance, Inputs, browser evidence, and workspace evidence. Unresolved escalations receive a retirement resolution, and retired Jobs move to the historical Archived view. No Job row or evidence row is deleted.

An AO owned workspace must be clean before retirement cleanup. Cleanup proves exact workspace ownership, uses normal nonforce Git worktree removal, preserves the Job branch, and marks the workspace cleaned. A dirty workspace blocks retirement because it may contain unique evidence.

Active isolated workspace ownership is keyed by logical repository identity. The default is one active write workspace per logical repository. Unrelated repositories may each own a workspace. A separate machine ceiling of four active workspaces prevents unbounded local resource use. Existing workspace records already contain repository identity, so restart recovery needs no path based backfill.

Selective primary checkout restore is a separate Red action named `repository.restore_tracked_paths`. AO captures the Project, logical repository, checkout binding, canonical root, branch, exact HEAD, exact tracked paths, staged and unstaged state, current and HEAD SHA 256 hashes, named untracked files to preserve, and a hash of the complete precondition set. Approval is bound to one durable restore action. If any precondition changes, execution fails closed and fresh approval is required.

The adapter permits only `git restore` for the exact approved paths and exact approved revision. It does not expose arbitrary Git, raw `.git` access, wildcards, path traversal, add, commit, checkout, reset, clean, stash, merge, rebase, or push. After execution, AO proves the approved paths match HEAD, branch and HEAD did not change, unrelated status is unchanged, and named untracked files remain byte identical.

Telegram text alone is not an approval identity. The current operator approval surface binds approval to the exact durable action ID. Any future Telegram approval flow must require an unambiguous action identity when more than one Red action is pending.

## Consequences

Historical evidence remains queryable without occupying active queues or workspace ownership. Independent repositories no longer block one another. Destructive primary checkout cleanup remains human gated, exact, state bound, and independently verifiable.
