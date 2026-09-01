import type { AgentRuntimeSummary } from './runtime.js';
import type { RepositorySummary } from './repository.js';

export type ProjectResourceType = 'git-repository' | 'local-folder';
export type ProjectResourceAvailability = 'available' | 'unavailable';

/** Installation-local non-Git folder association. Git resources reuse repository contracts. */
export interface DurableLocalFolderResource {
  readonly id: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly canonicalPath: string;
  readonly fingerprint: string;
  readonly availability: ProjectResourceAvailability;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface ProjectDocumentationEntry {
  readonly path: string;
  readonly kind: 'agents' | 'claude' | 'readme' | 'contributing' | 'architecture' | 'deployment';
  readonly providerSpecific: boolean;
}

export interface ProjectCapabilityReadiness {
  readonly repositoryReadOnlyJobs: 'available' | 'unavailable';
  readonly isolatedCodeChangeJobs: 'available' | 'unavailable';
  readonly boundedFileInspection: 'available' | 'unavailable';
  readonly inputs: 'available';
  readonly orchestratorConversation: 'available';
  readonly build: 'detected-unvalidated' | 'unknown';
  readonly preview: 'detected-unvalidated' | 'unknown';
  readonly publish: 'detected-unvalidated' | 'unknown';
}

/** Canonical provider-neutral Project context. Repository documentation only enriches it. */
export interface DurableProjectProfile {
  readonly projectId: string;
  readonly resourceSummary: string;
  readonly detectedStack: readonly string[];
  readonly packageManager?: string;
  readonly buildCommandCandidates: readonly string[];
  readonly testCommandCandidates: readonly string[];
  readonly previewCommandCandidates: readonly string[];
  readonly deploymentClues: readonly string[];
  readonly documentation: readonly ProjectDocumentationEntry[];
  readonly capabilities: ProjectCapabilityReadiness;
  readonly warnings: readonly string[];
  readonly knownConstraints: readonly string[];
  readonly agentsFileSuggestion: boolean;
  readonly inspectedAt: string;
  readonly revision: number;
}

export interface LocalFolderInspection {
  readonly canonicalPath: string;
  readonly fingerprint: string;
  readonly readable: boolean;
  readonly profile: Omit<DurableProjectProfile, 'projectId' | 'resourceSummary' | 'capabilities' | 'revision'>;
}

/** Bounded read-only filesystem inspection port for Project onboarding. */
export interface ProjectResourceInspectionAdapter {
  inspectLocalFolder(path: string): Promise<LocalFolderInspection>;
}

export interface ProjectRepositoryDefinition {
  /** Absolute, config-relative, or process-relative checkout path. Never an identity. */
  readonly path: string;
}

export interface ProjectDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
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
