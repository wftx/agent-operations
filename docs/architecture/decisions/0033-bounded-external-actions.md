# ADR 0033: Bounded external action Jobs

Status: Accepted

## Decision

External operational actions are not repository edits. `external-action` Jobs have an immutable Project action snapshot, closed string enum parameters, an opaque host binding ID, risk tier, exact systems read and written, mutation scope, credential requirement names, retry policy, and expected evidence. A Project needs no repository for this mode.

The Orchestrator can discover configured actions and request a Job. It cannot register an action, supply credentials, select arbitrary connectors, approve, or execute one. A request is not approval. The initial implementation requires exact human approval for every risk tier, including Red. The approval binds a SHA256 of the complete action definition and exact parameters, an actor, timestamp, and durable reference. Existing authorization may be reused by the trusted application after auditing equal or narrower scope. Model statements of approval are not sufficient.

Action definitions are immutable. Changing the target, binding, parameter vocabulary or scope requires a new action version and approval. Credential values belong only in the host adapter, never in definitions, tool arguments, receipts, or conversational context.

SQLite transactions create the Job, immutable plan, and Operator Run together. A durable exclusive claim precedes executor invocation. Repeated requests use a stable intent key. Repeated approval does not execute anything. Duplicate execute requests cannot acquire a second claim. An uncertain or already claimed action cannot be retried, retired or sent to a Worker.

Receipts atomically finalize the action and Operator Run, and complete the Job only after passed deterministic verification. They record action, Project, approval, exact scope, executor, timestamps, systems, counts, safe error codes, optional external identity and payload hash. Connector response bodies and error strings are never persisted. Telegram uses the normal notification system, with deterministic verification language rather than a fabricated Reviewer PASS.

The repository Worker runner skips external actions. It cannot assign repository privileges or create provider Attempts for this mode. The external executor registry is a trusted composition seam, not a model selected connector catalog. Missing bindings fail preflight without invoking a provider or external action. The Web action page shows exact scope, approval and immutable receipt. Refresh does not execute.

## Correcting misclassification

Existing Job execution modes remain immutable. A zero Attempt, zero workspace repository Job can be superseded by exactly one linked external Job in a transaction. The original mode, description, acceptance criteria and approval history remain intact. The old run closes and obsolete escalations resolve; its retirement links to the successor. Any prior Attempt, workspace or retirement blocks this correction. Unique predecessor and request keys prevent multiple successors.

## Runtime identity

The canonical CLI is a supervisor which launches `dist/daemon.js`. Agent processes report the SHA256 of that daemon executable captured at startup. Comparing it to `dist/cli.js` incorrectly reported a stale runtime after every healthy restart. The composition root now hashes `dist/daemon.js`. Tool catalog verification and exact code hash equality remain mandatory. A changed daemon still fails freshness until a safe canonical restart.

## Current integration boundary

`ZohoInvoiceSyncExecutor` implements the closed deterministic workflow behind typed source and destination bindings. Its source permits only paginated payments, estimates and invoices reads. Its destination permits one normalized POST and aggregate readback. No shell, filesystem, arbitrary MCP operation or credential catalog is exposed. `FixedSyncHttpBinding` pins an HTTPS sync endpoint, refuses redirects, bounds requests/responses, uses a private credential callback, and never retries.

The default AO composition does not invent or borrow a Codex plugin session as a server credential. A host must supply a verified account source binding and exact destination binding before the action becomes executable. Merely discovering a Zoho tool in an operator's Codex session does not configure that integration in the AO server. Until then, action preflight reports unavailable and preserves approval. This is intentionally not an integrations marketplace or automatic credential export mechanism.

## Limits

All automatic retries remain zero, including for upsert based syncs. Execution has a fifteen minute deadline and propagates cancellation to bound integrations. Expired claims recovered after a server restart become durable uncertain receipts and Needs Me, never another invocation. A process that loses a response after a claim must preserve uncertainty and reconcile independently, never resend. This first version does not implement generic external outcome reconciliation, distributed executors, scheduled execution, or automatic transfer of credentials between applications.
