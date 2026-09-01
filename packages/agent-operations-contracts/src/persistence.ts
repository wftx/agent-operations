import { createHash } from 'node:crypto';
import type {
  RepositoryAvailability,
  RepositoryIdentityKind,
  WorkingTreeState,
} from './repository.js';
import type { RuntimeProvider, RuntimeState } from './runtime.js';
import type { DurableJob, DurableJobAttempt, NewDurableJobAttempt } from './work.js';
import type { DurableExecutionPlan } from './execution.js';
import type { DurableExecutionDispatch } from './dispatch.js';
import type {
  DurableAttemptOutcomeDecision,
  DurableExecutionObservation,
} from './observation.js';
import type {
  DurableAttemptReview,
  DurableEscalation,
} from './orchestration.js';
import type {
  DurableHumanGuidance,
  DurableWorkerBudgetExtension,
  DurableOperatorNotificationDelivery,
  DurableOperatorRun,
} from './operator.js';
import type { DurableRepositoryWorkspace } from './workspace.js';
import type {
  DurableLocalFolderResource,
  DurableProjectProfile,
} from './project.js';
import type { DurableInput } from './input.js';

export interface AgentOperationsInstallation {
  readonly id: string;
  readonly createdAt: string;
  readonly label?: string;
}

/** Configured AO project state. This is not a runtime or repository observation. */
export interface DurableProject {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
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
  createLocalFolderResource(resource: DurableLocalFolderResource): Promise<void>;
  listLocalFolderResources(projectId?: string): Promise<readonly DurableLocalFolderResource[]>;
  saveProjectProfile(profile: DurableProjectProfile): Promise<void>;
  getProjectProfile(projectId: string): Promise<DurableProjectProfile | null>;
  createInput(input: DurableInput): Promise<void>;
  getInput(id: string): Promise<DurableInput | null>;
  listInputs(projectId?: string): Promise<readonly DurableInput[]>;
  associateInputsWithConversation(conversationId: string, inputIds: readonly string[]): Promise<void>;
  listConversationInputIds(conversationId: string): Promise<readonly string[]>;
  attachInputsToJob(jobId: string, inputIds: readonly string[]): Promise<void>;
  listJobInputIds(jobId: string): Promise<readonly string[]>;
  recordRepositoryObservation(observation: DurableRepositoryObservation): Promise<void>;
  getLatestRepositoryObservation(checkoutBindingId: string): Promise<DurableRepositoryObservation | null>;
  recordRuntimeObservation(observation: DurableRuntimeObservation): Promise<void>;
  getLatestRuntimeObservation(projectId: string, agentId: string): Promise<DurableRuntimeObservation | null>;
  createRepositoryWorkspace(workspace: DurableRepositoryWorkspace): Promise<void>;
  getRepositoryWorkspace(id: string): Promise<DurableRepositoryWorkspace | null>;
  getRepositoryWorkspaceForJob(jobId: string): Promise<DurableRepositoryWorkspace | null>;
  listRepositoryWorkspaces(): Promise<readonly DurableRepositoryWorkspace[]>;
  saveRepositoryWorkspaceTransition(
    workspace: DurableRepositoryWorkspace,
    expectedRevision: number,
  ): Promise<void>;
  createJob(job: DurableJob): Promise<void>;
  getJob(id: string): Promise<DurableJob | null>;
  listJobs(projectId?: string): Promise<readonly DurableJob[]>;
  saveJobTransition(job: DurableJob, expectedRevision: number): Promise<void>;
  createAttempt(attempt: NewDurableJobAttempt): Promise<DurableJobAttempt>;
  getAttempt(id: string): Promise<DurableJobAttempt | null>;
  listAttemptsForJob(jobId: string): Promise<readonly DurableJobAttempt[]>;
  saveAttemptTransition(attempt: DurableJobAttempt, expectedRevision: number): Promise<void>;
  createExecutionPlan(plan: DurableExecutionPlan): Promise<void>;
  getExecutionPlan(id: string): Promise<DurableExecutionPlan | null>;
  getExecutionPlanForAttempt(attemptId: string): Promise<DurableExecutionPlan | null>;
  createExecutionDispatch(dispatch: DurableExecutionDispatch): Promise<void>;
  getExecutionDispatch(id: string): Promise<DurableExecutionDispatch | null>;
  getExecutionDispatchForPlan(executionPlanId: string): Promise<DurableExecutionDispatch | null>;
  saveExecutionDispatchTransition(
    dispatch: DurableExecutionDispatch,
    expectedRevision: number,
  ): Promise<void>;
  appendExecutionObservation(observation: DurableExecutionObservation): Promise<boolean>;
  listExecutionObservationsForDispatch(
    dispatchId: string,
  ): Promise<readonly DurableExecutionObservation[]>;
  createAttemptOutcomeDecision(decision: DurableAttemptOutcomeDecision): Promise<void>;
  getAttemptOutcomeDecision(attemptId: string): Promise<DurableAttemptOutcomeDecision | null>;
  createAttemptReview(review: DurableAttemptReview): Promise<void>;
  getAttemptReviewForWorkerAttempt(workerAttemptId: string): Promise<DurableAttemptReview | null>;
  listAttemptReviewsForJob(jobId: string): Promise<readonly DurableAttemptReview[]>;
  createEscalation(escalation: DurableEscalation): Promise<void>;
  getEscalation(id: string): Promise<DurableEscalation | null>;
  listEscalations(jobId?: string, unresolvedOnly?: boolean): Promise<readonly DurableEscalation[]>;
  resolveEscalation(
    id: string,
    resolvedAt: string,
    resolutionSummary?: string,
  ): Promise<DurableEscalation>;
  resolveEscalationAndResumeOperatorRun(
    id: string,
    resolvedAt: string,
    resolutionSummary: string,
    run: DurableOperatorRun,
    expectedRunRevision: number,
  ): Promise<void>;
  resolveEscalationAndCreateEscalation(
    id: string,
    resolvedAt: string,
    resolutionSummary: string,
    replacement: DurableEscalation,
  ): Promise<void>;
  createOperatorRun(run: DurableOperatorRun): Promise<void>;
  getOperatorRun(id: string): Promise<DurableOperatorRun | null>;
  getOperatorRunForJob(jobId: string): Promise<DurableOperatorRun | null>;
  listOperatorRuns(): Promise<readonly DurableOperatorRun[]>;
  saveOperatorRunTransition(run: DurableOperatorRun, expectedRevision: number): Promise<void>;
  createHumanGuidanceAndResolveEscalation(
    guidance: DurableHumanGuidance,
    resolvedAt: string,
  ): Promise<void>;
  createHumanGuidanceAndResumeOperatorRun(
    guidance: DurableHumanGuidance,
    resolvedAt: string,
    run: DurableOperatorRun,
    expectedRunRevision: number,
  ): Promise<void>;
  listHumanGuidance(jobId: string): Promise<readonly DurableHumanGuidance[]>;
  authorizeWorkerBudgetExtensionAndResumeOperatorRun(
    extension: DurableWorkerBudgetExtension,
    guidance: DurableHumanGuidance | null,
    resolvedAt: string,
    resolutionSummary: string,
    run: DurableOperatorRun,
    expectedRunRevision: number,
  ): Promise<void>;
  listWorkerBudgetExtensions(jobId: string): Promise<readonly DurableWorkerBudgetExtension[]>;
  createOperatorNotificationDelivery(
    delivery: DurableOperatorNotificationDelivery,
  ): Promise<boolean>;
  getOperatorNotificationDeliveryByEventKey(
    eventKey: string,
  ): Promise<DurableOperatorNotificationDelivery | null>;
  listOperatorNotificationDeliveries(
    jobId?: string,
  ): Promise<readonly DurableOperatorNotificationDelivery[]>;
  saveOperatorNotificationDeliveryTransition(
    delivery: DurableOperatorNotificationDelivery,
    expectedRevision: number,
  ): Promise<void>;
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
