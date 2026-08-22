import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AgentOperationsInstallation,
  AgentOperationsStateStore,
  DurableProject,
  DurableProjectConfiguration,
  DurableRepository,
  DurableRepositoryObservation,
  DurableRuntimeObservation,
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
      applyStateMigrations(database, options.additionalMigrations, now);
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
