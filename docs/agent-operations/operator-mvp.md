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
- **Cancel Job** is available only when no Attempt or uncertain Dispatch may
  still be executing. It preserves the complete history.

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

## Telegram notifications

The Telegram adapter is notification-only. It sends once for a newly unresolved
Needs Me escalation and once when an operator-submitted Job completes. Worker,
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

Telegram failure is delivery truth only: it is recorded as failed, is not
automatically retried, creates no Needs Me item, and never changes Job,
Escalation, Review, or orchestration truth. AO durable state remains
authoritative whether Telegram is configured, unavailable, or rejected.

## Fixed MVP safety defaults

- filesystem: `read-only`
- network: `deny`
- environment: `empty`
- tools: bounded repository list/read/search only
- Worker Attempts: at most 2
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
at a time. Cleanup is explicit, refuses a dirty or mismatched worktree, removes
only a proven AO owned worktree, and preserves the dedicated branch and durable
evidence.

There is no automatic merge, general queue, scheduler, concurrent write Job
execution, interactive Telegram approval, production authentication, or remote
deployment in this MVP. Starting the AO web surface still does not start
CortextOS.
