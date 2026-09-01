# ADR 0026: Project Onboarding and Immutable Job Inputs

## Status

Accepted for the Phase 27C deterministic baseline.

## Context

Agent Operations already has authoritative logical Git repository identities, installation local checkout bindings, runtime associations, isolated worktrees, and repository execution tools. A Project must be broader than a repository. Operators also need to attach files and explicitly authorized URLs without placing source material in a repository or exposing installation paths to a provider.

## Decision

A Project is durable operator context. It may associate with an existing Git repository, an existing local folder, or no resource. Git Projects reuse the existing repository and checkout binding model. Local folders have installation scoped resource records. Resource free Projects still support conversation and Inputs, but repository execution remains unavailable.

Each Project has a provider neutral Profile. Bounded inspection records detected stack clues, package manager, candidate build, test, preview, and publish commands, documentation, warnings, constraints, and capability readiness. Inspection never executes a discovered command. Provider specific files such as `CLAUDE.md` may enrich the Profile but do not define it. A missing `AGENTS.md` is reported as a suggestion, not created automatically.

Operator supplied files and explicitly authorized URL retrievals become immutable AO Input records. Content is stored under the AO state directory with restrictive permissions and a generated identifier. Durable metadata includes display name, MIME type, byte size, SHA256 hash, source type, URLs when applicable, validation state, and creation time. Provider visible metadata excludes the storage path.

Input identity is independent of browser location, node identity, and physical storage path. The browser transfers bytes into AO controlled ingestion and never contributes a client local path. The generated Input ID and SHA256 integrity value remain stable references, while `storageReference` is an opaque locator owned by the configured `InputObjectStorageAdapter`. Conversations, Jobs, Plans, and provider tools reference Input IDs and hashes, not that locator. This permits a future storage backend or selected execution node to verify and project the same exact Input without changing its durable identity.

URL retrieval permits HTTP and HTTPS only. It rejects embedded credentials, localhost, private, loopback, link local, and reserved destinations. Every redirect target is checked again. Retrieval has byte, redirect, and time limits. Credentials are not forwarded.

Conversation turns and Jobs associate exact Input IDs. An execution Plan copies the Job association into an immutable allowlist. The runtime exposes `inputs.list` and `inputs.read` only when `inputRead` is explicitly requested and effective. Reads are bounded and base64 encoded so binary content remains safe. An isolated write Worker may use `inputs.copy_to_repository` to create one new repository file inside its exact write root. It cannot overwrite an existing file or escape the worktree. Reviewers receive read only Input access.

Inputs are not source repositories, conversation transcripts, or arbitrary provider filesystem roots. Derived or transformed content must be represented by a new Input or an explicit repository output. Existing successful Input records are never mutated.

## Consequences

Project onboarding does not create a Job, Dispatch, worktree, or provider turn. Existing Git identity and workspace invariants remain authoritative. Projects without a repository cannot start repository Jobs. Input access is auditable by durable Job and Plan associations. A later phase may add richer onboarding editing and controlled Input derivatives without changing these boundaries.

The current adapter remains single node and locally stored. Distributed blob replication, cloud object storage, hosted control plane synchronization, and execution node scheduling are outside Phase 27C. Resource availability remains node specific even when the Project and its conversational context remain globally durable. Any future claim requiring fresh Resource state must include node availability and last verified evidence.
