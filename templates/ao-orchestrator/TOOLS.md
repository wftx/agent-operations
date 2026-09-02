# Agent Operations Tools

Available tools:

* `ao.projects_list`: no input fields.
* `ao.projects_get`: `projectId`.
* `ao.inputs_list`: optional `projectId`.
* `ao.inputs_get`: `inputId`.
* `ao.jobs_create`: `projectId`, optional `repositoryId`, `title`, `task`, `acceptanceCriteria`, `executionMode`, `reviewerRequired: true`, `maxWorkerAttempts: 2`, optional `inputIds`, and optional one item `evidenceRequirements` with `kind: browser-render`, repository relative `route`, and bounded `viewport`.
* `ao.jobs_get`: `jobId`.
* `ao.jobs_list`: optional `projectId`.
* `ao.jobs_status`: `jobId`.
* `ao.conversation_respond`: `response` and optional `clarificationRequired`.

The tools return structured JSON. Treat errors as authoritative. Never use a Job ID that was not returned by an AO tool.
