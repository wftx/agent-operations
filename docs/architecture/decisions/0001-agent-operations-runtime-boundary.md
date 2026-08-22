# ADR 0001: Agent Operations Runtime Boundary

- Status: Accepted
- Date: 2026-08-21

## Context

CortextOS is the persistent agent runtime and execution substrate. It discovers
configured agents, supervises provider processes, maintains sessions, and owns
runtime-specific communication and lifecycle behavior.

Agent Operations will add product concerns such as orchestration, repositories,
durable jobs and attempts, integrations, approvals, audit, and remote APIs. Those
concerns need to evolve without depending on high-churn CortextOS implementation
details or making upstream synchronization unnecessarily difficult.

## Decision

Agent Operations will interact with CortextOS through the narrow read-only
`AgentRuntimeAdapter` contract. Agent Operations contracts and future domain code
must not depend directly on:

- `AgentManager`
- `AgentProcess`
- `FastChecker`
- PTY implementations
- hooks
- daemon implementation details
- CortextOS-specific filesystem layout

The `cortextos-adapter` module owns IPC, filesystem observation, runtime-name and
state translation, and incomplete-observability handling. The AO contract exposes
only normalized identity, provider, state, health, and conservative capability
metadata.

This first boundary is read-only. It contains no lifecycle, dispatch, scheduling,
job, repository, approval, or other mutation methods.

## Consequences

Benefits:

- Lower upstream merge-conflict risk
- AO-domain tests can use a deterministic fake adapter
- CortextOS integration can change without changing AO domain logic
- Other execution substrates can implement the same contract later
- Product and runtime ownership remain explicit

Costs:

- An adapter translation layer must be maintained
- Some CortextOS information is not currently observable through structured IPC
- Filesystem fallback is necessary for organization, provider, display name,
  enablement, and last-known heartbeat data
- Future mutation APIs must be added deliberately rather than leaking through

## Rule

When Agent Operations needs another CortextOS capability:

1. Extend the Agent Operations contract deliberately.
2. Implement the capability in the CortextOS adapter.
3. Add contract and adapter tests.
4. Keep CortextOS core imports and storage details out of AO domain code.
