import { createHash, randomUUID } from 'node:crypto';

export const JOB_RETIREMENT_DISPOSITIONS = ['retired', 'externally-published'] as const;
export type JobRetirementDisposition = (typeof JOB_RETIREMENT_DISPOSITIONS)[number];

/** Evidence preserving terminal disposition layered over the original Job history. */
export interface DurableJobRetirement {
  readonly jobId: string;
  readonly disposition: JobRetirementDisposition;
  readonly reason: string;
  readonly actor: string;
  readonly evidenceReference?: string;
  readonly retiredAt: string;
}

export type RepositoryRestoreState =
  | 'pending-approval'
  | 'approved'
  | 'completed'
  | 'rejected'
  | 'failed';

export const REPOSITORY_RESTORE_TRACKED_PATHS_OPERATION = 'repository.restore_tracked_paths';

export type RepositoryRestoreFileState =
  | 'unmodified'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'type-changed'
  | 'untracked'
  | 'ignored'
  | 'unknown';

export interface RepositoryRestoreStatusEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly indexStatus: RepositoryRestoreFileState;
  readonly worktreeStatus: RepositoryRestoreFileState;
}

export interface RepositoryRestorePathPrecondition {
  readonly path: string;
  readonly indexStatus: RepositoryRestoreFileState;
  readonly worktreeStatus: RepositoryRestoreFileState;
  readonly workingTreeSha256?: string;
  readonly headSha256: string;
}

export interface RepositoryPreservedPathEvidence {
  readonly path: string;
  readonly sha256: string;
}

export interface RepositoryRestorePreconditions {
  readonly repositoryId: string;
  readonly checkoutBindingId: string;
  readonly canonicalPath: string;
  readonly branch: string;
  readonly headRevision: string;
  readonly restorePaths: readonly RepositoryRestorePathPrecondition[];
  readonly preserveUntrackedPaths: readonly RepositoryPreservedPathEvidence[];
  readonly statusEntries: readonly RepositoryRestoreStatusEntry[];
  readonly evidenceHash: string;
}

export interface RepositoryRestoreResult {
  readonly beforeEvidenceHash: string;
  readonly afterEvidenceHash: string;
  readonly restoredPaths: readonly string[];
  readonly preservedUntrackedPaths: readonly RepositoryPreservedPathEvidence[];
  readonly completedAt: string;
}

export interface RepositoryFileHashEvidence {
  readonly path: string;
  readonly sha256: string;
}

export interface RepositoryRestoreExecutionReceipt {
  readonly actionId: string;
  readonly operation: typeof REPOSITORY_RESTORE_TRACKED_PATHS_OPERATION;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly checkoutBindingId: string;
  readonly approvedPaths: readonly string[];
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly executedAt: string;
  readonly recordedAt: string;
  readonly evidenceSource: 'captured-during-execution' | 'reconciled-from-completed-action';
  readonly branchBefore: string;
  readonly branchAfter: string;
  readonly headBefore: string;
  readonly headAfter: string;
  readonly approvedFileHashesBefore: readonly RepositoryFileHashEvidence[];
  readonly restoredFileHashesAfter: readonly RepositoryFileHashEvidence[];
  readonly preservedUntrackedFileHashesBefore: readonly RepositoryFileHashEvidence[];
  readonly preservedUntrackedFileHashesAfter: readonly RepositoryFileHashEvidence[];
  readonly finalStatus: readonly RepositoryRestoreStatusEntry[];
  readonly beforeEvidenceHash: string;
  readonly afterEvidenceHash: string;
  readonly commitPerformed: false;
  readonly pushPerformed: false;
  readonly deployPerformed: false;
  readonly verificationResult: 'passed' | 'failed' | 'partial';
  readonly failureReason?: string;
}

export interface DurableDeterministicRepositoryVerification {
  readonly id: string;
  readonly jobId: string;
  readonly actionId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly checkoutBindingId: string;
  readonly verifiedAt: string;
  readonly verifiedBy: string;
  readonly branch: string;
  readonly headRevision: string;
  readonly statusEntries: readonly RepositoryRestoreStatusEntry[];
  readonly cleanPaths: readonly string[];
  readonly preservedUntrackedFiles: readonly RepositoryFileHashEvidence[];
  readonly commitPerformed: false;
  readonly pushPerformed: false;
  readonly deployPerformed: false;
  readonly providerRuntimeRequired: false;
  readonly providerSubmissionsCreated: 0;
  readonly result: 'passed' | 'failed';
  readonly summary: string;
}

/** Exact Red action. Approval and execution are revisioned and idempotent. */
export interface DurableRepositoryRestoreAction {
  readonly id: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly checkoutBindingId: string;
  readonly state: RepositoryRestoreState;
  readonly preconditions: RepositoryRestorePreconditions;
  readonly approvalSummary: string;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly approvedAt?: string;
  readonly approvedBy?: string;
  readonly result?: RepositoryRestoreResult;
  readonly failureReason?: string;
  readonly revision: number;
}

export interface RepositoryRestoreInspection {
  readonly repositoryId: string;
  readonly canonicalPath: string;
  readonly branch?: string;
  readonly detachedHead: boolean;
  readonly headRevision: string;
  readonly statusEntries: readonly RepositoryRestoreStatusEntry[];
  readonly evidenceHash: string;
}

export interface RepositoryRestoreAdapter {
  inspect(canonicalPath: string): Promise<RepositoryRestoreInspection>;
  sha256ForWorkingTreeFile(canonicalPath: string, path: string): Promise<string | null>;
  sha256ForHeadFile(canonicalPath: string, headRevision: string, path: string): Promise<string | null>;
  restoreTrackedPaths(
    canonicalPath: string,
    headRevision: string,
    paths: readonly string[],
  ): Promise<void>;
}

export function createRepositoryRestoreActionId(uuid: string = randomUUID()): string {
  const clean = uuid.trim();
  if (!clean) throw new Error('Repository restore UUID is required');
  return `repository-restore:${clean}`;
}

export function createDeterministicRepositoryVerificationId(uuid: string = randomUUID()): string {
  const clean = uuid.trim();
  if (!clean) throw new Error('Deterministic verification UUID is required');
  return `deterministic-verification:${clean}`;
}

export function repositoryRestoreEvidenceHash(input: Omit<RepositoryRestorePreconditions, 'evidenceHash'>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
