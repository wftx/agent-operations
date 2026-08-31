# ADR 0025: CortextOS Orchestrator as Agent Operations Conversational Intelligence Layer

- Status: Accepted
- Date: 2026-08-31

## Context

Agent Operations already owns durable Projects, Jobs, execution policy,
Attempts, immutable Plans, Dispatches, exact observations, Reviews, Needs Me,
isolated workspaces, approval state, and promotion evidence. CortextOS already
owns persistent provider processes, native session continuation, agent
lifecycle, messaging, and Telegram transport.

Adding an independent AO chat engine would duplicate runtime, history, and
lifecycle responsibility. Letting AO Web import SQLite, Git, daemon, or provider
adapters would also bypass the application boundary.

## Decision

Use one dedicated global CortextOS agent, `ao-orchestrator`, as the Agent
Operations conversational intelligence layer. The native CortextOS agent and
provider session remain persistent across messages and restarts. The rehearsal
Worker and Reviewer agent remains separate.

AO Web depends only on `OperatorApplication` and
`OrchestratorConversationService`. A top level Agent Operations composition root
assembles SQLite, Git, CortextOS runtime, execution, observation, notification,
Operator, tool, and conversation adapters.

The Orchestrator receives a bounded application command surface:

- `ao.projects.list`
- `ao.projects.get`
- `ao.jobs.create`
- `ao.jobs.get`
- `ao.jobs.list`
- `ao.jobs.status`

Project and Job reads come from current AO application read models. Job creation
calls the existing Operator application service, including its Project,
repository, execution mode, review, budget, and workspace checks. No SQL, store,
Git, worktree, evidence mutation, completion, approval, or publish object is
exposed.

The dedicated profile uses the already authenticated Codex app server runtime.
Each web message starts one exactly correlated turn on its persistent thread.
That thread runs read only with network denied, an empty inherited environment,
and only a native `ao` dynamic tool namespace. The dynamic tools invoke one
provider neutral typed AO command handler in a separate control plane process.
Each turn must return its operator facing response through the structured
`ao.conversation_respond` tool. Structured tool results add related Job IDs to
the CortextOS owned turn projection. AO Web does not infer Job creation from
prose.

CortextOS owns provider history and bounded web conversation projections. AO
SQLite stores no chat transcript. The stable conversation identity is the
dedicated CortextOS instance and agent. Page rendering performs read operations
only and never starts the runtime.

## Safety

The dedicated profile has no schedules, no Telegram poller, no repository or
filesystem tools, no network tools, no raw bus tools, and no automatic local
version control. Codex features, apps, MCP servers, shell, skills, hooks, web
search, and multi agent capabilities are disabled for its persistent thread.
The profile is installed disabled until a separately authorized live proof.

AO remains the only source of Job and execution truth. CortextOS task and
approval records are not mirrored as competing state machines. Existing Worker
and Reviewer execution authority is unchanged.

## Follow on work

- route Telegram conversation through the same Orchestrator and retain AO
  notification intent and deduplication
- add bounded attachments and authorized URL inputs
- add exact workspace preview and visual review
- add human controlled Approve and Publish
