# ADR 0003: Agent Operations Durable State Ownership

- Status: Accepted
- Date: 2026-08-21

## Context

CortextOS owns runtime execution state and Git owns repository state. The dashboard's SQLite database is a dashboard-owned read cache over CortextOS JSON/JSONL data. Agent Operations needs to remember its own configured projects, logical repository identities, machine-local checkout bindings, runtime associations, and latest observations across process restarts without taking ownership of those external systems.

File-backed JSON or JSONL would be inspectable, but multi-record updates would require AO-specific locking, transaction, index, and migration mechanisms. The dashboard database has unrelated lifecycle and schema ownership and may be rebuilt as a cache. Node's built-in SQLite API remains experimental in the active Node 24 runtime and is unavailable under this repository's Node 20 minimum.

## Decision

Agent Operations owns a separate local SQLite database behind the `AgentOperationsStateStore` contract. The concrete adapter uses `better-sqlite3`, a small synchronous SQLite binding already proven in this repository's dashboard toolchain, but it is declared independently at the root AO boundary. Domain and core modules do not import SQLite or dashboard storage.

The default database is:

```text
~/.agent-operations/state.db
```

`AGENT_OPERATIONS_STATE_DIR` changes the AO-owned directory and `AGENT_OPERATIONS_DATABASE_PATH` selects an exact database path. Tests always use isolated temporary paths. The database enables foreign keys and a busy timeout. It retains SQLite's default rollback journal because Phase 6 has an explicit single-process sync and does not yet justify WAL.

The schema has explicit, transactional, once-only migrations recorded in `schema_migrations`. The initial schema separates:

- configured projects;
- logical repositories;
- machine-local repository checkout bindings;
- project-to-repository and project-to-runtime-agent associations;
- timestamped repository observations;
- timestamped runtime observations;
- one local AO installation identity.

Configured state records what AO believes should be associated. Observation rows record what adapters last saw. Observations do not overwrite configured identity.

## State ownership

AO persistence does not replace Git, CortextOS runtime state, or model-provider session state. AO stores normalized domain records and observations only. It does not write Git state, runtime state, dashboard cache data, credentials, or provider sessions.

## Repository and checkout identity

A logical remote repository keeps its portable `remote:<host>/<path>` identity independently of checkout paths. Local-only repositories retain explicit `local:` identities and are not claimed to be portable. A checkout binding combines the logical repository, a generated installation identity, and a canonical local path. One logical repository may therefore have multiple checkout bindings without changing identity.

Each database generates one random installation ID on first initialization and preserves it across reopen. It represents this AO installation, not a user, host, or fleet member. Moving an installation by restoring its AO database preserves the installation identity; starting a separate mini-PC database creates another identity.

A canonical path may not silently switch to a different logical repository within one installation. If remote selection changes and produces another logical ID for an existing path, persistence reports an identity conflict. Resolving fork/upstream or renamed-remote ambiguity remains an explicit future identity decision, not an automatic reassignment.

## Portability

Project and logical repository records can move from the MacBook to a mini-PC. The mini-PC creates its own local installation identity and checkout binding, such as `/srv/agent-operations/repos/agent-operations`, while retaining the same portable logical repository ID. AO state can be backed up as one database file while the store is closed; a formal backup procedure is not defined here.

## Consequences

- AO gains transactional configured-state updates, foreign-key integrity, reopen durability, and explicit migrations without a network service.
- The root package gains `better-sqlite3` and its TypeScript declarations.
- SQLite and filesystem locations remain confined to the concrete adapter and composition root.
- Runtime and repository observations are append-only history queried as latest state; Phase 6 does not build a telemetry platform or retention policy.

## Non-decisions

Phase 6 does not define jobs, attempts, queues, scheduling, repository mutation, runtime mutation, secrets storage, remote database hosting, multi-machine coordination, backup implementation, workers, leases, approvals, users, or permissions.
