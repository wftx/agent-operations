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

Configure dedicated Operator credentials outside Git:

```text
AO_TELEGRAM_BOT_TOKEN
AO_TELEGRAM_CHAT_ID
```

Both values are required; if neither is set, delivery is recorded as skipped.
A failure is recorded for operator visibility and never changes Job or
Escalation truth. Phase 22 does not send interactive Telegram actions and does
not reuse an agent's inbound bot configuration implicitly.

## Fixed MVP safety defaults

- filesystem: `read-only`
- network: `deny`
- environment: `empty`
- tools: bounded repository list/read/search only
- Worker Attempts: at most 2
- Reviewer passes: 1 per Worker Attempt
- automatic completion: only after Reviewer `PASS`

There is no write mode, general queue, scheduler, concurrent Job execution,
interactive Telegram approval, production authentication, or remote deployment
in this MVP. Starting the AO web surface does not start CortextOS. If the
Runtime indicator is offline, start the development runtime separately using
the documented CortextOS lifecycle.
