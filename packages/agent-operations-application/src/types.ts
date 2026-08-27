import type {
  AttemptReviewDecision,
  DurableAttemptReview,
  DurableEscalation,
  DurableJob,
  DurableJobAttempt,
  DurableProject,
  DurableRepository,
  ExecutionRole,
  RuntimeExecutionCapabilities,
  RuntimeExecutionPolicy,
} from '../../agent-operations-contracts/src/index.js';

export interface OperatorTaskInput {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly task: string;
  readonly acceptanceCriteria: string;
}

export interface OperatorPolicyDefaults {
  readonly policy: RuntimeExecutionPolicy;
  readonly capabilities: RuntimeExecutionCapabilities;
  readonly maxWorkerAttempts: 2;
  readonly reviewerEnabled: true;
  readonly automaticReadOnlyCompletion: true;
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
  readonly task: string;
  readonly acceptanceCriteria: string;
  readonly defaults: OperatorPolicyDefaults;
  readonly executionAuthorized: false;
}

export type OperatorRunStatus = 'running' | 'done' | 'needs-human' | 'failed';

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
  readonly latestReviewDecision: AttemptReviewDecision | null;
  readonly needsHuman: boolean;
}

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
  readonly finalWorkerResult?: string;
  readonly finalReview?: DurableAttemptReview;
  readonly completedAt?: string;
}

export type OperatorJobList = 'all' | 'running' | 'needs-human' | 'done';

export interface OperatorApplication {
  listProjects(): Promise<readonly OperatorProjectOption[]>;
  previewTask(input: OperatorTaskInput): Promise<OperatorTaskPreview>;
  runOperatorJob(input: OperatorTaskInput): Promise<OperatorRunSession>;
  waitForRun(jobId: string): Promise<OperatorRunSession>;
  listJobs(filter?: OperatorJobList): Promise<readonly OperatorJobSummary[]>;
  getJobDetail(jobId: string): Promise<OperatorJobDetail>;
}
