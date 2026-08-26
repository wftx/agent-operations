# ADR 0015: First Restricted and Exactly Correlated Live Agent Operations Turn

- Status: Accepted
- Date: 2026-08-26

## Context

Phase 13 proved one real Agent Operations execution, but the Codex session used unrestricted capability and only weak agent-level completion evidence. Phase 16 attempted restricted and exactly correlated execution, but policy-thread configuration was rejected before a Codex turn existed. Phase 17 therefore required a fresh repository-free Job, Attempt, immutable Plan, and Dispatch; the rejected Phase 16 chain was not eligible for reuse.

A pre-dispatch audit found that the rehearsal harness still selected the Phase 16 project identity and would have loaded its rejected chain. No live submission had occurred. The harness was narrowly corrected to use a new Phase 17 project identity, and an isolated regression test proves the preserved Phase 16 project cannot be selected. The fresh live gate was crossed only after that test, typecheck, preview, durable preparation, and preflight passed.

## Rehearsal

- Project: `ao-restricted-exact-correlation-live-rehearsal`
- Job: `job:56db3780-b234-4818-922c-85120d2d6537`
- Attempt: `attempt:07605e73-3093-4410-bbe9-8e49e401f770`
- Plan: `plan:0e4be431-c8b6-48d0-912c-36af39377d83`
- Dispatch: `dispatch:793c2b5b-d2df-45f8-b420-2536d6700c7f`
- Installation: `installation:41a0c98f-fbb0-4da2-af23-48027df4497d`
- Runtime: `agent-operations/rehearsal`
- Provider: Codex
- Repository: none
- Nonce: `72783F2B3FAC4A1F905C`

The immutable Plan requested policy version 1 with `filesystem=read-only`, `network=deny`, and `environment=empty`. Immediately before submission, preflight was `ready` and dispatchable. Job readiness, Attempt state and revisions, Plan associations, runtime association and availability, exact-turn capability, running state, policy support, and the absent repository target all passed.

The harmless instruction was:

```text
This is a controlled Agent Operations restricted execution rehearsal.

Do not use tools.
Do not modify or create files.
Do not run shell commands.
Do not use Git.
Do not contact external services.

Reply with exactly this one line and nothing else:
AGENT_OPERATIONS_RESTRICTED_OK 72783F2B3FAC4A1F905C
```

Exactly one real external submission occurred. The Dispatch was accepted, the Attempt entered `running`, and there were no retries or duplicates.

## Correlation

The accepted Dispatch persisted this external reference:

```text
cortextos:codex-turn:v1:01a03ce8-759e-71e1-bd24-fa3cf98db92f:01a03ce8-75e9-7c23-b001-f90755fbff73
```

- Thread: `01a03ce8-759e-71e1-bd24-fa3cf98db92f`
- Turn: `01a03ce8-75e9-7c23-b001-f90755fbff73`

The first observation recorded exact `runtime-running` evidence for that thread and turn. One bounded follow-up observation recorded `kind=turn-completed`, `correlation=exact`, and `correlatedDispatchId=dispatch:793c2b5b-d2df-45f8-b420-2536d6700c7f`. The structured Codex turn record reports completion after 7,725 ms. Agent-level running and idle observations remain supplemental and are not treated as exact completion evidence.

## Capability Enforcement

The accepted Dispatch persisted the same effective AO policy as requested: `read-only / deny / empty`. The exact persisted Codex session reports:

- sandbox policy `read-only`, never `danger-full-access`
- managed restricted permissions with read-only filesystem access and restricted network
- an empty attached environment map
- no workspace writable roots
- no tool-call response items, shell calls, or other non-message response items

The policy-aware provider path also supplied empty dynamic tools, empty selected capability roots, disabled configured MCP servers and apps, disabled goals/hooks/memories/multi-agent features, disabled agents, disabled login-shell inheritance, and disabled web-search and image tools. Descriptive skill/plugin metadata remained present in persisted prompt context, but it exposed no callable dynamic tool, app, MCP, or multi-agent capability in this turn.

`danger-full-access` was absent from the real turn context.

## Semantic Response

The bounded exact session transcript contains one assistant message:

```text
AGENT_OPERATIONS_RESTRICTED_OK 72783F2B3FAC4A1F905C
```

This nonce match is human semantic evidence only. It was not used to establish infrastructure correlation.

## Safety

- Real Phase 17 AO submissions: one.
- Adapter invocations: one.
- Phase 17 Dispatch records: one.
- Automatic retries: zero.
- Duplicate submissions: zero.
- Tool activity: none.
- Shell activity: none.
- File writes by the turn: none.
- Git activity by the turn: none.
- External tool-network activity: none.
- Repository target: none.
- Ownership conflicts: zero.
- Recovery loops: zero.
- Runtime ownership after completion: one default daemon and one Codex app-server writer.

The runtime persisted `last_message_injected.flag` before calling the provider turn-start boundary. Its Phase 17 value was `1787728262`; the earlier idle signal was thereby invalidated. The exact turn completed and normal runtime handling then wrote fresh idle value `1787728270`.

## Outcome

The Dispatch is `accepted` and exact technical completion evidence exists. After reviewing the restricted capability record, exact correlation, exact turn completion, matching nonce response, absence of prohibited activity, exactly-once behavior, and healthy runtime ownership during the rehearsal, the human explicitly authorized success for the Attempt and then completion of the Job.

Agent Operations recorded human Outcome Decision `outcome:512abb5b-052f-43d8-be45-e080432ed085`, bound to exact `turn-completed` Observation `observation:72cba7809b6d9c99823f54d3afc4fcce20efd21c94b14d98e66f65acf14520e9`. `overrideWithoutExactCompletionEvidence` is false. Attempt `attempt:07605e73-3093-4410-bbe9-8e49e401f770` and Job `job:56db3780-b234-4818-922c-85120d2d6537` are both `completed`.

Phase 13 remains accepted with its weak observation, human override, completed Attempt, and completed Job. Phase 16 remains rejected with its Attempt created, Job ready, no outcome, and no external reference.

## Non-Decisions

Phase 17 does not establish automatic semantic success, retries, workers, queues, scheduling, repository-bound execution, Git mutation, or autonomous monitoring. It proves that one restricted Agent Operations Dispatch created one exact Codex turn and that Agent Operations recorded exact structured completion evidence for that turn.
