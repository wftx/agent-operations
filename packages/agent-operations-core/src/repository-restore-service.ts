import type {
  AgentOperationsStateStore,
  DurableRepositoryRestoreAction,
  RepositoryPreservedPathEvidence,
  RepositoryRestoreAdapter,
  RepositoryRestoreInspection,
  RepositoryRestorePathPrecondition,
  RepositoryRestoreExecutionReceipt,
} from '../../agent-operations-contracts/src/index.js';
import {
  REPOSITORY_RESTORE_TRACKED_PATHS_OPERATION,
  createRepositoryRestoreActionId,
  repositoryRestoreEvidenceHash,
} from '../../agent-operations-contracts/src/index.js';
import { isActiveRepositoryWorkspace } from './repository-workspace-service.js';

export class RepositoryRestoreService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly adapter: RepositoryRestoreAdapter,
    options: { readonly now?: () => Date; readonly idFactory?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => createRepositoryRestoreActionId());
  }

  async prepare(input: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly checkoutBindingId: string;
    readonly restorePaths: readonly string[];
    readonly preserveUntrackedPaths?: readonly string[];
    readonly requestedBy: string;
    readonly expectedBranch?: string;
    readonly expectedHead?: string;
  }): Promise<DurableRepositoryRestoreAction> {
    const project = await this.store.getProject(input.projectId);
    const repository = await this.store.getRepository(input.repositoryId);
    const installation = await this.store.getInstallation();
    const binding = (await this.store.listCheckoutBindings(input.repositoryId)).find(candidate =>
      candidate.id === input.checkoutBindingId && candidate.installationId === installation.id);
    if (!project || !repository || !binding
      || !(await this.store.listProjectRepositoryIds(project.id)).includes(repository.id)) {
      throw new Error('Selective restore Project, repository, and checkout association is invalid');
    }
    const conflict = (await this.store.listRepositoryWorkspaces()).find(workspace =>
      workspace.repositoryId === repository.id && isActiveRepositoryWorkspace(workspace));
    if (conflict) {
      throw new Error(`Selective restore is blocked by active same repository workspace ${conflict.id}`);
    }
    const inspection = await this.adapter.inspect(binding.canonicalPath);
    validateInspection(inspection, repository.id, binding.canonicalPath, input.expectedBranch, input.expectedHead);
    const restorePaths = uniquePaths(input.restorePaths, 'Restore paths');
    const preservePaths = uniquePaths(input.preserveUntrackedPaths ?? [], 'Preserved paths', true);
    if (restorePaths.some(path => preservePaths.includes(path))) {
      throw new Error('A selective restore path cannot also be preserved');
    }
    const pathPreconditions: RepositoryRestorePathPrecondition[] = [];
    for (const path of restorePaths) {
      const status = inspection.statusEntries.find(entry => entry.path === path);
      if (!status || status.worktreeStatus === 'untracked' || status.indexStatus === 'untracked') {
        throw new Error(`Selective restore target is not a changed tracked path: ${path}`);
      }
      const headSha256 = await this.adapter.sha256ForHeadFile(binding.canonicalPath, inspection.headRevision, path);
      if (!headSha256) throw new Error(`Selective restore target is not tracked at HEAD: ${path}`);
      const workingTreeSha256 = await this.adapter.sha256ForWorkingTreeFile(binding.canonicalPath, path);
      pathPreconditions.push({
        path,
        indexStatus: status.indexStatus,
        worktreeStatus: status.worktreeStatus,
        ...(workingTreeSha256 ? { workingTreeSha256 } : {}),
        headSha256,
      });
    }
    const preserved: RepositoryPreservedPathEvidence[] = [];
    for (const path of preservePaths) {
      const status = inspection.statusEntries.find(entry => entry.path === path);
      if (!status || status.worktreeStatus !== 'untracked') {
        throw new Error(`Preserved path is not currently untracked: ${path}`);
      }
      const sha256 = await this.adapter.sha256ForWorkingTreeFile(binding.canonicalPath, path);
      if (!sha256) throw new Error(`Preserved untracked file is unavailable: ${path}`);
      preserved.push({ path, sha256 });
    }
    const withoutHash = {
      repositoryId: repository.id,
      checkoutBindingId: binding.id,
      canonicalPath: binding.canonicalPath,
      branch: inspection.branch!,
      headRevision: inspection.headRevision,
      restorePaths: pathPreconditions,
      preserveUntrackedPaths: preserved,
      statusEntries: inspection.statusEntries.map(entry => ({ ...entry })),
    };
    const action: DurableRepositoryRestoreAction = {
      id: this.idFactory(),
      projectId: project.id,
      repositoryId: repository.id,
      checkoutBindingId: binding.id,
      state: 'pending-approval',
      preconditions: { ...withoutHash, evidenceHash: repositoryRestoreEvidenceHash(withoutHash) },
      approvalSummary: `Discard uncommitted tracked changes in ${restorePaths.join(', ')}. Preserve ${preservePaths.join(', ') || 'all unrelated paths'}. No commit, push, deploy, clean, reset, or untracked file deletion.`,
      requestedBy: required(input.requestedBy, 'Requested by'),
      createdAt: this.now().toISOString(),
      revision: 0,
    };
    await this.store.createRepositoryRestoreAction(action);
    return action;
  }

  async approveAndExecute(id: string, approvedBy: string): Promise<DurableRepositoryRestoreAction> {
    let action = await this.requireAction(id);
    if (action.state === 'completed') return action;
    if (action.state !== 'pending-approval') {
      throw new Error(`Repository Restore ${action.id} is ${action.state}, not pending approval`);
    }
    const inspection = await this.adapter.inspect(action.preconditions.canonicalPath);
    if (!await matchesPreconditions(action, inspection, this.adapter)) {
      await this.store.saveRepositoryRestoreActionTransition({
        ...action,
        state: 'rejected',
        failureReason: undefined,
        revision: action.revision + 1,
      }, action.revision);
      throw new Error('Repository state changed after the restore request. Fresh approval is required.');
    }
    const approvedAt = this.now().toISOString();
    action = {
      ...action,
      state: 'approved',
      approvedAt,
      approvedBy: required(approvedBy, 'Approved by'),
      revision: action.revision + 1,
    };
    await this.store.saveRepositoryRestoreActionTransition(action, action.revision - 1);
    let executedAt: string | undefined;
    try {
      const stillCurrent = await this.adapter.inspect(action.preconditions.canonicalPath);
      if (!await matchesPreconditions(action, stillCurrent, this.adapter)) {
        throw new Error('Repository state changed after approval and before execution');
      }
      executedAt = this.now().toISOString();
      await this.adapter.restoreTrackedPaths(
        action.preconditions.canonicalPath,
        action.preconditions.headRevision,
        action.preconditions.restorePaths.map(item => item.path),
      );
      const after = await this.adapter.inspect(action.preconditions.canonicalPath);
      await verifyAfter(action, after, this.adapter);
      const completedAt = this.now().toISOString();
      const receipt = await buildReceipt(
        action, after, this.adapter, executedAt, completedAt, 'captured-during-execution', 'passed',
      );
      await this.store.createRepositoryRestoreExecutionReceipt(receipt);
      const completed: DurableRepositoryRestoreAction = {
        ...action,
        state: 'completed',
        result: {
          beforeEvidenceHash: action.preconditions.evidenceHash,
          afterEvidenceHash: after.evidenceHash,
          restoredPaths: action.preconditions.restorePaths.map(item => item.path),
          preservedUntrackedPaths: action.preconditions.preserveUntrackedPaths.map(item => ({ ...item })),
          completedAt,
        },
        revision: action.revision + 1,
      };
      await this.store.saveRepositoryRestoreActionTransition(completed, action.revision);
      return completed;
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      if (executedAt) {
        try {
          const after = await this.adapter.inspect(action.preconditions.canonicalPath);
          const receipt = await buildReceipt(
            action, after, this.adapter, executedAt, this.now().toISOString(),
            'captured-during-execution', 'partial', failureReason,
          );
          await this.store.createRepositoryRestoreExecutionReceipt(receipt);
        } catch {
          // A failed adapter may make bounded after evidence unavailable. The action still records failure truthfully.
        }
      }
      const failed: DurableRepositoryRestoreAction = {
        ...action,
        state: 'failed',
        failureReason,
        revision: action.revision + 1,
      };
      await this.store.saveRepositoryRestoreActionTransition(failed, action.revision);
      throw error;
    }
  }

  async getExecutionReceipt(id: string): Promise<RepositoryRestoreExecutionReceipt | null> {
    return this.store.getRepositoryRestoreExecutionReceipt(id.trim());
  }

  /** Reconstructs an immutable receipt for a completed pre-receipt action from exact current evidence. */
  async reconcileCompletedExecutionReceipt(id: string): Promise<RepositoryRestoreExecutionReceipt> {
    const existing = await this.store.getRepositoryRestoreExecutionReceipt(id.trim());
    if (existing) return existing;
    const action = await this.requireAction(id);
    if (action.state !== 'completed' || !action.result || !action.approvedAt || !action.approvedBy) {
      throw new Error(`Repository Restore ${action.id} is not eligible for receipt reconciliation`);
    }
    const after = await this.adapter.inspect(action.preconditions.canonicalPath);
    await verifyAfter(action, after, this.adapter);
    if (after.evidenceHash !== action.result.afterEvidenceHash) {
      throw new Error('Current repository evidence no longer matches the completed restore result');
    }
    const receipt = await buildReceipt(
      action,
      after,
      this.adapter,
      action.result.completedAt,
      this.now().toISOString(),
      'reconciled-from-completed-action',
      'passed',
    );
    await this.store.createRepositoryRestoreExecutionReceipt(receipt);
    return receipt;
  }

  private async requireAction(id: string): Promise<DurableRepositoryRestoreAction> {
    const action = await this.store.getRepositoryRestoreAction(id.trim());
    if (!action) throw new Error(`Repository Restore action not found: ${id}`);
    return action;
  }
}

async function buildReceipt(
  action: DurableRepositoryRestoreAction,
  after: RepositoryRestoreInspection,
  adapter: RepositoryRestoreAdapter,
  executedAt: string,
  recordedAt: string,
  evidenceSource: RepositoryRestoreExecutionReceipt['evidenceSource'],
  verificationResult: RepositoryRestoreExecutionReceipt['verificationResult'],
  failureReason?: string,
): Promise<RepositoryRestoreExecutionReceipt> {
  if (!action.approvedAt || !action.approvedBy) throw new Error('Approved restore identity is unavailable');
  const restoredFileHashesAfter = await Promise.all(action.preconditions.restorePaths.map(async item => {
    const sha256 = await adapter.sha256ForWorkingTreeFile(action.preconditions.canonicalPath, item.path);
    if (!sha256) throw new Error(`Restored path hash is unavailable: ${item.path}`);
    return { path: item.path, sha256 };
  }));
  const preservedUntrackedFileHashesAfter = await Promise.all(
    action.preconditions.preserveUntrackedPaths.map(async item => {
      const sha256 = await adapter.sha256ForWorkingTreeFile(action.preconditions.canonicalPath, item.path);
      if (!sha256) throw new Error(`Preserved path hash is unavailable: ${item.path}`);
      return { path: item.path, sha256 };
    }),
  );
  return {
    actionId: action.id,
    operation: REPOSITORY_RESTORE_TRACKED_PATHS_OPERATION,
    projectId: action.projectId,
    repositoryId: action.repositoryId,
    checkoutBindingId: action.checkoutBindingId,
    approvedPaths: action.preconditions.restorePaths.map(item => item.path),
    approvedBy: action.approvedBy,
    approvedAt: action.approvedAt,
    executedAt,
    recordedAt,
    evidenceSource,
    branchBefore: action.preconditions.branch,
    branchAfter: after.branch!,
    headBefore: action.preconditions.headRevision,
    headAfter: after.headRevision,
    approvedFileHashesBefore: action.preconditions.restorePaths.map(item => ({
      path: item.path,
      sha256: item.workingTreeSha256 ?? item.headSha256,
    })),
    restoredFileHashesAfter,
    preservedUntrackedFileHashesBefore: action.preconditions.preserveUntrackedPaths.map(item => ({ ...item })),
    preservedUntrackedFileHashesAfter,
    finalStatus: after.statusEntries.map(item => ({ ...item })),
    beforeEvidenceHash: action.preconditions.evidenceHash,
    afterEvidenceHash: after.evidenceHash,
    commitPerformed: false,
    pushPerformed: false,
    deployPerformed: false,
    verificationResult,
    ...(failureReason ? { failureReason } : {}),
  };
}

function validateInspection(
  inspection: RepositoryRestoreInspection,
  repositoryId: string,
  canonicalPath: string,
  expectedBranch?: string,
  expectedHead?: string,
): void {
  if (inspection.repositoryId !== repositoryId || inspection.canonicalPath !== canonicalPath
    || inspection.detachedHead || !inspection.branch) {
    throw new Error('Selective restore repository identity, root, or branch is unavailable');
  }
  if (expectedBranch && inspection.branch !== expectedBranch) throw new Error('Selective restore branch changed');
  if (expectedHead && inspection.headRevision !== expectedHead.toLowerCase()) throw new Error('Selective restore HEAD changed');
}

async function matchesPreconditions(
  action: DurableRepositoryRestoreAction,
  inspection: RepositoryRestoreInspection,
  adapter: RepositoryRestoreAdapter,
): Promise<boolean> {
  const expected = action.preconditions;
  const withoutHash = {
    repositoryId: inspection.repositoryId,
    checkoutBindingId: action.checkoutBindingId,
    canonicalPath: inspection.canonicalPath,
    branch: inspection.branch!,
    headRevision: inspection.headRevision,
    restorePaths: expected.restorePaths,
    preserveUntrackedPaths: expected.preserveUntrackedPaths,
    statusEntries: inspection.statusEntries,
  };
  const identityMatches = inspection.repositoryId === expected.repositoryId
    && inspection.canonicalPath === expected.canonicalPath
    && inspection.branch === expected.branch
    && inspection.headRevision === expected.headRevision
    && repositoryRestoreEvidenceHash(withoutHash) === expected.evidenceHash;
  if (!identityMatches) return false;
  for (const path of expected.restorePaths) {
    const current = await adapter.sha256ForWorkingTreeFile(expected.canonicalPath, path.path);
    if (current !== (path.workingTreeSha256 ?? null)) return false;
  }
  for (const path of expected.preserveUntrackedPaths) {
    if (await adapter.sha256ForWorkingTreeFile(expected.canonicalPath, path.path) !== path.sha256) return false;
  }
  return true;
}

async function verifyAfter(
  action: DurableRepositoryRestoreAction,
  inspection: RepositoryRestoreInspection,
  adapter: RepositoryRestoreAdapter,
): Promise<void> {
  const expected = action.preconditions;
  if (inspection.repositoryId !== expected.repositoryId || inspection.canonicalPath !== expected.canonicalPath
    || inspection.branch !== expected.branch || inspection.headRevision !== expected.headRevision) {
    throw new Error('Selective restore changed repository identity, branch, or HEAD');
  }
  const restored = new Set(expected.restorePaths.map(item => item.path));
  const expectedRemaining = expected.statusEntries.filter(item => !restored.has(item.path));
  if (JSON.stringify(inspection.statusEntries) !== JSON.stringify(expectedRemaining)) {
    throw new Error('Selective restore changed paths outside the exact approval');
  }
  for (const path of expected.restorePaths) {
    const actual = await adapter.sha256ForWorkingTreeFile(expected.canonicalPath, path.path);
    if (actual !== path.headSha256) throw new Error(`Restored path does not match approved HEAD: ${path.path}`);
  }
  for (const path of expected.preserveUntrackedPaths) {
    const actual = await adapter.sha256ForWorkingTreeFile(expected.canonicalPath, path.path);
    if (actual !== path.sha256) throw new Error(`Preserved untracked path changed: ${path.path}`);
  }
}

function uniquePaths(values: readonly string[], field: string, allowEmpty = false): readonly string[] {
  const paths = values.map(value => value.trim());
  if ((!allowEmpty && paths.length === 0) || paths.some(path => !path)) throw new Error(`${field} are required`);
  if (new Set(paths).size !== paths.length) throw new Error(`${field} must be unique`);
  return paths;
}

function required(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  return clean;
}
