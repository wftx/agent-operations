import type {
  AgentOperationsInstallation,
  AgentOperationsStateStore,
  DurableProject,
  DurableProjectConfiguration,
  DurableRepository,
  DurableRepositoryObservation,
  DurableRuntimeObservation,
  RepositoryCheckoutBinding,
} from '../persistence.js';
import { createRepositoryCheckoutBindingId } from '../persistence.js';

export type InMemoryStateStoreOperation =
  | 'get-installation'
  | 'apply-configuration'
  | 'read'
  | 'record-repository-observation'
  | 'record-runtime-observation'
  | 'close';

export interface InMemoryAgentOperationsStateStoreOptions {
  readonly installation?: AgentOperationsInstallation;
  readonly failOperations?: readonly InMemoryStateStoreOperation[];
}

const DEFAULT_INSTALLATION: AgentOperationsInstallation = {
  id: 'installation:test',
  createdAt: '2026-01-01T00:00:00.000Z',
  label: 'Deterministic test installation',
};

function copyProject(value: DurableProject): DurableProject {
  return { ...value };
}

function copyRepository(value: DurableRepository): DurableRepository {
  return { ...value };
}

function copyBinding(value: RepositoryCheckoutBinding): RepositoryCheckoutBinding {
  return { ...value };
}

function copyRepositoryObservation(value: DurableRepositoryObservation): DurableRepositoryObservation {
  return { ...value };
}

function copyRuntimeObservation(value: DurableRuntimeObservation): DurableRuntimeObservation {
  return { ...value };
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

/** Deterministic, defensively-copying state store for AO domain tests. */
export class InMemoryAgentOperationsStateStore implements AgentOperationsStateStore {
  private readonly installation: AgentOperationsInstallation;
  private readonly failOperations: ReadonlySet<InMemoryStateStoreOperation>;
  private readonly projects = new Map<string, DurableProject>();
  private readonly repositories = new Map<string, DurableRepository>();
  private readonly bindings = new Map<string, RepositoryCheckoutBinding>();
  private readonly projectRepositories = new Map<string, Set<string>>();
  private readonly projectRuntimeAgents = new Map<string, Set<string>>();
  private readonly repositoryObservations = new Map<string, DurableRepositoryObservation[]>();
  private readonly runtimeObservations = new Map<string, DurableRuntimeObservation[]>();
  private closed = false;

  constructor(options: InMemoryAgentOperationsStateStoreOptions = {}) {
    this.installation = { ...(options.installation ?? DEFAULT_INSTALLATION) };
    this.failOperations = new Set(options.failOperations ?? []);
  }

  async getInstallation(): Promise<AgentOperationsInstallation> {
    this.assertAvailable('get-installation');
    return { ...this.installation };
  }

  async applyProjectConfiguration(configuration: DurableProjectConfiguration): Promise<void> {
    this.assertAvailable('apply-configuration');
    const { project, repositories, checkoutBindings, runtimeAgentIds } = configuration;
    requireNonEmpty(project.id, 'Project ID');
    requireNonEmpty(project.name, 'Project name');
    rejectDuplicates(repositories.map(item => item.id), 'repository ID');
    rejectDuplicates(checkoutBindings.map(item => item.id), 'checkout binding ID');
    rejectDuplicates(runtimeAgentIds, 'runtime agent ID');

    const repositoryIds = new Set(repositories.map(item => item.id));
    for (const repository of repositories) {
      requireNonEmpty(repository.id, 'Repository ID');
      if (repository.identityKind === 'remote'
        && (!repository.canonicalRemote || repository.id !== `remote:${repository.canonicalRemote}`)) {
        throw new Error(`Remote repository ${repository.id} has inconsistent canonical identity`);
      }
      if (repository.identityKind === 'local'
        && (!repository.id.startsWith('local:') || repository.canonicalRemote !== undefined)) {
        throw new Error(`Local repository ${repository.id} has inconsistent local identity`);
      }
      const existing = this.repositories.get(repository.id);
      if (existing && (existing.identityKind !== repository.identityKind
        || existing.canonicalRemote !== repository.canonicalRemote)) {
        throw new Error(`Repository identity conflict for ${repository.id}`);
      }
    }
    for (const binding of checkoutBindings) {
      if (!repositoryIds.has(binding.repositoryId)) {
        throw new Error(`Checkout ${binding.id} references unknown repository ${binding.repositoryId}`);
      }
      if (binding.installationId !== this.installation.id) {
        throw new Error(`Checkout ${binding.id} belongs to another installation`);
      }
      if (binding.id !== createRepositoryCheckoutBindingId(binding.installationId, binding.canonicalPath)) {
        throw new Error(`Checkout binding ID does not match its installation and path: ${binding.id}`);
      }
      const pathConflict = [...this.bindings.values()].find(candidate =>
        candidate.installationId === binding.installationId
        && candidate.canonicalPath === binding.canonicalPath
        && candidate.repositoryId !== binding.repositoryId);
      if (pathConflict) {
        throw new Error(`Checkout path identity conflict: ${binding.canonicalPath} is already bound to ${pathConflict.repositoryId}`);
      }
      const idConflict = this.bindings.get(binding.id);
      if (idConflict && (idConflict.repositoryId !== binding.repositoryId
        || idConflict.installationId !== binding.installationId
        || idConflict.canonicalPath !== binding.canonicalPath)) {
        throw new Error(`Checkout binding identity conflict for ${binding.id}`);
      }
    }

    const existingProject = this.projects.get(project.id);
    this.projects.set(project.id, {
      ...copyProject(project),
      createdAt: existingProject?.createdAt ?? project.createdAt,
    });
    for (const repository of repositories) {
      const existing = this.repositories.get(repository.id);
      this.repositories.set(repository.id, {
        ...copyRepository(repository),
        createdAt: existing?.createdAt ?? repository.createdAt,
      });
    }
    for (const binding of checkoutBindings) {
      const existing = this.bindings.get(binding.id);
      this.bindings.set(binding.id, {
        ...copyBinding(binding),
        firstSeenAt: existing?.firstSeenAt ?? binding.firstSeenAt,
      });
    }
    this.projectRepositories.set(project.id, new Set(repositoryIds));
    this.projectRuntimeAgents.set(project.id, new Set(runtimeAgentIds));
  }

  async getProject(id: string): Promise<DurableProject | null> {
    this.assertAvailable('read');
    const value = this.projects.get(id);
    return value ? copyProject(value) : null;
  }

  async listProjects(): Promise<readonly DurableProject[]> {
    this.assertAvailable('read');
    return [...this.projects.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copyProject);
  }

  async getRepository(id: string): Promise<DurableRepository | null> {
    this.assertAvailable('read');
    const value = this.repositories.get(id);
    return value ? copyRepository(value) : null;
  }

  async listRepositories(): Promise<readonly DurableRepository[]> {
    this.assertAvailable('read');
    return [...this.repositories.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copyRepository);
  }

  async listCheckoutBindings(repositoryId?: string): Promise<readonly RepositoryCheckoutBinding[]> {
    this.assertAvailable('read');
    return [...this.bindings.values()]
      .filter(binding => !repositoryId || binding.repositoryId === repositoryId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(copyBinding);
  }

  async listProjectRepositoryIds(projectId: string): Promise<readonly string[]> {
    this.assertAvailable('read');
    return [...(this.projectRepositories.get(projectId) ?? [])].sort();
  }

  async listProjectRuntimeAgentIds(projectId: string): Promise<readonly string[]> {
    this.assertAvailable('read');
    return [...(this.projectRuntimeAgents.get(projectId) ?? [])].sort();
  }

  async recordRepositoryObservation(observation: DurableRepositoryObservation): Promise<void> {
    this.assertAvailable('record-repository-observation');
    const binding = this.bindings.get(observation.checkoutBindingId);
    if (!binding || binding.repositoryId !== observation.repositoryId) {
      throw new Error(`Unknown repository checkout association: ${observation.checkoutBindingId}`);
    }
    const values = this.repositoryObservations.get(observation.checkoutBindingId) ?? [];
    values.push(copyRepositoryObservation(observation));
    this.repositoryObservations.set(observation.checkoutBindingId, values);
  }

  async getLatestRepositoryObservation(checkoutBindingId: string): Promise<DurableRepositoryObservation | null> {
    this.assertAvailable('read');
    const values = this.repositoryObservations.get(checkoutBindingId) ?? [];
    const latest = values.reduce<DurableRepositoryObservation | undefined>(
      (candidate, value) => !candidate || value.observedAt >= candidate.observedAt ? value : candidate,
      undefined,
    );
    return latest ? copyRepositoryObservation(latest) : null;
  }

  async recordRuntimeObservation(observation: DurableRuntimeObservation): Promise<void> {
    this.assertAvailable('record-runtime-observation');
    if (!this.projectRuntimeAgents.get(observation.projectId)?.has(observation.agentId)) {
      throw new Error(`Unknown project runtime association: ${observation.projectId}/${observation.agentId}`);
    }
    const key = `${observation.projectId}\0${observation.agentId}`;
    const values = this.runtimeObservations.get(key) ?? [];
    values.push(copyRuntimeObservation(observation));
    this.runtimeObservations.set(key, values);
  }

  async getLatestRuntimeObservation(projectId: string, agentId: string): Promise<DurableRuntimeObservation | null> {
    this.assertAvailable('read');
    const values = this.runtimeObservations.get(`${projectId}\0${agentId}`) ?? [];
    const latest = values.reduce<DurableRuntimeObservation | undefined>(
      (candidate, value) => !candidate || value.observedAt >= candidate.observedAt ? value : candidate,
      undefined,
    );
    return latest ? copyRuntimeObservation(latest) : null;
  }

  async close(): Promise<void> {
    this.assertAvailable('close');
    this.closed = true;
  }

  private assertAvailable(operation: InMemoryStateStoreOperation): void {
    if (this.closed) throw new Error('Agent Operations state store is closed');
    if (this.failOperations.has(operation)) throw new Error(`Simulated persistence failure: ${operation}`);
  }
}
