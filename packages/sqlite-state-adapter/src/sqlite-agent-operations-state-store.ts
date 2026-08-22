import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AgentOperationsInstallation,
  AgentOperationsStateStore,
  DurableProject,
  DurableProjectConfiguration,
  DurableJob,
  DurableJobAttempt,
  DurableExecutionPlan,
  DurableExecutionDispatch,
  DispatchStatus,
  DurableExecutionObservation,
  DurableAttemptOutcomeDecision,
  ExecutionObservationKind,
  ExecutionCorrelation,
  AttemptOutcome,
  AttemptOutcomeDecisionSource,
  DurableRepository,
  DurableRepositoryObservation,
  DurableRuntimeObservation,
  NewDurableJobAttempt,
  AttemptStatus,
  JobStatus,
  RepositoryCheckoutBinding,
  RepositoryIdentityKind,
  RepositoryAvailability,
  RuntimeProvider,
  RuntimeState,
  WorkingTreeState,
} from '../../agent-operations-contracts/src/index.js';
import { createRepositoryCheckoutBindingId } from '../../agent-operations-contracts/src/index.js';
import { applyStateMigrations, type SqliteStateMigration } from './migrations.js';
import { resolveAgentOperationsStateLocation } from './state-location.js';

export interface SqliteAgentOperationsStateStoreOptions {
  readonly databasePath?: string;
  readonly installationLabel?: string;
  readonly installationIdFactory?: () => string;
  readonly now?: () => Date;
  /** Test/migration-development seam. Production schema lives in the default migration list. */
  readonly additionalMigrations?: readonly SqliteStateMigration[];
  /** Test seam for proving an actual v1 -> v2 upgrade. Never set by production composition. */
  readonly targetSchemaVersion?: number;
}

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface RepositoryRow {
  id: string;
  identity_kind: RepositoryIdentityKind;
  name: string;
  canonical_remote: string | null;
  created_at: string;
  updated_at: string;
}

interface CheckoutRow {
  id: string;
  repository_id: string;
  installation_id: string;
  canonical_path: string;
  availability: RepositoryAvailability;
  first_seen_at: string;
  last_seen_at: string;
}

interface RepositoryObservationRow {
  repository_id: string;
  checkout_binding_id: string;
  availability: RepositoryAvailability;
  branch: string | null;
  detached_head: number;
  head_commit: string | null;
  working_tree: WorkingTreeState;
  reason: string | null;
  observed_at: string;
}

interface RuntimeObservationRow {
  project_id: string;
  agent_id: string;
  association_state: 'available' | 'unavailable';
  provider: RuntimeProvider | null;
  runtime_state: RuntimeState | null;
  enabled_known: number;
  enabled: number | null;
  configured_known: number;
  configured: number | null;
  last_heartbeat: string | null;
  reason: string | null;
  observed_at: string;
}

interface JobRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: JobStatus;
  repository_id: string | null;
  preferred_runtime_agent_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  job_id: string;
  sequence: number;
  runtime_agent_id: string | null;
  status: AttemptStatus;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  failure_reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ExecutionPlanRow {
  id: string;
  attempt_id: string;
  job_id: string;
  project_id: string;
  installation_id: string;
  runtime_agent_id: string;
  repository_id: string | null;
  checkout_binding_id: string | null;
  input_version: 1;
  instruction: string;
  job_revision: number;
  attempt_revision: number;
  created_at: string;
}

interface ExecutionDispatchRow {
  id: string;
  execution_plan_id: string;
  attempt_id: string;
  job_id: string;
  runtime_agent_id: string;
  idempotency_key: string;
  status: DispatchStatus;
  external_reference: string | null;
  message: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  accepted_at: string | null;
  resolved_at: string | null;
}

interface ExecutionObservationRow {
  id: string;
  dispatch_id: string;
  attempt_id: string;
  source: string;
  source_event_id: string;
  kind: ExecutionObservationKind;
  correlation: ExecutionCorrelation;
  correlated_dispatch_id: string | null;
  runtime_session_id: string | null;
  external_reference: string | null;
  message: string | null;
  output_summary: string | null;
  observed_at: string;
  recorded_at: string;
}

interface AttemptOutcomeDecisionRow {
  id: string;
  attempt_id: string;
  dispatch_id: string;
  outcome: AttemptOutcome;
  source: AttemptOutcomeDecisionSource;
  summary: string | null;
  reason: string | null;
  evidence_observation_id: string | null;
  override_without_exact_evidence: number;
  created_at: string;
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} is required`);
}

function rejectDuplicates(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    requireNonEmpty(value, field);
    if (seen.has(value)) throw new Error(`Duplicate ${field}: ${value}`);
    seen.add(value);
  }
}

function toProject(row: ProjectRow): DurableProject {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toRepository(row: RepositoryRow): DurableRepository {
  return {
    id: row.id,
    identityKind: row.identity_kind,
    name: row.name,
    ...(row.canonical_remote ? { canonicalRemote: row.canonical_remote } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCheckout(row: CheckoutRow): RepositoryCheckoutBinding {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    installationId: row.installation_id,
    canonicalPath: row.canonical_path,
    availability: row.availability,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toRepositoryObservation(row: RepositoryObservationRow): DurableRepositoryObservation {
  return {
    repositoryId: row.repository_id,
    checkoutBindingId: row.checkout_binding_id,
    availability: row.availability,
    ...(row.branch ? { branch: row.branch } : {}),
    detachedHead: row.detached_head === 1,
    ...(row.head_commit ? { headCommit: row.head_commit } : {}),
    workingTree: row.working_tree,
    ...(row.reason ? { reason: row.reason } : {}),
    observedAt: row.observed_at,
  };
}

function toRuntimeObservation(row: RuntimeObservationRow): DurableRuntimeObservation {
  return {
    projectId: row.project_id,
    agentId: row.agent_id,
    associationState: row.association_state,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.runtime_state ? { runtimeState: row.runtime_state } : {}),
    ...(row.enabled_known === 1
      ? { enabled: row.enabled === null ? null : row.enabled === 1 }
      : {}),
    ...(row.configured_known === 1 ? { configured: row.configured === 1 } : {}),
    ...(row.last_heartbeat ? { lastHeartbeat: row.last_heartbeat } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    observedAt: row.observed_at,
  };
}

function toJob(row: JobRow): DurableJob {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    status: row.status,
    ...(row.repository_id ? { repositoryId: row.repository_id } : {}),
    ...(row.preferred_runtime_agent_id
      ? { preferredRuntimeAgentId: row.preferred_runtime_agent_id }
      : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: AttemptRow): DurableJobAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    sequence: row.sequence,
    ...(row.runtime_agent_id ? { runtimeAgentId: row.runtime_agent_id } : {}),
    status: row.status,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toExecutionPlan(row: ExecutionPlanRow): DurableExecutionPlan {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    jobId: row.job_id,
    projectId: row.project_id,
    installationId: row.installation_id,
    runtimeAgentId: row.runtime_agent_id,
    ...(row.repository_id ? { repositoryId: row.repository_id } : {}),
    ...(row.checkout_binding_id ? { checkoutBindingId: row.checkout_binding_id } : {}),
    input: { version: row.input_version, instruction: row.instruction },
    jobRevisionAtPreparation: row.job_revision,
    attemptRevisionAtPreparation: row.attempt_revision,
    createdAt: row.created_at,
  };
}

function toExecutionDispatch(row: ExecutionDispatchRow): DurableExecutionDispatch {
  return {
    id: row.id,
    executionPlanId: row.execution_plan_id,
    attemptId: row.attempt_id,
    jobId: row.job_id,
    runtimeAgentId: row.runtime_agent_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    ...(row.external_reference ? { externalReference: row.external_reference } : {}),
    ...(row.message ? { message: row.message } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.submitted_at ? { submittedAt: row.submitted_at } : {}),
    ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

function toExecutionObservation(row: ExecutionObservationRow): DurableExecutionObservation {
  return {
    id: row.id,
    dispatchId: row.dispatch_id,
    attemptId: row.attempt_id,
    source: row.source,
    sourceEventId: row.source_event_id,
    kind: row.kind,
    correlation: row.correlation,
    ...(row.correlated_dispatch_id ? { correlatedDispatchId: row.correlated_dispatch_id } : {}),
    ...(row.runtime_session_id ? { runtimeSessionId: row.runtime_session_id } : {}),
    ...(row.external_reference ? { externalReference: row.external_reference } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.output_summary ? { outputSummary: row.output_summary } : {}),
    observedAt: row.observed_at,
    recordedAt: row.recorded_at,
  };
}

function toAttemptOutcomeDecision(row: AttemptOutcomeDecisionRow): DurableAttemptOutcomeDecision {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    dispatchId: row.dispatch_id,
    outcome: row.outcome,
    source: row.source,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.evidence_observation_id ? { evidenceObservationId: row.evidence_observation_id } : {}),
    overrideWithoutExactCompletionEvidence: row.override_without_exact_evidence === 1,
    createdAt: row.created_at,
  };
}

function isValidDispatchTransition(from: DispatchStatus, to: DispatchStatus): boolean {
  return from === 'prepared' && to === 'submitting'
    || from === 'submitting' && (to === 'accepted' || to === 'rejected' || to === 'uncertain');
}

export class SqliteAgentOperationsStateStore implements AgentOperationsStateStore {
  readonly databasePath: string;
  private readonly database: Database.Database;
  private closed = false;

  private constructor(databasePath: string, database: Database.Database) {
    this.databasePath = databasePath;
    this.database = database;
  }

  static open(options: SqliteAgentOperationsStateStoreOptions = {}): SqliteAgentOperationsStateStore {
    const now = options.now ?? (() => new Date());
    const databasePath = resolve(options.databasePath ?? resolveAgentOperationsStateLocation().databasePath);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    let database: Database.Database | undefined;
    try {
      database = new Database(databasePath, { timeout: 5_000 });
      database.pragma('busy_timeout = 5000');
      database.pragma('foreign_keys = ON');
      applyStateMigrations(
        database,
        options.additionalMigrations,
        now,
        options.targetSchemaVersion,
      );
      const installation = database.prepare('SELECT id FROM installations LIMIT 1').get() as { id: string } | undefined;
      if (!installation) {
        const id = options.installationIdFactory?.() ?? `installation:${randomUUID()}`;
        requireNonEmpty(id, 'Installation ID');
        database.prepare('INSERT INTO installations (id, created_at, label) VALUES (?, ?, ?)')
          .run(id, now().toISOString(), options.installationLabel ?? null);
      }
      chmodSync(databasePath, 0o600);
      return new SqliteAgentOperationsStateStore(databasePath, database);
    } catch (error) {
      database?.close();
      throw new Error(`Could not open Agent Operations state at ${databasePath}: ${(error as Error).message}`);
    }
  }

  async getInstallation(): Promise<AgentOperationsInstallation> {
    this.assertOpen();
    const row = this.database.prepare('SELECT id, created_at, label FROM installations LIMIT 1')
      .get() as { id: string; created_at: string; label: string | null } | undefined;
    if (!row) throw new Error('Agent Operations state has no installation identity');
    return {
      id: row.id,
      createdAt: row.created_at,
      ...(row.label ? { label: row.label } : {}),
    };
  }

  async applyProjectConfiguration(configuration: DurableProjectConfiguration): Promise<void> {
    this.assertOpen();
    this.validateConfiguration(configuration);
    const apply = this.database.transaction(() => {
      const { project, repositories, checkoutBindings, runtimeAgentIds } = configuration;
      this.database.prepare(`
        INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
      `).run(project.id, project.name, project.createdAt, project.updatedAt);

      for (const repository of repositories) {
        const existing = this.database.prepare(
          'SELECT identity_kind, canonical_remote FROM repositories WHERE id = ?',
        ).get(repository.id) as { identity_kind: RepositoryIdentityKind; canonical_remote: string | null } | undefined;
        if (existing && (existing.identity_kind !== repository.identityKind
          || existing.canonical_remote !== (repository.canonicalRemote ?? null))) {
          throw new Error(`Repository identity conflict for ${repository.id}`);
        }
        this.database.prepare(`
          INSERT INTO repositories
            (id, identity_kind, name, canonical_remote, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
        `).run(
          repository.id,
          repository.identityKind,
          repository.name,
          repository.canonicalRemote ?? null,
          repository.createdAt,
          repository.updatedAt,
        );
      }

      for (const binding of checkoutBindings) {
        const pathConflict = this.database.prepare(`
          SELECT repository_id FROM repository_checkouts
          WHERE installation_id = ? AND canonical_path = ? AND repository_id <> ?
        `).get(binding.installationId, binding.canonicalPath, binding.repositoryId) as
          { repository_id: string } | undefined;
        if (pathConflict) {
          throw new Error(
            `Checkout path identity conflict: ${binding.canonicalPath} is already bound to ${pathConflict.repository_id}`,
          );
        }
        const idConflict = this.database.prepare(`
          SELECT repository_id, installation_id, canonical_path FROM repository_checkouts WHERE id = ?
        `).get(binding.id) as Pick<CheckoutRow, 'repository_id' | 'installation_id' | 'canonical_path'> | undefined;
        if (idConflict && (idConflict.repository_id !== binding.repositoryId
          || idConflict.installation_id !== binding.installationId
          || idConflict.canonical_path !== binding.canonicalPath)) {
          throw new Error(`Checkout binding identity conflict for ${binding.id}`);
        }
        this.database.prepare(`
          INSERT INTO repository_checkouts
            (id, repository_id, installation_id, canonical_path, availability, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            availability = excluded.availability,
            last_seen_at = excluded.last_seen_at
        `).run(
          binding.id,
          binding.repositoryId,
          binding.installationId,
          binding.canonicalPath,
          binding.availability,
          binding.firstSeenAt,
          binding.lastSeenAt,
        );
      }

      this.database.prepare('DELETE FROM project_repositories WHERE project_id = ?').run(project.id);
      const insertRepositoryAssociation = this.database.prepare(
        'INSERT INTO project_repositories (project_id, repository_id) VALUES (?, ?)',
      );
      for (const repository of repositories) insertRepositoryAssociation.run(project.id, repository.id);

      this.database.prepare('DELETE FROM project_runtime_agents WHERE project_id = ?').run(project.id);
      const insertRuntimeAssociation = this.database.prepare(
        'INSERT INTO project_runtime_agents (project_id, agent_id) VALUES (?, ?)',
      );
      for (const agentId of runtimeAgentIds) insertRuntimeAssociation.run(project.id, agentId);
    });
    apply();
  }

  async getProject(id: string): Promise<DurableProject | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  async listProjects(): Promise<readonly DurableProject[]> {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[]).map(toProject);
  }

  async getRepository(id: string): Promise<DurableRepository | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM repositories WHERE id = ?')
      .get(id) as RepositoryRow | undefined;
    return row ? toRepository(row) : null;
  }

  async listRepositories(): Promise<readonly DurableRepository[]> {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM repositories ORDER BY id').all() as RepositoryRow[])
      .map(toRepository);
  }

  async listCheckoutBindings(repositoryId?: string): Promise<readonly RepositoryCheckoutBinding[]> {
    this.assertOpen();
    const rows = repositoryId
      ? this.database.prepare('SELECT * FROM repository_checkouts WHERE repository_id = ? ORDER BY id').all(repositoryId)
      : this.database.prepare('SELECT * FROM repository_checkouts ORDER BY id').all();
    return (rows as CheckoutRow[]).map(toCheckout);
  }

  async listProjectRepositoryIds(projectId: string): Promise<readonly string[]> {
    this.assertOpen();
    return (this.database.prepare(
      'SELECT repository_id FROM project_repositories WHERE project_id = ? ORDER BY repository_id',
    ).all(projectId) as Array<{ repository_id: string }>).map(row => row.repository_id);
  }

  async listProjectRuntimeAgentIds(projectId: string): Promise<readonly string[]> {
    this.assertOpen();
    return (this.database.prepare(
      'SELECT agent_id FROM project_runtime_agents WHERE project_id = ? ORDER BY agent_id',
    ).all(projectId) as Array<{ agent_id: string }>).map(row => row.agent_id);
  }

  async recordRepositoryObservation(observation: DurableRepositoryObservation): Promise<void> {
    this.assertOpen();
    try {
      this.database.prepare(`
        INSERT INTO repository_observations
          (repository_id, checkout_binding_id, availability, branch, detached_head,
           head_commit, working_tree, reason, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.repositoryId,
        observation.checkoutBindingId,
        observation.availability,
        observation.branch ?? null,
        observation.detachedHead ? 1 : 0,
        observation.headCommit ?? null,
        observation.workingTree,
        observation.reason ?? null,
        observation.observedAt,
      );
    } catch (error) {
      throw new Error(`Could not record repository observation: ${(error as Error).message}`);
    }
  }

  async getLatestRepositoryObservation(checkoutBindingId: string): Promise<DurableRepositoryObservation | null> {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT repository_id, checkout_binding_id, availability, branch, detached_head,
             head_commit, working_tree, reason, observed_at
      FROM repository_observations
      WHERE checkout_binding_id = ?
      ORDER BY observed_at DESC, sequence DESC LIMIT 1
    `).get(checkoutBindingId) as RepositoryObservationRow | undefined;
    return row ? toRepositoryObservation(row) : null;
  }

  async recordRuntimeObservation(observation: DurableRuntimeObservation): Promise<void> {
    this.assertOpen();
    try {
      const association = this.database.prepare(`
        SELECT 1 FROM project_runtime_agents WHERE project_id = ? AND agent_id = ?
      `).get(observation.projectId, observation.agentId);
      if (!association) {
        throw new Error(`Unknown project runtime association: ${observation.projectId}/${observation.agentId}`);
      }
      this.database.prepare(`
        INSERT INTO runtime_observations
          (project_id, agent_id, association_state, provider, runtime_state,
           enabled_known, enabled, configured_known, configured, last_heartbeat, reason, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.projectId,
        observation.agentId,
        observation.associationState,
        observation.provider ?? null,
        observation.runtimeState ?? null,
        Object.hasOwn(observation, 'enabled') ? 1 : 0,
        observation.enabled === undefined || observation.enabled === null
          ? null
          : observation.enabled ? 1 : 0,
        Object.hasOwn(observation, 'configured') ? 1 : 0,
        observation.configured === undefined ? null : observation.configured ? 1 : 0,
        observation.lastHeartbeat ?? null,
        observation.reason ?? null,
        observation.observedAt,
      );
    } catch (error) {
      throw new Error(`Could not record runtime observation: ${(error as Error).message}`);
    }
  }

  async getLatestRuntimeObservation(projectId: string, agentId: string): Promise<DurableRuntimeObservation | null> {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT project_id, agent_id, association_state, provider, runtime_state,
             enabled_known, enabled, configured_known, configured, last_heartbeat, reason, observed_at
      FROM runtime_observations
      WHERE project_id = ? AND agent_id = ?
      ORDER BY observed_at DESC, sequence DESC LIMIT 1
    `).get(projectId, agentId) as RuntimeObservationRow | undefined;
    return row ? toRuntimeObservation(row) : null;
  }

  async createJob(job: DurableJob): Promise<void> {
    this.assertOpen();
    requireNonEmpty(job.title, 'Job title');
    if (!job.id.startsWith('job:')) throw new Error(`Invalid Agent Operations job ID: ${job.id}`);
    if (job.status !== 'draft' || job.revision !== 0) throw new Error('New jobs must be draft at revision 0');
    try {
      const project = this.database.prepare('SELECT 1 FROM projects WHERE id = ?').get(job.projectId);
      if (!project) throw new Error(`Unknown project for job: ${job.projectId}`);
      if (job.repositoryId) {
        const association = this.database.prepare(`
          SELECT 1 FROM project_repositories WHERE project_id = ? AND repository_id = ?
        `).get(job.projectId, job.repositoryId);
        if (!association) {
          throw new Error(`Repository ${job.repositoryId} is not associated with project ${job.projectId}`);
        }
      }
      if (job.preferredRuntimeAgentId) {
        const association = this.database.prepare(`
          SELECT 1 FROM project_runtime_agents WHERE project_id = ? AND agent_id = ?
        `).get(job.projectId, job.preferredRuntimeAgentId);
        if (!association) {
          throw new Error(
            `Runtime ${job.preferredRuntimeAgentId} is not associated with project ${job.projectId}`,
          );
        }
      }
      this.database.prepare(`
        INSERT INTO jobs
          (id, project_id, title, description, status, repository_id,
           preferred_runtime_agent_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id,
        job.projectId,
        job.title,
        job.description ?? null,
        job.status,
        job.repositoryId ?? null,
        job.preferredRuntimeAgentId ?? null,
        job.revision,
        job.createdAt,
        job.updatedAt,
      );
    } catch (error) {
      throw new Error(`Could not create job ${job.id}: ${(error as Error).message}`);
    }
  }

  async getJob(id: string): Promise<DurableJob | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  async listJobs(projectId?: string): Promise<readonly DurableJob[]> {
    this.assertOpen();
    const rows = projectId
      ? this.database.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at, id').all(projectId)
      : this.database.prepare('SELECT * FROM jobs ORDER BY created_at, id').all();
    return (rows as JobRow[]).map(toJob);
  }

  async saveJobTransition(job: DurableJob, expectedRevision: number): Promise<void> {
    this.assertOpen();
    const existingRow = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as JobRow | undefined;
    if (!existingRow) throw new Error(`Job not found: ${job.id}`);
    const existing = toJob(existingRow);
    if (existing.projectId !== job.projectId
      || existing.repositoryId !== job.repositoryId
      || existing.preferredRuntimeAgentId !== job.preferredRuntimeAgentId
      || existing.createdAt !== job.createdAt) {
      throw new Error(`Job transition cannot rewrite durable identity or assignment: ${job.id}`);
    }
    if (job.revision !== expectedRevision + 1) {
      throw new Error(`Job transition revision must advance exactly once: ${job.id}`);
    }
    const result = this.database.prepare(`
      UPDATE jobs SET title = ?, description = ?, status = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      job.title,
      job.description ?? null,
      job.status,
      job.revision,
      job.updatedAt,
      job.id,
      expectedRevision,
    );
    if (result.changes !== 1) throw new Error(`Stale job revision for ${job.id}`);
  }

  async createAttempt(attempt: NewDurableJobAttempt): Promise<DurableJobAttempt> {
    this.assertOpen();
    if (!attempt.id.startsWith('attempt:')) throw new Error(`Invalid Agent Operations attempt ID: ${attempt.id}`);
    if (attempt.status !== 'created' || attempt.revision !== 0) {
      throw new Error('New attempts must be created at revision 0');
    }
    try {
      const create = this.database.transaction(() => {
        const job = this.database.prepare('SELECT project_id FROM jobs WHERE id = ?')
          .get(attempt.jobId) as { project_id: string } | undefined;
        if (!job) throw new Error(`Unknown job for attempt: ${attempt.jobId}`);
        if (attempt.runtimeAgentId) {
          const association = this.database.prepare(`
            SELECT 1 FROM project_runtime_agents WHERE project_id = ? AND agent_id = ?
          `).get(job.project_id, attempt.runtimeAgentId);
          if (!association) {
            throw new Error(
              `Runtime ${attempt.runtimeAgentId} is not associated with project ${job.project_id}`,
            );
          }
        }
        const active = this.database.prepare(`
          SELECT id FROM job_attempts WHERE job_id = ? AND status IN ('created', 'running') LIMIT 1
        `).get(attempt.jobId) as { id: string } | undefined;
        if (active) throw new Error(`Job ${attempt.jobId} already has an active attempt`);
        const row = this.database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM job_attempts WHERE job_id = ?
        `).get(attempt.jobId) as { next_sequence: number };
        this.database.prepare(`
          INSERT INTO job_attempts
            (id, job_id, sequence, runtime_agent_id, status, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          attempt.id,
          attempt.jobId,
          row.next_sequence,
          attempt.runtimeAgentId ?? null,
          attempt.status,
          attempt.revision,
          attempt.createdAt,
          attempt.updatedAt,
        );
        return { ...attempt, sequence: row.next_sequence };
      });
      return create.immediate();
    } catch (error) {
      throw new Error(`Could not create attempt ${attempt.id}: ${(error as Error).message}`);
    }
  }

  async getAttempt(id: string): Promise<DurableJobAttempt | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM job_attempts WHERE id = ?')
      .get(id) as AttemptRow | undefined;
    return row ? toAttempt(row) : null;
  }

  async listAttemptsForJob(jobId: string): Promise<readonly DurableJobAttempt[]> {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY sequence')
      .all(jobId) as AttemptRow[]).map(toAttempt);
  }

  async saveAttemptTransition(attempt: DurableJobAttempt, expectedRevision: number): Promise<void> {
    this.assertOpen();
    const existingRow = this.database.prepare('SELECT * FROM job_attempts WHERE id = ?')
      .get(attempt.id) as AttemptRow | undefined;
    if (!existingRow) throw new Error(`Attempt not found: ${attempt.id}`);
    const existing = toAttempt(existingRow);
    if (existing.jobId !== attempt.jobId
      || existing.sequence !== attempt.sequence
      || existing.runtimeAgentId !== attempt.runtimeAgentId
      || existing.createdAt !== attempt.createdAt) {
      throw new Error(`Attempt transition cannot rewrite durable identity or assignment: ${attempt.id}`);
    }
    if (attempt.revision !== expectedRevision + 1) {
      throw new Error(`Attempt transition revision must advance exactly once: ${attempt.id}`);
    }
    const result = this.database.prepare(`
      UPDATE job_attempts SET
        status = ?, started_at = ?, finished_at = ?, summary = ?, failure_reason = ?,
        revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      attempt.status,
      attempt.startedAt ?? null,
      attempt.finishedAt ?? null,
      attempt.summary ?? null,
      attempt.failureReason ?? null,
      attempt.revision,
      attempt.updatedAt,
      attempt.id,
      expectedRevision,
    );
    if (result.changes !== 1) throw new Error(`Stale attempt revision for ${attempt.id}`);
  }

  async createExecutionPlan(plan: DurableExecutionPlan): Promise<void> {
    this.assertOpen();
    requireNonEmpty(plan.input.instruction, 'Execution instruction');
    if (!plan.id.startsWith('plan:')) throw new Error(`Invalid Execution Plan ID: ${plan.id}`);
    if (plan.input.version !== 1) throw new Error(`Unsupported execution input version: ${plan.input.version}`);
    if (plan.jobRevisionAtPreparation < 0 || plan.attemptRevisionAtPreparation < 0) {
      throw new Error('Execution Plan revisions must be non-negative');
    }
    const attempt = this.database.prepare(`
      SELECT a.job_id, a.runtime_agent_id, a.revision AS attempt_revision,
             j.project_id, j.repository_id, j.revision AS job_revision
      FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?
    `).get(plan.attemptId) as {
      job_id: string;
      runtime_agent_id: string | null;
      project_id: string;
      repository_id: string | null;
      job_revision: number;
      attempt_revision: number;
    } | undefined;
    if (!attempt
      || attempt.job_id !== plan.jobId
      || attempt.project_id !== plan.projectId
      || attempt.runtime_agent_id !== plan.runtimeAgentId
      || (attempt.repository_id ?? undefined) !== plan.repositoryId
      || attempt.job_revision !== plan.jobRevisionAtPreparation
      || attempt.attempt_revision !== plan.attemptRevisionAtPreparation) {
      throw new Error(`Invalid Execution Plan durable associations: ${plan.id}`);
    }
    try {
      this.database.prepare(`
        INSERT INTO execution_plans
          (id, attempt_id, job_id, project_id, installation_id, runtime_agent_id,
           repository_id, checkout_binding_id, input_version, instruction,
           job_revision, attempt_revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.id,
        plan.attemptId,
        plan.jobId,
        plan.projectId,
        plan.installationId,
        plan.runtimeAgentId,
        plan.repositoryId ?? null,
        plan.checkoutBindingId ?? null,
        plan.input.version,
        plan.input.instruction,
        plan.jobRevisionAtPreparation,
        plan.attemptRevisionAtPreparation,
        plan.createdAt,
      );
    } catch (error) {
      throw new Error(`Could not create Execution Plan ${plan.id}: ${(error as Error).message}`);
    }
  }

  async getExecutionPlan(id: string): Promise<DurableExecutionPlan | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_plans WHERE id = ?')
      .get(id) as ExecutionPlanRow | undefined;
    return row ? toExecutionPlan(row) : null;
  }

  async getExecutionPlanForAttempt(attemptId: string): Promise<DurableExecutionPlan | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_plans WHERE attempt_id = ?')
      .get(attemptId) as ExecutionPlanRow | undefined;
    return row ? toExecutionPlan(row) : null;
  }

  async createExecutionDispatch(dispatch: DurableExecutionDispatch): Promise<void> {
    this.assertOpen();
    requireNonEmpty(dispatch.idempotencyKey, 'Execution Dispatch idempotency key');
    if (!dispatch.id.startsWith('dispatch:')) throw new Error(`Invalid Execution Dispatch ID: ${dispatch.id}`);
    if (dispatch.status !== 'prepared' || dispatch.revision !== 0) {
      throw new Error('New Execution Dispatches must be prepared at revision 0');
    }
    const plan = this.database.prepare(`
      SELECT attempt_id, job_id, runtime_agent_id FROM execution_plans WHERE id = ?
    `).get(dispatch.executionPlanId) as {
      attempt_id: string;
      job_id: string;
      runtime_agent_id: string;
    } | undefined;
    if (!plan
      || plan.attempt_id !== dispatch.attemptId
      || plan.job_id !== dispatch.jobId
      || plan.runtime_agent_id !== dispatch.runtimeAgentId) {
      throw new Error(`Invalid Execution Dispatch Plan associations: ${dispatch.id}`);
    }
    try {
      this.database.prepare(`
        INSERT INTO execution_dispatches
          (id, execution_plan_id, attempt_id, job_id, runtime_agent_id, idempotency_key,
           status, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        dispatch.id,
        dispatch.executionPlanId,
        dispatch.attemptId,
        dispatch.jobId,
        dispatch.runtimeAgentId,
        dispatch.idempotencyKey,
        dispatch.status,
        dispatch.revision,
        dispatch.createdAt,
        dispatch.updatedAt,
      );
    } catch (error) {
      throw new Error(`Could not create Execution Dispatch ${dispatch.id}: ${(error as Error).message}`);
    }
  }

  async getExecutionDispatch(id: string): Promise<DurableExecutionDispatch | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_dispatches WHERE id = ?')
      .get(id) as ExecutionDispatchRow | undefined;
    return row ? toExecutionDispatch(row) : null;
  }

  async getExecutionDispatchForPlan(executionPlanId: string): Promise<DurableExecutionDispatch | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_dispatches WHERE execution_plan_id = ?')
      .get(executionPlanId) as ExecutionDispatchRow | undefined;
    return row ? toExecutionDispatch(row) : null;
  }

  async saveExecutionDispatchTransition(
    dispatch: DurableExecutionDispatch,
    expectedRevision: number,
  ): Promise<void> {
    this.assertOpen();
    const existingRow = this.database.prepare('SELECT * FROM execution_dispatches WHERE id = ?')
      .get(dispatch.id) as ExecutionDispatchRow | undefined;
    if (!existingRow) throw new Error(`Execution Dispatch not found: ${dispatch.id}`);
    const existing = toExecutionDispatch(existingRow);
    if (existing.executionPlanId !== dispatch.executionPlanId
      || existing.attemptId !== dispatch.attemptId
      || existing.jobId !== dispatch.jobId
      || existing.runtimeAgentId !== dispatch.runtimeAgentId
      || existing.idempotencyKey !== dispatch.idempotencyKey
      || existing.createdAt !== dispatch.createdAt) {
      throw new Error(`Execution Dispatch transition cannot rewrite durable identity: ${dispatch.id}`);
    }
    if (dispatch.revision !== expectedRevision + 1) {
      throw new Error(`Execution Dispatch transition revision must advance exactly once: ${dispatch.id}`);
    }
    if (!isValidDispatchTransition(existing.status, dispatch.status)) {
      throw new Error(`Execution Dispatch cannot transition from ${existing.status} to ${dispatch.status}`);
    }
    try {
      const result = this.database.prepare(`
        UPDATE execution_dispatches SET
          status = ?, external_reference = ?, message = ?, revision = ?, updated_at = ?,
          submitted_at = ?, accepted_at = ?, resolved_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        dispatch.status,
        dispatch.externalReference ?? null,
        dispatch.message ?? null,
        dispatch.revision,
        dispatch.updatedAt,
        dispatch.submittedAt ?? null,
        dispatch.acceptedAt ?? null,
        dispatch.resolvedAt ?? null,
        dispatch.id,
        expectedRevision,
      );
      if (result.changes !== 1) throw new Error(`Stale Execution Dispatch revision for ${dispatch.id}`);
    } catch (error) {
      throw new Error(`Could not transition Execution Dispatch ${dispatch.id}: ${(error as Error).message}`);
    }
  }

  async appendExecutionObservation(observation: DurableExecutionObservation): Promise<boolean> {
    this.assertOpen();
    requireNonEmpty(observation.source, 'Execution Observation source');
    requireNonEmpty(observation.sourceEventId, 'Execution Observation source event ID');
    const existing = this.database.prepare(`
      SELECT id FROM execution_observations
      WHERE id = ? OR (dispatch_id = ? AND source = ? AND source_event_id = ?)
      LIMIT 1
    `).get(
      observation.id,
      observation.dispatchId,
      observation.source,
      observation.sourceEventId,
    );
    if (existing) return false;
    try {
      this.database.prepare(`
        INSERT INTO execution_observations
          (id, dispatch_id, attempt_id, source, source_event_id, kind, correlation,
           correlated_dispatch_id, runtime_session_id, external_reference, message,
           output_summary, observed_at, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.id,
        observation.dispatchId,
        observation.attemptId,
        observation.source,
        observation.sourceEventId,
        observation.kind,
        observation.correlation,
        observation.correlatedDispatchId ?? null,
        observation.runtimeSessionId ?? null,
        observation.externalReference ?? null,
        observation.message ?? null,
        observation.outputSummary ?? null,
        observation.observedAt,
        observation.recordedAt,
      );
      return true;
    } catch (error) {
      const raced = this.database.prepare(`
        SELECT id FROM execution_observations
        WHERE id = ? OR (dispatch_id = ? AND source = ? AND source_event_id = ?)
        LIMIT 1
      `).get(
        observation.id,
        observation.dispatchId,
        observation.source,
        observation.sourceEventId,
      );
      if (raced) return false;
      throw new Error(`Could not append Execution Observation ${observation.id}: ${(error as Error).message}`);
    }
  }

  async listExecutionObservationsForDispatch(
    dispatchId: string,
  ): Promise<readonly DurableExecutionObservation[]> {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM execution_observations
      WHERE dispatch_id = ? ORDER BY observed_at, id
    `).all(dispatchId) as ExecutionObservationRow[]).map(toExecutionObservation);
  }

  async createAttemptOutcomeDecision(decision: DurableAttemptOutcomeDecision): Promise<void> {
    this.assertOpen();
    try {
      this.database.prepare(`
        INSERT INTO attempt_outcome_decisions
          (id, attempt_id, dispatch_id, outcome, source, summary, reason,
           evidence_observation_id, override_without_exact_evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.id,
        decision.attemptId,
        decision.dispatchId,
        decision.outcome,
        decision.source,
        decision.summary ?? null,
        decision.reason ?? null,
        decision.evidenceObservationId ?? null,
        decision.overrideWithoutExactCompletionEvidence ? 1 : 0,
        decision.createdAt,
      );
    } catch (error) {
      throw new Error(`Could not create Attempt Outcome Decision ${decision.id}: ${(error as Error).message}`);
    }
  }

  async getAttemptOutcomeDecision(attemptId: string): Promise<DurableAttemptOutcomeDecision | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM attempt_outcome_decisions WHERE attempt_id = ?')
      .get(attemptId) as AttemptOutcomeDecisionRow | undefined;
    return row ? toAttemptOutcomeDecision(row) : null;
  }

  async close(): Promise<void> {
    this.assertOpen();
    this.database.close();
    this.closed = true;
  }

  private validateConfiguration(configuration: DurableProjectConfiguration): void {
    const { project, repositories, checkoutBindings, runtimeAgentIds } = configuration;
    requireNonEmpty(project.id, 'Project ID');
    requireNonEmpty(project.name, 'Project name');
    rejectDuplicates(repositories.map(item => item.id), 'repository ID');
    rejectDuplicates(checkoutBindings.map(item => item.id), 'checkout binding ID');
    rejectDuplicates(runtimeAgentIds, 'runtime agent ID');
    const repositoryIds = new Set(repositories.map(item => item.id));
    const installation = this.database.prepare('SELECT id FROM installations LIMIT 1').get() as { id: string };
    for (const repository of repositories) {
      if (repository.identityKind === 'remote'
        && (!repository.canonicalRemote || repository.id !== `remote:${repository.canonicalRemote}`)) {
        throw new Error(`Remote repository ${repository.id} has inconsistent canonical identity`);
      }
      if (repository.identityKind === 'local'
        && (!repository.id.startsWith('local:') || repository.canonicalRemote !== undefined)) {
        throw new Error(`Local repository ${repository.id} has inconsistent local identity`);
      }
    }
    for (const binding of checkoutBindings) {
      if (!repositoryIds.has(binding.repositoryId)) {
        throw new Error(`Checkout ${binding.id} references unknown repository ${binding.repositoryId}`);
      }
      if (binding.installationId !== installation.id) {
        throw new Error(`Checkout ${binding.id} belongs to another installation`);
      }
      if (binding.id !== createRepositoryCheckoutBindingId(binding.installationId, binding.canonicalPath)) {
        throw new Error(`Checkout binding ID does not match its installation and path: ${binding.id}`);
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Agent Operations state store is closed');
  }
}
