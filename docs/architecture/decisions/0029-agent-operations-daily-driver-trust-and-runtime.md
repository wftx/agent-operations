# ADR 0029: Agent Operations Daily Driver Trust and Runtime

## Status

Accepted

## Context

Agent Operations can execute exact, bounded read only and isolated write work,
but its previous uniform two Worker budget and manual recovery boundaries made
routine work interrupt the operator too often. The existing execution,
workspace, review, and publication boundaries remain necessary.

## Decision

AO adds durable Trust Profiles at global, Project, and Job scope. A Project may
override the global default. A Job may restrict but never expand the effective
policy. Conservative preserves the prior operating posture. Daily Driver allows
bounded Green read only and Yellow isolated work, including normal Reviewer
revisions, previews, builds, tests, and safe stale runtime recovery. Custom is a
bounded application contract for advanced configuration.

Green read only work has a maximum of five Worker executions and five Reviewer
cycles. Yellow isolated write work has a maximum of three of each. Repeated
nonprogress may stop before the ceiling. Attempts remain immutable, every cycle
uses a fresh Plan and Dispatch, and accepted or uncertain Dispatches remain
ineligible for resend.

Red authority is invariant. Production publication, protected branch mutation,
credential changes, consequential external messages, spending, important
deletion, and irreversible production changes always require explicit human
approval outside autonomous Trust Profile permission.

AO classifies Needs Me records into machine resolvable, operator resolvable,
and terminal categories. Machine reconciliation is permitted only through
existing exact evidence and bounded lifecycle operations. Runtime freshness
compares the control plane expected code revision and dynamic tool catalog with
the live dedicated Orchestrator. A canonical restart is allowed only when the
effective profile permits it and no submitting, accepted, or uncertain provider
execution is active.

The configured Worker and Reviewer capacity retains the legacy
`agent-operations/rehearsal` identity. Under Daily Driver, AO may enable and
start that execution only agent when a Job requires it, provided its Telegram
polling and schedules are both disabled. This name does not make the runtime a
test only resource and does not merge it with the persistent Orchestrator role.

Authenticated Preview Sessions store secret browser state only in restrictive
installation local storage. Durable records contain safe identity, scope,
status, and expiry metadata. The model, tools, evidence, logs, and Telegram never
receive the secret material. Reuse is limited to one exact Project, Preview
Profile, and loopback origin.

CortextOS owns Telegram transport and routes inbound messages to the existing
persistent AO Orchestrator. AO remains the sole durable authority for guidance,
budget extensions, Jobs, reviews, and action approval. Deterministic inbound
message identities suppress duplicate provider submissions. Telegram does not
grant Red authority.

## Consequences

Routine reversible work can proceed with fewer interruptions while execution,
repository isolation, independent review, and human production approval remain
intact. Trust policy, Jobs, Inputs, and Evidence identity stay independent of
machine paths. Repository bindings, active processes, and authentication secret
material remain node local. Distributed scheduling and storage remain outside
this decision.
