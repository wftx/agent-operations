# ADR 0002: Agent Operations Project and Repository Ownership

- Status: Accepted
- Date: 2026-08-21

## Context

CortextOS owns persistent agent execution. Agent Operations also needs to know
where work can happen: which projects exist, which source repositories belong to
them, where local checkouts are located, and which runtime agents are associated
with those projects.

Project and repository identity must survive a checkout moving from a development
Mac to another machine whenever the repository has a portable remote identity.
Git implementation details must not leak into Agent Operations domain logic.

## Decision

Agent Operations owns:

- Project identity and explicit project configuration
- Repository identity and project-to-repository associations
- Project-to-runtime associations using AO runtime agent IDs
- Read-only repository inventory contracts and read models

Git command invocation, remote parsing, canonical paths, HEAD, branch, and dirty
state observation live behind `RepositoryInventoryAdapter` in `git-adapter`.
Project inventory logic depends only on `RepositoryInventoryAdapter` and the
Phase 4 `AgentRuntimeAdapter` contract. It does not depend on CortextOS or Git
implementations.

Remote-backed repository IDs use normalized host/path identity, independent of
HTTPS versus SSH syntax and a trailing `.git`. Repositories without a usable
remote receive an explicitly local, path-derived hashed identity. Local identity
is deterministic on one machine but may change when the checkout moves.

## Consequences

- Remote-backed repositories can move between machines without changing logical identity.
- Projects may contain multiple repositories or no runtime agents.
- Repositories may exist without a CortextOS agent.
- Runtime agents can be associated with projects without making CortextOS own projects.
- GitHub-specific metadata can later live in a separate integration.
- Future repository mutations must be deliberately added to a separate boundary.

## Explicit non-decision

Phase 5 does not decide:

- Repository cloning or checkout policy
- Branch naming or protection policy
- Worktree strategy
- Repository locking
- Commit, push, pull, fetch, or merge behavior
- GitHub integration
- Job execution or task queues
- Database persistence
