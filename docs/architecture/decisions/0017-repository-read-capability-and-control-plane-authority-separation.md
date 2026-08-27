# ADR 0017: Repository Read Capability and Control-Plane Authority Separation

- Status: Accepted
- Date: 2026-08-26

## Context

The first exact repository-bound turn used the intended `read-only / deny / empty` runtime policy and exact checkout, thread, and turn correlation. It completed technically but could not perform the semantic task because that restricted turn exposed no repository-reading tool.

The same rehearsal also revealed an operational boundary mistake: observation persistence was skipped because the invoking safety layer treated the agent's read-only filesystem policy as though it also prohibited Agent Operations from updating its own SQLite database. Code-path review found no `RuntimeExecutionPolicy` check in `ExecutionObservationService`, `ExecutionOutcomeService`, or the SQLite adapter. The observation service was never invoked. The defect was therefore authority conflation at the orchestration/invocation boundary, not a blocked SQLite call.

These are separate trust domains:

```text
Execution Plan → agent runtime policy/capabilities → Codex sandbox and tools
Agent Operations core → AO state adapter → AO-owned SQLite control-plane state
```

## Discovery

The available mechanisms were evaluated as follows:

| Mechanism | Read scope | Write/shell risk | Path enforcement | Auditability | Coupling |
| --- | --- | --- | --- | --- | --- |
| Codex built-in filesystem/shell | Provider sandbox, broader than one checkout | Shell surface; unsuitable | Provider-defined | Provider events | High |
| Bounded read-only shell | Command grammar remains a bypass risk | No write intended, but still a shell | Wrapper-dependent | Command-level | Medium |
| MCP server | Can be root-scoped | Depends on server/tool set | Server-defined | Tool calls | Medium |
| App-server dynamic tools | Exact declared functions | No shell or write function required | AO/CortextOS-defined | Exact tool-call request | High |
| AO-side repository reader exposed as dynamic tools | Exact canonical checkout | No process/write/network operations | Canonical root and per-request checks | Exact Dispatch/turn plus bounded metadata | Medium |

Codex app-server `thread/start` supports dynamic tool namespaces and sends each call back to the client as `item/tool/call`. CortextOS can therefore keep path enforcement on its side and return only bounded results. This is narrower than enabling a shell or generic provider filesystem API.

## Decision

### Independent authority domains

`RuntimeExecutionPolicy` and `RuntimeExecutionCapabilities` constrain only the external provider turn. They are never passed to the AO state store as write authority and cannot disable Dispatch persistence, observation append, outcome decisions, or Job/Attempt transitions.

The AO database path is not a provider working directory, writable root, environment value, selected capability root, dynamic-tool argument, or model-visible configuration value. AO persists control-plane records under its own process authority before and after external execution.

### Explicit repository-read capability

Immutable Plans now carry a versioned boolean `repositoryRead` capability. It is deliberately not an arbitrary tool list or general permission language. Repository-bound Plans must request it explicitly, and preflight requires the selected runtime to advertise `repository-read-tools`.

Preflight derives `repositoryReadRoot` from this authoritative chain:

```text
Execution Plan
→ installation-scoped RepositoryCheckoutBinding
→ live canonical Git root and repository identity
→ RuntimeExecutionContext.workingDirectory
→ RuntimeExecutionContext.repositoryReadRoot
```

The model can supply only repository-relative paths and search text. It cannot choose or override the root.

### Reader and provider mapping

CortextOS exposes one `repository` dynamic-tool namespace containing only:

- `list(path?)`
- `read(path, startLine?, maxLines?)`
- `search(query, path?)`

The policy-isolated Codex thread disables shell, shell snapshots, code mode, login shells, web search, apps, MCP servers, hooks, memories, goals, and multi-agent features. It registers no write, process, Git, network, or generic filesystem dynamic tool. The Codex sandbox remains read-only with no runtime workspace writable roots.

Every reader operation is tied to the exact protected Dispatch thread and turn. Calls for any other thread or turn are rejected. The correlated native turn record stores bounded audit metadata: operation, repository-relative path or query, success/failure, error code when applicable, and timestamp. File contents are not written into AO state or the audit record.

### Path and content safety

The reader canonicalizes its configured root once and validates every request. It rejects absolute paths, `..`, NULs, excessive path length, any symlink component, missing or mismatched target types, and any resolved path outside the exact root. Rejecting all symlinks is intentionally stricter than merely rejecting outside-root targets.

Explicit limits are:

- path length: 1,024 characters
- listed entries: 200
- source file size: 1 MiB
- returned response: 64 KiB
- read lines: 500
- search results: 100
- search traversal: 1,000 files and 8 MiB inspected

Binary or invalid UTF-8 files and oversized files are rejected. `.git`, `.env*`, SSH/credential/secret-like names, and private-key extensions are hidden and rejected. Ignored files are not interpreted through Git because the reader intentionally has no Git/process dependency; obvious secret-bearing paths remain blocked, and live rehearsals must target known non-secret source files.

### Durable evidence

Schema v8 persists requested capability on Plans, effective capability on Dispatches, and exact-turn capability/root evidence on observations. Legacy rows remain null rather than being assigned invented authority. Exact evidence can prove Dispatch, thread, turn, repository identity, working directory, runtime policy, repository-read capability, and reader root together.

## Critical Rules

1. Agent runtime policy must never disable AO's durable control-plane state.
2. Repository-read access must never imply repository-write access.
3. The runtime may read only through the exact repository root authorized by the immutable Execution Plan.

## Consequences and Residual Risk

The tool contract and implementation are provider-neutral at the AO boundary, but the current dynamic-tool transport is Codex app-server-specific. Another provider needs an adapter mapping with equivalent exact-turn routing and denial semantics.

Repository source may itself contain sensitive information that is not recognizable from a filename. Phase 19 uses bounded reads and obvious-path exclusions, not full content DLP. The reader also has a time-of-check/time-of-use window between checkout verification and an individual read; per-request canonical and symlink checks fail closed on detectable path substitution.

The capability is intentionally ergonomic enough for source discovery, bounded reads, and text search, but not for Git metadata, arbitrary glob semantics, streaming large files, or shell pipelines.

## Non-Decisions

Phase 19 does not define writes, patches, deletes, renames, chmod, process execution, Git mutation, commits, worktrees, branches, pull requests, autonomous retries, workers, queues, scheduling, or production secrets policy.
