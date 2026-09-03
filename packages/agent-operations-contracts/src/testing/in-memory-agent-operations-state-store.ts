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
import {
  isRuntimeExecutionCapabilitiesNoBroaderThan,
  isRuntimeExecutionPolicyNoBroaderThan,
} from '../execution.js';
import type { DurableJob, DurableJobAttempt, NewDurableJobAttempt } from '../work.js';
import { isActiveAttemptStatus } from '../work.js';
import type { DurableExecutionPlan } from '../execution.js';
import type { DurableExecutionDispatch } from '../dispatch.js';
import type {
  DurableAttemptOutcomeDecision,
  DurableExecutionObservation,
} from '../observation.js';
import { isBoundedExecutionResult } from '../observation.js';
import type { DurableAttemptReview, DurableEscalation } from '../orchestration.js';
import type {
  DurableHumanGuidance,
  DurableWorkerBudgetExtension,
  DurableOperatorNotificationDelivery,
  DurableOperatorRun,
} from '../operator.js';
import type { DurableRepositoryWorkspace } from '../workspace.js';
import type { DurableLocalFolderResource, DurableProjectProfile } from '../project.js';
import type { DurableInput } from '../input.js';
import type {
  BrowserEvidenceRequirement,
  DurableBrowserEvidence,
  DurablePreviewProfile,
  DurablePreviewSession,
  DurableAuthenticatedPreviewSession,
} from '../preview.js';
import type { DurableTrustProfile } from '../trust.js';
import { validateTrustProfile } from '../trust.js';
import type { DurableJobRetirement, DurableRepositoryRestoreAction } from '../lifecycle.js';

export type InMemoryStateStoreOperation =
  | 'get-installation'
  | 'apply-configuration'
  | 'read'
  | 'record-repository-observation'
  | 'record-runtime-observation'
  | 'write-repository-workspace'
  | 'write-job'
  | 'write-attempt'
  | 'write-execution-plan'
  | 'write-execution-dispatch'
  | 'write-execution-observation'
  | 'write-attempt-outcome'
  | 'write-attempt-review'
  | 'write-escalation'
  | 'write-operator-run'
  | 'write-human-guidance'
  | 'write-worker-budget-extension'
  | 'write-operator-notification'
  | 'write-job-retirement'
  | 'write-repository-restore'
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

function copyLocalFolderResource(value: DurableLocalFolderResource): DurableLocalFolderResource {
  return { ...value };
}

function copyProjectProfile(value: DurableProjectProfile): DurableProjectProfile {
  return {
    ...value,
    detectedStack: [...value.detectedStack],
    buildCommandCandidates: [...value.buildCommandCandidates],
    testCommandCandidates: [...value.testCommandCandidates],
    previewCommandCandidates: [...value.previewCommandCandidates],
    deploymentClues: [...value.deploymentClues],
    documentation: value.documentation.map(entry => ({ ...entry })),
    capabilities: { ...value.capabilities },
    warnings: [...value.warnings],
    knownConstraints: [...value.knownConstraints],
  };
}

function copyTrustProfile(value: DurableTrustProfile): DurableTrustProfile {
  return { ...value, policy: { ...value.policy } };
}

function copyInput(value: DurableInput): DurableInput {
  return { ...value };
}

function copyPreviewProfile(value: DurablePreviewProfile): DurablePreviewProfile {
  return { ...value, command: { ...value.command, arguments: [...value.command.arguments] },
    ...(value.validation ? { validation: { ...value.validation } } : {}) };
}

function copyPreviewSession(value: DurablePreviewSession): DurablePreviewSession { return { ...value }; }
function copyAuthenticatedPreviewSession(value: DurableAuthenticatedPreviewSession): DurableAuthenticatedPreviewSession { return { ...value }; }

function copyBrowserEvidence(value: DurableBrowserEvidence): DurableBrowserEvidence {
  return {
    ...value,
    viewport: { ...value.viewport },
    consoleFailures: [...value.consoleFailures],
    failedResources: [...value.failedResources],
    audit: value.audit.map(operation => ({ ...operation })),
  };
}

function copyRepositoryObservation(value: DurableRepositoryObservation): DurableRepositoryObservation {
  return { ...value };
}

function copyRuntimeObservation(value: DurableRuntimeObservation): DurableRuntimeObservation {
  return { ...value };
}

function copyRepositoryWorkspace(value: DurableRepositoryWorkspace): DurableRepositoryWorkspace {
  return {
    ...value,
    ...(value.evidence
      ? {
          evidence: {
            ...value.evidence,
            changedFiles: [...value.evidence.changedFiles],
            ...(value.evidence.binaryFiles
              ? { binaryFiles: value.evidence.binaryFiles.map(file => ({ ...file })) }
              : {}),
            testResults: value.evidence.testResults.map(result => ({
              ...result,
              ...(result.ephemeralArtifacts
                ? { ephemeralArtifacts: result.ephemeralArtifacts.map(artifact => ({ ...artifact })) }
                : {}),
            })),
          },
        }
      : {}),
  };
}

function copyJob(value: DurableJob): DurableJob {
  return { ...value };
}

function copyJobRetirement(value: DurableJobRetirement): DurableJobRetirement {
  return { ...value };
}

function copyRepositoryRestoreAction(value: DurableRepositoryRestoreAction): DurableRepositoryRestoreAction {
  return {
    ...value,
    preconditions: {
      ...value.preconditions,
      restorePaths: value.preconditions.restorePaths.map(item => ({ ...item })),
      preserveUntrackedPaths: value.preconditions.preserveUntrackedPaths.map(item => ({ ...item })),
      statusEntries: value.preconditions.statusEntries.map(item => ({ ...item })),
    },
    ...(value.result
      ? {
          result: {
            ...value.result,
            restoredPaths: [...value.result.restoredPaths],
            preservedUntrackedPaths: value.result.preservedUntrackedPaths.map(item => ({ ...item })),
          },
        }
      : {}),
  };
}

function copyAttempt(value: DurableJobAttempt): DurableJobAttempt {
  return { ...value };
}

function copyExecutionPlan(value: DurableExecutionPlan): DurableExecutionPlan {
  return {
    ...value,
    input: { ...value.input },
    ...(value.inputIds ? { inputIds: [...value.inputIds] } : {}),
    ...(value.requestedPolicy ? { requestedPolicy: { ...value.requestedPolicy } } : {}),
    ...(value.requestedCapabilities
      ? { requestedCapabilities: { ...value.requestedCapabilities } }
      : {}),
  };
}

function copyExecutionDispatch(value: DurableExecutionDispatch): DurableExecutionDispatch {
  return {
    ...value,
    ...(value.effectivePolicy ? { effectivePolicy: { ...value.effectivePolicy } } : {}),
    ...(value.effectiveCapabilities
      ? { effectiveCapabilities: { ...value.effectiveCapabilities } }
      : {}),
  };
}

function copyExecutionObservation(value: DurableExecutionObservation): DurableExecutionObservation {
  return { ...value };
}

function copyAttemptOutcomeDecision(value: DurableAttemptOutcomeDecision): DurableAttemptOutcomeDecision {
  return { ...value };
}

function copyAttemptReview(value: DurableAttemptReview): DurableAttemptReview {
  return { ...value };
}

function copyEscalation(value: DurableEscalation): DurableEscalation {
  return { ...value };
}

function copyOperatorRun(value: DurableOperatorRun): DurableOperatorRun {
  return { ...value };
}

function copyHumanGuidance(value: DurableHumanGuidance): DurableHumanGuidance {
  return { ...value };
}

function copyWorkerBudgetExtension(value: DurableWorkerBudgetExtension): DurableWorkerBudgetExtension {
  return { ...value };
}

function copyOperatorNotificationDelivery(
  value: DurableOperatorNotificationDelivery,
): DurableOperatorNotificationDelivery {
  return { ...value };
}

function isValidDispatchTransition(from: string, to: string): boolean {
  return from === 'prepared' && to === 'submitting'
    || from === 'submitting' && (to === 'accepted' || to === 'rejected' || to === 'uncertain');
}

function validateDispatchShape(dispatch: DurableExecutionDispatch): void {
  const terminal = dispatch.status === 'accepted'
    || dispatch.status === 'rejected'
    || dispatch.status === 'uncertain';
  if (dispatch.status === 'prepared'
    && (dispatch.submittedAt || dispatch.acceptedAt || dispatch.resolvedAt)) {
    throw new Error('Prepared Dispatch cannot have submission or resolution timestamps');
  }
  if (dispatch.status === 'submitting'
    && (!dispatch.submittedAt || dispatch.acceptedAt || dispatch.resolvedAt)) {
    throw new Error('Submitting Dispatch requires only a submission timestamp');
  }
  if (terminal && (!dispatch.submittedAt || !dispatch.resolvedAt)) {
    throw new Error('Terminal Dispatch requires submission and resolution timestamps');
  }
  if ((dispatch.status === 'accepted') !== Boolean(dispatch.acceptedAt)) {
    throw new Error('Only an accepted Dispatch has an acceptance timestamp');
  }
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
  private readonly localFolderResources = new Map<string, DurableLocalFolderResource>();
  private readonly projectProfiles = new Map<string, DurableProjectProfile>();
  private readonly trustProfiles = new Map<string, DurableTrustProfile>();
  private readonly inputs = new Map<string, DurableInput>();
  private readonly conversationInputs = new Map<string, Set<string>>();
  private readonly jobInputs = new Map<string, Set<string>>();
  private readonly previewProfiles = new Map<string, DurablePreviewProfile>();
  private readonly browserRequirements = new Map<string, BrowserEvidenceRequirement>();
  private readonly previewSessions = new Map<string, DurablePreviewSession>();
  private readonly authenticatedPreviewSessions = new Map<string, DurableAuthenticatedPreviewSession>();
  private readonly browserEvidence = new Map<string, DurableBrowserEvidence>();
  private readonly repositoryObservations = new Map<string, DurableRepositoryObservation[]>();
  private readonly runtimeObservations = new Map<string, DurableRuntimeObservation[]>();
  private readonly repositoryWorkspaces = new Map<string, DurableRepositoryWorkspace>();
  private readonly jobRetirements = new Map<string, DurableJobRetirement>();
  private readonly repositoryRestoreActions = new Map<string, DurableRepositoryRestoreAction>();
  private readonly jobs = new Map<string, DurableJob>();
  private readonly attempts = new Map<string, DurableJobAttempt>();
  private readonly executionPlans = new Map<string, DurableExecutionPlan>();
  private readonly executionDispatches = new Map<string, DurableExecutionDispatch>();
  private readonly executionObservations = new Map<string, DurableExecutionObservation>();
  private readonly attemptOutcomeDecisions = new Map<string, DurableAttemptOutcomeDecision>();
  private readonly attemptReviews = new Map<string, DurableAttemptReview>();
  private readonly escalations = new Map<string, DurableEscalation>();
  private readonly operatorRuns = new Map<string, DurableOperatorRun>();
  private readonly humanGuidance = new Map<string, DurableHumanGuidance>();
  private readonly workerBudgetExtensions = new Map<string, DurableWorkerBudgetExtension>();
  private readonly operatorNotificationDeliveries = new Map<string, DurableOperatorNotificationDelivery>();
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

  async createLocalFolderResource(resource: DurableLocalFolderResource): Promise<void> {
    this.assertAvailable('apply-configuration');
    if (!this.projects.has(resource.projectId)) throw new Error(`Project not found: ${resource.projectId}`);
    if (resource.installationId !== this.installation.id) throw new Error('Project Resource belongs to another installation');
    if (this.localFolderResources.has(resource.id)) throw new Error(`Project Resource already exists: ${resource.id}`);
    this.localFolderResources.set(resource.id, copyLocalFolderResource(resource));
  }

  async listLocalFolderResources(projectId?: string): Promise<readonly DurableLocalFolderResource[]> {
    this.assertAvailable('read');
    return [...this.localFolderResources.values()]
      .filter(resource => !projectId || resource.projectId === projectId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(copyLocalFolderResource);
  }

  async saveProjectProfile(profile: DurableProjectProfile): Promise<void> {
    this.assertAvailable('apply-configuration');
    if (!this.projects.has(profile.projectId)) throw new Error(`Project not found: ${profile.projectId}`);
    const existing = this.projectProfiles.get(profile.projectId);
    if (profile.revision !== (existing ? existing.revision + 1 : 0)) {
      throw new Error(`Stale Project Profile revision for ${profile.projectId}`);
    }
    this.projectProfiles.set(profile.projectId, copyProjectProfile(profile));
  }

  async getProjectProfile(projectId: string): Promise<DurableProjectProfile | null> {
    this.assertAvailable('read');
    const profile = this.projectProfiles.get(projectId);
    return profile ? copyProjectProfile(profile) : null;
  }

  async saveTrustProfile(profile: DurableTrustProfile): Promise<void> {
    this.assertAvailable('apply-configuration');
    validateTrustProfile(profile);
    if (profile.scope === 'project' && !this.projects.has(profile.scopeId!)) {
      throw new Error(`Project not found: ${profile.scopeId}`);
    }
    if (profile.scope === 'job' && !this.jobs.has(profile.scopeId!)) {
      throw new Error(`Job not found: ${profile.scopeId}`);
    }
    const existing = this.trustProfiles.get(profile.id);
    if (profile.revision !== (existing ? existing.revision + 1 : 0)
      || (existing && (existing.scope !== profile.scope
        || existing.scopeId !== profile.scopeId
        || existing.createdAt !== profile.createdAt))) {
      throw new Error(`Stale or rewritten Trust Profile: ${profile.id}`);
    }
    const duplicate = [...this.trustProfiles.values()].find(value =>
      value.id !== profile.id && value.scope === profile.scope && value.scopeId === profile.scopeId);
    if (duplicate) throw new Error(`Trust Profile already exists for ${profile.scope}:${profile.scopeId ?? 'global'}`);
    this.trustProfiles.set(profile.id, copyTrustProfile(profile));
  }

  async getTrustProfile(id: string): Promise<DurableTrustProfile | null> {
    this.assertAvailable('read');
    const profile = this.trustProfiles.get(id);
    return profile ? copyTrustProfile(profile) : null;
  }

  async listTrustProfiles(): Promise<readonly DurableTrustProfile[]> {
    this.assertAvailable('read');
    return [...this.trustProfiles.values()]
      .sort((left, right) => left.scope.localeCompare(right.scope)
        || (left.scopeId ?? '').localeCompare(right.scopeId ?? ''))
      .map(copyTrustProfile);
  }

  async savePreviewProfile(profile: DurablePreviewProfile): Promise<void> {
    this.assertAvailable('apply-configuration');
    const existing = this.previewProfiles.get(profile.id);
    if (!this.projects.has(profile.projectId) || profile.revision !== (existing ? existing.revision + 1 : 0)) {
      throw new Error(`Stale or invalid Preview Profile: ${profile.id}`);
    }
    this.previewProfiles.set(profile.id, copyPreviewProfile(profile));
  }

  async getPreviewProfile(id: string): Promise<DurablePreviewProfile | null> {
    this.assertAvailable('read');
    const profile = this.previewProfiles.get(id);
    return profile ? copyPreviewProfile(profile) : null;
  }

  async listPreviewProfiles(projectId?: string): Promise<readonly DurablePreviewProfile[]> {
    this.assertAvailable('read');
    return [...this.previewProfiles.values()].filter(profile => !projectId || profile.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name)).map(copyPreviewProfile);
  }

  async createAuthenticatedPreviewSession(session: DurableAuthenticatedPreviewSession): Promise<void> {
    this.assertAvailable('apply-configuration');
    if (!session.id.startsWith('preview-auth:') || session.status !== 'pending-human-login'
      || session.revision !== 0 || this.authenticatedPreviewSessions.has(session.id)) {
      throw new Error(`Invalid Authenticated Preview Session: ${session.id}`);
    }
    const profile = this.previewProfiles.get(session.previewProfileId);
    if (!profile || profile.projectId !== session.projectId || !profile.authenticationRequired) {
      throw new Error(`Authenticated Preview Session has no matching required Profile: ${session.id}`);
    }
    this.authenticatedPreviewSessions.set(session.id, copyAuthenticatedPreviewSession(session));
  }

  async getAuthenticatedPreviewSession(id: string): Promise<DurableAuthenticatedPreviewSession | null> {
    this.assertAvailable('read');
    const value = this.authenticatedPreviewSessions.get(id);
    return value ? copyAuthenticatedPreviewSession(value) : null;
  }

  async listAuthenticatedPreviewSessions(projectId?: string): Promise<readonly DurableAuthenticatedPreviewSession[]> {
    this.assertAvailable('read');
    return [...this.authenticatedPreviewSessions.values()]
      .filter(value => !projectId || value.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(copyAuthenticatedPreviewSession);
  }

  async saveAuthenticatedPreviewSessionTransition(
    session: DurableAuthenticatedPreviewSession,
    expectedRevision: number,
  ): Promise<void> {
    this.assertAvailable('apply-configuration');
    const existing = this.authenticatedPreviewSessions.get(session.id);
    if (!existing || existing.revision !== expectedRevision || session.revision !== expectedRevision + 1
      || existing.projectId !== session.projectId || existing.previewProfileId !== session.previewProfileId
      || existing.installationId !== session.installationId || existing.origin !== session.origin
      || existing.createdAt !== session.createdAt || !validAuthTransition(existing.status, session.status)) {
      throw new Error(`Invalid Authenticated Preview Session transition: ${session.id}`);
    }
    this.authenticatedPreviewSessions.set(session.id, copyAuthenticatedPreviewSession(session));
  }

  async createInput(input: DurableInput): Promise<void> {
    this.assertAvailable('apply-configuration');
    if (this.inputs.has(input.id)) throw new Error(`Input already exists: ${input.id}`);
    if (input.projectId && !this.projects.has(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    this.inputs.set(input.id, copyInput(input));
  }

  async getInput(id: string): Promise<DurableInput | null> {
    this.assertAvailable('read');
    const input = this.inputs.get(id);
    return input ? copyInput(input) : null;
  }

  async listInputs(projectId?: string): Promise<readonly DurableInput[]> {
    this.assertAvailable('read');
    return [...this.inputs.values()]
      .filter(input => !projectId || input.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(copyInput);
  }

  async associateInputsWithConversation(conversationId: string, inputIds: readonly string[]): Promise<void> {
    this.assertAvailable('apply-configuration');
    rejectDuplicates(inputIds, 'Input ID');
    const associated = this.conversationInputs.get(conversationId) ?? new Set<string>();
    for (const inputId of inputIds) {
      if (!this.inputs.has(inputId)) throw new Error(`Input not found: ${inputId}`);
      if (associated.has(inputId)) throw new Error(`Input already associated with conversation: ${inputId}`);
      associated.add(inputId);
    }
    this.conversationInputs.set(conversationId, associated);
  }

  async listConversationInputIds(conversationId: string): Promise<readonly string[]> {
    this.assertAvailable('read');
    return [...(this.conversationInputs.get(conversationId) ?? [])].sort();
  }

  async attachInputsToJob(jobId: string, inputIds: readonly string[]): Promise<void> {
    this.assertAvailable('write-job');
    rejectDuplicates(inputIds, 'Input ID');
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const attached = this.jobInputs.get(jobId) ?? new Set<string>();
    for (const inputId of inputIds) {
      const input = this.inputs.get(inputId);
      if (!input) throw new Error(`Input not found: ${inputId}`);
      if (input.projectId && input.projectId !== job.projectId) throw new Error(`Input ${inputId} belongs to another Project`);
      if (attached.has(inputId)) throw new Error(`Input already attached to Job: ${inputId}`);
      attached.add(inputId);
    }
    this.jobInputs.set(jobId, attached);
  }

  async listJobInputIds(jobId: string): Promise<readonly string[]> {
    this.assertAvailable('read');
    return [...(this.jobInputs.get(jobId) ?? [])].sort();
  }

  async setJobBrowserEvidenceRequirement(jobId: string, requirement: BrowserEvidenceRequirement): Promise<void> {
    this.assertAvailable('write-job');
    if (!this.jobs.has(jobId)) throw new Error(`Job not found: ${jobId}`);
    this.browserRequirements.set(jobId, { ...requirement, viewport: { ...requirement.viewport } });
  }

  async getJobBrowserEvidenceRequirement(jobId: string): Promise<BrowserEvidenceRequirement | null> {
    this.assertAvailable('read');
    const requirement = this.browserRequirements.get(jobId);
    return requirement ? { ...requirement, viewport: { ...requirement.viewport } } : null;
  }

  async createPreviewSession(session: DurablePreviewSession): Promise<void> {
    this.assertAvailable('write-job');
    if (this.previewSessions.has(session.id)) {
      throw new Error(`Preview Session already exists: ${session.id}`);
    }
    this.previewSessions.set(session.id, copyPreviewSession(session));
  }

  async getPreviewSession(id: string): Promise<DurablePreviewSession | null> {
    this.assertAvailable('read');
    const session = this.previewSessions.get(id);
    return session ? copyPreviewSession(session) : null;
  }

  async getPreviewSessionForJob(jobId: string): Promise<DurablePreviewSession | null> {
    this.assertAvailable('read');
    const session = [...this.previewSessions.values()].filter(value => value.jobId === jobId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    return session ? copyPreviewSession(session) : null;
  }

  async savePreviewSessionTransition(session: DurablePreviewSession, expectedRevision: number): Promise<void> {
    this.assertAvailable('write-job');
    const existing = this.previewSessions.get(session.id);
    if (!existing || existing.revision !== expectedRevision || session.revision !== expectedRevision + 1) {
      throw new Error(`Preview Session transition conflict: ${session.id}`);
    }
    this.previewSessions.set(session.id, copyPreviewSession(session));
  }

  async createBrowserEvidence(evidence: DurableBrowserEvidence): Promise<void> {
    this.assertAvailable('write-job');
    if (this.browserEvidence.has(evidence.id)) throw new Error(`Browser Evidence already exists: ${evidence.id}`);
    this.browserEvidence.set(evidence.id, copyBrowserEvidence(evidence));
  }

  async getBrowserEvidence(id: string): Promise<DurableBrowserEvidence | null> {
    this.assertAvailable('read');
    const evidence = this.browserEvidence.get(id);
    return evidence ? copyBrowserEvidence(evidence) : null;
  }

  async listBrowserEvidenceForJob(jobId: string): Promise<readonly DurableBrowserEvidence[]> {
    this.assertAvailable('read');
    return [...this.browserEvidence.values()].filter(value => value.jobId === jobId)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).map(copyBrowserEvidence);
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

  async createRepositoryWorkspace(workspace: DurableRepositoryWorkspace): Promise<void> {
    this.assertAvailable('write-repository-workspace');
    const job = this.jobs.get(workspace.jobId);
    if (!job || job.projectId !== workspace.projectId || job.repositoryId !== workspace.repositoryId) {
      throw new Error(`Invalid Repository Workspace Job association: ${workspace.id}`);
    }
    const binding = this.bindings.get(workspace.sourceCheckoutBindingId);
    if (!binding || binding.repositoryId !== workspace.repositoryId) {
      throw new Error(`Invalid Repository Workspace checkout association: ${workspace.id}`);
    }
    if (workspace.state !== 'preparing' || workspace.revision !== 0) {
      throw new Error('New Repository Workspaces must be preparing at revision 0');
    }
    if (this.repositoryWorkspaces.has(workspace.id)
      || [...this.repositoryWorkspaces.values()].some(value => value.jobId === workspace.jobId)) {
      throw new Error(`Duplicate Repository Workspace identity: ${workspace.id}`);
    }
    if ([...this.repositoryWorkspaces.values()].some(value => value.canonicalPath === workspace.canonicalPath)) {
      throw new Error(`Repository Workspace path already has an owner: ${workspace.canonicalPath}`);
    }
    this.repositoryWorkspaces.set(workspace.id, copyRepositoryWorkspace(workspace));
  }

  async getRepositoryWorkspace(id: string): Promise<DurableRepositoryWorkspace | null> {
    this.assertAvailable('read');
    const value = this.repositoryWorkspaces.get(id);
    return value ? copyRepositoryWorkspace(value) : null;
  }

  async getRepositoryWorkspaceForJob(jobId: string): Promise<DurableRepositoryWorkspace | null> {
    this.assertAvailable('read');
    const value = [...this.repositoryWorkspaces.values()].find(workspace => workspace.jobId === jobId);
    return value ? copyRepositoryWorkspace(value) : null;
  }

  async listRepositoryWorkspaces(): Promise<readonly DurableRepositoryWorkspace[]> {
    this.assertAvailable('read');
    return [...this.repositoryWorkspaces.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(copyRepositoryWorkspace);
  }

  async saveRepositoryWorkspaceTransition(
    workspace: DurableRepositoryWorkspace,
    expectedRevision: number,
  ): Promise<void> {
    this.assertAvailable('write-repository-workspace');
    const existing = this.repositoryWorkspaces.get(workspace.id);
    if (!existing) throw new Error(`Repository Workspace not found: ${workspace.id}`);
    if (existing.revision !== expectedRevision || workspace.revision !== expectedRevision + 1) {
      throw new Error(`Stale Repository Workspace revision for ${workspace.id}`);
    }
    for (const field of [
      'jobId', 'projectId', 'repositoryId', 'sourceCheckoutBindingId', 'baseRevision',
      'baseBranch', 'branchName', 'canonicalPath', 'createdAt',
    ] as const) {
      if (existing[field] !== workspace[field]) {
        throw new Error(`Repository Workspace transition cannot rewrite ${field}: ${workspace.id}`);
      }
    }
    const allowed = existing.state === 'preparing'
      ? ['active', 'failed', 'cancelled']
      : existing.state === 'active'
        ? ['reviewing', 'failed', 'cancelled']
        : existing.state === 'reviewing'
          ? ['active', 'ready_for_approval', 'failed', 'cleanup_pending', 'cancelled']
          : existing.state === 'ready_for_approval'
            ? ['active', 'failed', 'cleanup_pending', 'cancelled']
          : existing.state === 'failed'
            ? ['cleanup_pending', 'cancelled']
            : existing.state === 'cancelled'
              ? ['cleanup_pending']
              : existing.state === 'cleanup_pending' ? ['cleaned', 'failed'] : [];
    if (!allowed.includes(workspace.state)) {
      throw new Error(`Repository Workspace cannot transition from ${existing.state} to ${workspace.state}`);
    }
    this.repositoryWorkspaces.set(workspace.id, copyRepositoryWorkspace(workspace));
  }

  async retireJob(retirement: DurableJobRetirement): Promise<void> {
    this.assertAvailable('write-job-retirement');
    if (!this.jobs.has(retirement.jobId)) throw new Error(`Job not found: ${retirement.jobId}`);
    const existing = this.jobRetirements.get(retirement.jobId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(retirement)) {
        throw new Error(`Job ${retirement.jobId} already has another retirement disposition`);
      }
      return;
    }
    this.jobRetirements.set(retirement.jobId, copyJobRetirement(retirement));
    for (const [id, escalation] of this.escalations) {
      if (escalation.jobId === retirement.jobId && !escalation.resolvedAt) {
        this.escalations.set(id, {
          ...escalation,
          resolvedAt: retirement.retiredAt,
          resolutionSummary: `Job retired: ${retirement.reason}`,
        });
      }
    }
  }

  async getJobRetirement(jobId: string): Promise<DurableJobRetirement | null> {
    this.assertAvailable('read');
    const value = this.jobRetirements.get(jobId);
    return value ? copyJobRetirement(value) : null;
  }

  async listJobRetirements(): Promise<readonly DurableJobRetirement[]> {
    this.assertAvailable('read');
    return [...this.jobRetirements.values()].sort((a, b) =>
      a.retiredAt.localeCompare(b.retiredAt) || a.jobId.localeCompare(b.jobId)).map(copyJobRetirement);
  }

  async createRepositoryRestoreAction(action: DurableRepositoryRestoreAction): Promise<void> {
    this.assertAvailable('write-repository-restore');
    if (!action.id.startsWith('repository-restore:') || action.state !== 'pending-approval'
      || action.revision !== 0 || this.repositoryRestoreActions.has(action.id)) {
      throw new Error(`Invalid new Repository Restore action: ${action.id}`);
    }
    const binding = this.bindings.get(action.checkoutBindingId);
    if (!this.projects.has(action.projectId) || binding?.repositoryId !== action.repositoryId
      || binding.canonicalPath !== action.preconditions.canonicalPath) {
      throw new Error(`Invalid Repository Restore associations: ${action.id}`);
    }
    this.repositoryRestoreActions.set(action.id, copyRepositoryRestoreAction(action));
  }

  async getRepositoryRestoreAction(id: string): Promise<DurableRepositoryRestoreAction | null> {
    this.assertAvailable('read');
    const value = this.repositoryRestoreActions.get(id);
    return value ? copyRepositoryRestoreAction(value) : null;
  }

  async listRepositoryRestoreActions(): Promise<readonly DurableRepositoryRestoreAction[]> {
    this.assertAvailable('read');
    return [...this.repositoryRestoreActions.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(copyRepositoryRestoreAction);
  }

  async saveRepositoryRestoreActionTransition(
    action: DurableRepositoryRestoreAction,
    expectedRevision: number,
  ): Promise<void> {
    this.assertAvailable('write-repository-restore');
    const existing = this.repositoryRestoreActions.get(action.id);
    if (!existing || existing.revision !== expectedRevision || action.revision !== expectedRevision + 1
      || existing.projectId !== action.projectId || existing.repositoryId !== action.repositoryId
      || existing.checkoutBindingId !== action.checkoutBindingId
      || existing.createdAt !== action.createdAt
      || JSON.stringify(existing.preconditions) !== JSON.stringify(action.preconditions)) {
      throw new Error(`Invalid Repository Restore transition: ${action.id}`);
    }
    const allowed = existing.state === 'pending-approval'
      ? ['approved', 'rejected']
      : existing.state === 'approved' ? ['completed', 'failed'] : [];
    if (!allowed.includes(action.state)) {
      throw new Error(`Repository Restore cannot transition from ${existing.state} to ${action.state}`);
    }
    this.repositoryRestoreActions.set(action.id, copyRepositoryRestoreAction(action));
  }

  async createJob(job: DurableJob): Promise<void> {
    this.assertAvailable('write-job');
    requireNonEmpty(job.id, 'Job ID');
    requireNonEmpty(job.title, 'Job title');
    if (job.automaticReadOnlyCompletion && !job.acceptanceCriteria?.trim()) {
      throw new Error('Automatic read-only completion requires acceptance criteria');
    }
    if (!job.id.startsWith('job:')) throw new Error(`Invalid Agent Operations job ID: ${job.id}`);
    if (job.status !== 'draft' || job.revision !== 0) throw new Error('New jobs must be draft at revision 0');
    if (!this.projects.has(job.projectId)) throw new Error(`Unknown project for job: ${job.projectId}`);
    if (job.repositoryId && !this.projectRepositories.get(job.projectId)?.has(job.repositoryId)) {
      throw new Error(`Repository ${job.repositoryId} is not associated with project ${job.projectId}`);
    }
    if (job.preferredRuntimeAgentId
      && !this.projectRuntimeAgents.get(job.projectId)?.has(job.preferredRuntimeAgentId)) {
      throw new Error(`Runtime ${job.preferredRuntimeAgentId} is not associated with project ${job.projectId}`);
    }
    if (this.jobs.has(job.id)) throw new Error(`Duplicate job ID: ${job.id}`);
    this.jobs.set(job.id, copyJob(job));
  }

  async getJob(id: string): Promise<DurableJob | null> {
    this.assertAvailable('read');
    const job = this.jobs.get(id);
    return job ? copyJob(job) : null;
  }

  async listJobs(projectId?: string): Promise<readonly DurableJob[]> {
    this.assertAvailable('read');
    return [...this.jobs.values()]
      .filter(job => !projectId || job.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(copyJob);
  }

  async saveJobTransition(job: DurableJob, expectedRevision: number): Promise<void> {
    this.assertAvailable('write-job');
    const existing = this.jobs.get(job.id);
    if (!existing) throw new Error(`Job not found: ${job.id}`);
    if (existing.revision !== expectedRevision || job.revision !== expectedRevision + 1) {
      throw new Error(`Stale job revision for ${job.id}; expected ${existing.revision}`);
    }
    if (existing.projectId !== job.projectId
      || existing.repositoryId !== job.repositoryId
      || existing.preferredRuntimeAgentId !== job.preferredRuntimeAgentId
      || existing.acceptanceCriteria !== job.acceptanceCriteria
      || existing.automaticReadOnlyCompletion !== job.automaticReadOnlyCompletion
      || existing.executionMode !== job.executionMode
      || existing.createdAt !== job.createdAt) {
      throw new Error(`Job transition cannot rewrite durable identity or assignment: ${job.id}`);
    }
    this.jobs.set(job.id, copyJob(job));
  }

  async createAttempt(attempt: NewDurableJobAttempt): Promise<DurableJobAttempt> {
    this.assertAvailable('write-attempt');
    if (!attempt.id.startsWith('attempt:')) throw new Error(`Invalid Agent Operations attempt ID: ${attempt.id}`);
    if (attempt.status !== 'created' || attempt.revision !== 0) {
      throw new Error('New attempts must be created at revision 0');
    }
    const job = this.jobs.get(attempt.jobId);
    if (!job) throw new Error(`Unknown job for attempt: ${attempt.jobId}`);
    if (attempt.runtimeAgentId
      && !this.projectRuntimeAgents.get(job.projectId)?.has(attempt.runtimeAgentId)) {
      throw new Error(`Runtime ${attempt.runtimeAgentId} is not associated with project ${job.projectId}`);
    }
    if (this.attempts.has(attempt.id)) throw new Error(`Duplicate attempt ID: ${attempt.id}`);
    const executionRole = attempt.executionRole ?? 'worker';
    const jobAttempts = [...this.attempts.values()].filter(candidate => candidate.jobId === attempt.jobId);
    const roleAttempts = jobAttempts.filter(candidate => candidate.executionRole === executionRole);
    if (roleAttempts.some(candidate => isActiveAttemptStatus(candidate.status))) {
      throw new Error(`Job ${attempt.jobId} already has an active attempt for role ${executionRole}`);
    }
    const created: DurableJobAttempt = {
      ...attempt,
      sequence: Math.max(0, ...jobAttempts.map(candidate => candidate.sequence)) + 1,
      roleSequence: Math.max(0, ...roleAttempts.map(candidate => candidate.roleSequence)) + 1,
      executionRole,
    };
    this.attempts.set(created.id, copyAttempt(created));
    return copyAttempt(created);
  }

  async getAttempt(id: string): Promise<DurableJobAttempt | null> {
    this.assertAvailable('read');
    const attempt = this.attempts.get(id);
    return attempt ? copyAttempt(attempt) : null;
  }

  async listAttemptsForJob(jobId: string): Promise<readonly DurableJobAttempt[]> {
    this.assertAvailable('read');
    return [...this.attempts.values()]
      .filter(attempt => attempt.jobId === jobId)
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
      .map(copyAttempt);
  }

  async saveAttemptTransition(attempt: DurableJobAttempt, expectedRevision: number): Promise<void> {
    this.assertAvailable('write-attempt');
    const existing = this.attempts.get(attempt.id);
    if (!existing) throw new Error(`Attempt not found: ${attempt.id}`);
    if (existing.revision !== expectedRevision || attempt.revision !== expectedRevision + 1) {
      throw new Error(`Stale attempt revision for ${attempt.id}; expected ${existing.revision}`);
    }
    if (existing.jobId !== attempt.jobId
      || existing.sequence !== attempt.sequence
      || existing.roleSequence !== attempt.roleSequence
      || existing.executionRole !== attempt.executionRole
      || existing.runtimeAgentId !== attempt.runtimeAgentId
      || existing.createdAt !== attempt.createdAt) {
      throw new Error(`Attempt transition cannot rewrite durable identity or assignment: ${attempt.id}`);
    }
    this.attempts.set(attempt.id, copyAttempt(attempt));
  }

  async createExecutionPlan(plan: DurableExecutionPlan): Promise<void> {
    this.assertAvailable('write-execution-plan');
    requireNonEmpty(plan.id, 'Execution Plan ID');
    requireNonEmpty(plan.input.instruction, 'Execution instruction');
    if (!plan.id.startsWith('plan:')) throw new Error(`Invalid Execution Plan ID: ${plan.id}`);
    if (plan.input.version !== 1) throw new Error(`Unsupported execution input version: ${plan.input.version}`);
    if (!plan.requestedPolicy) throw new Error('New Execution Plans require an explicit runtime execution policy');
    if (!plan.requestedCapabilities) throw new Error('New Execution Plans require explicit runtime tool capabilities');
    for (const inputId of plan.inputIds ?? []) {
      if (!this.jobInputs.get(plan.jobId)?.has(inputId)) throw new Error(`Execution Plan Input is not attached to Job: ${inputId}`);
    }
    if (plan.jobRevisionAtPreparation < 0 || plan.attemptRevisionAtPreparation < 0) {
      throw new Error('Execution Plan revisions must be non-negative');
    }
    const installation = this.installation;
    if (plan.installationId !== installation.id) {
      throw new Error(`Execution Plan belongs to another installation: ${plan.installationId}`);
    }
    const job = this.jobs.get(plan.jobId);
    if (!job || job.projectId !== plan.projectId) {
      throw new Error(`Invalid Execution Plan job/project association: ${plan.jobId}`);
    }
    const attempt = this.attempts.get(plan.attemptId);
    if (!attempt || attempt.jobId !== job.id) {
      throw new Error(`Invalid Execution Plan attempt/job association: ${plan.attemptId}`);
    }
    if (attempt.runtimeAgentId !== plan.runtimeAgentId) {
      throw new Error(`Execution Plan runtime does not match Attempt: ${plan.attemptId}`);
    }
    if (job.revision !== plan.jobRevisionAtPreparation
      || attempt.revision !== plan.attemptRevisionAtPreparation) {
      throw new Error('Execution Plan preparation revisions do not match current durable state');
    }
    if (job.repositoryId !== plan.repositoryId) {
      throw new Error(`Execution Plan repository does not match Job: ${plan.jobId}`);
    }
    if ((plan.repositoryId === undefined) !== (plan.checkoutBindingId === undefined)) {
      throw new Error('Execution Plan repository and checkout must both be present or both be absent');
    }
    if (plan.checkoutBindingId) {
      const binding = this.bindings.get(plan.checkoutBindingId);
      if (!binding
        || binding.repositoryId !== plan.repositoryId
        || binding.installationId !== plan.installationId) {
        throw new Error(`Invalid Execution Plan checkout association: ${plan.checkoutBindingId}`);
      }
    }
    if (this.executionPlans.has(plan.id)) throw new Error(`Duplicate Execution Plan ID: ${plan.id}`);
    if ([...this.executionPlans.values()].some(candidate => candidate.attemptId === plan.attemptId)) {
      throw new Error(`Attempt already has an Execution Plan: ${plan.attemptId}`);
    }
    this.executionPlans.set(plan.id, copyExecutionPlan(plan));
  }

  async getExecutionPlan(id: string): Promise<DurableExecutionPlan | null> {
    this.assertAvailable('read');
    const plan = this.executionPlans.get(id);
    return plan ? copyExecutionPlan(plan) : null;
  }

  async getExecutionPlanForAttempt(attemptId: string): Promise<DurableExecutionPlan | null> {
    this.assertAvailable('read');
    const plan = [...this.executionPlans.values()].find(candidate => candidate.attemptId === attemptId);
    return plan ? copyExecutionPlan(plan) : null;
  }

  async createExecutionDispatch(dispatch: DurableExecutionDispatch): Promise<void> {
    this.assertAvailable('write-execution-dispatch');
    requireNonEmpty(dispatch.id, 'Execution Dispatch ID');
    requireNonEmpty(dispatch.idempotencyKey, 'Execution Dispatch idempotency key');
    if (!dispatch.id.startsWith('dispatch:')) throw new Error(`Invalid Execution Dispatch ID: ${dispatch.id}`);
    if (dispatch.status !== 'prepared' || dispatch.revision !== 0) {
      throw new Error('New Execution Dispatches must be prepared at revision 0');
    }
    validateDispatchShape(dispatch);
    const plan = this.executionPlans.get(dispatch.executionPlanId);
    if (!plan
      || plan.attemptId !== dispatch.attemptId
      || plan.jobId !== dispatch.jobId
      || plan.runtimeAgentId !== dispatch.runtimeAgentId) {
      throw new Error(`Invalid Execution Dispatch Plan associations: ${dispatch.id}`);
    }
    if (this.executionDispatches.has(dispatch.id)) {
      throw new Error(`Duplicate Execution Dispatch ID: ${dispatch.id}`);
    }
    if ([...this.executionDispatches.values()].some(candidate =>
      candidate.executionPlanId === dispatch.executionPlanId)) {
      throw new Error(`Execution Plan already has a Dispatch: ${dispatch.executionPlanId}`);
    }
    if ([...this.executionDispatches.values()].some(candidate =>
      candidate.idempotencyKey === dispatch.idempotencyKey)) {
      throw new Error(`Duplicate Execution Dispatch idempotency key: ${dispatch.idempotencyKey}`);
    }
    this.executionDispatches.set(dispatch.id, copyExecutionDispatch(dispatch));
  }

  async getExecutionDispatch(id: string): Promise<DurableExecutionDispatch | null> {
    this.assertAvailable('read');
    const dispatch = this.executionDispatches.get(id);
    return dispatch ? copyExecutionDispatch(dispatch) : null;
  }

  async getExecutionDispatchForPlan(executionPlanId: string): Promise<DurableExecutionDispatch | null> {
    this.assertAvailable('read');
    const dispatch = [...this.executionDispatches.values()]
      .find(candidate => candidate.executionPlanId === executionPlanId);
    return dispatch ? copyExecutionDispatch(dispatch) : null;
  }

  async saveExecutionDispatchTransition(
    dispatch: DurableExecutionDispatch,
    expectedRevision: number,
  ): Promise<void> {
    this.assertAvailable('write-execution-dispatch');
    const existing = this.executionDispatches.get(dispatch.id);
    if (!existing) throw new Error(`Execution Dispatch not found: ${dispatch.id}`);
    if (existing.revision !== expectedRevision || dispatch.revision !== expectedRevision + 1) {
      throw new Error(`Stale Execution Dispatch revision for ${dispatch.id}`);
    }
    if (existing.executionPlanId !== dispatch.executionPlanId
      || existing.attemptId !== dispatch.attemptId
      || existing.jobId !== dispatch.jobId
      || existing.runtimeAgentId !== dispatch.runtimeAgentId
      || existing.idempotencyKey !== dispatch.idempotencyKey
      || existing.createdAt !== dispatch.createdAt) {
      throw new Error(`Execution Dispatch transition cannot rewrite durable identity: ${dispatch.id}`);
    }
    if (!isValidDispatchTransition(existing.status, dispatch.status)) {
      throw new Error(`Execution Dispatch cannot transition from ${existing.status} to ${dispatch.status}`);
    }
    if (dispatch.status !== 'accepted' && (dispatch.effectivePolicy || dispatch.effectiveCapabilities)) {
      throw new Error(`Only an accepted Execution Dispatch may record effective policy and capabilities: ${dispatch.id}`);
    }
    if (dispatch.status === 'accepted') {
      const requestedPolicy = this.executionPlans.get(dispatch.executionPlanId)?.requestedPolicy;
      if (requestedPolicy && (!dispatch.effectivePolicy
        || !isRuntimeExecutionPolicyNoBroaderThan(dispatch.effectivePolicy, requestedPolicy))) {
        throw new Error(`Accepted Execution Dispatch must record a non-broader effective policy: ${dispatch.id}`);
      }
      if (!requestedPolicy && dispatch.effectivePolicy) {
        throw new Error(`Legacy Execution Dispatch cannot invent effective policy: ${dispatch.id}`);
      }
      const requestedCapabilities = this.executionPlans.get(dispatch.executionPlanId)?.requestedCapabilities;
      if (requestedCapabilities && (!dispatch.effectiveCapabilities
        || !isRuntimeExecutionCapabilitiesNoBroaderThan(
          dispatch.effectiveCapabilities,
          requestedCapabilities,
        ))) {
        throw new Error(`Accepted Execution Dispatch must record non-broader effective capabilities: ${dispatch.id}`);
      }
      if (!requestedCapabilities && dispatch.effectiveCapabilities) {
        throw new Error(`Legacy Execution Dispatch cannot invent effective capabilities: ${dispatch.id}`);
      }
    }
    validateDispatchShape(dispatch);
    this.executionDispatches.set(dispatch.id, copyExecutionDispatch(dispatch));
  }

  async appendExecutionObservation(observation: DurableExecutionObservation): Promise<boolean> {
    this.assertAvailable('write-execution-observation');
    requireNonEmpty(observation.id, 'Execution Observation ID');
    requireNonEmpty(observation.source, 'Execution Observation source');
    requireNonEmpty(observation.sourceEventId, 'Execution Observation source event ID');
    const dispatch = this.executionDispatches.get(observation.dispatchId);
    if (!dispatch || dispatch.status !== 'accepted' || dispatch.attemptId !== observation.attemptId) {
      throw new Error(`Invalid Execution Observation Dispatch association: ${observation.id}`);
    }
    if (observation.correlation === 'exact'
      && observation.correlatedDispatchId !== observation.dispatchId) {
      throw new Error(`Exact Execution Observation must identify its Dispatch: ${observation.id}`);
    }
    if (observation.correlation !== 'exact' && observation.correlatedDispatchId !== undefined) {
      throw new Error(`Non-exact Execution Observation cannot identify a Dispatch: ${observation.id}`);
    }
    if (observation.resultText !== undefined
      && (!isBoundedExecutionResult(observation.resultText)
        || observation.kind !== 'turn-completed'
        || observation.correlation !== 'exact')) {
      throw new Error(`Execution result text requires exact bounded completion evidence: ${observation.id}`);
    }
    const duplicate = this.executionObservations.get(observation.id)
      ?? [...this.executionObservations.values()].find(candidate =>
        candidate.dispatchId === observation.dispatchId
        && candidate.source === observation.source
        && candidate.sourceEventId === observation.sourceEventId);
    if (duplicate) return false;
    this.executionObservations.set(observation.id, copyExecutionObservation(observation));
    return true;
  }

  async listExecutionObservationsForDispatch(
    dispatchId: string,
  ): Promise<readonly DurableExecutionObservation[]> {
    this.assertAvailable('read');
    return [...this.executionObservations.values()]
      .filter(observation => observation.dispatchId === dispatchId)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id))
      .map(copyExecutionObservation);
  }

  async createAttemptOutcomeDecision(decision: DurableAttemptOutcomeDecision): Promise<void> {
    this.assertAvailable('write-attempt-outcome');
    requireNonEmpty(decision.id, 'Attempt Outcome Decision ID');
    const dispatch = this.executionDispatches.get(decision.dispatchId);
    const attempt = this.attempts.get(decision.attemptId);
    if (!dispatch || dispatch.status !== 'accepted' || dispatch.attemptId !== decision.attemptId || !attempt) {
      throw new Error(`Invalid Attempt Outcome Decision associations: ${decision.id}`);
    }
    if (decision.outcome === 'completed' && !decision.summary?.trim()) {
      throw new Error('Completed Attempt Outcome Decision requires a summary');
    }
    if (decision.outcome === 'failed' && !decision.reason?.trim()) {
      throw new Error('Failed Attempt Outcome Decision requires a reason');
    }
    if (decision.evidenceObservationId) {
      const evidence = this.executionObservations.get(decision.evidenceObservationId);
      if (!evidence || evidence.dispatchId !== decision.dispatchId || evidence.attemptId !== decision.attemptId) {
        throw new Error(`Invalid outcome evidence Observation: ${decision.evidenceObservationId}`);
      }
    }
    if (this.attemptOutcomeDecisions.has(decision.attemptId)) {
      throw new Error(`Attempt already has an Outcome Decision: ${decision.attemptId}`);
    }
    if ([...this.attemptOutcomeDecisions.values()].some(candidate => candidate.id === decision.id)) {
      throw new Error(`Duplicate Attempt Outcome Decision ID: ${decision.id}`);
    }
    this.attemptOutcomeDecisions.set(decision.attemptId, copyAttemptOutcomeDecision(decision));
  }

  async getAttemptOutcomeDecision(attemptId: string): Promise<DurableAttemptOutcomeDecision | null> {
    this.assertAvailable('read');
    const decision = this.attemptOutcomeDecisions.get(attemptId);
    return decision ? copyAttemptOutcomeDecision(decision) : null;
  }

  async createAttemptReview(review: DurableAttemptReview): Promise<void> {
    this.assertAvailable('write-attempt-review');
    requireNonEmpty(review.id, 'Attempt Review ID');
    requireNonEmpty(review.summary, 'Attempt Review summary');
    if (!review.id.startsWith('review:')) throw new Error(`Invalid Attempt Review ID: ${review.id}`);
    const worker = this.attempts.get(review.workerAttemptId);
    const reviewer = this.attempts.get(review.reviewerAttemptId);
    if (!worker || !reviewer || worker.jobId !== review.jobId || reviewer.jobId !== review.jobId
      || worker.executionRole !== 'worker' || reviewer.executionRole !== 'reviewer'
      || reviewer.runtimeAgentId !== review.reviewerRuntimeAgentId) {
      throw new Error(`Invalid Attempt Review associations: ${review.id}`);
    }
    if (review.decision === 'REVISION_REQUIRED' && !review.feedback?.trim()) {
      throw new Error('Revision-required review needs concrete feedback');
    }
    if ([...this.attemptReviews.values()].some(candidate =>
      candidate.id === review.id
      || candidate.workerAttemptId === review.workerAttemptId
      || candidate.reviewerAttemptId === review.reviewerAttemptId)) {
      throw new Error(`Duplicate Attempt Review: ${review.id}`);
    }
    this.attemptReviews.set(review.id, copyAttemptReview(review));
  }

  async getAttemptReviewForWorkerAttempt(workerAttemptId: string): Promise<DurableAttemptReview | null> {
    this.assertAvailable('read');
    const value = [...this.attemptReviews.values()]
      .find(review => review.workerAttemptId === workerAttemptId);
    return value ? copyAttemptReview(value) : null;
  }

  async listAttemptReviewsForJob(jobId: string): Promise<readonly DurableAttemptReview[]> {
    this.assertAvailable('read');
    return [...this.attemptReviews.values()]
      .filter(review => review.jobId === jobId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(copyAttemptReview);
  }

  async createEscalation(escalation: DurableEscalation): Promise<void> {
    this.assertAvailable('write-escalation');
    requireNonEmpty(escalation.id, 'Escalation ID');
    requireNonEmpty(escalation.summary, 'Escalation summary');
    if (!escalation.id.startsWith('escalation:')) throw new Error(`Invalid Escalation ID: ${escalation.id}`);
    if (!this.jobs.has(escalation.jobId)) throw new Error(`Unknown Job for Escalation: ${escalation.jobId}`);
    if (escalation.attemptId && this.attempts.get(escalation.attemptId)?.jobId !== escalation.jobId) {
      throw new Error(`Invalid Escalation Attempt association: ${escalation.id}`);
    }
    if (escalation.reviewId && this.attemptReviews.get(escalation.reviewId)?.jobId !== escalation.jobId) {
      throw new Error(`Invalid Escalation Review association: ${escalation.id}`);
    }
    if (this.escalations.has(escalation.id)) throw new Error(`Duplicate Escalation ID: ${escalation.id}`);
    this.escalations.set(escalation.id, copyEscalation(escalation));
  }

  async getEscalation(id: string): Promise<DurableEscalation | null> {
    this.assertAvailable('read');
    const value = this.escalations.get(id);
    return value ? copyEscalation(value) : null;
  }

  async listEscalations(
    jobId?: string,
    unresolvedOnly = false,
  ): Promise<readonly DurableEscalation[]> {
    this.assertAvailable('read');
    return [...this.escalations.values()]
      .filter(escalation => (!jobId || escalation.jobId === jobId)
        && (!unresolvedOnly || !escalation.resolvedAt))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(copyEscalation);
  }

  async resolveEscalation(
    id: string,
    resolvedAt: string,
    resolutionSummary?: string,
  ): Promise<DurableEscalation> {
    this.assertAvailable('write-escalation');
    const escalation = this.escalations.get(id);
    if (!escalation) throw new Error(`Escalation not found: ${id}`);
    if (!resolvedAt.trim()) throw new Error('Escalation resolution timestamp is required');
    if (resolutionSummary !== undefined) requireNonEmpty(resolutionSummary, 'Escalation resolution summary');
    if (escalation.resolvedAt && (escalation.resolvedAt !== resolvedAt
      || escalation.resolutionSummary !== resolutionSummary)) {
      throw new Error(`Escalation ${id} is already resolved`);
    }
    const resolved = { ...escalation, resolvedAt, ...(resolutionSummary ? { resolutionSummary } : {}) };
    this.escalations.set(id, resolved);
    return copyEscalation(resolved);
  }

  async resolveEscalationAndResumeOperatorRun(
    id: string,
    resolvedAt: string,
    resolutionSummary: string,
    run: DurableOperatorRun,
    expectedRunRevision: number,
  ): Promise<void> {
    this.assertAvailable('write-operator-run');
    const escalation = this.escalations.get(id);
    const existingRun = this.operatorRuns.get(run.id);
    requireNonEmpty(resolutionSummary, 'Escalation resolution summary');
    if (!escalation || escalation.resolvedAt || escalation.jobId !== run.jobId) {
      throw new Error(`Escalation resolution conflict: ${id}`);
    }
    if (!existingRun || existingRun.jobId !== run.jobId
      || existingRun.revision !== expectedRunRevision || run.revision !== expectedRunRevision + 1
      || !isValidOperatorRunTransition(existingRun.status, run.status)) {
      throw new Error(`Operator Run transition conflict: ${run.id}`);
    }
    this.escalations.set(id, { ...escalation, resolvedAt, resolutionSummary });
    this.operatorRuns.set(run.id, copyOperatorRun(run));
  }

  async resolveEscalationAndCreateEscalation(
    id: string,
    resolvedAt: string,
    resolutionSummary: string,
    replacement: DurableEscalation,
  ): Promise<void> {
    this.assertAvailable('write-escalation');
    const escalation = this.escalations.get(id);
    requireNonEmpty(resolutionSummary, 'Escalation resolution summary');
    requireNonEmpty(replacement.summary, 'Replacement Escalation summary');
    if (!escalation || escalation.resolvedAt || escalation.jobId !== replacement.jobId
      || replacement.resolvedAt || !replacement.id.startsWith('escalation:')
      || (replacement.attemptId
        && this.attempts.get(replacement.attemptId)?.jobId !== replacement.jobId)
      || this.escalations.has(replacement.id)) {
      throw new Error(`Escalation resolution conflict: ${id}`);
    }
    this.escalations.set(id, { ...escalation, resolvedAt, resolutionSummary });
    this.escalations.set(replacement.id, copyEscalation(replacement));
  }

  async createOperatorRun(run: DurableOperatorRun): Promise<void> {
    this.assertAvailable('write-operator-run');
    requireNonEmpty(run.id, 'Operator Run ID');
    if (!run.id.startsWith('operator-run:') || !this.jobs.has(run.jobId)) {
      throw new Error(`Invalid Operator Run: ${run.id}`);
    }
    if (run.revision !== 0 || run.status !== 'pending') {
      throw new Error('New Operator Run must be pending at revision 0');
    }
    if (this.operatorRuns.has(run.id)
      || [...this.operatorRuns.values()].some(candidate => candidate.jobId === run.jobId)) {
      throw new Error(`Duplicate Operator Run: ${run.id}`);
    }
    this.operatorRuns.set(run.id, copyOperatorRun(run));
  }

  async getOperatorRun(id: string): Promise<DurableOperatorRun | null> {
    this.assertAvailable('read');
    const value = this.operatorRuns.get(id);
    return value ? copyOperatorRun(value) : null;
  }

  async getOperatorRunForJob(jobId: string): Promise<DurableOperatorRun | null> {
    this.assertAvailable('read');
    const value = [...this.operatorRuns.values()].find(run => run.jobId === jobId);
    return value ? copyOperatorRun(value) : null;
  }

  async listOperatorRuns(): Promise<readonly DurableOperatorRun[]> {
    this.assertAvailable('read');
    return [...this.operatorRuns.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(copyOperatorRun);
  }

  async saveOperatorRunTransition(run: DurableOperatorRun, expectedRevision: number): Promise<void> {
    this.assertAvailable('write-operator-run');
    const existing = this.operatorRuns.get(run.id);
    if (!existing || existing.revision !== expectedRevision || run.revision !== expectedRevision + 1) {
      throw new Error(`Operator Run transition conflict: ${run.id}`);
    }
    if (existing.jobId !== run.jobId || !isValidOperatorRunTransition(existing.status, run.status)) {
      throw new Error(`Invalid Operator Run transition: ${existing.status} -> ${run.status}`);
    }
    this.operatorRuns.set(run.id, copyOperatorRun(run));
  }

  async createHumanGuidanceAndResolveEscalation(
    guidance: DurableHumanGuidance,
    resolvedAt: string,
  ): Promise<void> {
    this.assertAvailable('write-human-guidance');
    const escalation = this.escalations.get(guidance.escalationId);
    requireNonEmpty(guidance.instruction, 'Human Guidance instruction');
    if (!guidance.id.startsWith('guidance:') || !escalation
      || escalation.jobId !== guidance.jobId || escalation.resolvedAt) {
      throw new Error(`Invalid Human Guidance association: ${guidance.id}`);
    }
    if ([...this.humanGuidance.values()].some(value => value.escalationId === guidance.escalationId)) {
      throw new Error(`Escalation already has Human Guidance: ${guidance.escalationId}`);
    }
    this.humanGuidance.set(guidance.id, copyHumanGuidance(guidance));
    this.escalations.set(escalation.id, { ...escalation, resolvedAt });
  }

  async createHumanGuidanceAndResumeOperatorRun(
    guidance: DurableHumanGuidance,
    resolvedAt: string,
    run: DurableOperatorRun,
    expectedRunRevision: number,
  ): Promise<void> {
    this.assertAvailable('write-human-guidance');
    const escalation = this.escalations.get(guidance.escalationId);
    const existingRun = this.operatorRuns.get(run.id);
    requireNonEmpty(guidance.instruction, 'Human Guidance instruction');
    if (!guidance.id.startsWith('guidance:') || !escalation
      || escalation.jobId !== guidance.jobId || escalation.resolvedAt
      || [...this.humanGuidance.values()].some(value => value.escalationId === guidance.escalationId)) {
      throw new Error(`Invalid Human Guidance association: ${guidance.id}`);
    }
    if (!existingRun || existingRun.jobId !== guidance.jobId
      || existingRun.revision !== expectedRunRevision || run.revision !== expectedRunRevision + 1
      || !isValidOperatorRunTransition(existingRun.status, run.status)) {
      throw new Error(`Operator Run transition conflict: ${run.id}`);
    }
    this.humanGuidance.set(guidance.id, copyHumanGuidance(guidance));
    this.escalations.set(escalation.id, { ...escalation, resolvedAt });
    this.operatorRuns.set(run.id, copyOperatorRun(run));
  }

  async listHumanGuidance(jobId: string): Promise<readonly DurableHumanGuidance[]> {
    this.assertAvailable('read');
    return [...this.humanGuidance.values()]
      .filter(value => value.jobId === jobId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(copyHumanGuidance);
  }

  async authorizeWorkerBudgetExtensionAndResumeOperatorRun(
    extension: DurableWorkerBudgetExtension,
    guidance: DurableHumanGuidance | null,
    resolvedAt: string,
    resolutionSummary: string,
    run: DurableOperatorRun,
    expectedRunRevision: number,
  ): Promise<void> {
    this.assertAvailable('write-worker-budget-extension');
    const escalation = this.escalations.get(extension.escalationId);
    const existingRun = this.operatorRuns.get(run.id);
    requireNonEmpty(resolutionSummary, 'Escalation resolution summary');
    if (!extension.id.startsWith('worker-budget-extension:')
      || extension.additionalWorkerExecutions !== 1
      || !escalation || escalation.jobId !== extension.jobId || escalation.resolvedAt
      || this.workerBudgetExtensions.has(extension.id)
      || [...this.workerBudgetExtensions.values()].some(value => value.escalationId === extension.escalationId)) {
      throw new Error(`Invalid Worker Budget Extension: ${extension.id}`);
    }
    if (guidance && (!guidance.id.startsWith('guidance:')
      || guidance.jobId !== extension.jobId
      || guidance.escalationId !== extension.escalationId
      || !guidance.instruction.trim()
      || [...this.humanGuidance.values()].some(value => value.escalationId === guidance.escalationId))) {
      throw new Error(`Invalid Human Guidance association: ${guidance.id}`);
    }
    if (!existingRun || existingRun.jobId !== extension.jobId
      || existingRun.revision !== expectedRunRevision || run.revision !== expectedRunRevision + 1
      || !isValidOperatorRunTransition(existingRun.status, run.status)) {
      throw new Error(`Operator Run transition conflict: ${run.id}`);
    }
    this.workerBudgetExtensions.set(extension.id, copyWorkerBudgetExtension(extension));
    if (guidance) this.humanGuidance.set(guidance.id, copyHumanGuidance(guidance));
    this.escalations.set(escalation.id, { ...escalation, resolvedAt, resolutionSummary });
    this.operatorRuns.set(run.id, copyOperatorRun(run));
  }

  async listWorkerBudgetExtensions(jobId: string): Promise<readonly DurableWorkerBudgetExtension[]> {
    this.assertAvailable('read');
    return [...this.workerBudgetExtensions.values()]
      .filter(value => value.jobId === jobId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(copyWorkerBudgetExtension);
  }

  async createOperatorNotificationDelivery(
    delivery: DurableOperatorNotificationDelivery,
  ): Promise<boolean> {
    this.assertAvailable('write-operator-notification');
    if (!delivery.id.startsWith('notification-delivery:') || !this.jobs.has(delivery.jobId)
      || delivery.status !== 'pending' || delivery.revision !== 0) {
      throw new Error(`Invalid Operator Notification Delivery: ${delivery.id}`);
    }
    if ([...this.operatorNotificationDeliveries.values()]
      .some(value => value.eventKey === delivery.eventKey)) return false;
    this.operatorNotificationDeliveries.set(delivery.id, copyOperatorNotificationDelivery(delivery));
    return true;
  }

  async getOperatorNotificationDeliveryByEventKey(
    eventKey: string,
  ): Promise<DurableOperatorNotificationDelivery | null> {
    this.assertAvailable('read');
    const value = [...this.operatorNotificationDeliveries.values()]
      .find(delivery => delivery.eventKey === eventKey);
    return value ? copyOperatorNotificationDelivery(value) : null;
  }

  async listOperatorNotificationDeliveries(
    jobId?: string,
  ): Promise<readonly DurableOperatorNotificationDelivery[]> {
    this.assertAvailable('read');
    return [...this.operatorNotificationDeliveries.values()]
      .filter(value => !jobId || value.jobId === jobId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(copyOperatorNotificationDelivery);
  }

  async saveOperatorNotificationDeliveryTransition(
    delivery: DurableOperatorNotificationDelivery,
    expectedRevision: number,
  ): Promise<void> {
    this.assertAvailable('write-operator-notification');
    const existing = this.operatorNotificationDeliveries.get(delivery.id);
    if (!existing || existing.revision !== expectedRevision || delivery.revision !== expectedRevision + 1
      || existing.status !== 'pending' || delivery.status === 'pending'
      || existing.eventKey !== delivery.eventKey) {
      throw new Error(`Operator Notification transition conflict: ${delivery.id}`);
    }
    this.operatorNotificationDeliveries.set(delivery.id, copyOperatorNotificationDelivery(delivery));
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

function isValidOperatorRunTransition(from: string, to: string): boolean {
  return from === 'pending' && (to === 'running' || to === 'failed')
    || from === 'running' && ['completed', 'needs_human', 'failed'].includes(to)
    || from === 'needs_human' && (to === 'pending' || to === 'cancelled');
}

function validAuthTransition(from: string, to: string): boolean {
  return from === 'pending-human-login' && (to === 'ready' || to === 'expired' || to === 'revoked')
    || from === 'ready' && (to === 'expired' || to === 'revoked')
    || from === 'expired' && to === 'revoked';
}
