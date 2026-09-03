# Agent Operations Daily Operator Workflow

The Operator MVP is a separate local mission-control surface for durable Agent
Operations Jobs. The existing CortextOS dashboard remains the runtime
diagnostics surface.

## Start the local web UI

First ensure the normal Agent Operations durable state already contains a
configured Project with a repository and runtime. Starting the UI does not run
state sync and does not start CortextOS.

```bash
npm run ao:web
```

Open `http://127.0.0.1:4310`. Set `AO_WEB_PORT` to choose another local port.
The server always binds to `127.0.0.1`; Phase 22 does not expose a public
listener or add authentication.

Jobs, Running, Needs Me, Done, Job detail, refresh, and lightweight Running-page
polling only read AO durable state. Preview creates no Job, Plan, or Dispatch.
**Run Job** durably accepts a Job and returns immediately; the one-process local
runner continues Worker and Reviewer work after the HTTP request ends.

## Exact local previews and browser evidence

A Job may require a browser render at one repository relative route and bounded
viewport. AO keeps detected preview script candidates separate from a durable
Preview Profile. The command is validated only after an explicit preview start
or as required by an authorized Job. It runs as tokenized process arguments,
never through a shell, and binds only to a dynamic `127.0.0.1` port.

Read only Jobs use a clean detached AO worktree at one verified commit. Write
Jobs use their existing isolated Job worktree. The primary checkout is never a
preview execution root. AO records both the commit and a source state hash so a
render cannot be attributed to a changed worktree.

The Job detail page offers explicit Start Preview and Capture Evidence actions.
Loading or refreshing any page starts nothing. The bounded browser can access
only the exact Preview Session origin. It blocks external URLs, other local
ports, file URLs, downloads, and redirect escapes. Evidence includes the route,
viewport, title, final URL, visible text, console failures, failed resources,
screenshot dimensions, byte size, SHA 256, and a durable evidence hash.

Screenshot bytes use the existing immutable Input storage boundary. Workers and
Reviewers receive only the bounded Browser Evidence record and the attached
screenshot Input ID. AO storage paths are never exposed. A Job with a required
browser render stops before provider execution if preview or capture cannot be
proven for the exact source state.

If the runtime is offline, **Start Runtime** is the only web action that may
start CortextOS. It is an explicit POST action. Page load, refresh, status
inventory, previews, and Job detail reads never start a process. The lifecycle
adapter inventories the configured agents, cron count, integration count, and
current owner before it uses the canonical `node dist/cli.js start
--foreground --instance default` path. It resolves Codex from
`AO_CODEX_EXECUTABLE`, then `PATH`, then the packaged ChatGPT macOS candidate.
Missing Codex and early provider exit return bounded, credential-redacted
diagnostics. A healthy runtime or concurrent Start request never creates a
second daemon. Stop Runtime remains deferred until a comparably narrow
supported lifecycle can be proven.

The server resumes only Jobs with a durable Operator Run marker. It never scans
or executes unrelated historical ready Jobs. Exactly one Operator Run is active
at a time; this is a local continuation mechanism, not a general queue.

## Daily flow

```text
Submit Job
→ durable Operator Run
→ local runner
→ Worker / Reviewer
→ Done or Needs Me
```

If the web process restarts, it continues from AO-owned boundaries. Existing
accepted Dispatches are observed by their exact external reference and are
never resent. An uncertain Dispatch becomes Needs Me. Captured Worker results,
persisted Reviews, revision decisions, and a Reviewer PASS are reconciled
locally before any new execution state is created.

Needs Me offers only actions that are valid for that escalation:

- **Provide Guidance + Continue** persists up to 4,096 characters, resolves the
  original escalation without deleting it, and includes the guidance only in a
  new Worker Attempt and Plan. It is limited to human-judgment and Reviewer-
  uncertainty boundaries while the two-Worker budget remains.
- **Authorize 1 More Attempt + Continue** appears when a Reviewer requests a
  revision after the automatic two Worker execution budget is exhausted. It
  records one durable human budget extension for that exact escalation, accepts
  optional guidance, and permits one fresh Worker Attempt and Plan. The original
  automatic budget remains exhausted in history. Refresh never creates an
  extension, and another revision requires another explicit human decision.
- **Check Execution Again** is limited to a recoverable observation timeout and
  observes the existing accepted Dispatch without resending it.
- **Cancel Job** is available only when no Attempt or uncertain Dispatch may
  still be executing. It preserves the complete history.

The UI classifies each unresolved escalation as actionable continuation, human
approval, guidance required, budget extension required, or terminal. It offers
only actions supported by the underlying durable state. Ready for Approval and
uncertain Dispatch states never present a generic Continue action.

## CLI

List the configured choices and existing work:

```bash
npm run ao -- projects
npm run ao -- jobs
npm run ao -- running
npm run ao -- jobs --filter needs-human
npm run ao -- needs-me
npm run ao -- done
npm run ao -- show <job-id>
npm run ao -- runtime
```

Preview task intake without creating a Job:

```bash
npm run ao -- run \
  --project agent-operations \
  --repository remote:github.com/wftx/agent-operations \
  --task "Find where execution reviews are stored." \
  --acceptance "Identify the authoritative file and PASS / REVISION_REQUIRED / ESCALATE."
```

Live execution is separately guarded by `--execute --confirm ORCHESTRATE`.
Do not use those flags without explicit authorization for that live Job.

Guided continuation and cancellation use explicit escalation commands:

```bash
npm run ao -- guide <escalation-id> --instruction "Use the documented behavior."
npm run ao -- cancel <escalation-id>
```

The CLI waits while execution runs because it is a short-lived process. Use
`npm run ao:web` for durable daytime operation that survives browser closure.

## Daily Driver trust and autonomy

Trust Profiles define whether AO may proceed with already bounded actions
without another operator interruption. The global profile is the default. A
Project may override it, and a Job may only restrict the effective policy. A
Job can never widen its Project or global ceiling.

The Conservative preset keeps the previous two Worker execution ceiling and
requires explicit continuation. The Daily Driver preset allows routine Green
read only work for up to five Worker and Reviewer cycles and isolated Yellow
write work for up to three cycles. These are ceilings, not targets. Repeated
Reviewer feedback that is not producing progress stops early. Every revision
still creates a new immutable Attempt, Plan, Dispatch, and exact provider turn.
Accepted or uncertain Dispatches are never resent.

Red actions always require human approval. Trust Profiles cannot authorize a
production publish, protected branch push or merge, consequential external
message, credential change, purchase, important deletion, destructive
production data change, or irreversible live system change.

Needs Me reasons are classified as machine resolvable, operator resolvable, or
terminal. AO may reconcile exact late results, clean known ephemeral output,
refresh validated evidence, or restart stale runtime code when policy permits
and no accepted provider work is active. Missing human judgment, ambiguous
intent, unavailable resources, preview authentication, and Red authority still
come to the operator with a concrete action. The escalation store suppresses a
second unresolved record for the same Job, Attempt, and reason.

AO Web exposes the effective Trust Profile and a compact Daily Driver summary.
The metrics report Jobs, autonomous completions, human interventions, Worker
executions, Reviewer revisions, recoveries, provider submissions, and time to
result. They are operational counts, not user analytics.

## Runtime freshness

Before starting eligible work, AO compares the expected application revision
and dynamic tool catalog with the running dedicated Orchestrator. Daily Driver
may use the canonical lifecycle restart only when no running Attempt has a
submitting, accepted, or uncertain Dispatch. Active or potentially accepted
work produces Restart pending and is left alone. After restart, AO verifies the loaded revision and catalog before
resuming durable work. A mismatch that cannot be resolved safely stops before
new provider submission.

## Authenticated preview sessions

A Preview Profile may declare that human login is required. AO Web then offers
Authenticate Preview, Verify Login, and Revoke Session actions. Authentication
opens a visible controlled browser for the exact local Preview origin. The
human completes login directly in that browser.

Only safe metadata is durable: authentication session ID, Project, Preview
Profile, exact origin, installation, state, timestamps, and expiry. Browser
cookies, tokens, passwords, and storage remain in a restrictive node local
directory. They never enter model context, tool output, evidence, logs, or
Telegram. An expired, revoked, wrong Project, wrong profile, or wrong origin
session fails closed. A valid session may be reused only for bounded evidence
against that exact origin.

Project, Job, Input, Browser Evidence, and Trust Profile identity do not contain
personal machine paths. Repository and folder bindings, preview processes, and
authenticated session secrets are installation local. This preserves future
dedicated execution node placement without adding multi node coordination now.

## Telegram notifications and replies

The durable notification path sends once for a newly unresolved Needs Me
escalation and once when an operator submitted Job completes. Worker,
Reviewer, observation, repository-read, and turn-ID events are never sent.

Configure dedicated Operator credentials in the ignored local file
`.agent-operations/telegram.env`:

```dotenv
AO_TELEGRAM_BOT_TOKEN=<dedicated AO bot token>
AO_TELEGRAM_CHAT_ID=<dedicated AO chat ID>
```

Create the directory/file locally and restrict access before adding values:

```bash
mkdir -p .agent-operations
chmod 700 .agent-operations
touch .agent-operations/telegram.env
chmod 600 .agent-operations/telegram.env
```

Do not reuse an unrelated agent's bot configuration. Both dedicated values are
required. Existing shell variables take precedence over the local file, and no
credential value is shown by the health/test command or AO Web.

Preview configuration and the exact harmless message without network traffic:

```bash
npm run ao:telegram:test
```

A real connectivity check is deliberately separate and requires both gates:

```bash
npm run ao:telegram:test -- --send --confirm TELEGRAM_TEST
```

The test performs at most one request and never retries. It creates no Job,
Attempt, Plan, Dispatch, Review, or Escalation. Immutable, credential-redacted
test receipts are stored under the local Agent Operations state directory in
`notification-tests/`; they are not replayed on restart. Restart AO Web after
adding or changing credentials so its process receives the new configuration.

Normal notifications occur only for Job completion and newly created Needs Me
escalations. Intermediate Worker/Reviewer activity, previews, runtime health,
reconciliation checks, and the Telegram dry-run do not notify. Durable delivery
event keys allow one completion notification per completed Job and one Needs Me
notification per escalation, including across reload/restart.

When inbound Telegram polling is explicitly enabled for the dedicated
Orchestrator, CortextOS routes a reply into that same persistent Orchestrator
session and exact correlated turn path used by AO Web. Telegram transport owns
no second AO transcript or Job state. The Orchestrator may query bounded AO
state, persist guidance, authorize exactly one additional Worker execution, or
open the human preview authentication flow through AO application tools.
Ambiguous replies require clarification. Telegram text cannot approve a Red
action or bypass durable AO authority. Redelivered Telegram updates use a
deterministic conversation identity and create no duplicate provider turn.

Telegram failure is delivery truth only: it is recorded as failed, is not
automatically retried, creates no Needs Me item, and never changes Job,
Escalation, Review, or orchestration truth. AO durable state remains
authoritative whether Telegram is configured, unavailable, or rejected.

## Daily Driver development principle

When a defect is narrow, well understood, low risk, generic, and covered by a
deterministic regression, fix it, validate it, publish it, and continue the
workflow. Use a new architecture decision only when domain or authority
boundaries materially change.

## Fixed capability boundaries

- filesystem: `read-only`
- network: `deny`
- environment: `empty`
- tools: bounded repository list/read/search only
- autonomous Worker executions: 2 in Conservative, 5 for Green Daily Driver
  work, and 3 for Yellow Daily Driver work
- additional Worker executions: one per explicit durable human authorization
- Reviewer passes: 1 per Worker Attempt
- automatic completion: only after Reviewer `PASS`

## Isolated Code Changes

The Operator mode selector offers **Repository Read Only** and **Code Change in
Isolated Worktree**. Previewing either mode creates no Job, workspace, Plan, or
Dispatch. Write capable Jobs execute in a dedicated AO Git worktree and Job
branch without modifying the operator's primary checkout. The Worker can write
only inside that isolated worktree, while the Reviewer remains read only.
Human approval is required before any future merge, and the Worker cannot
commit, merge, or push. A write Job uses these fixed boundaries:

```text
one durable Job
→ one AO owned Git worktree and deterministic branch
→ Worker with bounded patch and test tools
→ bounded diff and test evidence
→ independent read only Reviewer
→ Ready for Approval or Needs Me
```

AO creates worktrees under its machine local state directory, never inside the
tracked checkout. The Worker receives `workspace-write / deny / empty` and can
use only repository list, read, search, exact patch, allowlisted test, and read
only Git inspection tools. It cannot create, delete, rename, chmod, commit,
merge, rebase, push, use arbitrary shell, or enable network. The Reviewer sees
the same worktree with read only filesystem authority plus the captured files,
diff, and test evidence.

Reviewer `PASS` means Ready for Approval. It does not complete the Job, commit,
merge, or push. A revision uses the same worktree but a fresh Worker Attempt,
Plan, Dispatch, and exact provider turn. One active write workspace is permitted
per logical repository, with a separate machine ceiling of four active
workspaces. Unrelated repositories do not block one another. Cleanup is
explicit, refuses a dirty or mismatched worktree, removes only a proven AO owned
worktree, and preserves the dedicated branch and durable evidence.

Retiring a completed proof Job preserves its full audit history while releasing
a clean AO owned workspace. Active or uncertain executions and workspaces with
unique dirty changes cannot be retired. Archived Jobs remain available in the
historical operator view.

Restoring exact tracked files in a primary checkout is a separate Red action.
AO records branch, HEAD, Git status, file hashes, and the exact path list before
requesting human approval. The operation fails closed if any bound precondition
changes and never deletes untracked files or exposes broad Git cleanup commands.
After execution, AO preserves an immutable receipt containing approval identity,
before and after hashes, final Git status, and explicit commit, push, and deploy
effects. Completed actions that predate receipts can be reconciled only while
their current repository evidence still exactly matches the recorded result.

Exact factual verification can use this receipt and the bounded repository
adapter directly. Branch, HEAD, status classification, and file hashes do not
require a provider runtime. A Job may complete through this path only when its
criteria are fully expressed as exact repository assertions. Semantic review
continues to use the Worker and Reviewer model.

There is no automatic merge, same repository concurrent write execution,
interactive Telegram approval, production authentication, or remote deployment
in this MVP. Starting the AO web surface still does not start CortextOS.

## Conversational Orchestrator

AO Web includes one global **Orchestrator** conversation for natural language
Job intake. It delegates each message to the dedicated persistent CortextOS
agent named `ao-orchestrator`. CortextOS owns the provider process, session
continuity, and conversation records. AO does not create a second model loop or
store a duplicate transcript in SQLite.

The Orchestrator can list and resolve Projects, create a Job through the normal
Operator application service, and read current Job state. It receives no raw
SQLite, Git, repository, worktree, network, approval, completion, or publish
authority. Its generated Job links come from structured AO tool results. Job
state displayed beside those links is read from current AO truth.

One Orchestrator serves all Projects. An optional UI Project selection is only
a hint. Explicit Project references must still resolve to an exact AO Project
ID, and ambiguity requires a concise clarification rather than a guessed
mutation.

The web channel stores bounded turn projections and Job links under the
CortextOS agent state directory. Provider native history remains the continuity
source after restart. Loading or refreshing the page reads that state and never
starts the runtime or submits a turn.

The dedicated profile uses the existing authenticated Codex app server. Each
web message requires one exact provider turn on the persistent Orchestrator
thread. The thread is read only, denies network, inherits no environment, and
exposes only the bounded native Agent Operations tool namespace. The profile is
registered disabled until the separately authorized live proof.

The persistent thread state is bound to an exact hash of that native tool
catalog. CortextOS starts a new provider thread when the saved catalog hash is
stale, while AO Web rejects a running daemon that does not advertise the
catalog required by the current application build. This makes an application
restart requirement explicit instead of silently omitting newly added tools.

Daily Driver routes Telegram replies through this same CortextOS Orchestrator
while retaining AO notification intent, deduplication, and action authority.
Preview, visual review, and Approve and Publish remain separate authority
boundaries.

## Projects and Inputs

Projects provide durable operator context and are not limited to repositories.
A Project may use an existing Git repository, an existing local folder, or no
attached resource. Onboarding performs bounded read only inspection to create a
readiness Profile. It does not execute discovered commands, install
dependencies, create a worktree, or run a provider.

Files uploaded in AO Web and URLs explicitly authorized by the operator become
immutable AO Inputs outside source repositories. Input metadata records size
and hash without exposing the AO storage path. Conversation turns and Jobs
reference exact Input IDs. Workers and Reviewers can inspect only the Inputs
attached to that exact execution. An isolated write Worker may copy an attached
Input into its worktree through the bounded Input tool, but it receives no
access to unrelated Inputs or the operator's primary checkout.
