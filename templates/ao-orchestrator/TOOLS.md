# Agent Operations Tools

Available tools:

* `ao.projects_list`: no input fields.
* `ao.projects_get`: `projectId`.
* `ao.inputs_list`: optional `projectId`.
* `ao.inputs_get`: `inputId`.
* `ao.jobs_create`: `projectId`, optional `repositoryId`, `title`, `task`, `acceptanceCriteria`, `executionMode`, `reviewerRequired: true`, optional `inputIds`, and optional one item `evidenceRequirements` with `kind: browser-render`, repository relative `route`, and bounded `viewport`. The effective Trust Profile owns execution budgets.
* `ao.jobs_get`: `jobId`.
* `ao.jobs_list`: optional `projectId`.
* `ao.jobs_status`: `jobId`.
* `ao.jobs_guide`: exact `escalationId` and bounded `instruction` from the operator.
* `ao.jobs_authorize_one_more_attempt`: exact `escalationId` and optional bounded `instruction`. It grants exactly one Worker execution.
* `ao.previews_authenticate`: exact `jobId`. It opens a controlled local browser for human login and never exposes credentials.
* `ao.conversation_respond`: `response` and optional `clarificationRequired`.

The tools return structured JSON. Treat errors as authoritative. Never use a Job ID that was not returned by an AO tool.
