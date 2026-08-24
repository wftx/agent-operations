# ADR 0009: Agent Operations Rehearsal Runtime

- Status: Accepted
- Date: 2026-08-22

## Context

Phase 11 proved that Agent Operations safely blocks live execution when no CortextOS runtime exists. A reproducible dedicated runtime is required before the first live AO Dispatch, without reusing a production or personal agent or granting repository context unnecessarily.

## Decision

Use exactly one dedicated CortextOS agent with the stable identity `agent-operations/rehearsal`. Its provider is `codex-app-server`, normalized to `codex` at the AO runtime boundary, because the existing Codex CLI login was authenticated on the development machine. Provider credentials remain in the provider's secure local login state.

The agent uses an existing absolute host-local working directory under the CortextOS instance state, outside the Agent Operations Git checkout. The tracked fixture contains a minimal rehearsal identity and policy; the same `AGENTS.md` is copied into the external working root so Codex loads it. The agent has no cron, autonomous goal, repository role, production responsibility, or personal/business context.

Telegram, Slack, Buzz/Nostr, GitHub, Google, MCP, knowledge-base embeddings, PM2, tunnels, and public endpoints are not configured. Empty ignored CortextOS environment placeholders are retained only because the supported scaffold creates them.

Use the supported CLI initialization and add-agent flow. For development, run the daemon through `cortextos start --foreground` (or the repository-local equivalent) rather than production process management. The normal daemon lifecycle owns the Codex app-server process; AO does not start or configure it.

A rehearsal runtime is admissible only when it is configured, explicitly enabled, a known provider, and running; has a recent affirmative idle signal; has empty inbox and inflight queues; and either has never received an injected message or has become idle at or after its most recent injection. Missing idle evidence, stale idle evidence, newer injection evidence, queued work, or non-running health fails closed.

No existing agent is reused because its workload, integrations, repository access, and occupancy cannot be assumed safe for a controlled integration rehearsal.

## Safety Rule

> Runtime bring-up and Agent Operations dispatch are separate operational steps.

Normal provider startup may create a provider session and one inherent bootstrap turn. That provider contact is not an AO Dispatch and does not authorize an AO instruction.

## Consequences

- AO can discover one predictable, repository-free runtime through its existing boundary.
- A brand-new idle agent is not permanently blocked solely because no message has ever been injected.
- Occupancy protection remains affirmative and fail-closed.
- Reproduction requires a host-local working directory and an existing Codex login; no credential values enter Git.
- Foreground processes intentionally stop when the development terminal closes.

## Non-Decisions

Phase 12 does not establish production agent taxonomy, multi-agent orchestration, persistent PM2 deployment, repository-bound runtime policy, exact provider correlation, workers or queues, retries, autonomous scheduling, production credentials, or public infrastructure.
