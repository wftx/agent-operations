# ADR 0022: Agent Operations Operator Notifications

- Status: Accepted
- Date: 2026-08-28

## Context

Agent Operations daily orchestration can continue independently of the browser
and can reconcile late exact executions after its bounded observation window.
The operator should not need to keep checking the local dashboard to learn that
a reviewed Job completed or that work stopped at a Needs Me boundary.

## Decision

Use a provider-neutral notification intent in the AO application layer, with
Telegram as the first delivery adapter:

```text
AO durable state
      ↓
Operator notification intent
      ↓
OperatorNotifier
      ↓
TelegramNotificationAdapter
      ↓
Telegram transport
```

Notify only when:

- an Operator Job completes after Reviewer `PASS`; or
- a durable Needs Me escalation is created.

Do not notify intermediate Worker, Reviewer, Dispatch, observation, runtime, or
repository-reader activity.

## State rule

Telegram is delivery only. Agent Operations durable Job, Attempt, Plan,
Dispatch, observation, review, escalation, and Operator Run state remains
authoritative. Telegram receives an outbound rendering and cannot read or
mutate orchestration state.

## Delivery rule

A notification delivery claim is durable before transport invocation. A
Telegram failure is recorded truthfully but never changes Job or escalation
truth, creates Needs Me, or triggers an automatic retry.

Connectivity testing is a separate local-only path. It sends no repository or
Job data, creates no orchestration records, and writes immutable redacted test
receipts outside the repository. A real test requires the explicit
`--send --confirm TELEGRAM_TEST` gate and performs at most one request.

## Deduplication

The event key permits one completion delivery claim per completed Job and one
Needs Me delivery claim per escalation. Reload and restart do not replay a
claimed event. Connectivity test receipts are never loaded by the Operator
runner and therefore cannot become recurring messages.

## Configuration

Only `AO_TELEGRAM_BOT_TOKEN` and `AO_TELEGRAM_CHAT_ID` configure the adapter.
They live in a restricted local environment or ignored AO-local environment
file and are never logged, rendered, or committed. Unrelated agent Telegram
credentials are not reused implicitly.

## Non-decisions

- interactive Telegram approvals;
- Telegram Job submission;
- conversational bot control;
- Slack or email delivery;
- production delivery retry policy;
- mobile push notifications; or
- making Telegram an orchestration state owner.
