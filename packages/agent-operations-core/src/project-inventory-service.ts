import { isAbsolute, resolve } from 'node:path';
import type {
  AgentOperationsConfiguration,
  AgentRuntimeAdapter,
  AgentRuntimeSummary,
  ProjectInventory,
  ProjectRepositoryObservation,
  ProjectRuntimeObservation,
  RepositoryInventoryAdapter,
} from '../../agent-operations-contracts/src/index.js';

export interface ProjectInventoryServiceOptions {
  readonly now?: () => Date;
}

function combineReasons(reasons: Array<string | undefined>): string | undefined {
  const unique = [...new Set(reasons.filter((reason): reason is string => Boolean(reason)))];
  return unique.length ? unique.join('; ') : undefined;
}

export class ProjectInventoryService {
  private readonly repositoryAdapter: RepositoryInventoryAdapter;
  private readonly runtimeAdapter: AgentRuntimeAdapter;
  private readonly now: () => Date;

  constructor(
    repositoryAdapter: RepositoryInventoryAdapter,
    runtimeAdapter: AgentRuntimeAdapter,
    options: ProjectInventoryServiceOptions = {},
  ) {
    this.repositoryAdapter = repositoryAdapter;
    this.runtimeAdapter = runtimeAdapter;
    this.now = options.now ?? (() => new Date());
  }

  async listProjects(
    configuration: AgentOperationsConfiguration,
    baseDirectory: string,
  ): Promise<readonly ProjectInventory[]> {
    let runtimes: readonly AgentRuntimeSummary[] = [];
    let runtimeInventoryError: string | undefined;
    const hasRuntimeAssociations = configuration.projects.some(project => project.runtimeAgentIds.length > 0);
    if (hasRuntimeAssociations) {
      try {
        runtimes = await this.runtimeAdapter.listAgents();
      } catch (error) {
        runtimeInventoryError = `Runtime inventory failed: ${(error as Error).message}`;
      }
    }
    const runtimeById = new Map(runtimes.map(runtime => [runtime.id, runtime]));
    return Promise.all(configuration.projects.map(async project => {
      const observedAt = this.now().toISOString();
      const repositoryObservations: ProjectRepositoryObservation[] = await Promise.all(
        project.repositories.map(async definition => {
          const resolvedPath = isAbsolute(definition.path)
            ? resolve(definition.path)
            : resolve(baseDirectory, definition.path);
          try {
            const repository = await this.repositoryAdapter.inspectRepository(resolvedPath);
            const state = repository.availability === 'available'
              ? 'available'
              : repository.availability === 'degraded'
                ? 'degraded'
                : 'unavailable';
            return {
              configuredPath: definition.path,
              resolvedPath,
              state,
              repository,
              ...(state !== 'available'
                ? { reason: repository.reason ?? `Repository is ${repository.availability}` }
                : {}),
            };
          } catch (error) {
            return {
              configuredPath: definition.path,
              resolvedPath,
              state: 'unavailable' as const,
              repository: null,
              reason: `Repository inventory failed: ${(error as Error).message}`,
            };
          }
        }),
      );

      const runtimeObservations: ProjectRuntimeObservation[] = project.runtimeAgentIds.map(agentId => {
        const runtime = runtimeById.get(agentId);
        if (runtime) return { agentId, state: 'available' as const, runtime };
        return {
          agentId,
          state: 'unavailable' as const,
          runtime: null,
          reason: runtimeInventoryError ?? 'Configured runtime agent is not currently observable',
        };
      });

      const hasDegradedAssociation = repositoryObservations.some(item => item.state !== 'available')
        || runtimeObservations.some(item => item.state !== 'available');
      const reasons = [
        ...repositoryObservations.filter(item => item.state !== 'available').map(item => item.reason),
        ...runtimeObservations.filter(item => item.state !== 'available').map(item => item.reason),
      ];
      const reason = combineReasons(reasons);
      return {
        id: project.id,
        name: project.name,
        repositories: repositoryObservations,
        runtimes: runtimeObservations,
        state: hasDegradedAssociation ? 'degraded' as const : 'available' as const,
        observedAt,
        ...(reason ? { reason } : {}),
      };
    }));
  }
}
