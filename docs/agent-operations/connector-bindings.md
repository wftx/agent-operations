# Authenticated Connector Bindings

AO owns its connection independently of Codex hosted connectors. No hosted
connector credential is copied, imported, or impersonated. Connections do not
create Jobs, grant Red approval, or execute external actions.

## Operator setup

Open **Settings / Connections / Zoho Invoice** at
`http://127.0.0.1:4310/settings/connections/zoho-invoice`.

Register a Zoho **Server based Application** in the API Console for the account's
data center. Register this exact callback:

`http://127.0.0.1:4310/settings/connections/zoho-invoice/callback`

Enter Client ID and Client Secret in the local password fields, the nonsecret
Zoho Invoice Organization ID, and the data center. Save, then select **Connect
Zoho Invoice** and complete consent. Secrets are not echoed after save. Do not
paste credentials into a conversation, repository, command, or Telegram.

Requested OAuth scopes are exactly:

* `ZohoInvoice.customerpayments.READ`
* `ZohoInvoice.estimates.READ`
* `ZohoInvoice.invoices.READ`

OAuth uses offline access and a single use, expiring state bound to an HttpOnly
browser cookie. Code exchange happens once. Access tokens refresh on bounded
use or explicit verification, not page refresh. Permanent refresh failures show
"Zoho Invoice connection needs reauthentication." Network failures remain
unavailable and do not retry the failed request. Missing, extra, or wrong token
scope evidence fails closed. No settings, profile, or mutation scopes are added.

Zoho organization list/get requires `ZohoInvoice.settings.READ`. Consequently AO
does not enumerate organizations or claim a verified company name. It verifies
access to the operator-selected Organization ID with one bounded read of each
allowed collection. This ID and data center are then pinned to the action binding.
Changing account after pinning requires a separate explicit account migration;
reconnecting cannot silently redirect the existing production action.

## Storage and boundaries

Migration 22 adds `connector_bindings` and `connector_action_links`. SQLite holds
only strictly validated metadata: stable binding ID, installation identity,
provider, data center, Organization ID, scopes, timestamps, status, health, and
an opaque credential reference. It has no tokens, client configuration, code,
OAuth state, or secret paths. Existing Jobs and execution history are unchanged.

The node stores credentials separately in
`~/.agent-operations/connector-secrets/` (or the configured AO state directory).
The directory is mode 0700, files mode 0600, owned by the current OS user.
Credential reads reject symlinks, hard links, oversized files and loose modes.
Atomic replacement prevents partial secret writes. An exclusive credential
lock prevents concurrent callback/refresh operations across processes. A crashed
owner leaves a fail-closed lock for explicit inspection; it is never guessed
stale and removed by a retry. Filesystem protection is not encryption at rest:
the OS account and disk security remain trusted boundaries.

Disconnect deletes only this connector's local credential file. To revoke the
grant at Zoho, use Zoho Accounts connected applications. Deleting local material
does not falsely claim remote revocation. No credentials enter the agent env,
tool projections, logs, Telegram or Job receipts. Do not place the configured
state directory inside a source repository or expose it as an AO Project.

The callback origin is injectable through `AO_ZOHO_CALLBACK_URL`; nonlocal
callbacks must be HTTPS. Changing storage location or callback does not change
connector identity. Hosted authentication/session infrastructure and distributed
secret replication are not implemented. Current production serving remains
loopback only. A future hosted deployment must supply authenticated operator
sessions before exposing credential entry beyond this node.

## First External Action integration

The trusted host connects `action:frusterio-pulse:production-zoho-sync:v1` and
`binding:frusterio-pulse-production-sync` to the verified node connector. The
exact connector/account link is pinned only after successful verification. Its
executor resolves only that registered action and exact approved scope hash.
The Orchestrator sees connection status, scopes and a Connections link through
`ao.actions.list`, never credential references or credential operations.

The closed action reads all pages of payments, estimates and invoices, posts one
normalized payload to `https://frusterio-pulse.netlify.app/api/internal/sync`, then
reads aggregate verification evidence. Zoho writes are unavailable. There are no
arbitrary URLs, methods, Git operations, shell commands or automatic retries.
The existing durable execution claim and immutable receipt enforce at most one
invocation of an approved action plan, including duplicate requests.

The destination secret is privately loaded only during an authorized execution
from `AO_PULSE_SYNC_SECRET_FILE`, defaulting to the existing Pulse `.env.local`.
That file must be owned by this OS user with no group/other permissions and no
symlink. Only `SYNC_SECRET` is used. Missing/insecure destination credentials
must be resolved before a live invocation. Connecting Zoho alone is not proof
that Pulse credentials, runtime freshness or existing Red authorization are valid.

This implementation stops after publishing and exposing Connections. It does
not convert, continue, replace or execute the existing sync Job on callback.

## Verification

Tests use injected fake transports with fixed fake credentials. They do not
contact Zoho or Pulse. Run the connector, AO Web and External Action tests, then
the normal architecture, typecheck, AO, full repository and build validation.

References: [Zoho Invoice OAuth](https://www.zoho.com/invoice/api/v3/oauth/),
[Zoho organization scopes](https://www.zoho.com/invoice/api/v3/organizations/).
