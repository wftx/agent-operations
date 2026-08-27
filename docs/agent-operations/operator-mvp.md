# Agent Operations Operator MVP

The Operator MVP is a separate local mission-control surface for durable Agent
Operations Jobs. The existing CortextOS dashboard remains the runtime
diagnostics surface.

## Start the local web UI

First ensure the normal Agent Operations durable state already contains a
configured Project with a repository and runtime. Starting the UI does not run
state sync and does not start CortextOS.

```bash
npm run dev:ao-web
```

Open `http://127.0.0.1:4310`. Set `AO_WEB_PORT` to choose another local port.
The server always binds to `127.0.0.1`; Phase 21 does not expose a public
listener or add authentication.

Jobs, Running, Needs Me, Done, Job detail, manual refresh, and Preview only read
AO durable state. Preview creates no Job, Plan, or Dispatch. **Run Job** is the
only web action that creates a Job and invokes orchestration.

## CLI

List the configured choices and existing work:

```bash
npm run ao -- projects
npm run ao -- jobs
npm run ao -- jobs --filter needs-human
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

## Fixed MVP safety defaults

- filesystem: `read-only`
- network: `deny`
- environment: `empty`
- tools: bounded repository list/read/search only
- Worker Attempts: at most 2
- Reviewer passes: 1 per Worker Attempt
- automatic completion: only after Reviewer `PASS`

There is no write mode, queue, scheduler, automatic page polling, escalation
approval action, production authentication, or remote deployment in this MVP.
