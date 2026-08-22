import type {
  AgentOperationsConfiguration,
  AgentOperationsInstallation,
  AgentOperationsStateStore,
  AgentRuntimeAdapter,
  DurableProjectConfiguration,
  DurableRepository,
  DurableRepositoryObservation,
  DurableRuntimeObservation,
  ProjectInventory,
  RepositoryCheckoutBinding,
  RepositoryInventoryAdapter,
} from '../../agent-operations-contracts/src/index.js';
import { createRepositoryCheckoutBindingId } from '../../agent-operations-contracts/src/index.js';
import { ProjectInventoryService } from './project-inventory-service.js';
import type { ProjectInventoryServiceOptions } from './project-inventory-service.js';

export interface StateSyncResult {
  readonly installation: AgentOperationsInstallation;
  readonly projects: readonly ProjectInventory[];
  readonly persistedRepositoryObservations: number;
  readonly persistedRuntimeObservations: number;
}

export type AgentOperationsStateSyncServiceOptions = ProjectInventoryServiceOptions;

/** Explicit developer-invoked observation -> durable AO state flow. It is not a reconciler. */
export class AgentOperationsStateSyncService {
  private readonly inventory: ProjectInventoryService;
  private readonly stateStore: AgentOperationsStateStore;

  constructor(
    repositoryAdapter: RepositoryInventoryAdapter,
    runtimeAdapter: AgentRuntimeAdapter,
    stateStore: AgentOperationsStateStore,
    options: AgentOperationsStateSyncServiceOptions = {},
  ) {
    this.inventory = new ProjectInventoryService(repositoryAdapter, runtimeAdapter, options);
    this.stateStore = stateStore;
  }

  async sync(
    configuration: AgentOperationsConfiguration,
    baseDirectory: string,
  ): Promise<StateSyncResult> {
    const installation = await this.stateStore.getInstallation();
    const projects = await this.inventory.listProjects(configuration, baseDirectory);
    let persistedRepositoryObservations = 0;
    let persistedRuntimeObservations = 0;

    for (const project of projects) {
      const repositories = new Map<string, DurableRepository>();
      const checkoutBindings: RepositoryCheckoutBinding[] = [];
      const repositoryObservations: DurableRepositoryObservation[] = [];

      for (const association of project.repositories) {
        const observed = association.repository;
        if (!observed) continue;
        const canonicalRemote = observed.identityKind === 'remote' && observed.id.startsWith('remote:')
          ? observed.id.slice('remote:'.length)
          : undefined;
        const repository: DurableRepository = {
          id: observed.id,
          identityKind: observed.identityKind,
          name: observed.name,
          ...(canonicalRemote ? { canonicalRemote } : {}),
          createdAt: observed.observedAt,
          updatedAt: observed.observedAt,
        };
        const existing = repositories.get(repository.id);
        if (existing && (existing.identityKind !== repository.identityKind
          || existing.canonicalRemote !== repository.canonicalRemote)) {
          throw new Error(`Repository inventory returned contradictory identity ${repository.id}`);
        }
        repositories.set(repository.id, repository);

        const canonicalPath = observed.repositoryRoot ?? observed.checkoutPath;
        const binding: RepositoryCheckoutBinding = {
          id: createRepositoryCheckoutBindingId(installation.id, canonicalPath),
          repositoryId: repository.id,
          installationId: installation.id,
          canonicalPath,
          availability: observed.availability,
          firstSeenAt: observed.observedAt,
          lastSeenAt: observed.observedAt,
        };
        checkoutBindings.push(binding);
        repositoryObservations.push({
          repositoryId: repository.id,
          checkoutBindingId: binding.id,
          availability: observed.availability,
          ...(observed.branch ? { branch: observed.branch } : {}),
          detachedHead: observed.detachedHead,
          ...(observed.headCommit ? { headCommit: observed.headCommit } : {}),
          workingTree: observed.workingTree,
          ...(observed.reason ? { reason: observed.reason } : {}),
          observedAt: observed.observedAt,
        });
      }

      const durableConfiguration: DurableProjectConfiguration = {
        project: {
          id: project.id,
          name: project.name,
          createdAt: project.observedAt,
          updatedAt: project.observedAt,
        },
        repositories: [...repositories.values()],
        checkoutBindings,
        runtimeAgentIds: project.runtimes.map(runtime => runtime.agentId),
      };
      await this.stateStore.applyProjectConfiguration(durableConfiguration);

      for (const observation of repositoryObservations) {
        await this.stateStore.recordRepositoryObservation(observation);
        persistedRepositoryObservations += 1;
      }

      for (const association of project.runtimes) {
        const runtime = association.runtime;
        const observation: DurableRuntimeObservation = {
          projectId: project.id,
          agentId: association.agentId,
          associationState: association.state,
          ...(runtime ? {
            provider: runtime.provider,
            runtimeState: runtime.health.state,
            enabled: runtime.enabled,
            configured: runtime.configured,
            ...(runtime.health.lastHeartbeat ? { lastHeartbeat: runtime.health.lastHeartbeat } : {}),
          } : {}),
          ...((association.reason ?? runtime?.health.reason)
            ? { reason: association.reason ?? runtime?.health.reason }
            : {}),
          observedAt: project.observedAt,
        };
        await this.stateStore.recordRuntimeObservation(observation);
        persistedRuntimeObservations += 1;
      }
    }

    return {
      installation,
      projects,
      persistedRepositoryObservations,
      persistedRuntimeObservations,
    };
  }
}
