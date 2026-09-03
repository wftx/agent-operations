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

export function repositoryRestoreEvidenceHash(input: Omit<RepositoryRestorePreconditions, 'evidenceHash'>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
