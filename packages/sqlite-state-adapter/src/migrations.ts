import type Database from 'better-sqlite3';

export interface SqliteStateMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (database: Database.Database) => void;
}

export const INITIAL_SCHEMA_VERSION = 1;
export const JOB_SCHEMA_VERSION = 2;
export const EXECUTION_PLAN_SCHEMA_VERSION = 3;
export const DISPATCH_SCHEMA_VERSION = 4;
export const OBSERVATION_SCHEMA_VERSION = 5;
export const RUNTIME_POLICY_SCHEMA_VERSION = 6;
export const EXECUTION_CONTEXT_EVIDENCE_SCHEMA_VERSION = 7;
export const EXECUTION_CAPABILITY_SCHEMA_VERSION = 8;
export const ORCHESTRATION_SCHEMA_VERSION = 9;
export const CURRENT_SCHEMA_VERSION = ORCHESTRATION_SCHEMA_VERSION;

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

const EXECUTION_PLAN_SCHEMA_SQL = `
  CREATE UNIQUE INDEX jobs_identity_with_project ON jobs(id, project_id);
  CREATE UNIQUE INDEX attempts_identity_with_job ON job_attempts(id, job_id);
  CREATE UNIQUE INDEX checkout_identity_with_scope
    ON repository_checkouts(id, repository_id, installation_id);

  CREATE TABLE execution_plans (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    runtime_agent_id TEXT NOT NULL,
    repository_id TEXT,
    checkout_binding_id TEXT,
    input_version INTEGER NOT NULL CHECK (input_version = 1),
    instruction TEXT NOT NULL CHECK (length(trim(instruction)) > 0),
    job_revision INTEGER NOT NULL CHECK (job_revision >= 0),
    attempt_revision INTEGER NOT NULL CHECK (attempt_revision >= 0),
    created_at TEXT NOT NULL,
    CHECK (
      (repository_id IS NULL AND checkout_binding_id IS NULL)
      OR (repository_id IS NOT NULL AND checkout_binding_id IS NOT NULL)
    ),
    FOREIGN KEY (job_id, project_id) REFERENCES jobs(id, project_id),
    FOREIGN KEY (attempt_id, job_id) REFERENCES job_attempts(id, job_id),
    FOREIGN KEY (checkout_binding_id, repository_id, installation_id)
      REFERENCES repository_checkouts(id, repository_id, installation_id)
  );

  CREATE INDEX execution_plans_by_job ON execution_plans(job_id, created_at, id);
`;

const EXECUTION_DISPATCH_SCHEMA_SQL = `
  CREATE UNIQUE INDEX execution_plans_dispatch_scope
    ON execution_plans(id, attempt_id, job_id, runtime_agent_id);

  CREATE TABLE execution_dispatches (
    id TEXT PRIMARY KEY,
    execution_plan_id TEXT NOT NULL UNIQUE,
    attempt_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    runtime_agent_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
    status TEXT NOT NULL CHECK (status IN ('prepared', 'submitting', 'accepted', 'rejected', 'uncertain')),
    external_reference TEXT,
    message TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    submitted_at TEXT,
    accepted_at TEXT,
    resolved_at TEXT,
    FOREIGN KEY (attempt_id) REFERENCES job_attempts(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id),
    FOREIGN KEY (execution_plan_id, attempt_id, job_id, runtime_agent_id)
      REFERENCES execution_plans(id, attempt_id, job_id, runtime_agent_id),
    CHECK (
      (status = 'prepared' AND submitted_at IS NULL AND accepted_at IS NULL AND resolved_at IS NULL)
      OR (status = 'submitting' AND submitted_at IS NOT NULL AND accepted_at IS NULL AND resolved_at IS NULL)
      OR (status = 'accepted' AND submitted_at IS NOT NULL AND accepted_at IS NOT NULL AND resolved_at IS NOT NULL)
      OR (status IN ('rejected', 'uncertain') AND submitted_at IS NOT NULL AND accepted_at IS NULL AND resolved_at IS NOT NULL)
    )
  );

  CREATE INDEX execution_dispatches_by_attempt ON execution_dispatches(attempt_id, created_at, id);
`;

const EXECUTION_OBSERVATION_SCHEMA_SQL = `
  CREATE UNIQUE INDEX execution_dispatches_observation_scope
    ON execution_dispatches(id, attempt_id);

  CREATE TABLE execution_observations (
    id TEXT PRIMARY KEY,
    dispatch_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (length(trim(source)) > 0),
    source_event_id TEXT NOT NULL CHECK (length(trim(source_event_id)) > 0),
    kind TEXT NOT NULL CHECK (kind IN (
      'runtime-running', 'runtime-idle', 'turn-completed', 'output-available',
      'runtime-crashed', 'runtime-unavailable', 'unknown'
    )),
    correlation TEXT NOT NULL CHECK (correlation IN (
      'exact', 'runtime-session', 'agent-level', 'uncorrelated'
    )),
    correlated_dispatch_id TEXT,
    runtime_session_id TEXT,
    external_reference TEXT,
    message TEXT,
    output_summary TEXT,
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (dispatch_id, source, source_event_id),
    UNIQUE (id, dispatch_id, attempt_id),
    FOREIGN KEY (dispatch_id, attempt_id) REFERENCES execution_dispatches(id, attempt_id),
    CHECK (
      (correlation = 'exact' AND correlated_dispatch_id = dispatch_id)
      OR (correlation <> 'exact' AND correlated_dispatch_id IS NULL)
    )
  );

  CREATE INDEX execution_observations_by_dispatch
    ON execution_observations(dispatch_id, observed_at, id);

  CREATE TABLE attempt_outcome_decisions (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES job_attempts(id),
    dispatch_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
    source TEXT NOT NULL CHECK (source IN ('human', 'runtime-evidence')),
    summary TEXT,
    reason TEXT,
    evidence_observation_id TEXT,
    override_without_exact_evidence INTEGER NOT NULL
      CHECK (override_without_exact_evidence IN (0, 1)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (dispatch_id, attempt_id) REFERENCES execution_dispatches(id, attempt_id),
    FOREIGN KEY (evidence_observation_id, dispatch_id, attempt_id)
      REFERENCES execution_observations(id, dispatch_id, attempt_id),
    CHECK (
      (outcome = 'completed' AND length(trim(summary)) > 0 AND reason IS NULL)
      OR (outcome = 'failed' AND length(trim(reason)) > 0 AND summary IS NULL)
    )
  );
`;

const RUNTIME_POLICY_SCHEMA_SQL = `
  ALTER TABLE execution_plans ADD COLUMN requested_policy_version INTEGER
    CHECK (requested_policy_version IS NULL OR requested_policy_version = 1);
  ALTER TABLE execution_plans ADD COLUMN requested_filesystem TEXT
    CHECK (requested_filesystem IS NULL OR requested_filesystem IN ('none', 'read-only', 'workspace-write'));
  ALTER TABLE execution_plans ADD COLUMN requested_network TEXT
    CHECK (requested_network IS NULL OR requested_network IN ('deny', 'allow'));
  ALTER TABLE execution_plans ADD COLUMN requested_environment TEXT
    CHECK (requested_environment IS NULL OR requested_environment IN ('empty', 'minimal', 'inherit'));

  ALTER TABLE execution_dispatches ADD COLUMN effective_policy_version INTEGER
    CHECK (effective_policy_version IS NULL OR effective_policy_version = 1);
  ALTER TABLE execution_dispatches ADD COLUMN effective_filesystem TEXT
    CHECK (effective_filesystem IS NULL OR effective_filesystem IN ('none', 'read-only', 'workspace-write'));
  ALTER TABLE execution_dispatches ADD COLUMN effective_network TEXT
    CHECK (effective_network IS NULL OR effective_network IN ('deny', 'allow'));
  ALTER TABLE execution_dispatches ADD COLUMN effective_environment TEXT
    CHECK (effective_environment IS NULL OR effective_environment IN ('empty', 'minimal', 'inherit'));

  CREATE TRIGGER execution_plans_policy_complete_insert
  BEFORE INSERT ON execution_plans
  WHEN (NEW.requested_policy_version IS NULL) != (NEW.requested_filesystem IS NULL)
    OR (NEW.requested_policy_version IS NULL) != (NEW.requested_network IS NULL)
    OR (NEW.requested_policy_version IS NULL) != (NEW.requested_environment IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'execution plan policy must be wholly null or wholly specified');
  END;

  CREATE TRIGGER execution_plans_policy_complete_update
  BEFORE UPDATE OF requested_policy_version, requested_filesystem, requested_network, requested_environment
  ON execution_plans
  WHEN (NEW.requested_policy_version IS NULL) != (NEW.requested_filesystem IS NULL)
    OR (NEW.requested_policy_version IS NULL) != (NEW.requested_network IS NULL)
    OR (NEW.requested_policy_version IS NULL) != (NEW.requested_environment IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'execution plan policy must be wholly null or wholly specified');
  END;

  CREATE TRIGGER execution_dispatches_policy_complete_insert
  BEFORE INSERT ON execution_dispatches
  WHEN (NEW.effective_policy_version IS NULL) != (NEW.effective_filesystem IS NULL)
    OR (NEW.effective_policy_version IS NULL) != (NEW.effective_network IS NULL)
    OR (NEW.effective_policy_version IS NULL) != (NEW.effective_environment IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'execution dispatch policy must be wholly null or wholly specified');
  END;

  CREATE TRIGGER execution_dispatches_policy_complete_update
  BEFORE UPDATE OF effective_policy_version, effective_filesystem, effective_network, effective_environment
  ON execution_dispatches
  WHEN (NEW.effective_policy_version IS NULL) != (NEW.effective_filesystem IS NULL)
    OR (NEW.effective_policy_version IS NULL) != (NEW.effective_network IS NULL)
    OR (NEW.effective_policy_version IS NULL) != (NEW.effective_environment IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'execution dispatch policy must be wholly null or wholly specified');
  END;
`;

const EXECUTION_CONTEXT_EVIDENCE_SCHEMA_SQL = `
  ALTER TABLE execution_observations ADD COLUMN execution_working_directory TEXT;
  ALTER TABLE execution_observations ADD COLUMN effective_policy_version INTEGER
    CHECK (effective_policy_version IS NULL OR effective_policy_version = 1);
  ALTER TABLE execution_observations ADD COLUMN effective_filesystem TEXT
    CHECK (effective_filesystem IS NULL OR effective_filesystem IN ('none', 'read-only', 'workspace-write'));
  ALTER TABLE execution_observations ADD COLUMN effective_network TEXT
    CHECK (effective_network IS NULL OR effective_network IN ('deny', 'allow'));
  ALTER TABLE execution_observations ADD COLUMN effective_environment TEXT
    CHECK (effective_environment IS NULL OR effective_environment IN ('empty', 'minimal', 'inherit'));
`;

const EXECUTION_CAPABILITY_SCHEMA_SQL = `
  ALTER TABLE execution_plans ADD COLUMN requested_capabilities_version INTEGER
    CHECK (requested_capabilities_version IS NULL OR requested_capabilities_version = 1);
  ALTER TABLE execution_plans ADD COLUMN requested_repository_read INTEGER
    CHECK (requested_repository_read IS NULL OR requested_repository_read IN (0, 1));

  ALTER TABLE execution_dispatches ADD COLUMN effective_capabilities_version INTEGER
    CHECK (effective_capabilities_version IS NULL OR effective_capabilities_version = 1);
  ALTER TABLE execution_dispatches ADD COLUMN effective_repository_read INTEGER
    CHECK (effective_repository_read IS NULL OR effective_repository_read IN (0, 1));

  ALTER TABLE execution_observations ADD COLUMN repository_read_root TEXT;
  ALTER TABLE execution_observations ADD COLUMN effective_capabilities_version INTEGER
    CHECK (effective_capabilities_version IS NULL OR effective_capabilities_version = 1);
  ALTER TABLE execution_observations ADD COLUMN effective_repository_read INTEGER
    CHECK (effective_repository_read IS NULL OR effective_repository_read IN (0, 1));

  CREATE TRIGGER execution_plans_capabilities_complete_insert
  BEFORE INSERT ON execution_plans
  WHEN (NEW.requested_capabilities_version IS NULL) != (NEW.requested_repository_read IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'execution plan capabilities must be wholly null or wholly specified');
  END;

  CREATE TRIGGER execution_plans_capabilities_complete_update
  BEFORE UPDATE OF requested_capabilities_version, requested_repository_read
  ON execution_plans
  WHEN (NEW.requested_capabilities_version IS NULL) != (NEW.requested_repository_read IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'execution plan capabilities must be wholly null or wholly specified');
  END;

  CREATE TRIGGER execution_dispatches_capabilities_complete_insert
  BEFORE INSERT ON execution_dispatches
  WHEN (NEW.effective_capabilities_version IS NULL) != (NEW.effective_repository_read IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'execution dispatch capabilities must be wholly null or wholly specified');
  END;

  CREATE TRIGGER execution_dispatches_capabilities_complete_update
  BEFORE UPDATE OF effective_capabilities_version, effective_repository_read
  ON execution_dispatches
  WHEN (NEW.effective_capabilities_version IS NULL) != (NEW.effective_repository_read IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'execution dispatch capabilities must be wholly null or wholly specified');
  END;

  CREATE TRIGGER execution_observations_capabilities_complete_insert
  BEFORE INSERT ON execution_observations
  WHEN (NEW.effective_capabilities_version IS NULL) != (NEW.effective_repository_read IS NULL)
    OR (NEW.repository_read_root IS NOT NULL AND NEW.effective_repository_read != 1)
  BEGIN
    SELECT RAISE(ABORT, 'execution observation repository capability evidence is incomplete');
  END;
`;

const ORCHESTRATION_SCHEMA_SQL = `
  ALTER TABLE jobs ADD COLUMN acceptance_criteria TEXT;
  ALTER TABLE jobs ADD COLUMN automatic_read_only_completion INTEGER NOT NULL DEFAULT 0
    CHECK (automatic_read_only_completion IN (0, 1));

  CREATE TRIGGER jobs_automatic_completion_criteria_insert
  BEFORE INSERT ON jobs
  WHEN NEW.automatic_read_only_completion = 1
    AND (NEW.acceptance_criteria IS NULL OR length(trim(NEW.acceptance_criteria)) = 0)
  BEGIN
    SELECT RAISE(ABORT, 'automatic read-only completion requires acceptance criteria');
  END;

  CREATE TRIGGER jobs_automatic_completion_criteria_update
  BEFORE UPDATE OF automatic_read_only_completion, acceptance_criteria ON jobs
  WHEN NEW.automatic_read_only_completion = 1
    AND (NEW.acceptance_criteria IS NULL OR length(trim(NEW.acceptance_criteria)) = 0)
  BEGIN
    SELECT RAISE(ABORT, 'automatic read-only completion requires acceptance criteria');
  END;

  ALTER TABLE job_attempts ADD COLUMN execution_role TEXT NOT NULL DEFAULT 'worker'
    CHECK (execution_role IN ('worker', 'reviewer'));
  ALTER TABLE job_attempts ADD COLUMN role_sequence INTEGER NOT NULL DEFAULT 1
    CHECK (role_sequence > 0);
  UPDATE job_attempts SET role_sequence = sequence WHERE execution_role = 'worker';

  DROP INDEX one_active_attempt_per_job;
  CREATE UNIQUE INDEX one_active_attempt_per_job_role
    ON job_attempts(job_id, execution_role)
    WHERE status IN ('created', 'running');
  CREATE UNIQUE INDEX attempts_role_sequence
    ON job_attempts(job_id, execution_role, role_sequence);

  ALTER TABLE execution_observations ADD COLUMN result_text TEXT;

  CREATE TRIGGER execution_observations_result_insert
  BEFORE INSERT ON execution_observations
  WHEN NEW.result_text IS NOT NULL AND (
    length(trim(NEW.result_text)) = 0
    OR length(NEW.result_text) > 16384
    OR NEW.kind <> 'turn-completed'
    OR NEW.correlation <> 'exact'
  )
  BEGIN
    SELECT RAISE(ABORT, 'execution result requires bounded exact completion evidence');
  END;

  CREATE TABLE attempt_reviews (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    worker_attempt_id TEXT NOT NULL UNIQUE,
    reviewer_attempt_id TEXT NOT NULL UNIQUE,
    reviewer_runtime_agent_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('PASS', 'REVISION_REQUIRED', 'ESCALATE')),
    summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
    feedback TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (worker_attempt_id, job_id) REFERENCES job_attempts(id, job_id),
    FOREIGN KEY (reviewer_attempt_id, job_id) REFERENCES job_attempts(id, job_id),
    CHECK (decision <> 'REVISION_REQUIRED' OR length(trim(feedback)) > 0)
  );

  CREATE INDEX attempt_reviews_by_job ON attempt_reviews(job_id, created_at, id);

  CREATE TABLE escalations (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    attempt_id TEXT REFERENCES job_attempts(id),
    review_id TEXT REFERENCES attempt_reviews(id),
    reason TEXT NOT NULL CHECK (reason IN (
      'review_failed_after_budget', 'reviewer_uncertain', 'dispatch_rejected',
      'dispatch_uncertain', 'runtime_failure', 'exact_correlation_missing',
      'observation_timeout', 'policy_blocked', 'human_judgment_required'
    )),
    summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX escalations_needing_attention
    ON escalations(resolved_at, created_at, id);
  CREATE INDEX escalations_by_job ON escalations(job_id, created_at, id);
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
  {
    version: EXECUTION_PLAN_SCHEMA_VERSION,
    name: 'immutable-execution-plans',
    up: database => database.exec(EXECUTION_PLAN_SCHEMA_SQL),
  },
  {
    version: DISPATCH_SCHEMA_VERSION,
    name: 'manual-execution-dispatches',
    up: database => database.exec(EXECUTION_DISPATCH_SCHEMA_SQL),
  },
  {
    version: OBSERVATION_SCHEMA_VERSION,
    name: 'execution-observations-and-outcomes',
    up: database => database.exec(EXECUTION_OBSERVATION_SCHEMA_SQL),
  },
  {
    version: RUNTIME_POLICY_SCHEMA_VERSION,
    name: 'runtime-capability-policy',
    up: database => database.exec(RUNTIME_POLICY_SCHEMA_SQL),
  },
  {
    version: EXECUTION_CONTEXT_EVIDENCE_SCHEMA_VERSION,
    name: 'exact-execution-context-evidence',
    up: database => database.exec(EXECUTION_CONTEXT_EVIDENCE_SCHEMA_SQL),
  },
  {
    version: EXECUTION_CAPABILITY_SCHEMA_VERSION,
    name: 'repository-read-execution-capability',
    up: database => database.exec(EXECUTION_CAPABILITY_SCHEMA_SQL),
  },
  {
    version: ORCHESTRATION_SCHEMA_VERSION,
    name: 'mvp-orchestrator-review-and-escalation',
    up: database => database.exec(ORCHESTRATION_SCHEMA_SQL),
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
