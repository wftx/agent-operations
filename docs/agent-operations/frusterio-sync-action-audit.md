# Frusterio Pulse production sync audit

Audited on 2026-09-04 using the existing checkout. No Frusterio source changes or production actions were performed by this audit.

## Actual architecture

Source evidence: `docs/zoho-sync-agent.md`, `scripts/normalize-zoho.mjs`, `scripts/sync.mjs`, `app/api/internal/sync/route.ts`, `lib/sync/upsert.ts`, `lib/sync/run.ts`, and dashboard aggregate queries.

Zoho Invoice payments, estimates and invoices are read through the connected Zoho MCP account. All pages are required. A full scan of invoices includes paid and void records so previously outstanding balances can be reconciled. The mapping to the normalized Pulse envelope is executable and deterministic; an LLM Worker is unnecessary.

The destination documented by the repository is `https://frusterio-pulse.netlify.app/api/internal/sync`. Its authenticated POST writes normalized payments, estimates and invoices to the Pulse production database, then records sync history. Authenticated GET reads aggregate financial totals and last successful sync time. The secret grants financially sensitive aggregate reads as well as ingestion writes.

Zoho records are NOT modified. There is no Zoho create, update, delete or email step. No deployment or repository change is required.

## Idempotency and failure caveat

Financial rows are upserted by Zoho ID in one batch transaction. They are not deleted when missing from a later payload. Duplicate IDs within a payload are collapsed by the server. Repeated identical payloads do not duplicate financial rows, but they do create further sync history and may change metadata.

`recordSuccess` happens after `upsertAll`, in the same JavaScript try block but outside the financial transaction. If recording success fails after the batch commits, the catch can return `sync_failed` even though financial data has already changed. Therefore the documentation's blanket statement that every 500 means no data changed is not sufficient execution evidence. AO treats an ambiguous POST result as uncertain and never automatically retries it. No website fix is included in this AO task.

Success evidence must include exact read and upsert counts for all three record types, zero rejections, payload SHA256, timestamp correlation, and independent aggregate readback. The endpoint does not distinguish created versus updated rows and does not return a database sync run ID. AO must not invent those counts or IDs; its receipt can use the returned sync timestamp as the external execution reference.

## Host integration findings

The Codex session exposes Zoho Invoice read tools for the three record types. The repository's local environment file contains a `SYNC_SECRET` key. Values were not printed. The AO organization and dedicated Orchestrator environment files do not contain a Zoho source credential binding, and the inspected Codex MCP configuration has no directly reusable Zoho server entry.

An authenticated Codex plugin connection is not an AO server transport. Its credentials must not be extracted or copied. The bounded executor accepts a host provided verified Zoho read binding and a fixed Pulse destination binding. Production invocation remains blocked until both are available and the connected account and destination are verified. No sample or stale payload may be used as a substitute.

## Authorization scope

The original Job authorizes the supported full production sync using existing credentials, with no retries or unrelated changes. Reading Zoho and ingesting the resulting financial data into Pulse is the documented sync requested by the operator, not authority to mutate Zoho itself. The existing approval can be referenced for this equal or narrower audited action, conditioned on exact account and destination verification. No new authorization is needed merely because the execution mode was corrected.
