# ADR 0028: Durable Preview and Browser Evidence

## Status

Accepted

## Context

Visual work needs evidence from the exact source state being reviewed. A detected package script is not sufficient authority to execute a server. A browser screenshot without a durable Project, Job, revision, origin, route, viewport, and integrity record cannot support an independent review.

The current installation is single node, but Project, Input, and evidence identity must remain independent of a browser client path or a future execution node path.

## Decision

AO stores a durable Preview Profile separately from discovered command candidates. An explicit start or an evidence requirement authorizes bounded validation of that profile. Preview commands are tokenized commands from a small package manager allowlist and never pass through a shell.

Repository read only Jobs preview a clean detached AO Git worktree at one verified commit. Isolated write Jobs preview their existing AO owned Job worktree. A source state hash binds the preview to either the clean commit or the exact bounded worktree evidence.

Preview Sessions store installation placement, process state, loopback origin, exact route, PID, bounded logs, source revision, and source state hash. A GET request never starts a session.

The browser adapter can reach only the exact Preview Session origin. Browser Evidence records page title, final URL, visible text, console failures, failed resources, bounded audit operations, viewport, screenshot metadata, source state, and an evidence hash. Screenshot bytes are stored through the existing Input storage port and associated with the Job by Input ID. Raw storage paths are not part of provider facing metadata.

Jobs may declare one structured `browser-render` evidence requirement. AO satisfies it before Worker execution. The Worker and Reviewer receive the same bounded evidence record and screenshot Input. A missing or stale evidence boundary stops before provider execution.

## Consequences

The local implementation can later place preview processes, screenshot bytes, or browser capture on another node without changing Preview Profile, Input, or Browser Evidence identity. Node selection, remote preview proxying, distributed blob replication, and hosted control plane synchronization remain outside this phase.
