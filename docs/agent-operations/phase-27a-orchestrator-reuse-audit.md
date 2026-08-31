# Phase 27A: CortextOS Orchestrator Reuse Audit and AO Integration Design

Status: design only. No runtime behavior changes are included in this phase.

## 1. Executive conclusion

CortextOS already provides most of the conversational agent substrate that
Agent Operations needs:

- a persistent agent process and provider specific session continuation;
- an Orchestrator template with a long lived LLM loop, organizational context,
  memory, goals, schedules, Telegram, and delegation conventions;
- durable inbox delivery with acknowledgement and stale inflight recovery;
- inbound and outbound Telegram transport, media capture, history logs, and
  callback routing;
- agent inventory, lifecycle, provider selection, schedules, task records,
  approvals, and dashboard diagnostics;
- an existing dashboard conversation view, transcript reader, and outbound
  stream.

CortextOS does not provide the workforce management guarantees that AO already
has. Its task and approval records are useful coordination artifacts, but they
do not model immutable Plans, exactly once Dispatch, exact provider turn
correlation, Worker budgets, independent Reviews, isolated workspaces, bounded
evidence, or controlled promotion. Those remain AO owned.

Phase 27B is therefore mostly integration with a small amount of new product
code. It should add a typed conversation gateway around one existing persistent
CortextOS Orchestrator session and a bounded AO application command surface. It
must not add another LLM loop, provider session implementation, Telegram
poller, message bus, or chat transcript store.

The recommended inbound choice is a narrow form of option B:

> AO Web calls an AO conversation application service. That service delegates
> the turn to the existing CortextOS Orchestrator session through a typed
> CortextOS conversation port. CortextOS remains the conversation engine and
> transcript owner. AO stores only links from conversation turns to AO
> proposals and Jobs.

This extra application layer is not a second conversation engine. It prevents
AO Web from importing daemon, PTY, SQLite, or provider internals, and it gives
the product a stable place to enforce identity, confirmation, and Job linkage.

## 2. Reuse matrix

| Capability | Existing CortextOS implementation | Reuse directly | Wrap or extend | AO must own | Evidence and code references | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| Orchestrator LLM loop | Persistent agent created from `templates/orchestrator` | Yes | Add an AO role and bounded AO command documentation | No | `templates/orchestrator/config.json`; `templates/orchestrator/CLAUDE.md`; `AgentProcess.start` | The runtime loop, schedules, crash recovery, and provider process already exist. |
| Conversational session | Provider native session selected by `AgentProcess.shouldContinue` | Yes | Add a typed conversation port and turn metadata | Only conversation to Job links | `src/daemon/agent-process.ts`; `AgentPTY`; `CodexAppServerPTY`; `HermesPTY`; `OpencodePTY` | Provider history should remain provider native. AO needs stable product linkage, not a duplicate transcript. |
| Telegram inbound | Per agent `TelegramPoller`, allowlisted user gate, media processing, fast checker injection | Yes | Route the designated AO bot only to the AO Orchestrator | No | `AgentManager.startAgent`; `TelegramPoller.pollOnce`; `FastChecker.queueTelegramMessage` | It already handles offsets, ordering, access checks, media, and restart behavior. |
| Telegram outbound | `TelegramAPI`, bus commands, last sent cache, JSONL logging | Yes | Expose transport through a CortextOS notification port | Notification intent and dedupe | `src/telegram/api.ts`; `src/telegram/logging.ts`; `OperatorRunner.deliver` | AO should decide that a notification exists. CortextOS should transport it. |
| Task bus | Per organization JSON task records, claim locks, dependency edges, audit JSONL | For conversational coordination only | Add an AO Job link in message metadata if useful | Job and execution truth | `src/bus/task.ts`; `Task` in `src/types/index.ts` | Status changes are broad coordination operations. They are not AO execution transactions. |
| Agent messaging | Signed file inbox, inflight move, acknowledgement, stale inflight recovery | Yes | Use for non Job collaboration and Orchestrator wake up | No | `sendMessage`, `checkInbox`, `ackInbox`, `recoverStaleInflight` | This is a useful durable delivery primitive. It does not prove a provider turn or execution result. |
| Agent delegation | Template instructs create task plus prompt based `send-message` | Yes, outside AO Jobs | Attach AO Job references when delegation concerns AO | Attempt, Plan, Dispatch, Review | `templates/orchestrator/CLAUDE.md`; `src/cli/bus.ts` | Delegation is prompt based and result return is another message. AO work must use AO orchestration. |
| Approvals | Pending and resolved JSON files, Telegram buttons, inbox notification | Presentation only | Route AO callbacks into AO application commands | Ready for Approval, Needs Me, publish approval | `src/bus/approval.ts`; `FastChecker.routeApprovalCallback` | CortextOS approval resolves a generic record. It does not enforce AO workspace or evidence state. |
| Memory | Agent `MEMORY.md`, daily memory, provider history, optional knowledge base | Yes for conversational context | Add read only AO summaries when needed | Durable Job evidence | `templates/orchestrator/CLAUDE.md`; `src/bus/knowledge-base.ts` | Memory can guide reasoning but cannot override current AO state. |
| Goals | `goals.json`, generated `GOALS.md`, goal cascade instructions | Yes | None for the first slice | No | `src/cli/goals.ts`; Orchestrator goal management skill | Goals are useful agent context, not execution authority. |
| Cron | Daemon managed schedules in agent state | Yes | No AO scheduler in 27B | Any future AO scheduled Job authorization | `templates/orchestrator/config.json`; daemon cron scheduler | Schedules may wake the Orchestrator, but a schedule must not silently authorize AO execution. |
| Runtime lifecycle | `AgentManager` and `AgentProcess` across four provider adapters | Yes | Conversation readiness adapter | No | `src/daemon/agent-manager.ts`; `src/daemon/agent-process.ts` | AO must not create another provider lifecycle. |
| Provider selection | Agent config selects Claude Code, Codex app server, OpenCode, or Hermes | Yes | Choose a supported dedicated Orchestrator profile | No | `AgentConfig.runtime`; `AgentProcess.start` | Selection is already runtime configuration. |
| Agent inventory | Daemon registry, list agents IPC, heartbeats | Yes | Present through an application read model | Project to runtime association | `AgentManager`; IPC command types; AO runtime adapter | AO already consumes inventory through its runtime port. |
| Agent tools | CLI and skills for Claude style agents; Codex dynamic tool namespaces for exact AO turns | Yes as substrate | Add provider neutral AO application commands; later map them to native dynamic tools | Tool authorization | `templates/orchestrator/TOOLS.md`; `buildDynamicTools` in `src/pty/codex-app-server-pty.ts` | One AO application handler can back a CLI adapter now and native tools later. |
| Project context | Organization context, agent workspace instructions, task `project` string | Partly | Inject AO project summaries from AO queries | Project, repository, checkout binding | `OrgContext`; `SYSTEM.md` generation; `OperatorApplication.listProjects` | CortextOS project text is not the canonical repository identity model. |
| Job creation | No equivalent with AO guarantees | No | Orchestrator calls a bounded AO proposal and creation service | Yes | `OperatorApplication.previewTask`; `runOperatorJob`; `JobLifecycleService` | Only AO validates project, repository, execution mode, policy defaults, and active run constraints. |
| Job status | Dashboard task status exists, but semantics differ | No | Orchestrator queries AO read models | Yes | `OperatorApplication.listJobs`; `getJobDetail` | AO status includes attempts, reviews, escalations, workspace, and run state. |
| Execution policy | Restricted policy mapping and capability envelope exist in AO and the CortextOS adapter | Runtime enforcement reuse | Keep adapter mapping below AO application | Yes | `RuntimeExecutionPolicy`; `buildDynamicTools`; `ExecutionPreflightService` | The runtime enforces a requested ceiling, but AO decides the permitted ceiling. |
| Worker Dispatch | Exact correlated injection exists in CortextOS | Runtime primitive only | Continue through AO execution adapter | Yes | `AgentProcess.injectCorrelatedMessageDetailed`; `ManualDispatchService`; `DurableExecutionDispatch` | AO owns immutable submission intent and no resend semantics. |
| Reviewer workflow | No durable equivalent in CortextOS task bus | No | Continue existing AO workflow | Yes | `OrchestrationService`; `DurableAttemptReview` | Independent review decisions and revision budgets are AO domain rules. |
| Needs Me | Human tasks and approvals can display a need | Presentation only | Project AO Escalations to conversation and Telegram | Yes | `DurableEscalation`; `OperatorApplication.getJobDetail` | AO must preserve the reason, evidence, resolution, and valid continuation actions. |
| Human guidance | CortextOS can deliver natural language messages | Transport only | Parse and confirm guidance, then call AO application | Yes | `provideGuidanceAndContinue`; `DurableHumanGuidance` | Guidance changes a durable AO run and must target an exact unresolved Escalation. |
| Previews | No authoritative AO workspace preview service | No | Add later through an AO preview profile and adapter | Yes | Current AO intake preview in `OperatorApplication.previewTask`; workspace state | A local server must be tied to the exact workspace and cannot change approval state. |
| Attachments and inputs | Telegram downloads media to an agent directory; dashboard accepts message uploads | Transport reuse only | Ingest into an AO controlled content store with provenance | Yes | `processMediaMessage`; dashboard message upload route | Worker access needs a stable hash and bounded local path, not an agent workspace path or remote URL. |
| Publish approval | Generic deployment approval category exists | Presentation only | AO issues a publish approval intent and consumes the decision | Yes | CortextOS `ApprovalCategory`; AO `ready_for_approval` workspace state | Exact reviewed evidence and fast forward promotion rules are AO specific. |
| Exact execution evidence | CortextOS emits provider turn identity and tool audit data through its execution adapter | Runtime evidence producer | Keep current adapter and observer | Yes | `DurableExecutionObservation`; `CortextOSExecutionObserver` | AO records and judges exact evidence. CortextOS supplies observations. |

## 3. Source map

### Orchestrator and lifecycle

| Source | Important symbol | Finding |
| --- | --- | --- |
| `templates/orchestrator/config.json` | Orchestrator configuration | Claude Code runtime, long session, heartbeat and review schedules, and local version control defaults. |
| `templates/orchestrator/CLAUDE.md` | Orchestrator role and protocols | Chief of staff behavior is prompt and skill driven. Delegation is task creation plus bus messages. |
| `templates/orchestrator/SYSTEM.md` | Static system context | Organization facts are copied into the agent workspace. Live inventory is queried separately. |
| `src/cli/add-agent.ts` | `addAgentCommand`, `NON_CODEX_TEMPLATES` | Instantiates the template. A Codex Orchestrator template is currently rejected. Multiple Orchestrator templates can be created, but only an empty `context.json.orchestrator` field is filled. |
| `src/daemon/agent-manager.ts` | `AgentManager.startAgent` | The designated Orchestrator is mostly a normal persistent agent. Special treatment is ownership of shared Slack, activity Telegram, and Buzz transports. |
| `src/daemon/agent-process.ts` | `AgentProcess.start`, `sessionRefresh`, `shouldContinue` | Selects provider PTY, restores sessions, injects messages, and performs crash recovery. |

### Sessions and conversations

| Source | Important symbol | Finding |
| --- | --- | --- |
| `src/pty/agent-pty.ts` | `AgentPTY.spawn` | Claude Code resumes with `--continue` in the configured working directory. |
| `src/pty/codex-app-server-pty.ts` | `startOrResumeThread`, `readThreadState` | Resumes a persisted Codex thread, falls back to the latest thread for the same directory, and persists extended history. |
| `src/pty/hermes-pty.ts` | `HermesPTY`, `hermesDbExists` | Hermes uses its state database and `--continue`. |
| `src/pty/opencode-pty.ts` | `OpencodePTY` and session marker | OpenCode uses isolated state roots and `--continue`. |
| `src/daemon/agent-process.ts` | `buildStartupPrompt`, `buildContinuePrompt`, `consumeHandoffBlock` | Restart prompts reload bootstrap context. A hard restart may consume a handoff document reference, while a normal refresh preserves native provider history. |
| `src/daemon/context-handoff-lease.ts` | `requestContextHandoffLease` | Bounds concurrent context handoffs across agents. It coordinates handoff work but does not store conversation history. |
| `src/telegram/logging.ts` | `logInboundMessage`, `logOutboundMessage`, `buildRecentHistory` | JSONL transport history supports transcript display and short context injection. It is not the provider session itself. |
| `dashboard/src/app/api/messages/history/[agent]/route.ts` | message history endpoint | Merges inbound and outbound JSONL for a chat transcript. |
| `dashboard/src/app/api/messages/stream/[agent]/route.ts` | outbound SSE endpoint | Streams complete outbound log entries by polling JSONL. It is not provider token streaming. |

One Orchestrator session can span many AO Jobs and Projects because session
identity is tied to the agent and its working directory, not an AO Job. Project
selection must therefore be explicit in each AO command. The provider history
is suitable for continued conversation after daemon restart, but it is not a
substitute for a durable conversation to Job link.

### Telegram and messaging

| Source | Important symbol | Finding |
| --- | --- | --- |
| `src/telegram/poller.ts` | `TelegramPoller.pollOnce` | Persists offsets after successful handlers. Failed handlers leave updates for ordered redelivery. Conflict and transient backoff are implemented. |
| `src/daemon/agent-manager.ts` | Telegram setup inside `startAgent` | Applies the allowlisted user gate, archives inbound messages, processes media, builds recent history, and queues the result to the fast checker. |
| `src/daemon/fast-checker.ts` | `pollCycle`, `formatTelegramTextMessage` | Combines Telegram, Slack, Buzz, and bus input, injects one message block, then acknowledges accepted bus messages. |
| `src/telegram/api.ts` | `TelegramAPI` | Owns API calls, rate limiting, credential validation, send operations, and update polling. |
| `src/bus/message.ts` | `sendMessage`, `checkInbox`, `ackInbox` | Atomically writes signed inbox messages, moves them to inflight, and recovers unacknowledged inflight files after five minutes. |

Agent addressing is by configured agent name. Delegation content and returned
results are natural language. A task ID or reply ID can be included, but there
is no atomic task to message to provider turn chain. The inbox is durable and
redelivered, so consumers must tolerate duplicate delivery. It is safe for
conversation wake up and informal collaboration, not for AO Dispatch. There is
no automatic prevention of agents starting a conversational message cycle.
Task dependency cycles are checked, but that check does not govern messages.

### Tasks, approvals, memory, and goals

| Source | Important symbol | Finding |
| --- | --- | --- |
| `src/types/index.ts` | `Task`, `Approval`, `OrgContext` | Defines file record schemas. Task `project` is a string, not an AO Project or repository reference. |
| `src/bus/task.ts` | `createTask`, `claimTask`, `updateTask`, `completeTask` | JSON is authoritative for the bus task. Claim uses an exclusive file. Dependency cycles are checked. General status update and completion do not enforce an AO style transition graph. |
| `src/bus/task.ts` | `appendTaskAudit`, `checkStaleTasks`, `compactTasks` | Audit is explicitly best effort. Recovery identifies stale work but does not provide exact execution reconciliation. |
| `src/bus/approval.ts` | `createApproval`, `updateApproval` | Moves a record from pending to resolved and sends an inbox notice. Telegram delivery failure does not block record creation. |
| `src/daemon/fast-checker.ts` | `routeApprovalCallback` | Telegram buttons resolve the CortextOS approval record after an allowlisted user check. |
| `src/cli/goals.ts` | `goalsCommand` | Converts agent `goals.json` into prompt context in `GOALS.md`. |
| `src/bus/knowledge-base.ts` | `queryKnowledgeBase`, `ingestKnowledgeBase` | Optional organization and private agent retrieval uses MMRAG collections. |

The bus task is an authoritative record only for CortextOS coordination. It is
advisory relative to an AO Job because it lacks AO execution invariants. The
same distinction applies to CortextOS approvals. They can project an AO state
for presentation, but the callback must invoke AO first and the projection must
follow AO truth. Task recovery consists of stale work reporting and manual or
agent driven status changes. It does not retry or reconcile an exact provider
execution.

### Dashboard and UI

| Source | Important symbol | Finding |
| --- | --- | --- |
| `dashboard/src/app/(dashboard)/comms/page.tsx` | communication page | Existing conversation layout and components are reusable visual assets. |
| `dashboard/src/components/comms/channel-view.tsx` | `ChannelView` | Implements chat input, transcript display, uploads, and polling behavior. |
| `dashboard/src/app/api/messages/send/route.ts` | dashboard send endpoint | Reimplements bus file writes and wakes the fast checker directly. This should not be copied into AO Web. |
| `dashboard/src/app/api/messages/history/[agent]/route.ts` | history endpoint | Reads daemon JSONL files directly. Useful behavior, but coupled to local runtime storage. |
| `dashboard/src/app/api/messages/stream/[agent]/route.ts` | SSE stream | A practical first streaming implementation, also coupled to daemon log files. |
| `dashboard/src/app/(dashboard)/tasks/page.tsx` | task board | Useful engine room view for CortextOS tasks, not an AO Job view. |
| `dashboard/src/app/(dashboard)/approvals/page.tsx` | approvals page | Useful generic approval UI, but currently calls CortextOS approval operations. |
| `apps/ao-web/src/app.ts` | `OperatorWebApplication` | Correctly depends on the `OperatorApplication` interface. |
| `apps/ao-web/src/server.ts` | current composition root | Imports SQLite, Git, CortextOS adapters, and execution services directly. This conflicts with the stated Phase 27 architecture constraint and should move to a separate local launcher. |

Reuse the dashboard conversation components and interaction patterns, not its
direct filesystem and signal based server routes. AO Web should receive a
conversation application interface and the existing Operator application
interface by dependency injection.

### AO authority and runtime tools

| Source | Important symbol | Finding |
| --- | --- | --- |
| `packages/agent-operations-application/src/types.ts` | `OperatorApplication` | Existing product boundary supports projects, runtime status, Job intake, run, read models, guidance, reconciliation, and cancellation. |
| `packages/agent-operations-application/src/operator-application-service.ts` | `OperatorApplicationService` | Validates project and repository association, execution mode, run concurrency, Worker budget, and escalation continuation. |
| `packages/agent-operations-application/src/operator-runner.ts` | `OperatorRunner` | Restart safe runner and durable at most once notification claims. |
| `packages/agent-operations-contracts/src/persistence.ts` | `AgentOperationsStateStore` | AO owned store interface exposes no SQL concepts and supports revision checked transitions. |
| `packages/agent-operations-contracts/src/dispatch.ts` | `DurableExecutionDispatch` | Immutable Plan submission intent, idempotency key, and accepted or uncertain boundary. |
| `packages/agent-operations-contracts/src/observation.ts` | `DurableExecutionObservation` | Exact provider correlation and bounded tool evidence. |
| `packages/agent-operations-contracts/src/orchestration.ts` | `DurableAttemptReview`, `DurableEscalation` | Independent review and durable Needs Me state. |
| `packages/agent-operations-contracts/src/workspace.ts` | `DurableRepositoryWorkspace` | Isolated workspace state, bounded text diff, tests, and binary metadata. |
| `src/pty/codex-app-server-pty.ts` | `buildDynamicTools` | Demonstrates a narrow dynamic namespace with bounded repository, test, and Git operations for policy isolated AO turns. |

No general provider neutral dynamic tool registry is present for the current
Claude Orchestrator template. CortextOS agents conventionally discover bounded
CLI commands through `TOOLS.md` and skills. The initial AO command surface can
therefore be a provider neutral application handler exposed through a bounded
local CLI adapter. A future Codex Orchestrator can map the same handler to
native dynamic tools without changing AO authority.

## 4. Recommended architecture

```text
                            conversation transcript and provider session
                                         owned by CortextOS
                                                    │
Human ──→ AO Web ──→ AO Conversation Application ──→ CortextOS Orchestrator
  │                read models and turn links             │
  │                                                       │ bounded AO commands
  └────→ Telegram ──→ CortextOS Telegram router ──────────┤
                                                          ▼
                                            AO Orchestrator Application API
                                                          │
                                            AO durable domain and store
                                                          │
                                      AO Worker and Reviewer orchestration
                                                          │
                                          CortextOS execution runtime
```

### Ownership

- CortextOS owns the Orchestrator process, provider session, native history,
  Telegram polling, agent wake up, provider lifecycle, and outbound transport.
- The AO Conversation Application owns authentication, selected Orchestrator,
  current project hint, and links between CortextOS turn references and AO
  proposal or Job IDs. It does not store a second transcript or call an LLM.
- The AO Orchestrator Application API owns command validation and calls existing
  AO application services. It exposes no store, SQL, Git, PTY, or daemon object.
- AO remains the only authority for Job and execution state.

### Turn flow

1. AO Web authenticates the operator and sends text plus an optional selected
   AO Project ID to `OrchestratorConversationApplication.sendTurn`.
2. The application resolves the one designated Orchestrator through a
   `CortextOSConversationPort` and obtains a provider session and turn reference.
3. The persistent Orchestrator reasons over the conversation and calls bounded
   AO commands. Every command revalidates identifiers and authority in AO.
4. CortextOS streams or exposes the assistant result. AO Web shows it and any
   linked Job cards returned by AO read models.
5. Restart resumes the same provider session. AO links remain valid because
   they refer to durable AO IDs and external CortextOS turn references.

Raw dashboard inbox writes should not be the new product API. They provide no
single completion reference and make AO Web depend on runtime file locations.
The conversation port may reuse their underlying inbox, logs, and SSE mechanics
inside the CortextOS adapter, but must expose typed send, observe, history, and
readiness operations.

## 5. Proposed AO Orchestrator application surface

### Common rules

- Every command receives an authenticated operator principal and a bounded
  request ID.
- Every mutation supports an idempotency key.
- Project and repository paths are never model supplied. The model supplies AO
  IDs returned by read commands.
- Mutation responses return the durable AO ID, current state, and a safe next
  action. They do not return adapter handles.
- A human confirmation record contains the proposed operation hash, operator,
  conversation turn reference, and expiration. The Orchestrator cannot invent
  it.
- Read commands may be called autonomously. Execution, continuation, input
  ingestion, preview start, and publish mutations require the authority stated
  below.

| Capability | Purpose and arguments | Return shape | Mutation | Human confirmation | Security and autonomy | Existing reuse candidate |
| --- | --- | --- | --- | --- | --- | --- |
| `ao.projects.list` | List Projects, optional search text | Bounded Project summaries, repository IDs, available modes | No | No | Autonomous, authenticated read | `OperatorApplication.listProjects` |
| `ao.projects.get` | Get one `projectId` | Project, repositories, runtime readiness, allowed execution modes | No | No | Autonomous, exact AO ID | `listProjects` plus AO store backed read model |
| `ao.jobs.propose` | Propose one or more Jobs from `projectId`, task, criteria, mode, optional input IDs and client request ID | Proposal ID, normalized Job drafts, policy summary, clarifications, confirmation hash | Proposal only | No execution confirmation yet | Autonomous. Bounds count and text. No Job, Run, Plan, or Dispatch | `previewTask`, extended to a durable or signed proposal envelope |
| `ao.jobs.create` | Create accepted proposal by `proposalId`, `confirmationId`, and idempotency key | Job IDs, Operator Run states, conversation links | Yes | Yes, unless a future policy explicitly treats the current direct command as confirmation | Cannot alter proposal content. AO revalidates Project, repository, mode, slot, and runtime | `runOperatorJob`, with a proposal based overload |
| `ao.jobs.get` | Get `jobId` | Operator Job detail with attempts, review, workspace, escalation, linked inputs | No | No | Autonomous, bounded result | `getJobDetail` |
| `ao.jobs.list` | Filter by Project, state, or recent limit | Bounded Job summaries | No | No | Autonomous | `listJobs`, extended filters |
| `ao.jobs.status` | Compact status for one or more Job IDs | Stage, Needs Me reason, Ready for Approval marker, latest review | No | No | Autonomous | `listJobs` and `getJobDetail` read models |
| `ao.guidance.submit` | Submit `escalationId`, bounded guidance, confirmation ID, idempotency key | Resumed run and new guidance ID | Yes | Yes | Must target one unresolved escalation and pass AO continuation eligibility | `provideGuidanceAndContinue` |
| `ao.jobs.continue` | Continue an escalation with no free form guidance, such as exact reconciliation | Resumed or unchanged Run and evidence summary | Yes | Yes | Only actions advertised by AO for that escalation | `reconcileTimedOutExecution`; later typed continuation actions |
| `ao.inputs.list` | List Job or proposal input metadata | Input IDs, media type, byte size, hash, provenance, scan status | No | No | Autonomous metadata only | New AO input read model |
| `ao.inputs.add` | Register an already uploaded AO blob or authorized import receipt | Durable input ID and metadata | Yes | Yes for external import or attachment binding | No arbitrary local path or URL fetch. Content hash and size required | New AO input ingestion service, transport adapter below application |
| `ao.preview.get` | Read preview eligibility or active preview for `jobId` | Profile, exact workspace evidence revision, URL, process status | No | No | Autonomous read | New AO preview read model |
| `ao.preview.request` | Start an allowlisted Project preview for a Ready for Approval Job | Preview session ID and local URL | Yes, operational only | Yes | Exact workspace and evidence revision, fixed command profile, no approval transition | Future bounded preview service |
| `ao.approvals.get` | Read valid human actions for Job or escalation | Approval view, evidence digest, allowed action IDs | No | No | Autonomous | Existing escalation actions and workspace state |
| `ao.approvals.request` | Ask AO to present an existing valid action to the human | Durable approval intent and presentation status | Yes | No, this creates the request rather than granting it | Cannot approve. AO derives valid actions | New projection over AO state, not CortextOS approval truth |
| `ao.publish.request` | Request promotion of exact reviewed workspace revision | Durable publish request, required checks, confirmation hash | Yes | Yes to create; a separate explicit approval grants promotion | No Git arguments from the model. AO derives branch, base, paths, and evidence | Future promotion application service |

`ao.jobs.cancel` is intentionally omitted from the first Orchestrator surface.
Cancellation has execution uncertainty and workspace consequences. It can be
added later with the same action advertisement and human confirmation pattern.

### Conversation application interface sketch

```ts
interface OrchestratorConversationApplication {
  getConversation(): Promise<OrchestratorConversationView>;
  sendTurn(input: {
    text: string;
    selectedProjectId?: string;
    clientRequestId: string;
  }): Promise<OrchestratorTurnReceipt>;
  observeTurn(turnReference: string): Promise<OrchestratorTurnView>;
}

interface CortextOSConversationPort {
  getDesignatedOrchestrator(): Promise<OrchestratorRuntimeIdentity>;
  sendTurn(input: CortextOSConversationTurn): Promise<CortextOSTurnReceipt>;
  observeTurn(turnReference: string): Promise<CortextOSTurnObservation>;
  listHistory(cursor?: string): Promise<readonly CortextOSConversationMessage[]>;
}
```

The interface sketch is documentation only. It deliberately contains no
SQLite, PTY, Git, or provider type.

## 6. Conversational responsibility model

### The Orchestrator may reason about

- which Project the operator likely means;
- whether a request is one Job or several;
- useful Job titles and acceptance criteria;
- which details require clarification;
- whether tasks are independent or ordered;
- whether the user supplied input belongs to a proposed Job;
- which existing AO execution mode is suitable;
- how to summarize Job state, evidence, and Reviewer feedback;
- whether to ask AO to present a valid approval or continuation action.

### AO must enforce

- Project, repository, and local checkout identity;
- execution modes and capability ceilings;
- isolated workspace ownership and writable roots;
- immutable Plans and exactly once Dispatch;
- exact provider turn correlation;
- Worker execution budgets and fresh Attempt rules;
- validation, binary evidence, and Reviewer state;
- durable Needs Me, guidance, and continuation eligibility;
- Ready for Approval and human approval requirements;
- preview profile and exact workspace binding;
- publish permission, ancestry, exact approved paths, and audit evidence;
- notification intent and dedupe.

The Orchestrator's prompt, memory, tool arguments, or prior statement never
override an AO validation failure.

## 7. Project and context strategy

Use one global AO Orchestrator per AO installation for the first product slice.
The same conversation may discuss and create Jobs across multiple Projects.

Selection rules:

1. AO Web supplies the currently selected Project ID as a hint, never as hidden
   authority.
2. The Orchestrator calls `ao.projects.list` or `ao.projects.get` before a Job
   proposal when the Project is not already unambiguous in the current turn.
3. A unique exact or clear alias match may be proposed to the operator.
4. Multiple plausible matches require a clarification question. No Job is
   created from a guess.
5. Every Job command includes an explicit AO Project ID and repository ID. AO
   revalidates both.
6. Project specific policies are returned as data from AO. They are not copied
   into long term agent memory as permanent facts.

Initial agent assignment should keep the current AO Project to runtime
association and current Worker and Reviewer selection logic. The conversational
Orchestrator should not name provider agents directly in the first slice.

Configure a dedicated AO Orchestrator agent. Do not reuse the rehearsal agent.
The rehearsal agent is an execution endpoint whose policy isolated exact turns
serve Workers and Reviewers. Combining that role with a long lived operator
conversation risks thread ownership, busy state, and capability confusion.

The dedicated agent should reuse `AgentProcess`, provider lifecycle, Telegram,
session continuation, and bus delivery. Its instructions should be narrower
than the general organization Orchestrator template. Disable unrelated chief of
staff schedules and agent creation behavior for the initial AO product profile.
The current source has no Codex variant of the Orchestrator template, so Phase
27B must either use the supported Claude Code template or add a separately
reviewed Codex template before selecting Codex.

## 8. Telegram recommendation

Conversational Telegram inbound should route through CortextOS to the one
designated AO Orchestrator. AO should not run a second `getUpdates` loop.

AO should continue to own:

- durable notification intent;
- event key dedupe;
- delivery state;
- Needs Me and completion semantics;
- the set of valid human actions;
- approval and guidance mutations.

CortextOS should own:

- bot credentials and polling;
- inbound allowlist enforcement;
- update offsets and ordered redelivery;
- media download transport;
- outbound API calls and rate limiting;
- callback receipt and agent session injection.

One bot can support conversation and AO notifications safely if CortextOS is
the sole poller and callback router. Callback data needs a separate bounded AO
namespace. A callback must call the AO application command first. CortextOS may
then update the displayed button state from the AO result. It must not resolve
a generic CortextOS approval and assume the AO transition succeeded.

Natural language such as "continue" or "approve" should enter the persistent
Orchestrator conversation. The Orchestrator reads the valid AO actions, asks for
clarification when more than one target is possible, and obtains the required
human confirmation record. It then calls the AO command. A bare word without an
unambiguous target must not mutate AO.

The current direct `TelegramOperatorNotifier` is a migration candidate. During
a staged migration, preserve its durable AO delivery records and change only
the transport implementation to call CortextOS outbound messaging. Do not run
both transports for the same event key.

## 9. Inputs, URLs, preview, and publish

### Job inputs

Add an AO owned `JobInput` model after the first 27B slice. It should record:

- input ID and optional proposal or Job association;
- original name and media type;
- byte size and content hash;
- provenance such as AO Web upload, Telegram message reference, or approved
  external import;
- immutable local content reference below an AO controlled root;
- scan or validation status;
- created by principal and timestamp.

AO Web uploads should enter this service directly. Telegram media can reuse the
CortextOS download transport, then hand the bytes and Telegram provenance to AO
ingestion. External URLs and Google Drive links require an operator authorized
ingress adapter that downloads once, validates size and type, hashes the bytes,
and stores a local bounded input. Workers receive only AO input IDs and approved
local paths. Worker network access is not needed to consume these inputs.

### Preview

Store a validated preview profile with the AO Project or repository binding.
The profile names an allowlisted command, expected port behavior, and artifact
cleanup rules. `ao.preview.request` may start it only for the exact isolated
workspace and exact evidence revision that reached Ready for Approval. Preview
state is operational and must not approve, complete, commit, merge, or publish a
Job.

### Publish

Add a durable promotion request that names the Job, workspace, reviewed evidence
digest, base revision, allowed paths, and target branch. The Orchestrator can ask
AO to present "Approve and Publish" but cannot run Git. Human approval creates a
separate durable decision. A promotion application service then revalidates the
exact workspace, build evidence, remote ancestry, and fast forward condition
before calling a narrow Git promotion adapter. The result and deployment
observation remain durable AO evidence.

## 10. Duplication findings

| AO or dashboard functionality | CortextOS overlap | Recommendation | Migration risk | Timing |
| --- | --- | --- | --- | --- |
| AO direct Telegram transport in `TelegramOperatorNotifier` | CortextOS already owns Telegram API, bot polling, rate limiting, and logs | Keep AO intent and dedupe. Move delivery to a CortextOS outbound transport adapter | Medium. A dual sender can duplicate real notifications | After the 27B conversation path proves one bot ownership |
| A new AO chat transcript store, if contemplated | Provider native history plus CortextOS inbound and outbound JSONL already exist | Do not build it. Store only turn to Job links and read history through a port | Low if avoided now, high after two histories drift | 27B |
| A new AO Orchestrator LLM service, if contemplated | CortextOS `AgentProcess` and provider PTYs already provide it | Do not build it | High because lifecycle and restart semantics would diverge | Never unless source constraints change |
| Dashboard message send route | Reimplements bus write and process wake behavior | Reuse only UI. Replace server route use with a CortextOS conversation port | Medium. Existing dashboard behavior must remain intact during migration | AO Web 27B, CortextOS dashboard later |
| Dashboard history and stream routes | Directly read CortextOS logs | Move equivalent behavior behind the conversation port | Low for AO Web, medium if changing the existing dashboard | AO Web 27B |
| AO Web `server.ts` composition | Imports SQLite, Git, CortextOS, and execution implementations | Move concrete assembly into a separate local launcher or composition package. Keep AO Web dependent on application interfaces only | Medium because startup and shutdown wiring move | Early 27B architecture step |
| CortextOS task records for AO execution | Superficially overlap Jobs | Deliberately do not map AO Job truth into tasks. Optional one way projection may link an AO Job for fleet visibility | High if treated as bidirectional authority | No authoritative migration |
| CortextOS approvals for Ready for Approval or Needs Me | Superficially overlap AO human gates | Use only as presentation or callback transport after AO action validation | High if generic approval status becomes source of truth | After typed AO actions exist |

## 11. Concrete Phase 27B plan

1. Add architecture tests that forbid AO Web from importing SQLite, Git,
   daemon, PTY, and execution adapter modules. Move current concrete assembly
   from `apps/ao-web/src/server.ts` into a local launcher composition root.
2. Define `CortextOSConversationPort` in an AO facing contract package and a
   thin `OrchestratorConversationApplication` in the AO application package.
   Model only designated agent identity, send receipt, turn observation,
   history cursor, and conversation to Job links. Do not model an LLM.
3. Implement the CortextOS adapter by reusing designated Orchestrator lookup,
   persistent `AgentProcess` injection, provider session continuation, existing
   message logs, and outbound stream behavior. Add idempotent client request
   handling and a stable turn reference where the provider supports it.
4. Configure one dedicated AO Orchestrator with a narrow AO role. Use the
   supported Claude Code Orchestrator path initially unless a Codex template is
   deliberately added and reviewed. Disable unrelated schedules and broad
   chief of staff workflows.
5. Add a provider neutral AO command handler for only:
   `ao.projects.list`, `ao.projects.get`, `ao.jobs.propose`, `ao.jobs.create`,
   `ao.jobs.get`, `ao.jobs.list`, and `ao.jobs.status`. Expose it through a
   bounded local CLI adapter and document it in the Orchestrator tool skill.
6. Make Job creation proposal based. The proposal captures exact task text,
   acceptance criteria, Project, repository, execution mode, and policy
   summary. Creation requires a matching operator confirmation and idempotency
   key. Reuse `previewTask` and `runOperatorJob` below this boundary.
7. Add an AO Web chat pane by adapting the existing CortextOS dashboard chat
   component patterns. AO Web calls only the conversation and Operator
   application interfaces. Show linked Job cards from AO read models.
8. Add deterministic tests for restart continuation, duplicate client request,
   ambiguous Project, one request split into several proposals, confirmation
   mismatch, Job linkage, runtime offline, and an AO validation rejection that
   the Orchestrator cannot override.
9. Run one local rehearsal with no repository mutation: discuss Duck Face,
   propose Jobs, confirm exactly one harmless repository read only Job, observe
   it in AO, and verify the same conversation resumes after a canonical daemon
   restart. This live proof requires separate authorization.
10. Add guidance and continuation commands only after the creation and status
    slice is stable. Inputs, preview automation, and publish follow in separate
    phases.

Phase 27B success is one persistent conversation that identifies Duck Face,
asks only necessary questions, creates confirmed AO Jobs through the
application boundary, and displays their durable AO status. Attachments,
automatic preview, and publish are intentionally outside that first slice.

## 12. Risks and open questions

1. **Turn identity for Claude Code conversation.** Codex app server has native
   thread and turn IDs, but the current Orchestrator template cannot use that
   runtime. The Claude conversation adapter needs a stable completion receipt
   or a clearly labeled weaker conversation reference. This does not affect AO
   Worker Dispatch correlation, which remains on the existing exact path.
2. **Orchestrator permissions.** The general Orchestrator template assumes a
   broad chief of staff role and Claude Code may run unattended. The dedicated
   AO profile needs a reviewed permission posture, a dedicated working
   directory, no repository checkout, and no direct AO state path as a tool.
3. **Single writer and busy turns.** Telegram, AO Web, and schedules can all
   inject into one agent. The conversation port needs ordered admission and a
   visible busy state so messages are not combined into the wrong turn.
4. **Transcript semantics.** Current history merges transport JSONL, while the
   provider session is the real reasoning history. The adapter must define how
   non Telegram AO Web messages and assistant output are logged once without
   creating a second transcript authority.
5. **Confirmation binding.** A human confirmation must bind to exact proposed
   content and Project. Natural language acknowledgement alone is not a durable
   security token.
6. **One bot migration.** Existing AO Telegram notification credentials may be
   separate from the CortextOS Orchestrator bot. Consolidation needs a planned
   credential and event ownership migration with no period of dual polling or
   duplicate sends.
7. **Multiple Orchestrator templates.** The CLI permits several agents created
   from the Orchestrator template but organization context designates one. AO
   must resolve the designated identity and reject ambiguity.
8. **Existing AO Web composition root.** The current concrete imports are a
   source proven boundary violation relative to the Phase 27 constraint. Moving
   them should precede chat work, but must not change proven execution behavior.

## 13. Repository changes and validation

Phase 27A adds only this audit and design document. It changes no application,
runtime, provider, Telegram, bus, persistence, or execution code. No live Job,
Worker, Reviewer, Telegram message, commit, merge, or push is part of this
phase.
