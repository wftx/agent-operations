import type Database from 'better-sqlite3';

export interface SqliteStateMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (database: Database.Database) => void;
}

export const INITIAL_SCHEMA_VERSION = 1;
export const JOB_SCHEMA_VERSION = 2;
export const CURRENT_SCHEMA_VERSION = JOB_SCHEMA_VERSION;

const INITIAL_SCHEMA_SQL = `
  CREATE TABLE installations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    label TEXT
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    identity_kind TEXT NOT NULL CHECK (identity_kind IN ('remote', 'local')),
    name TEXT NOT NULL,
    canonical_remote TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (identity_kind = 'local' OR canonical_remote IS NOT NULL)
  );

  CREATE TABLE repository_checkouts (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    canonical_path TEXT NOT NULL,
    availability TEXT NOT NULL CHECK (availability IN ('available', 'degraded', 'unavailable', 'not-a-repository')),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (installation_id, canonical_path),
    UNIQUE (id, repository_id)
  );

  CREATE TABLE project_repositories (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    PRIMARY KEY (project_id, repository_id)
  );

  CREATE TABLE project_runtime_agents (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    PRIMARY KEY (project_id, agent_id)
  );

  CREATE TABLE repository_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id TEXT NOT NULL,
    checkout_binding_id TEXT NOT NULL,
    availability TEXT NOT NULL CHECK (availability IN ('available', 'degraded', 'unavailable', 'not-a-repository')),
    branch TEXT,
    detached_head INTEGER NOT NULL CHECK (detached_head IN (0, 1)),
    head_commit TEXT,
    working_tree TEXT NOT NULL CHECK (working_tree IN ('clean', 'dirty', 'unknown')),
    reason TEXT,
    observed_at TEXT NOT NULL,
    FOREIGN KEY (checkout_binding_id, repository_id)
      REFERENCES repository_checkouts(id, repository_id)
  );

  CREATE TABLE runtime_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    association_state TEXT NOT NULL CHECK (association_state IN ('available', 'unavailable')),
    provider TEXT,
    runtime_state TEXT,
    enabled_known INTEGER NOT NULL CHECK (enabled_known IN (0, 1)),
    enabled INTEGER CHECK (enabled IS NULL OR enabled IN (0, 1)),
    configured_known INTEGER NOT NULL CHECK (configured_known IN (0, 1)),
    configured INTEGER CHECK (configured IS NULL OR configured IN (0, 1)),
    last_heartbeat TEXT,
    reason TEXT,
    observed_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE INDEX repository_observations_latest
    ON repository_observations(checkout_binding_id, observed_at DESC, sequence DESC);
  CREATE INDEX runtime_observations_latest
    ON runtime_observations(project_id, agent_id, observed_at DESC, sequence DESC);
`;

const JOB_AND_ATTEMPT_SCHEMA_SQL = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'completed', 'cancelled')),
    repository_id TEXT REFERENCES repositories(id),
    preferred_runtime_agent_id TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE job_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    runtime_agent_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('created', 'running', 'completed', 'failed', 'cancelled')),
    started_at TEXT,
    finished_at TEXT,
    summary TEXT,
    failure_reason TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (job_id, sequence)
  );

  CREATE UNIQUE INDEX one_active_attempt_per_job
    ON job_attempts(job_id)
    WHERE status IN ('created', 'running');
  CREATE INDEX jobs_by_project ON jobs(project_id, created_at, id);
  CREATE INDEX attempts_by_job ON job_attempts(job_id, sequence);
`;

export const DEFAULT_STATE_MIGRATIONS: readonly SqliteStateMigration[] = [
  {
    version: INITIAL_SCHEMA_VERSION,
    name: 'initial-agent-operations-state',
    up: database => database.exec(INITIAL_SCHEMA_SQL),
  },
  {
    version: JOB_SCHEMA_VERSION,
    name: 'durable-jobs-and-attempts',
    up: database => database.exec(JOB_AND_ATTEMPT_SCHEMA_SQL),
  },
];

export function applyStateMigrations(
  database: Database.Database,
  additionalMigrations: readonly SqliteStateMigration[] = [],
  now: () => Date = () => new Date(),
  targetVersion?: number,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const migrations = [...DEFAULT_STATE_MIGRATIONS, ...additionalMigrations]
    .sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const [index, migration] of migrations.entries()) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Invalid Agent Operations migration version: ${migration.version}`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate Agent Operations migration version: ${migration.version}`);
    }
    if (migration.version !== index + 1) {
      throw new Error(`Agent Operations migrations must be contiguous; expected ${index + 1}, found ${migration.version}`);
    }
    versions.add(migration.version);
  }

  const appliedRows = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>;
  const knownByVersion = new Map(migrations.map(migration => [migration.version, migration]));
  for (const row of appliedRows) {
    const known = knownByVersion.get(row.version);
    if (!known || known.name !== row.name) {
      throw new Error(`Unknown or conflicting Agent Operations schema migration ${row.version}: ${row.name}`);
    }
  }

  const resolvedTarget = targetVersion ?? migrations.at(-1)?.version ?? 0;
  if (!knownByVersion.has(resolvedTarget)) {
    throw new Error(`Unknown Agent Operations target schema version: ${resolvedTarget}`);
  }
  const newerApplied = appliedRows.find(row => row.version > resolvedTarget);
  if (newerApplied) {
    throw new Error(`Agent Operations schema ${newerApplied.version} cannot be downgraded to ${resolvedTarget}`);
  }

  const applied = new Set(appliedRows.map(row => row.version));
  for (const migration of migrations) {
    if (migration.version > resolvedTarget) continue;
    if (applied.has(migration.version)) continue;
    const applyOne = database.transaction(() => {
      migration.up(database);
      database.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, now().toISOString());
    });
    applyOne();
  }
}
