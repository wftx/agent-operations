import type { AgentRuntimeSummary } from './runtime.js';
import type { RepositorySummary } from './repository.js';

export interface ProjectRepositoryDefinition {
  /** Absolute, config-relative, or process-relative checkout path. Never an identity. */
  readonly path: string;
}

export interface ProjectDefinition {
  readonly id: string;
  readonly name: string;
  readonly repositories: readonly ProjectRepositoryDefinition[];
  readonly runtimeAgentIds: readonly string[];
}

export interface AgentOperationsConfiguration {
  readonly version: 1;
  readonly projects: readonly ProjectDefinition[];
}

export type RepositoryAssociationState = 'available' | 'degraded' | 'unavailable';

export interface ProjectRepositoryObservation {
  readonly configuredPath: string;
  readonly resolvedPath: string;
  readonly state: RepositoryAssociationState;
  readonly repository: RepositorySummary | null;
  readonly reason?: string;
}

export type RuntimeAssociationState = 'available' | 'unavailable';

export interface ProjectRuntimeObservation {
  readonly agentId: string;
  readonly state: RuntimeAssociationState;
  readonly runtime: AgentRuntimeSummary | null;
  readonly reason?: string;
}

export interface ProjectInventory {
  readonly id: string;
  readonly name: string;
  readonly repositories: readonly ProjectRepositoryObservation[];
  readonly runtimes: readonly ProjectRuntimeObservation[];
  readonly state: 'available' | 'degraded';
  readonly observedAt: string;
  readonly reason?: string;
}
