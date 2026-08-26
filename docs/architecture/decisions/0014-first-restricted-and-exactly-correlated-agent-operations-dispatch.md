# ADR 0014: First Restricted and Exactly Correlated Agent Operations Dispatch

- Status: Accepted
- Date: 2026-08-26

## Context

The first live Agent Operations Dispatch succeeded with a harmless repository-free instruction, but its persistent Codex session had unrestricted provider capability and its completion evidence was only agent-level. Phases 14 and 15 added exact Codex thread/turn correlation and an explicit runtime capability policy. Phase 16 attempted one additional live submission to verify both protections together without adding automation or repository access.

## Rehearsal

Agent Operations selected the dedicated `agent-operations/rehearsal` runtime through the Codex provider. The Project, Job, Attempt, and Plan were all new and repository-free:

- Project: `ao-restricted-live-rehearsal`
- Job: `job:23f58685-1791-410b-9ba8-95b990b31227`
- Attempt: `attempt:2e5f8fca-9a8c-4100-bb49-dd055bb15606`
- Plan: `plan:76b313b5-7e32-40f5-a618-b0db1ef3f543`
- Dispatch: `dispatch:72317c6f-9bc6-474f-84ed-6d7e7d3626da`
- Installation: `installation:41a0c98f-fbb0-4da2-af23-48027df4497d`
- Repository: none

The requested policy was `filesystem=read-only`, `network=deny`, and `environment=empty`. Preflight resolved the same effective AO policy, confirmed the running Codex runtime advertised exact-turn correlation and all required policy capabilities, and reported every finding as a pass.

The harmless instruction prohibited tools, files, shell commands, Git, and external services, then requested exactly:

```text
AGENT_OPERATIONS_RESTRICTED_OK 1AA573A43B7D41C8BA95
```

Exactly one real AO submission was made. There were no retries or duplicate submissions.

## Correlation

The Dispatch was rejected before Codex created a policy-isolated thread or turn. No external thread/turn reference was returned or persisted, no correlated provider record exists, and no exact observation was possible. This rehearsal therefore did not establish `turn-completed` evidence or exact Dispatch-to-turn correlation.

## Capability Enforcement

The committed policy mapping requested a dedicated Codex thread with:

- `sandbox: read-only`
- `sandboxPolicy: readOnly` with `networkAccess: false`
- `approvalPolicy: never`
- empty environments and no inherited shell environment
- no runtime workspace roots, dynamic tools, or selected capability roots
- goals, hooks, memories, multi-agent behavior, apps, and configured MCP servers disabled
- login shell, web search, and image tools disabled

The live app-server rejected `thread/start` while parsing `apps._default.approvals_reviewer: null`; it interpreted the null as an invalid empty enum variant. The failure occurred before a real restricted turn existed, so Phase 16 cannot claim that the effective provider sandbox was exercised. The policy-aware request did not use the generic `danger-full-access` turn overrides.

After preserving the durable rejection evidence, the provider mapping was fixed narrowly to omit unsupported null-valued app settings, with regression coverage asserting that neither field is sent. The fix was not exercised by another live Dispatch in Phase 16.

## Semantic Result

No Codex turn was created, so no model response or nonce result exists. Human semantic verification is therefore unavailable and remains separate from the missing infrastructure correlation evidence.

## Safety

- Real AO submissions: one.
- Codex turns created: zero.
- Automatic retries: zero.
- Duplicate Dispatches or submissions: zero.
- Tool, shell, Git, or outbound tool-network activity: none; no provider turn ran.
- Runtime or repository file writes requested by the instruction: none.
- The expected occupancy marker was written before policy-thread setup, invalidating the previous idle signal and conservatively closing further admission.
- Daemon ownership conflicts: zero.
- Recovery loops: zero.
- Runtime ownership after rejection: one daemon and one Codex app-server writer.

## Outcome

The Dispatch remains `rejected`. The Attempt remains `created`, the Job remains `ready`, and no outcome decision exists. No success, failure, or Job completion was inferred. The preserved Phase 13 Dispatch, observations, human override, Attempt, and Job remain unchanged.

## Non-Decisions

Phase 16 does not establish automatic semantic success, workers, queues, scheduling, retry policy, repository-bound execution, Git mutation, production permission taxonomy, or a successful restricted exactly correlated live execution. A later rehearsal requires a new explicit authorization and must not reuse this rejected Plan or Dispatch.
