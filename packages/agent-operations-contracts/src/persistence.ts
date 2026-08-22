import { createHash } from 'node:crypto';
import type {
  RepositoryAvailability,
  RepositoryIdentityKind,
  WorkingTreeState,
} from './repository.js';
import type { RuntimeProvider, RuntimeState } from './runtime.js';
import type { DurableJob, DurableJobAttempt, NewDurableJobAttempt } from './work.js';

export interface AgentOperationsInstallation {
  readonly id: string;
  readonly createdAt: string;
  readonly label?: string;
}

/** Configured AO project state. This is not a runtime or repository observation. */
export interface DurableProject {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Logical repository identity, independent of any machine-local checkout path. */
export interface DurableRepository {
  readonly id: string;
  readonly identityKind: RepositoryIdentityKind;
  readonly name: string;
  readonly canonicalRemote?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RepositoryCheckoutBinding {
  readonly id: string;
  readonly repositoryId: string;
  readonly installationId: string;
  readonly canonicalPath: string;
  readonly availability: RepositoryAvailability;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** One atomic configured-state replacement for a project and its associations. */
export interface DurableProjectConfiguration {
  readonly project: DurableProject;
  readonly repositories: readonly DurableRepository[];
  readonly checkoutBindings: readonly RepositoryCheckoutBinding[];
  readonly runtimeAgentIds: readonly string[];
}

/** Normalized observed Git state. Configured identity remains in separate records. */
export interface DurableRepositoryObservation {
  readonly repositoryId: string;
  readonly checkoutBindingId: string;
  readonly availability: RepositoryAvailability;
  readonly branch?: string;
  readonly detachedHead: boolean;
  readonly headCommit?: string;
  readonly workingTree: WorkingTreeState;
  readonly reason?: string;
  readonly observedAt: string;
}

/** Normalized observed runtime state for one configured project association. */
export interface DurableRuntimeObservation {
  readonly projectId: string;
  readonly agentId: string;
  readonly associationState: 'available' | 'unavailable';
  readonly provider?: RuntimeProvider;
  readonly runtimeState?: RuntimeState;
  readonly enabled?: boolean | null;
  readonly configured?: boolean;
  readonly lastHeartbeat?: string;
  readonly reason?: string;
  readonly observedAt: string;
}

/** AO-owned durable-state boundary. It deliberately exposes no SQL concepts. */
export interface AgentOperationsStateStore {
  getInstallation(): Promise<AgentOperationsInstallation>;
  applyProjectConfiguration(configuration: DurableProjectConfiguration): Promise<void>;
  getProject(id: string): Promise<DurableProject | null>;
  listProjects(): Promise<readonly DurableProject[]>;
  getRepository(id: string): Promise<DurableRepository | null>;
  listRepositories(): Promise<readonly DurableRepository[]>;
  listCheckoutBindings(repositoryId?: string): Promise<readonly RepositoryCheckoutBinding[]>;
  listProjectRepositoryIds(projectId: string): Promise<readonly string[]>;
  listProjectRuntimeAgentIds(projectId: string): Promise<readonly string[]>;
  recordRepositoryObservation(observation: DurableRepositoryObservation): Promise<void>;
  getLatestRepositoryObservation(checkoutBindingId: string): Promise<DurableRepositoryObservation | null>;
  recordRuntimeObservation(observation: DurableRuntimeObservation): Promise<void>;
  getLatestRuntimeObservation(projectId: string, agentId: string): Promise<DurableRuntimeObservation | null>;
  createJob(job: DurableJob): Promise<void>;
  getJob(id: string): Promise<DurableJob | null>;
  listJobs(projectId?: string): Promise<readonly DurableJob[]>;
  saveJobTransition(job: DurableJob, expectedRevision: number): Promise<void>;
  createAttempt(attempt: NewDurableJobAttempt): Promise<DurableJobAttempt>;
  getAttempt(id: string): Promise<DurableJobAttempt | null>;
  listAttemptsForJob(jobId: string): Promise<readonly DurableJobAttempt[]>;
  saveAttemptTransition(attempt: DurableJobAttempt, expectedRevision: number): Promise<void>;
  close(): Promise<void>;
}

/** Stable only within one AO installation and canonical local checkout path. */
export function createRepositoryCheckoutBindingId(installationId: string, canonicalPath: string): string {
  const cleanInstallation = installationId.trim();
  const cleanPath = canonicalPath.trim();
  if (!cleanInstallation) throw new Error('Installation ID is required');
  if (!cleanPath) throw new Error('Canonical checkout path is required');
  const digest = createHash('sha256').update(cleanInstallation).update('\0').update(cleanPath).digest('hex');
  return `checkout:${digest}`;
}
