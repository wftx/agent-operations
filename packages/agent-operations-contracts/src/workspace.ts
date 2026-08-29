import { createHash } from 'node:crypto';

export const REPOSITORY_WORKSPACE_STATES = [
  'preparing',
  'active',
  'reviewing',
  'ready_for_approval',
  'failed',
  'cancelled',
  'cleanup_pending',
  'cleaned',
] as const;
export type RepositoryWorkspaceState = (typeof REPOSITORY_WORKSPACE_STATES)[number];

export interface WorkspaceTestResult {
  readonly commandId: string;
  readonly command: string;
  readonly status: 'passed' | 'failed';
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly occurredAt: string;
}

export interface WorkspaceBinaryFileEvidence {
  readonly path: string;
  readonly gitStatus: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface RepositoryWorkspaceEvidence {
  readonly changedFiles: readonly string[];
  readonly binaryFiles?: readonly WorkspaceBinaryFileEvidence[];
  readonly diffStat: string;
  readonly diffText: string;
  readonly diffTruncated: boolean;
  readonly testResults: readonly WorkspaceTestResult[];
  readonly capturedAt: string;
}

/** Machine-local durable ownership of one isolated Git worktree for one Job. */
export interface DurableRepositoryWorkspace {
  readonly id: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly sourceCheckoutBindingId: string;
  readonly baseRevision: string;
  readonly baseBranch?: string;
  readonly branchName: string;
  readonly canonicalPath: string;
  readonly state: RepositoryWorkspaceState;
  readonly evidence?: RepositoryWorkspaceEvidence;
  readonly failureReason?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RepositoryWorkspacePreparation {
  readonly sourceCheckoutPath: string;
  readonly destinationPath: string;
  readonly repositoryId: string;
  readonly baseRevision: string;
  readonly branchName: string;
}

export interface RepositoryWorkspaceInspection {
  readonly exists: boolean;
  readonly registered: boolean;
  readonly canonicalPath?: string;
  readonly repositoryId?: string;
  readonly branchName?: string;
  readonly headRevision?: string;
  readonly reason?: string;
}

/** Git mutation is confined to isolated worktree preparation and evidence capture. */
export interface RepositoryWorkspaceAdapter {
  createWorkspace(input: RepositoryWorkspacePreparation): Promise<RepositoryWorkspaceInspection>;
  inspectWorkspace(input: RepositoryWorkspacePreparation): Promise<RepositoryWorkspaceInspection>;
  captureEvidence(canonicalPath: string): Promise<Omit<RepositoryWorkspaceEvidence, 'testResults' | 'capturedAt'>>;
  removeWorkspace(input: RepositoryWorkspacePreparation): Promise<RepositoryWorkspaceInspection>;
}

export function createRepositoryWorkspaceId(jobId: string): string {
  const clean = jobId.trim();
  if (!clean) throw new Error('Job ID is required for Repository Workspace identity');
  return `workspace:${createHash('sha256').update(clean).digest('hex')}`;
}
