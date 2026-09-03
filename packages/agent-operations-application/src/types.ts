import type {
  AttemptReviewDecision,
  DurableAttemptReview,
  DurableEscalation,
  DurableHumanGuidance,
  DurableWorkerBudgetExtension,
  DurableJob,
  DurableJobAttempt,
  DurableOperatorNotificationDelivery,
  DurableOperatorRun,
  DurableProject,
  DurableRepository,
  ExecutionRole,
  RuntimeExecutionCapabilities,
  RuntimeExecutionPolicy,
  RuntimeStartResult,
  JobExecutionMode,
  DurableRepositoryWorkspace,
  DurableLocalFolderResource,
  DurableProjectProfile,
  InputMetadata,
  RepositoryAvailability,
  WorkingTreeState,
  BrowserEvidenceRequirement,
  DurableBrowserEvidence,
  DurablePreviewProfile,
  DurablePreviewSession,
  DurableTrustProfile,
  DurableAuthenticatedPreviewSession,
  TrustProfilePolicy,
  TrustProfilePreset,
  TrustProfileScope,
  RuntimeFreshnessReport,
} from '../../agent-operations-contracts/src/index.js';

export type {
  DurableTrustProfile,
  RuntimeFreshnessReport,
  RuntimeStartResult,
} from '../../agent-operations-contracts/src/index.js';

export interface OperatorTaskInput {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly title?: string;
  readonly task: string;
  readonly acceptanceCriteria: string;
  readonly executionMode?: JobExecutionMode;
  readonly inputIds?: readonly string[];
  readonly browserEvidenceRequirement?: BrowserEvidenceRequirement;
}

export type CreateProjectResourceInput =
  | { readonly type: 'git-repository'; readonly path: string }
  | { readonly type: 'local-folder'; readonly path: string }
  | { readonly type: 'none' };

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly resource: CreateProjectResourceInput;
}

export interface ProjectOnboardingResult {
  readonly project: DurableProject;
  readonly repositories: readonly DurableRepository[];
  readonly localFolders: readonly DurableLocalFolderResource[];
  readonly repositoryReadiness: readonly ProjectRepositoryReadiness[];
  readonly profile: DurableProjectProfile;
}

export interface ProjectRepositoryReadiness {
  readonly repositoryId: string;
  readonly canonicalPath: string;
  readonly canonicalRemote?: string;
  readonly availability: RepositoryAvailability;
  readonly branch?: string;
  readonly detachedHead: boolean;
  readonly headCommit?: string;
  readonly workingTree: WorkingTreeState;
}

export interface ProjectApplication {
  createProject(input: CreateProjectInput): Promise<ProjectOnboardingResult>;
  getProject(projectId: string): Promise<ProjectOnboardingResult>;
  listProjects(): Promise<readonly ProjectOnboardingResult[]>;
}

export interface CreateUploadedInputRequest {
  readonly displayName: string;
  readonly mimeType?: string;
  readonly bytes: Uint8Array;
  readonly projectId?: string;
}

export interface CreateUrlInputRequest {
  readonly url: string;
  readonly projectId?: string;
}

export interface InputApplication {
  createUploadedInput(input: CreateUploadedInputRequest): Promise<InputMetadata>;
  createUrlInput(input: CreateUrlInputRequest): Promise<InputMetadata>;
  getInput(inputId: string): Promise<InputMetadata>;
  listInputs(projectId?: string): Promise<readonly InputMetadata[]>;
  readInput(inputId: string): Promise<Uint8Array>;
  associateWithConversation(conversationId: string, inputIds: readonly string[]): Promise<void>;
}

export interface OperatorPolicyDefaults {
  readonly policy: RuntimeExecutionPolicy;
  readonly capabilities: RuntimeExecutionCapabilities;
  readonly maxWorkerAttempts: number;
  readonly reviewerEnabled: true;
  readonly automaticReadOnlyCompletion: boolean;
}

export interface OperatorProjectOption {
  readonly project: DurableProject;
  readonly repositories: readonly DurableRepository[];
  readonly runtimeAgentIds: readonly string[];
  readonly runnable: boolean;
  readonly unavailableReason?: string;
}

export interface OperatorTaskPreview {
  readonly project: DurableProject;
  readonly repository: DurableRepository;
  readonly runtimeAgentId: string;
  readonly title?: string;
  readonly task: string;
  readonly acceptanceCriteria: string;
  readonly defaults: OperatorPolicyDefaults;
  readonly executionMode?: JobExecutionMode;
  readonly executionAuthorized: false;
  readonly inputIds?: readonly string[];
  readonly browserEvidenceRequirement?: BrowserEvidenceRequirement;
}

export type OperatorRunStatus = 'pending' | 'running' | 'done' | 'needs-human' | 'failed' | 'cancelled';

export interface OperatorRunSession {
  readonly jobId: string;
  readonly status: OperatorRunStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly message?: string;
}

export interface OperatorJobSummary {
  readonly job: DurableJob;
  readonly projectName: string;
  readonly repositoryName: string;
  readonly latestAttempt: DurableJobAttempt | null;
  readonly currentRole: ExecutionRole | null;
  readonly orchestrationState: string;
  readonly workerAttemptCount: number;
  /** Worker Attempts that crossed, or may have crossed, provider submission. */
  readonly workerExecutionCount: number;
  readonly automaticWorkerExecutionLimit: number;
  readonly humanWorkerBudgetExtensionCount: number;
  readonly authorizedWorkerExecutionLimit: number;
  readonly latestReviewDecision: AttemptReviewDecision | null;
  readonly needsHuman: boolean;
  readonly operatorRun: DurableOperatorRun | null;
  readonly currentStage: OperatorExecutionStage;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
}

export type OperatorExecutionStage =
  | 'Accepted'
  | 'Preparing Worker'
  | 'Executing Worker'
  | 'Capturing Worker Result'
  | 'Preparing Reviewer'
  | 'Executing Reviewer'
  | 'Capturing Review'
  | 'Preparing Revision'
  | 'Needs Me'
  | 'Ready for Approval'
  | 'Completed'
  | 'Cancelled'
  | 'Failed';

export interface OperatorRuntimeStatus {
  readonly state: 'ready' | 'offline' | 'degraded';
  readonly label: string;
  readonly reason?: string;
}

export type OperatorEscalationAction =
  | 'provide-guidance'
  | 'authorize-worker-budget-extension'
  | 'reconcile-execution'
  | 'cancel-job';

export type OperatorEscalationKind =
  | 'actionable-continuation'
  | 'human-approval'
  | 'guidance-required'
  | 'budget-extension-required'
  | 'terminal';

export interface OperatorAttemptStory {
  readonly attempt: DurableJobAttempt;
  readonly resultText?: string;
  readonly review?: DurableAttemptReview;
  readonly executionPlanId?: string;
  readonly dispatchId?: string;
  readonly externalReference?: string;
}

export interface OperatorJobDetail {
  readonly summary: OperatorJobSummary;
  readonly acceptanceCriteria: string;
  readonly workerAttempts: readonly OperatorAttemptStory[];
  readonly reviewerAttempts: readonly OperatorAttemptStory[];
  readonly reviews: readonly DurableAttemptReview[];
  readonly escalations: readonly DurableEscalation[];
  readonly guidance: readonly DurableHumanGuidance[];
  readonly workerBudgetExtensions: readonly DurableWorkerBudgetExtension[];
  readonly notificationDeliveries: readonly DurableOperatorNotificationDelivery[];
  readonly escalationActions: Readonly<Record<string, readonly OperatorEscalationAction[]>>;
  readonly escalationKinds: Readonly<Record<string, OperatorEscalationKind>>;
  readonly finalWorkerResult?: string;
  readonly finalReview?: DurableAttemptReview;
  readonly completedAt?: string;
  readonly repositoryWorkspace?: DurableRepositoryWorkspace;
  readonly inputs?: readonly InputMetadata[];
  readonly browserEvidenceRequirement?: BrowserEvidenceRequirement;
  readonly previewProfile?: DurablePreviewProfile;
  readonly previewSession?: DurablePreviewSession;
  readonly browserEvidence?: readonly DurableBrowserEvidence[];
  readonly authenticatedPreviewSession?: DurableAuthenticatedPreviewSession;
}

export interface EffectiveTrustProfile {
  readonly profile: DurableTrustProfile | null;
  readonly policy: TrustProfilePolicy;
  readonly source: 'global' | 'project' | 'job' | 'conservative-fallback';
}

export interface SaveTrustProfileInput {
  readonly scope: TrustProfileScope;
  readonly scopeId?: string;
  readonly name?: string;
  readonly preset: TrustProfilePreset;
  readonly policy?: TrustProfilePolicy;
}

export interface TrustProfileApplication {
  list(): Promise<readonly DurableTrustProfile[]>;
  save(input: SaveTrustProfileInput): Promise<DurableTrustProfile>;
  effectiveForProject(projectId: string): Promise<EffectiveTrustProfile>;
  effectiveForJob(jobId: string): Promise<EffectiveTrustProfile>;
}

export interface DailyDriverMetrics {
  readonly jobsCreated: number;
  readonly jobsCompleted: number;
  readonly jobsFailed: number;
  readonly jobsCancelled: number;
  readonly jobsActiveOrNeedsHuman: number;
  readonly autonomousCompletions: number;
  readonly autonomousCompletionRate: number | null;
  readonly jobsRequiringHumanIntervention: number;
  readonly humanInterventionCount: number;
  readonly humanInterventionRate: number | null;
  readonly needsMeCategories: {
    readonly machineResolvable: number;
    readonly operatorResolvable: number;
    readonly terminal: number;
  };
  readonly workerExecutions: number;
  readonly averageWorkerExecutions: number | null;
  readonly reviewerRevisionCount: number;
  readonly reviewerRevisionRate: number | null;
  readonly recoveryCount: number;
  readonly providerSubmissions: number;
  readonly duplicateDispatchCount: number;
  readonly averageTimeToResultMs: number | null;
}

export interface DailyDriverMetricsApplication { read(): Promise<DailyDriverMetrics>; }

export interface RuntimeFreshnessApplication {
  inspect(): Promise<RuntimeFreshnessReport>;
  ensureCurrentForJob(jobId: string): Promise<RuntimeFreshnessReport>;
}

export interface PreviewApplication {
  setJobEvidenceRequirement(jobId: string, requirement: BrowserEvidenceRequirement): Promise<void>;
  setJobPreviewProfile(jobId: string, command: string, authenticationRequired?: boolean): Promise<DurablePreviewProfile>;
  beginPreviewAuthentication(jobId: string): Promise<DurableAuthenticatedPreviewSession>;
  verifyPreviewAuthentication(jobId: string): Promise<DurableAuthenticatedPreviewSession>;
  revokePreviewAuthentication(jobId: string): Promise<DurableAuthenticatedPreviewSession>;
  startJobPreview(jobId: string): Promise<DurablePreviewSession>;
  refreshJobEvidence(jobId: string): Promise<DurableBrowserEvidence>;
  ensureJobEvidence(jobId: string): Promise<DurableBrowserEvidence>;
  getJobPreview(jobId: string): Promise<{
    readonly requirement: BrowserEvidenceRequirement | null;
    readonly profile: DurablePreviewProfile | null;
    readonly session: DurablePreviewSession | null;
    readonly evidence: readonly DurableBrowserEvidence[];
    readonly authentication: DurableAuthenticatedPreviewSession | null;
  }>;
}

export type OperatorJobList = 'all' | 'running' | 'needs-human' | 'done';

export interface OperatorApplication {
  startRunner(): void;
  listProjects(): Promise<readonly OperatorProjectOption[]>;
  getRuntimeStatus(): Promise<OperatorRuntimeStatus>;
  startRuntime(): Promise<RuntimeStartResult>;
  previewTask(input: OperatorTaskInput): Promise<OperatorTaskPreview>;
  runOperatorJob(input: OperatorTaskInput): Promise<OperatorRunSession>;
  waitForRun(jobId: string): Promise<OperatorRunSession>;
  provideGuidanceAndContinue(escalationId: string, instruction: string): Promise<OperatorRunSession>;
  authorizeOneMoreWorkerAttempt(escalationId: string, instruction?: string): Promise<OperatorRunSession>;
  reconcileTimedOutExecution(escalationId: string): Promise<OperatorRunSession>;
  cancelEscalatedJob(escalationId: string): Promise<OperatorRunSession>;
  listJobs(filter?: OperatorJobList): Promise<readonly OperatorJobSummary[]>;
  getJobDetail(jobId: string): Promise<OperatorJobDetail>;
}

export type OrchestratorToolName =
  | 'ao.projects.list'
  | 'ao.projects.get'
  | 'ao.inputs.list'
  | 'ao.inputs.get'
  | 'ao.jobs.create'
  | 'ao.jobs.get'
  | 'ao.jobs.list'
  | 'ao.jobs.status'
  | 'ao.jobs.guide'
  | 'ao.jobs.authorize-one-more-attempt'
  | 'ao.previews.authenticate';

export interface OrchestratorToolRequest {
  readonly name: OrchestratorToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface OrchestratorToolResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly relatedJobIds: readonly string[];
}

export interface OrchestratorTurnInput {
  readonly message: string;
  readonly projectId?: string;
  readonly inputIds?: readonly string[];
}

export interface OrchestratorConversationTurn {
  readonly id: string;
  readonly operatorMessage: string;
  readonly response?: string;
  readonly projectId?: string;
  readonly inputIds?: readonly string[];
  readonly relatedJobIds: readonly string[];
  readonly clarificationRequired: boolean;
  readonly status: 'pending' | 'completed' | 'failed';
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly providerSessionId?: string;
  readonly providerTurnId?: string;
}

export interface OrchestratorConversationState {
  readonly agentId: string;
  /** Stable CortextOS agent session identity. Provider native history remains CortextOS owned. */
  readonly sessionId: string;
  readonly runtimeState: 'ready' | 'offline' | 'busy';
  readonly runtimeReason?: string;
  readonly turns: readonly OrchestratorConversationTurn[];
}

export interface OrchestratorTurnResult {
  readonly agentId: string;
  readonly sessionId: string;
  readonly turn: OrchestratorConversationTurn;
}

export interface OrchestratorConversationRuntime {
  sendTurn(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult>;
  getConversationState(): Promise<OrchestratorConversationState>;
}

export interface OrchestratorConversationService {
  sendTurn(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult>;
  getConversationState(): Promise<OrchestratorConversationState>;
}
