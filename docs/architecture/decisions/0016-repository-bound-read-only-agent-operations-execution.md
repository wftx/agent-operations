# ADR 0016: Repository-Bound Read-Only Agent Operations Execution

- Status: Accepted
- Date: 2026-08-26

## Context

Agent Operations has proven restricted, exactly correlated, repository-free execution. Repository work adds a separate question: whether the exact provider turn ran in the installation-local checkout belonging to the logical repository selected by the immutable Execution Plan. A prompt-level `cd`, an agent configuration default, or the app-server process directory does not prove that relationship.

The installed Codex app-server protocol accepts `cwd` on `thread/start`, `thread/resume`, and `turn/start`. A policy-isolated thread can therefore use a checkout different from the reusable agent's persistent thread without starting another provider process.

## Decision

Repository-bound execution resolves this chain:

```text
logical repository identity
→ installation-local checkout binding
→ canonical Git repository root
→ provider-neutral RuntimeExecutionContext
→ new policy-isolated Codex thread cwd
→ exact correlated turn record
```

Immediately before manual Dispatch, preflight reloads the Plan's checkout binding and installation, observes the checkout through the read-only Git adapter, compares the canonical Git root and normalized remote identity with the durable Plan identities, and returns an execution context only when all checks pass. Missing paths, non-Git replacements, wrong installations, wrong remotes, moved or stale bindings, ambiguous checkout selection, unavailable inspection, or a runtime lacking per-execution-CWD capability block Dispatch. Dirty state and detached HEAD remain warnings.

Phase 18 repository Plans require `filesystem=read-only`, `network=deny`, and `environment=empty`. The CortextOS adapter carries the exact canonical directory through correlation-safe IPC. Codex creates a new restricted thread with that `cwd`; it does not resume the repository-free persistent thread. The turn repeats the same `cwd` and restricted policy. Read-only mode has no writable roots and never uses `danger-full-access`.

The bounded native turn record stores thread ID, turn ID, working directory, effective policy, status, and timestamps. Exact AO observations persist the same working-directory and policy evidence. Transcripts are not added to AO state. Exact provider completion remains technical evidence only and does not decide semantic Job success.

Agent-level `workingDirectory` is not authoritative for repository execution because one reusable Codex app-server may host multiple isolated threads with different directories. Thread reuse is permitted only when CWD and effective policy are compatible; Phase 18 takes the simpler fail-safe path of creating a new restricted thread for each correlated policy-aware execution.

## Critical Rule

> Repository-bound execution must never rely on prompt-level `cd` instructions or assumed runtime working directories.

## Consequences and Residual Risk

The selected checkout is proven at preflight and again represented in the provider request and exact turn evidence. A filesystem time-of-check/time-of-use race cannot be eliminated completely, but canonical-path and live Git-identity revalidation narrow the window and fail closed on detected drift.

Codex read-only mode still permits reads outside the selected repository. Phase 18 records that residual capability and does not redesign the provider sandbox. Repository tasks must therefore contain no secrets and remain narrowly scoped.

## Non-Decisions

Phase 18 does not define repository writes, worktrees, branch management, commits, pull requests, write approvals, autonomous workers, retry policies, scheduling, or a general session-routing/worker-pool system.
