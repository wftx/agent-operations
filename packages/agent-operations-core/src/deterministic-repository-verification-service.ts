import type {
  AgentOperationsStateStore,
  DurableDeterministicRepositoryVerification,
  RepositoryFileHashEvidence,
  RepositoryRestoreAdapter,
} from '../../agent-operations-contracts/src/index.js';
import { createDeterministicRepositoryVerificationId } from '../../agent-operations-contracts/src/index.js';
import { JobLifecycleService } from './job-lifecycle-service.js';

export interface DeterministicRepositoryVerificationInput {
  readonly jobId: string;
  readonly actionId: string;
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly cleanPaths: readonly string[];
  readonly preservedUntrackedFiles: readonly RepositoryFileHashEvidence[];
  readonly requireExactStatus?: boolean;
  readonly verifiedBy: string;
}

/** Exact repository verification. It has no runtime, provider, or dispatch dependency. */
export class DeterministicRepositoryVerificationService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly lifecycle: JobLifecycleService;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly adapter: RepositoryRestoreAdapter,
    options: { readonly now?: () => Date; readonly idFactory?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => createDeterministicRepositoryVerificationId());
    this.lifecycle = new JobLifecycleService(store, { now: this.now });
  }

  async verifyAndComplete(
    input: DeterministicRepositoryVerificationInput,
  ): Promise<DurableDeterministicRepositoryVerification> {
    const existing = await this.store.getDeterministicRepositoryVerification(input.jobId);
    if (existing) {
      if (existing.result === 'passed') await this.finishDurableState(existing.jobId, existing.summary);
      return existing;
    }
    const job = await this.store.getJob(required(input.jobId, 'Job ID'));
    const action = await this.store.getRepositoryRestoreAction(required(input.actionId, 'Red action ID'));
    const receipt = await this.store.getRepositoryRestoreExecutionReceipt(input.actionId);
    if (!job || job.status !== 'ready') throw new Error(`Deterministic verification Job is not ready: ${input.jobId}`);
    if (!action || action.state !== 'completed' || !receipt || receipt.verificationResult !== 'passed') {
      throw new Error(`A passed immutable Red action receipt is required: ${input.actionId}`);
    }
    if (job.projectId !== action.projectId || job.repositoryId !== action.repositoryId
      || receipt.checkoutBindingId !== action.checkoutBindingId) {
      throw new Error('Deterministic verification Job and Red action associations do not match');
    }
    const attempts = await this.store.listAttemptsForJob(job.id);
    if (attempts.length > 0) {
      throw new Error('Deterministic verification cannot replace or overlap provider Attempts');
    }
    const branch = required(input.expectedBranch, 'Expected branch');
    const head = required(input.expectedHead, 'Expected HEAD').toLowerCase();
    const cleanPaths = unique(input.cleanPaths, 'Clean paths');
    const preserved = [...input.preservedUntrackedFiles].map(item => ({
      path: required(item.path, 'Preserved path'), sha256: requiredHash(item.sha256),
    }));
    if (new Set(preserved.map(item => item.path)).size !== preserved.length) {
      throw new Error('Preserved untracked paths must be unique');
    }
    const inspection = await this.adapter.inspect(action.preconditions.canonicalPath);
    const failures: string[] = [];
    if (inspection.repositoryId !== job.repositoryId) failures.push('repository identity changed');
    if (inspection.branch !== branch) failures.push(`branch is ${inspection.branch ?? 'detached'}, expected ${branch}`);
    if (inspection.headRevision !== head) failures.push(`HEAD is ${inspection.headRevision}, expected ${head}`);
    if (receipt.branchAfter !== branch || receipt.headAfter !== head) failures.push('receipt branch or HEAD differs');
    const byPath = new Map(inspection.statusEntries.map(item => [item.path, item]));
    for (const path of cleanPaths) if (byPath.has(path)) failures.push(`${path} is not clean`);
    for (const item of preserved) {
      const status = byPath.get(item.path);
      if (!status || status.worktreeStatus !== 'untracked') failures.push(`${item.path} is not untracked`);
      const actual = await this.adapter.sha256ForWorkingTreeFile(action.preconditions.canonicalPath, item.path);
      if (actual !== item.sha256) failures.push(`${item.path} hash differs`);
    }
    if (input.requireExactStatus) {
      const expectedPaths = [...preserved.map(item => item.path)].sort();
      const actualPaths = [...inspection.statusEntries.map(item => item.path)].sort();
      if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) failures.push('working tree has other changes');
    }
    const passed = failures.length === 0;
    const summary = passed
      ? `Verified ${branch} at ${head}. ${cleanPaths.join(', ')} are clean. ${preserved.length} preserved file(s) remain untracked with exact hashes. The approved Red action performed no commit, push, or deploy.`
      : `Deterministic repository verification failed: ${failures.join('; ')}.`;
    const verification: DurableDeterministicRepositoryVerification = {
      id: this.idFactory(),
      jobId: job.id,
      actionId: action.id,
      projectId: job.projectId,
      repositoryId: action.repositoryId,
      checkoutBindingId: action.checkoutBindingId,
      verifiedAt: this.now().toISOString(),
      verifiedBy: required(input.verifiedBy, 'Verified by'),
      branch: inspection.branch ?? 'detached',
      headRevision: inspection.headRevision,
      statusEntries: inspection.statusEntries.map(item => ({ ...item })),
      cleanPaths,
      preservedUntrackedFiles: preserved,
      commitPerformed: false,
      pushPerformed: false,
      deployPerformed: false,
      providerRuntimeRequired: false,
      providerSubmissionsCreated: 0,
      result: passed ? 'passed' : 'failed',
      summary,
    };
    await this.store.createDeterministicRepositoryVerification(verification);
    if (!passed) return verification;
    await this.finishDurableState(job.id, summary);
    return verification;
  }

  private async finishDurableState(jobId: string, summary: string): Promise<void> {
    const job = await this.store.getJob(jobId);
    if (job?.status === 'ready') await this.lifecycle.completeJob(jobId);
    const timestamp = this.now().toISOString();
    for (const escalation of await this.store.listEscalations(jobId, true)) {
      await this.store.resolveEscalation(escalation.id, timestamp, summary);
    }
    const run = await this.store.getOperatorRunForJob(jobId);
    if (run?.status === 'needs_human') {
      await this.store.saveOperatorRunTransition({
        ...run,
        status: 'completed',
        failureMessage: undefined,
        finishedAt: timestamp,
        updatedAt: timestamp,
        revision: run.revision + 1,
      }, run.revision);
    }
  }
}

function required(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  return clean;
}

function requiredHash(value: string): string {
  const clean = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(clean)) throw new Error('SHA-256 hash is required');
  return clean;
}

function unique(values: readonly string[], field: string): readonly string[] {
  const cleaned = values.map(value => required(value, field));
  if (!cleaned.length || new Set(cleaned).size !== cleaned.length) throw new Error(`${field} must be nonempty and unique`);
  return cleaned;
}
