# Project Onboarding

AO Web can add a Project with one of two operator choices:

* Add Local Folder: AO performs bounded read only inspection and automatically determines whether the selected directory is a Git repository or worktree. A detected repository reuses the logical repository and installation local checkout binding model. An ordinary folder receives an installation local folder association instead.
* Start Without Files: AO records context only. Orchestrator conversation and Inputs remain available.

Git detection records configured remote identity when present, branch or detached HEAD, current commit, and dirty or clean state. It does not change the checkout. A Git repository without a remote retains a machine local logical identity. Repository read only and isolated code change Jobs become available for a valid Git backed resource. They remain unavailable for an ordinary local folder.

If the selected ordinary folder contains nested Git repositories, AO reports their relative paths but keeps the selected folder as a normal local folder. It does not silently bind a nested repository. The operator must explicitly select that nested repository in a separate onboarding action.

The readiness Profile records the detected resource classification, stack clues, package manager, candidate commands, deployment clues, documentation, warnings, known constraints, and current capability availability. Candidate commands are informational until a later authorized validation runs.

## Documentation

AO recognizes provider neutral documentation such as `README.md`, `CONTRIBUTING.md`, architecture notes, and `AGENTS.md`. Provider specific files such as `CLAUDE.md` are labeled and treated as supplementary context. AO may suggest an `AGENTS.md` when one is absent, but onboarding never creates it automatically.

## Inputs

The Orchestrator page accepts a bounded file upload or one explicitly authorized public HTTP or HTTPS URL. AO stores successful Input content outside repositories and exposes only safe metadata to the provider. URL retrieval checks every destination and redirect, rejects private or local targets and embedded credentials, and enforces time and size limits.

An Input can be attached to a conversation turn and then to a Job by exact ID. Job execution receives an immutable allowlist. Text and binary Inputs are read in bounded base64 chunks. A write Worker may copy an attached Input to a new file inside its isolated worktree. It cannot overwrite a file, write outside the worktree, commit, merge, or publish.
