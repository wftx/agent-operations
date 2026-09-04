# ADR 0032: Runner control and atomic retirement

## Decision

Retirement is an execution lifecycle operation, not just a display filter. SQLite
commits the retirement record, cancellation of nonterminal Job and Operator Run,
and resolution of obsolete escalations in one transaction. Existing completed
results and all Attempts, Plans, Dispatches and reviews remain unchanged.
Retirement refuses active prepared, accepted, submitting or uncertain execution.
Workspace cleanup remains behind the existing safe workspace lifecycle.

The runner checks retirement before and after asynchronous readiness checks.
Repeated retirement repairs historical orphan run ownership without new execution.

AO Web owns one durable runner heartbeat. Tool compositions do not own or start
another runner. Expired heartbeats mean Waiting for runner, not provider execution.
An administrative pause persists across process restart and requires explicit
human resume. A scoped maintenance pause is visible, has a one minute deadline,
and expires automatically only under the global Daily Driver profile. Canonical
startup restores normal execution unless an administrative pause exists. Shutdown
marks the owner stopped without removing the administrative pause. A live owner
cannot be replaced by another Web process.

Queue acceptance is called Queued, Waiting for runner, or Execution paused.
Dispatching and Provider Accepted refer only to authoritative Dispatch state.
Provider submission counts do not establish external tool execution or production
mutation. Both Web and the Orchestrator status projection preserve this distinction.

An application preflight can hold an unexecuted Job atomically in Needs Me without
creating a Worker Attempt or contacting a provider. Required external capabilities
must exist independently of the human authorization. Repository write Jobs still
deny network, credentials and arbitrary shell; they are not production sync jobs.
An unsupported production action must remain held rather than be recast as code
editing or delegated to a Worker that cannot perform it.

## Scope

This does not add a Zoho executor, credentials, network permissions or a new Job
execution mode. Production operations require a separately bounded action adapter
with target validation, approval binding, exact execution receipts and verification.
