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
export const DAILY_OPERATOR_SCHEMA_VERSION = 10;
export const LATE_EXECUTION_RECONCILIATION_SCHEMA_VERSION = 11;
export const ISOLATED_WRITE_WORKSPACE_SCHEMA_VERSION = 12;
export const PROJECT_ONBOARDING_INPUTS_SCHEMA_VERSION = 13;
export const WORKER_BUDGET_EXTENSIONS_SCHEMA_VERSION = 14;
export const PREVIEW_BROWSER_EVIDENCE_SCHEMA_VERSION = 15;
export const DAILY_DRIVER_TRUST_SCHEMA_VERSION = 16;
export const AUTHENTICATED_PREVIEW_SCHEMA_VERSION = 17;
export const JOB_RETIREMENT_AND_RESTORE_SCHEMA_VERSION = 18;
export const CURRENT_SCHEMA_VERSION = JOB_RETIREMENT_AND_RESTORE_SCHEMA_VERSION;

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

const DAILY_OPERATOR_SCHEMA_SQL = `
  CREATE TABLE operator_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'running', 'completed', 'needs_human', 'failed', 'cancelled'
    )),
    failure_message TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    CHECK (
      (status = 'pending' AND started_at IS NULL AND finished_at IS NULL)
      OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL)
      OR (status IN ('completed', 'needs_human', 'failed', 'cancelled')
        AND started_at IS NOT NULL AND finished_at IS NOT NULL)
    )
  );

  CREATE INDEX operator_runs_by_status
    ON operator_runs(status, created_at, id);

  CREATE TABLE human_guidance (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    escalation_id TEXT NOT NULL UNIQUE REFERENCES escalations(id),
    instruction TEXT NOT NULL CHECK (
      length(trim(instruction)) > 0 AND length(instruction) <= 4096
    ),
    created_at TEXT NOT NULL
  );

  CREATE INDEX human_guidance_by_job
    ON human_guidance(job_id, created_at, id);

  CREATE TABLE operator_notification_deliveries (
    id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE CHECK (length(trim(event_key)) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('job_completed', 'needs_human')),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    escalation_id TEXT REFERENCES escalations(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
    message TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    attempted_at TEXT,
    CHECK ((kind = 'needs_human') = (escalation_id IS NOT NULL)),
    CHECK ((status = 'pending') = (attempted_at IS NULL))
  );

  CREATE INDEX operator_notifications_by_job
    ON operator_notification_deliveries(job_id, created_at, id);
`;

const LATE_EXECUTION_RECONCILIATION_SCHEMA_SQL = `
  ALTER TABLE escalations ADD COLUMN resolution_summary TEXT
    CHECK (resolution_summary IS NULL OR length(trim(resolution_summary)) > 0);
`;

const ISOLATED_WRITE_WORKSPACE_SCHEMA_SQL = `
  ALTER TABLE jobs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'repository-read-only'
    CHECK (execution_mode IN ('repository-read-only', 'repository-write-isolated'));

  CREATE TABLE repository_workspaces (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    source_checkout_binding_id TEXT NOT NULL REFERENCES repository_checkouts(id),
    base_revision TEXT NOT NULL CHECK (length(trim(base_revision)) > 0),
    base_branch TEXT,
    branch_name TEXT NOT NULL UNIQUE CHECK (length(trim(branch_name)) > 0),
    canonical_path TEXT NOT NULL UNIQUE CHECK (length(trim(canonical_path)) > 0),
    state TEXT NOT NULL CHECK (state IN (
      'preparing', 'active', 'reviewing', 'ready_for_approval', 'failed', 'cancelled',
      'cleanup_pending', 'cleaned'
    )),
    evidence_json TEXT,
    failure_reason TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((state = 'failed') = (failure_reason IS NOT NULL))
  );

  CREATE INDEX repository_workspaces_by_state
    ON repository_workspaces(state, created_at, id);

  ALTER TABLE execution_plans ADD COLUMN repository_workspace_id TEXT
    REFERENCES repository_workspaces(id);
  ALTER TABLE execution_plans ADD COLUMN requested_repository_patch INTEGER
    CHECK (requested_repository_patch IS NULL OR requested_repository_patch IN (0, 1));
  ALTER TABLE execution_plans ADD COLUMN requested_test_run INTEGER
    CHECK (requested_test_run IS NULL OR requested_test_run IN (0, 1));
  ALTER TABLE execution_plans ADD COLUMN requested_git_inspect INTEGER
    CHECK (requested_git_inspect IS NULL OR requested_git_inspect IN (0, 1));

  ALTER TABLE execution_dispatches ADD COLUMN effective_repository_patch INTEGER
    CHECK (effective_repository_patch IS NULL OR effective_repository_patch IN (0, 1));
  ALTER TABLE execution_dispatches ADD COLUMN effective_test_run INTEGER
    CHECK (effective_test_run IS NULL OR effective_test_run IN (0, 1));
  ALTER TABLE execution_dispatches ADD COLUMN effective_git_inspect INTEGER
    CHECK (effective_git_inspect IS NULL OR effective_git_inspect IN (0, 1));

  ALTER TABLE execution_observations ADD COLUMN repository_write_root TEXT;
  ALTER TABLE execution_observations ADD COLUMN effective_repository_patch INTEGER
    CHECK (effective_repository_patch IS NULL OR effective_repository_patch IN (0, 1));
  ALTER TABLE execution_observations ADD COLUMN effective_test_run INTEGER
    CHECK (effective_test_run IS NULL OR effective_test_run IN (0, 1));
  ALTER TABLE execution_observations ADD COLUMN effective_git_inspect INTEGER
    CHECK (effective_git_inspect IS NULL OR effective_git_inspect IN (0, 1));
  ALTER TABLE execution_observations ADD COLUMN tool_operations_json TEXT;
`;

const PROJECT_ONBOARDING_INPUTS_SCHEMA_SQL = `
  ALTER TABLE projects ADD COLUMN description TEXT;

  CREATE TABLE project_local_folders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    canonical_path TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK (length(trim(fingerprint)) > 0),
    availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (installation_id, canonical_path),
    UNIQUE (project_id, canonical_path)
  );

  CREATE INDEX project_local_folders_by_project
    ON project_local_folders(project_id, id);

  CREATE TABLE project_profiles (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    resource_summary TEXT NOT NULL,
    detected_stack_json TEXT NOT NULL,
    package_manager TEXT,
    build_commands_json TEXT NOT NULL,
    test_commands_json TEXT NOT NULL,
    preview_commands_json TEXT NOT NULL,
    deployment_clues_json TEXT NOT NULL,
    documentation_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    known_constraints_json TEXT NOT NULL,
    agents_file_suggestion INTEGER NOT NULL CHECK (agents_file_suggestion IN (0, 1)),
    inspected_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0)
  );

  CREATE TABLE inputs (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    source_type TEXT NOT NULL CHECK (source_type IN ('uploaded-file', 'authorized-url')),
    original_url TEXT,
    final_url TEXT,
    project_id TEXT REFERENCES projects(id),
    storage_reference TEXT NOT NULL UNIQUE CHECK (length(trim(storage_reference)) > 0),
    ingestion_state TEXT NOT NULL CHECK (ingestion_state = 'complete'),
    validation_state TEXT NOT NULL CHECK (validation_state = 'valid'),
    created_at TEXT NOT NULL,
    CHECK (
      (source_type = 'uploaded-file' AND original_url IS NULL AND final_url IS NULL)
      OR (source_type = 'authorized-url' AND original_url IS NOT NULL AND final_url IS NOT NULL)
    )
  );

  CREATE INDEX inputs_by_project ON inputs(project_id, created_at, id);

  CREATE TABLE conversation_inputs (
    conversation_id TEXT NOT NULL CHECK (length(trim(conversation_id)) > 0),
    input_id TEXT NOT NULL REFERENCES inputs(id),
    PRIMARY KEY (conversation_id, input_id)
  );

  CREATE TABLE job_inputs (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    input_id TEXT NOT NULL REFERENCES inputs(id),
    PRIMARY KEY (job_id, input_id)
  );

  CREATE TABLE execution_plan_inputs (
    execution_plan_id TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
    input_id TEXT NOT NULL REFERENCES inputs(id),
    PRIMARY KEY (execution_plan_id, input_id)
  );

  ALTER TABLE execution_plans ADD COLUMN requested_input_read INTEGER
    CHECK (requested_input_read IS NULL OR requested_input_read IN (0, 1));
  ALTER TABLE execution_dispatches ADD COLUMN effective_input_read INTEGER
    CHECK (effective_input_read IS NULL OR effective_input_read IN (0, 1));
  ALTER TABLE execution_observations ADD COLUMN effective_input_read INTEGER
    CHECK (effective_input_read IS NULL OR effective_input_read IN (0, 1));

  INSERT INTO project_profiles (
    project_id, resource_summary, detected_stack_json, package_manager,
    build_commands_json, test_commands_json, preview_commands_json,
    deployment_clues_json, documentation_json, capabilities_json,
    warnings_json, known_constraints_json, agents_file_suggestion, inspected_at, revision
  )
  SELECT
    p.id,
    CASE WHEN EXISTS (SELECT 1 FROM project_repositories pr WHERE pr.project_id = p.id)
      THEN 'Existing Git repository' ELSE 'No resource attached' END,
    '[]', NULL, '[]', '[]', '[]', '[]', '[]',
    CASE WHEN EXISTS (SELECT 1 FROM project_repositories pr WHERE pr.project_id = p.id)
      THEN '{"repositoryReadOnlyJobs":"available","isolatedCodeChangeJobs":"available","boundedFileInspection":"available","inputs":"available","orchestratorConversation":"available","build":"unknown","preview":"unknown","publish":"unknown"}'
      ELSE '{"repositoryReadOnlyJobs":"unavailable","isolatedCodeChangeJobs":"unavailable","boundedFileInspection":"unavailable","inputs":"available","orchestratorConversation":"available","build":"unknown","preview":"unknown","publish":"unknown"}' END,
    '["Run bounded Project inspection to enrich detected stack and command candidates."]',
    '[]', 0, p.updated_at, 0
  FROM projects p;
`;

const WORKER_BUDGET_EXTENSIONS_SCHEMA_SQL = `
  CREATE TABLE worker_budget_extensions (
    id TEXT PRIMARY KEY CHECK (id LIKE 'worker-budget-extension:%'),
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    escalation_id TEXT NOT NULL UNIQUE REFERENCES escalations(id),
    additional_worker_executions INTEGER NOT NULL CHECK (additional_worker_executions = 1),
    created_at TEXT NOT NULL
  );

  CREATE INDEX worker_budget_extensions_by_job
    ON worker_budget_extensions(job_id, created_at, id);
`;

const PREVIEW_BROWSER_EVIDENCE_SCHEMA_SQL = `
  CREATE TABLE preview_profiles (
    id TEXT PRIMARY KEY CHECK (id LIKE 'preview-profile:%'),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    command_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('candidate', 'validated', 'invalid')),
    validation_json TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, name)
  );

  CREATE TABLE job_browser_evidence_requirements (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind = 'browser-render'),
    route TEXT NOT NULL CHECK (substr(route, 1, 1) = '/' AND instr(route, char(0)) = 0),
    viewport_width INTEGER NOT NULL CHECK (viewport_width BETWEEN 320 AND 2560),
    viewport_height INTEGER NOT NULL CHECK (viewport_height BETWEEN 240 AND 2560)
  );

  CREATE TABLE preview_sessions (
    id TEXT PRIMARY KEY CHECK (id LIKE 'preview-session:%'),
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    profile_id TEXT NOT NULL REFERENCES preview_profiles(id),
    workspace_kind TEXT NOT NULL CHECK (workspace_kind IN ('read-only-detached-worktree', 'isolated-write-worktree')),
    workspace_path TEXT NOT NULL,
    revision_commit TEXT NOT NULL CHECK (length(trim(revision_commit)) > 0),
    source_state_hash TEXT NOT NULL CHECK (length(source_state_hash) = 64),
    origin TEXT NOT NULL CHECK (origin LIKE 'http://127.0.0.1:%'),
    route TEXT NOT NULL CHECK (substr(route, 1, 1) = '/'),
    port INTEGER NOT NULL CHECK (port BETWEEN 1024 AND 65535),
    pid INTEGER,
    state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'stopped', 'failed', 'stale')),
    logs TEXT NOT NULL,
    failure_reason TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((state = 'failed') = (failure_reason IS NOT NULL))
  );

  CREATE INDEX preview_sessions_by_job ON preview_sessions(job_id, created_at, id);

  CREATE TABLE browser_evidence (
    id TEXT PRIMARY KEY CHECK (id LIKE 'browser-evidence:%'),
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    preview_profile_id TEXT NOT NULL REFERENCES preview_profiles(id),
    preview_session_id TEXT NOT NULL REFERENCES preview_sessions(id),
    revision_commit TEXT NOT NULL,
    source_state_hash TEXT NOT NULL CHECK (length(source_state_hash) = 64),
    origin TEXT NOT NULL,
    route TEXT NOT NULL,
    viewport_json TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    title TEXT NOT NULL,
    final_url TEXT NOT NULL,
    screenshot_input_id TEXT NOT NULL REFERENCES inputs(id),
    screenshot_sha256 TEXT NOT NULL CHECK (length(screenshot_sha256) = 64),
    screenshot_byte_size INTEGER NOT NULL CHECK (screenshot_byte_size > 0),
    screenshot_width INTEGER NOT NULL CHECK (screenshot_width > 0),
    screenshot_height INTEGER NOT NULL CHECK (screenshot_height > 0),
    visible_text TEXT NOT NULL,
    console_failures_json TEXT NOT NULL,
    failed_resources_json TEXT NOT NULL,
    audit_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version = 1),
    evidence_hash TEXT NOT NULL UNIQUE CHECK (length(evidence_hash) = 64)
  );

  CREATE INDEX browser_evidence_by_job ON browser_evidence(job_id, captured_at, id);
`;

const DAILY_DRIVER_TRUST_SCHEMA_SQL = `
  CREATE TABLE trust_profiles (
    id TEXT PRIMARY KEY CHECK (id LIKE 'trust-profile:%'),
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'job')),
    scope_id TEXT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    preset TEXT NOT NULL CHECK (preset IN ('conservative', 'daily-driver', 'custom')),
    policy_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((scope = 'global' AND scope_id IS NULL) OR (scope != 'global' AND scope_id IS NOT NULL)),
    UNIQUE (scope, scope_id)
  );

  CREATE UNIQUE INDEX one_global_trust_profile
    ON trust_profiles(scope)
    WHERE scope = 'global';
`;

const AUTHENTICATED_PREVIEW_SCHEMA_SQL = `
  ALTER TABLE preview_profiles
    ADD COLUMN authentication_required INTEGER NOT NULL DEFAULT 0
    CHECK (authentication_required IN (0, 1));

  CREATE TABLE authenticated_preview_sessions (
    id TEXT PRIMARY KEY CHECK (id LIKE 'preview-auth:%'),
    project_id TEXT NOT NULL REFERENCES projects(id),
    preview_profile_id TEXT NOT NULL REFERENCES preview_profiles(id),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    origin TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending-human-login', 'ready', 'expired', 'revoked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_verified_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0)
  );

  CREATE INDEX authenticated_preview_sessions_by_profile
    ON authenticated_preview_sessions(project_id, preview_profile_id, created_at, id);
`;

const JOB_RETIREMENT_AND_RESTORE_SCHEMA_SQL = `
  CREATE TABLE job_retirements (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id),
    disposition TEXT NOT NULL CHECK (disposition IN ('retired', 'externally-published')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
    evidence_reference TEXT,
    retired_at TEXT NOT NULL
  );

  CREATE INDEX job_retirements_by_time ON job_retirements(retired_at, job_id);

  CREATE TABLE repository_restore_actions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    checkout_binding_id TEXT NOT NULL REFERENCES repository_checkouts(id),
    state TEXT NOT NULL CHECK (state IN ('pending-approval', 'approved', 'completed', 'rejected', 'failed')),
    preconditions_json TEXT NOT NULL,
    approval_summary TEXT NOT NULL CHECK (length(trim(approval_summary)) > 0),
    requested_by TEXT NOT NULL CHECK (length(trim(requested_by)) > 0),
    created_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT,
    result_json TEXT,
    failure_reason TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    CHECK ((state = 'completed') = (result_json IS NOT NULL)),
    CHECK ((state = 'failed') = (failure_reason IS NOT NULL))
  );

  CREATE INDEX repository_restore_actions_by_state
    ON repository_restore_actions(state, created_at, id);
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
  {
    version: DAILY_OPERATOR_SCHEMA_VERSION,
    name: 'daily-operator-runs-guidance-and-notifications',
    up: database => database.exec(DAILY_OPERATOR_SCHEMA_SQL),
  },
  {
    version: LATE_EXECUTION_RECONCILIATION_SCHEMA_VERSION,
    name: 'late-execution-reconciliation',
    up: database => database.exec(LATE_EXECUTION_RECONCILIATION_SCHEMA_SQL),
  },
  {
    version: ISOLATED_WRITE_WORKSPACE_SCHEMA_VERSION,
    name: 'isolated-write-job-workspaces',
    up: database => database.exec(ISOLATED_WRITE_WORKSPACE_SCHEMA_SQL),
  },
  {
    version: PROJECT_ONBOARDING_INPUTS_SCHEMA_VERSION,
    name: 'project-onboarding-and-job-inputs',
    up: database => database.exec(PROJECT_ONBOARDING_INPUTS_SCHEMA_SQL),
  },
  {
    version: WORKER_BUDGET_EXTENSIONS_SCHEMA_VERSION,
    name: 'human-worker-budget-extensions',
    up: database => database.exec(WORKER_BUDGET_EXTENSIONS_SCHEMA_SQL),
  },
  {
    version: PREVIEW_BROWSER_EVIDENCE_SCHEMA_VERSION,
    name: 'preview-profiles-and-browser-evidence',
    up: database => database.exec(PREVIEW_BROWSER_EVIDENCE_SCHEMA_SQL),
  },
  {
    version: DAILY_DRIVER_TRUST_SCHEMA_VERSION,
    name: 'daily-driver-trust-profiles',
    up: database => database.exec(DAILY_DRIVER_TRUST_SCHEMA_SQL),
  },
  {
    version: AUTHENTICATED_PREVIEW_SCHEMA_VERSION,
    name: 'authenticated-preview-session-metadata',
    up: database => database.exec(AUTHENTICATED_PREVIEW_SCHEMA_SQL),
  },
  {
    version: JOB_RETIREMENT_AND_RESTORE_SCHEMA_VERSION,
    name: 'job-retirement-and-selective-restore',
    up: database => database.exec(JOB_RETIREMENT_AND_RESTORE_SCHEMA_SQL),
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
