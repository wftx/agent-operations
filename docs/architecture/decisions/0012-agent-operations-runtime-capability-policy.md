# ADR 0012: Agent Operations Runtime Capability Policy

- Status: Accepted
- Date: 2026-08-24

## Context

The first live Agent Operations Dispatch obeyed its instruction not to use tools, files, Git, or external services, but the Codex turn still ran with `approvalPolicy: never` and `danger-full-access`. Observed restraint is valuable behavioral evidence; it is not a security boundary. Phase 13 therefore remains truthful as unrestricted-provider execution with human semantic verification.

## Decision

Every new Execution Plan carries one immutable requested runtime policy. Version 1 has only three ordered dimensions:

```text
filesystem: none | read-only | workspace-write
network: deny | allow
environment: empty | minimal | inherit
```

The Job is not permission-bound. The policy belongs to the Plan for one Attempt. Agent-level policy maxima are deferred; the Plan is authoritative in Phase 15.

Provider capabilities describe behavior, not provider configuration strings. Preflight resolves an effective policy from those capabilities. The effective policy may equal the requested policy or be stricter, but it must never be broader. An unspecified, unsupported, or broader policy blocks Dispatch. The execution adapter repeats the check at the mutation boundary and returns a structured policy rejection without external submission.

> A runtime must never silently execute with broader capabilities than the Execution Plan permits.

## Persistence and Historical Truth

Schema migration v6 adds four nullable requested-policy columns to Execution Plans and four nullable effective-policy columns to Dispatches. New Plans require all requested fields. Accepted policy-aware Dispatches require a non-broader effective policy. Existing rows remain null, meaning `policy-unspecified`; migration does not invent restrictions or rewrite Plan, Dispatch, outcome, observations, or external references.

The Phase 13 rehearsal remains recorded as provider-unrestricted. Its no-tool instruction and observed no-tool behavior are not relabeled as sandbox enforcement.

## Preflight and Auditability

Plan detail exposes the immutable request. Preflight exposes requested policy, provider support, and effective policy. Policy findings distinguish supported, unspecified, and unsupported state. Durable accepted Dispatch history records the effective provider-neutral policy, so an operator can answer what authority was requested and enforced without interpreting Codex protocol fields.

## Codex Mapping

The installed Codex app-server protocol supports per-turn sandbox and approval overrides, and thread-start configuration. A restricted rehearsal request maps centrally to:

```text
thread/start:
  sandbox = read-only
  approvalPolicy = never
  runtimeWorkspaceRoots = []
  environments = []
  dynamicTools = []
  selectedCapabilityRoots = []
  config.features.goals = false
  config.features.hooks = false
  config.features.memories = false
  config.features.multi_agent = false
  config.agents.enabled = false
  config.allow_login_shell = false
  config.tools.web_search = false
  config.tools.view_image = false
  config.shell_environment_policy.inherit = none
  config.shell_environment_policy.experimental_use_profile = false
  config.apps._default.enabled = false
  config.mcp_servers.<every configured server>.enabled = false

turn/start:
  sandboxPolicy = { type: readOnly, networkAccess: false }
  approvalPolicy = never
  runtimeWorkspaceRoots = []
  environments = []
```

`approvalPolicy: never` is the safest current non-interactive choice because CortextOS rejects app-server approval requests and has no approval UI. Safety comes from restrictive sandboxing, not from `never` itself.

## Session Compatibility and Correlation

Policy-aware Agent Operations execution never reuses the persistent legacy agent thread. It creates a new dedicated thread with the requested policy ceiling and repeats the effective settings on `turn/start`. This prevents an older `danger-full-access` session from silently undermining a restricted Plan and avoids relying on partially inherited resume state.

The restricted thread returns its exact provider thread and turn IDs. Phase 14 correlation, native turn-state persistence, exact observation, active-turn rejection, and marker-before-submission ordering remain unchanged. Policy validation occurs before the occupancy marker; once provider setup/submission begins, the marker is already durable.

## Environment, Filesystem, Network, and Tools

The `empty` environment policy means no Codex execution-environment attachment and no inherited environment for shell subprocesses. The app-server process itself still receives CortextOS agent configuration and provider authentication context; the per-thread shell policy prevents ordinary command subprocesses from inheriting it. Tests use only a fake sentinel and verify it is absent from the provider request.

Codex read-only strongly prevents normal filesystem writes, including Git mutation, and explicit `networkAccess: false` denies outbound network from sandboxed runtime commands without disabling model-provider transport. The rehearsal remains repository-free and its CWD is the external rehearsal workspace, not the Agent Operations checkout.

Residual capabilities are explicit:

- Codex can still invoke shell and inspection tools; Phase 15 constrains side effects rather than claiming shell is disabled.
- Read-only mode does not narrow filesystem reads to the rehearsal root. `runtimeWorkspaceRoots` is not a read allowlist.
- Model-provider transport remains available.
- Before creating the restricted thread, CortextOS reads the effective Codex configuration and disables every configured MCP server by name. If configuration discovery fails or is malformed, no restricted thread or turn is created. This is a strong boundary for the configuration snapshot, but a server hot-added after the snapshot is not proven covered by the same network boundary.
- Per-thread fields also disable hooks, goals/automatic continuation, memories, multi-agent tools, login shells, web search, host dynamic tools, selected capability roots, and configured apps by default.
- `filesystem: none` is therefore unsupported by the Codex adapter and fails before submission.

## Rehearsal Policy

Future rehearsal Plans explicitly request:

```text
version: 1
filesystem: read-only
network: deny
environment: empty
```

The preview reports requested and effective policy and remains non-executing unless the separate live confirmation boundary is used. Phase 15 authorizes no live Dispatch.

## Non-Decisions

Phase 15 does not define production roles, RBAC/ABAC, agent maxima, Git write policy, repository-bound execution, interactive approvals, tool allowlists, autonomous execution, queues, workers, retries, scheduling, dashboard UI, or Claude/OpenCode/Hermes enforcement parity.
