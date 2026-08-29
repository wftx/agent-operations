# ADR 0024: Isolated Write-Capable Repository Execution

- Status: Accepted
- Date: 2026-08-28

## Context

The repository bound read only daily MVP is operational. Agent Operations now
needs a safe way to prepare engineering changes without allowing an AI Worker
to modify the operator's primary checkout or publish its own work.

## Decision

Use one durable `RepositoryWorkspace` for each
`repository-write-isolated` Job. AO records the logical repository, source
checkout binding, base revision and branch, deterministic Job branch, canonical
worktree path, lifecycle state, and bounded evidence. The worktree lives under
the machine local AO state root, outside the tracked repository.

```text
Job
→ isolated Git branch and worktree
→ Worker writes only in that worktree
→ allowlisted tests and bounded evidence
→ independent read only Reviewer
→ Ready for Approval
```

The Worker policy is `workspace-write / deny / empty`. Dynamic capabilities are
limited to repository list, read, search, exact patch, allowlisted test runs,
and read only Git status, diff, diff stat, and HEAD inspection. There is no
generic shell or generic Git command surface. Patch targets must be existing,
regular, non-symlink files beneath the exact canonical worktree root.

The test runner selects only predefined command identifiers. Its child process
receives a minimal environment, bounded output, a timeout, denied network, and
write access limited to the Job worktree. It fails closed when the required
local operating system sandbox is unavailable.

AO independently captures changed files, bounded diff text and statistics, and
test results. The Reviewer receives the original Job, acceptance criteria,
Worker result, workspace identity, and captured evidence. The Reviewer runs
with read only filesystem authority against that same worktree and cannot patch
or run tests.

`REVISION_REQUIRED` reuses the durable worktree but creates a fresh Worker
Attempt, Plan, Dispatch, and exact provider turn. `ESCALATE` stops in Needs Me.
Reviewer `PASS` transitions the workspace to Ready for Approval and creates a
human judgment escalation. It does not complete, commit, merge, or push the
Job.

## Safety

The primary checkout is never a write target. Worktree creation records durable
intent before Git mutation and validates repository identity, registration,
branch, base revision, and canonical path on recovery. An existing matching
worktree is recovered without recreation. A mismatch fails closed before
provider Dispatch.

Only one active write workspace is permitted. Cleanup is explicit. Git removal
occurs only after exact AO ownership is revalidated, does not use force, leaves
the Job branch intact, and preserves durable evidence. Dirty, mismatched, or
unrelated worktrees are retained and marked for operator attention.

The critical rule is:

> No AI Worker may directly modify the operator's primary checkout or merge its
> own work.

## Non decisions

- automatic merge or local merge approval
- Worker commits
- pull request creation
- remote push
- concurrent write Jobs
- deployment
- production branch protection integration
