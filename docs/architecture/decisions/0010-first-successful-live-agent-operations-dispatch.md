# ADR 0010: First Successful Live Agent Operations Dispatch

- Status: Accepted
- Date: 2026-08-23

## Context

Phases 4–12 established the Agent Operations execution architecture and a dedicated, ready CortextOS rehearsal runtime without sending real AO work. The first live crossing needed to exercise the durable Job, Attempt, Plan, Dispatch, observation, and outcome boundaries exactly once while keeping the runtime outside every Git repository and retaining human authority over success.

## Rehearsal

Agent Operations targeted the dedicated `agent-operations/rehearsal` runtime through the Codex provider with no repository target. The project key was `ao-live-rehearsal`. The harmless instruction prohibited tools, files, shell commands, Git, and external services, then requested exactly:

```text
AGENT_OPERATIONS_REHEARSAL_OK 84566F2EED594DECA1D7
```

The durable identifiers were:

- Job: `job:2ff9317a-f1e3-429a-b0b6-6fee7f55b606`
- Attempt: `attempt:01a13aef-e4c8-4ab7-88ca-3e78037acbad`
- Plan: `plan:0293c343-4dec-4b13-85a1-47ec525f23c8`
- Dispatch: `dispatch:db4d4597-3e1b-444f-9655-e1fb33d673ec`
- Installation: `installation:41a0c98f-fbb0-4da2-af23-48027df4497d`

Exactly one external submission was made. There were no retries or duplicate submissions.

## Result

The runtime accepted the Dispatch and the Attempt entered `running`. The daemon acknowledged injection in approximately 2 ms. One bounded observation pass retained an accepted-time `runtime-running` observation and a subsequent `runtime-idle` observation; both were agent-level weak evidence.

The local runtime output and the dedicated Codex session transcript contained the exact nonce response. The structured transcript showed one user instruction, the exact assistant response, and task completion, with no intervening tool call. The response completed in approximately 2.3 seconds, with approximately 1.9 seconds to first token.

After explicit human verification, the existing human override recorded a completed human Outcome and transitioned the Attempt to `completed`. A separate explicit action then transitioned the Job to `completed`. The Dispatch remained `accepted`, preserving the distinct meanings of transport acceptance and execution outcome.

## Safety

- Git mutations caused by the runtime: zero.
- Runtime workspace file mutations: zero; its tracked policy hash and file inventory were unchanged.
- Tool, shell, Git, or external-service use in the dispatched turn: none observed.
- Automatic retries: zero.
- Duplicate Dispatches or adapter submissions: zero.
- Workers, queues, schedulers, autonomous polling, and repository access: not used.

The persistent Codex session had a broader prior context and exposed tool capability, including an unrestricted runtime sandbox setting, but followed the repository-free policy and the instruction exactly. This makes policy and runtime isolation load-bearing; harmless behavior in this rehearsal does not itself establish a production sandbox.

## Correlation

The nonce match is explicit human verification evidence, not trusted exact per-Dispatch infrastructure correlation. The two runtime observations are agent-level and cannot prove that a specific provider response belongs to the Dispatch. Therefore no automatic completion was inferred. Attempt success required the deliberate human override, and Job completion remained a separate human-authorized action.

## Findings

The real runtime differed from the fake path in several ways:

- IPC acceptance was immediate and proved only that the daemon accepted the injection, not that the model completed it.
- The dedicated agent reused a persistent Codex session rather than creating an isolated per-Dispatch provider session.
- The bounded daemon observer could show running and later idle state, but could not retrieve or correlate the response.
- The concise daemon output exposed the response, while the provider transcript supplied stronger behavioral evidence that no tool call occurred.
- A successful direct daemon injection did not write `last_message_injected.flag`. Because admission compares that marker with `last_idle.flag`, a live agent could incorrectly appear available while processing an injected message. Phase 13 fixed this narrowly in `AgentProcess.injectMessageDetailed()` by persisting the marker before PTY injection and failing closed if it cannot be persisted, with regression coverage. No second live Dispatch was used to test the fix.

## Non-Decisions

This ADR does not establish exact provider correlation, automatic outcome inference, autonomous observation, retry policy, queue or worker architecture, scheduling, production deployment, production credentials, repository-bound execution, a production sandbox, multi-agent orchestration, or future runtime automation policy.
