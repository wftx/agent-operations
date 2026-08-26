# ADR 0013: CortextOS Development Runtime Ownership

- Status: Accepted
- Date: 2026-08-25

## Context

Phase 15 runtime bring-up exposed a dual-daemon ownership gap. A supported
non-foreground start intentionally detached a daemon and its Codex child. A
subsequent health probe was denied access to the daemon's Unix socket by the
development sandbox and reported the daemon as stopped even though its PID was
alive. A second foreground daemon then unlinked the first daemon's socket,
replaced the shared PID file, and attempted to resume the same persisted Codex
thread. Codex's provider-owned thread-writer lock correctly rejected the second
writer, but CortextOS classified the rejection as a normal process exit and
scheduled exponential crash recovery.

PID files and socket existence were advisory metadata, not an exclusive daemon
claim. IPC startup also treated `EADDRINUSE` as stale-state recovery and could
unlink a socket without first proving its owner dead.

## Decision

Each CortextOS instance has one atomic, host-local daemon ownership claim under
`~/.cortextos/<instance>/daemon.owner`. The daemon must acquire this claim before
writing `daemon.pid`, binding IPC, discovering agents, starting crons, or
launching a provider. The claim records the instance, owner PID, unique token,
and start time. A live owner or an ownership claim still being initialized
causes a competing daemon to exit before any agent/provider side effect.

Dead ownership is reclaimed conservatively. A serialized reclaim marker avoids
two stale-state contenders deleting each other's replacement claim. A live
legacy `daemon.pid` also blocks acquisition so an older daemon cannot be
silently displaced during an upgrade. Release removes only metadata whose PID
and unique token still match the releasing daemon.

IPC responses include the owning instance identity. Readiness requires a live
matching owner/PID, a reachable socket whose response identifies the requested
instance, and the expected agent lifecycle. IPC `EADDRINUSE` fails closed; it
does not unlink and retry against a possible live owner.

Codex remains authoritative for persisted thread-writer ownership. A Codex
`thread-store conflict` / `already has an active writer` response is classified
as an external ownership conflict. CortextOS cleans up its failed child, marks
the agent halted, and suppresses generic crash recovery. Ordinary unexpected
provider exits retain the existing bounded exponential recovery behavior.

For Agent Operations development, the canonical lifecycle is:

```bash
node dist/cli.js start --foreground --instance default
```

The operator waits for bounded, identity-checked health before any read-only AO
inventory or preview. Foreground and detached background starts must not be
mixed. Non-foreground detach remains supported for general local CortextOS use
but is not the AO development default and is not a substitute for PM2 or another
supervisor.

## Ownership Invariant

> At most one live daemon may own a CortextOS instance, and no agent, cron, or
> provider startup may occur until that ownership is exclusive.

Provider recovery is permitted only beneath the daemon that holds that instance
claim. A provider-owned persisted thread is a halt condition, not a recoverable
process crash.

## Consequences

- Concurrent or near-concurrent daemon starts produce one winner and a loser
  that exits before provider startup.
- A second daemon cannot unlink the winner's health socket or replace its PID.
- Stale PID/socket/claim metadata can recover without deleting provider session
  history, AO durable history, or agent configuration.
- Sandbox-denied IPC remains operationally distinguishable from process death by
  checking the live owner/PID and performing health with appropriate local
  socket access.
- Exact-correlation and Phase 15 capability-policy architecture are unchanged.

## Non-Decisions

This decision does not introduce a distributed lease, PM2, production service
management, provider-session migration, AO dispatch retries, cron changes,
external integrations, or any new execution capability.
