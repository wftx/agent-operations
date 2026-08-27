import { randomUUID } from 'node:crypto';

export const JOB_STATUSES = ['draft', 'ready', 'completed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const ATTEMPT_STATUSES = ['created', 'running', 'completed', 'failed', 'cancelled'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const EXECUTION_ROLES = ['worker', 'reviewer'] as const;
export type ExecutionRole = (typeof EXECUTION_ROLES)[number];

export interface DurableJob {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  /** Small, human-authored success definition supplied to the Reviewer. */
  readonly acceptanceCriteria?: string;
  /** Explicit opt-in. Absence and false both prohibit autonomous completion. */
  readonly automaticReadOnlyCompletion?: boolean;
  readonly status: JobStatus;
  readonly repositoryId?: string;
  /** Preferred/default runtime. Each attempt records the actual runtime used. */
  readonly preferredRuntimeAgentId?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewDurableJobAttempt {
  readonly id: string;
  readonly jobId: string;
  readonly runtimeAgentId?: string;
  /** Omitted only by pre-v9 callers, where it means worker. */
  readonly executionRole?: ExecutionRole;
  readonly status: 'created';
  readonly revision: 0;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DurableJobAttempt {
  readonly id: string;
  readonly jobId: string;
  readonly sequence: number;
  /** Global Job history sequence, plus an independent sequence within the role. */
  readonly roleSequence: number;
  readonly executionRole: ExecutionRole;
  /** Actual runtime assigned to this attempt; never rewritten by later attempts. */
  readonly runtimeAgentId?: string;
  readonly status: AttemptStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly failureReason?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createJobId(uuid: string = randomUUID()): string {
  const value = uuid.trim();
  if (!value) throw new Error('Job UUID is required');
  return `job:${value}`;
}

export function createAttemptId(uuid: string = randomUUID()): string {
  const value = uuid.trim();
  if (!value) throw new Error('Attempt UUID is required');
  return `attempt:${value}`;
}

export function isActiveAttemptStatus(status: AttemptStatus): boolean {
  return status === 'created' || status === 'running';
}

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
