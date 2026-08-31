import type {
  AttemptReviewDecision,
  DurableAttemptReview,
  DurableEscalation,
  DurableHumanGuidance,
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
} from '../../agent-operations-contracts/src/index.js';

export type { RuntimeStartResult } from '../../agent-operations-contracts/src/index.js';

export interface OperatorTaskInput {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly title?: string;
  readonly task: string;
  readonly acceptanceCriteria: string;
  readonly executionMode?: JobExecutionMode;
}

export interface OperatorPolicyDefaults {
  readonly policy: RuntimeExecutionPolicy;
  readonly capabilities: RuntimeExecutionCapabilities;
  readonly maxWorkerAttempts: 2;
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

export type OperatorEscalationAction = 'provide-guidance' | 'reconcile-execution' | 'cancel-job';

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
  readonly notificationDeliveries: readonly DurableOperatorNotificationDelivery[];
  readonly escalationActions: Readonly<Record<string, readonly OperatorEscalationAction[]>>;
  readonly finalWorkerResult?: string;
  readonly finalReview?: DurableAttemptReview;
  readonly completedAt?: string;
  readonly repositoryWorkspace?: DurableRepositoryWorkspace;
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
  reconcileTimedOutExecution(escalationId: string): Promise<OperatorRunSession>;
  cancelEscalatedJob(escalationId: string): Promise<OperatorRunSession>;
  listJobs(filter?: OperatorJobList): Promise<readonly OperatorJobSummary[]>;
  getJobDetail(jobId: string): Promise<OperatorJobDetail>;
}

export type OrchestratorToolName =
  | 'ao.projects.list'
  | 'ao.projects.get'
  | 'ao.jobs.create'
  | 'ao.jobs.get'
  | 'ao.jobs.list'
  | 'ao.jobs.status';

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
}

export interface OrchestratorConversationTurn {
  readonly id: string;
  readonly operatorMessage: string;
  readonly response?: string;
  readonly projectId?: string;
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
