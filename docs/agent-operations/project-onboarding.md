# Project Onboarding

AO Web can add a Project with one of three starting resources:

* Existing Git repository: AO inspects the selected checkout and reuses the logical repository and installation local checkout binding model. Repository read only and isolated code change Jobs are available when runtime configuration is also ready.
* Existing local folder: AO records an installation local folder association and bounded Profile. Repository Jobs remain unavailable.
* No resource: AO records context only. Orchestrator conversation and Inputs remain available.

The readiness Profile records detected stack clues, package manager, candidate commands, deployment clues, documentation, warnings, known constraints, and current capability availability. Candidate commands are informational until a later authorized validation runs.

## Documentation

AO recognizes provider neutral documentation such as `README.md`, `CONTRIBUTING.md`, architecture notes, and `AGENTS.md`. Provider specific files such as `CLAUDE.md` are labeled and treated as supplementary context. AO may suggest an `AGENTS.md` when one is absent, but onboarding never creates it automatically.

## Inputs

The Orchestrator page accepts a bounded file upload or one explicitly authorized public HTTP or HTTPS URL. AO stores successful Input content outside repositories and exposes only safe metadata to the provider. URL retrieval checks every destination and redirect, rejects private or local targets and embedded credentials, and enforces time and size limits.

An Input can be attached to a conversation turn and then to a Job by exact ID. Job execution receives an immutable allowlist. Text and binary Inputs are read in bounded base64 chunks. A write Worker may copy an attached Input to a new file inside its isolated worktree. It cannot overwrite a file, write outside the worktree, commit, merge, or publish.
