import { join, resolve } from 'node:path';
import type {
  AgentOperationsStateStore,
  DurableJob,
  DurableRepositoryWorkspace,
  RepositoryInventoryAdapter,
  RepositoryWorkspaceAdapter,
  WorkspaceTestResult,
} from '../../agent-operations-contracts/src/index.js';
import { createRepositoryWorkspaceId, executionModeForJob } from '../../agent-operations-contracts/src/index.js';

export interface RepositoryWorkspaceServiceOptions {
  readonly stateDirectory: string;
  readonly now?: () => Date;
}

/** Owns durable preparation and recovery of one isolated worktree per write Job. */
export class RepositoryWorkspaceService {
  private readonly workspaceRoot: string;
  private readonly now: () => Date;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly repositories: RepositoryInventoryAdapter,
    private readonly workspaces: RepositoryWorkspaceAdapter,
    options: RepositoryWorkspaceServiceOptions,
  ) {
    this.workspaceRoot = resolve(options.stateDirectory, 'workspaces');
    this.now = options.now ?? (() => new Date());
  }

  async prepareForJob(jobId: string): Promise<DurableRepositoryWorkspace> {
    const job = await this.requireWriteJob(jobId);
    const existing = await this.store.getRepositoryWorkspaceForJob(job.id);
    if (existing) return this.recover(existing);
    const occupied = (await this.store.listRepositoryWorkspaces()).find(candidate =>
      candidate.jobId !== job.id
      && ['preparing', 'active', 'reviewing', 'ready_for_approval'].includes(candidate.state));
    if (occupied) {
      throw new Error(`Write Job ${occupied.jobId} already owns the active isolated workspace slot`);
    }
    const installation = await this.store.getInstallation();
    const bindings = (await this.store.listCheckoutBindings(job.repositoryId))
      .filter(binding => binding.installationId === installation.id);
    if (bindings.length !== 1) {
      throw new Error(`Write Job ${job.id} requires exactly one configured local checkout`);
    }
    const source = await this.repositories.inspectRepository(bindings[0].canonicalPath);
    if (source.availability !== 'available' || source.id !== job.repositoryId
      || !source.repositoryRoot || !source.headCommit) {
      throw new Error(`Write Job ${job.id} source checkout identity and HEAD must be available`);
    }
    const slug = job.id.slice('job:'.length).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const timestamp = this.now().toISOString();
    const workspace: DurableRepositoryWorkspace = {
      id: createRepositoryWorkspaceId(job.id),
      jobId: job.id,
      projectId: job.projectId,
      repositoryId: job.repositoryId,
      sourceCheckoutBindingId: bindings[0].id,
      baseRevision: source.headCommit,
      ...(source.branch ? { baseBranch: source.branch } : {}),
      branchName: `ao/job-${slug}`,
      canonicalPath: join(this.workspaceRoot, slug),
      state: 'preparing',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.createRepositoryWorkspace(workspace);
    return this.recover(workspace);
  }

  async captureEvidence(
    workspaceId: string,
    testResults: readonly WorkspaceTestResult[] = [],
  ): Promise<DurableRepositoryWorkspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    if (workspace.state !== 'active') {
      throw new Error(`Repository Workspace ${workspace.id} is ${workspace.state}, not active`);
    }
    const captured = await this.workspaces.captureEvidence(workspace.canonicalPath);
    return this.transition(workspace, {
      state: 'reviewing',
      evidence: {
        ...captured,
        testResults: testResults.map(result => ({ ...result })),
        capturedAt: this.now().toISOString(),
      },
    });
  }

  async cancel(workspaceId: string): Promise<DurableRepositoryWorkspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    if (!['preparing', 'active', 'reviewing', 'ready_for_approval'].includes(workspace.state)) {
      throw new Error(`Repository Workspace ${workspace.id} cannot be cancelled from ${workspace.state}`);
    }
    return this.transition(workspace, { state: 'cancelled' });
  }

  async requestCleanup(workspaceId: string): Promise<DurableRepositoryWorkspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    if (!['reviewing', 'ready_for_approval', 'failed', 'cancelled'].includes(workspace.state)) {
      throw new Error(`Repository Workspace ${workspace.id} cannot request cleanup from ${workspace.state}`);
    }
    return this.transition(workspace, { state: 'cleanup_pending' });
  }

  async reopenForRevision(workspaceId: string): Promise<DurableRepositoryWorkspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    if (!['reviewing', 'ready_for_approval'].includes(workspace.state)) {
      throw new Error(`Repository Workspace ${workspace.id} is ${workspace.state}, not reviewable`);
    }
    const { evidence: _evidence, failureReason: _failureReason, ...identity } = workspace;
    const next: DurableRepositoryWorkspace = {
      ...identity,
      state: 'active',
      revision: workspace.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    await this.store.saveRepositoryWorkspaceTransition(next, workspace.revision);
    return next;
  }

  async markReadyForApproval(workspaceId: string): Promise<DurableRepositoryWorkspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    if (workspace.state !== 'reviewing' || !workspace.evidence) {
      throw new Error(`Repository Workspace ${workspace.id} has no reviewed evidence`);
    }
    return this.transition(workspace, { state: 'ready_for_approval', evidence: workspace.evidence });
  }

  async cleanup(workspaceId: string): Promise<DurableRepositoryWorkspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    if (workspace.state !== 'cleanup_pending') {
      throw new Error(`Repository Workspace ${workspace.id} is ${workspace.state}, not cleanup pending`);
    }
    const input = {
      sourceCheckoutPath: await this.bindingPath(workspace.sourceCheckoutBindingId),
      destinationPath: workspace.canonicalPath,
      repositoryId: workspace.repositoryId,
      baseRevision: workspace.baseRevision,
      branchName: workspace.branchName,
    };
    const result = await this.workspaces.removeWorkspace(input);
    if (result.exists || result.registered) {
      return this.transition(workspace, {
        state: 'failed',
        failureReason: result.reason ?? 'Repository Workspace cleanup could not be proven.',
      });
    }
    return this.transition(workspace, { state: 'cleaned' });
  }

  private async recover(workspace: DurableRepositoryWorkspace): Promise<DurableRepositoryWorkspace> {
    if (!['preparing', 'active', 'reviewing', 'ready_for_approval'].includes(workspace.state)) {
      return workspace;
    }
    const input = {
      sourceCheckoutPath: (await this.bindingPath(workspace.sourceCheckoutBindingId)),
      destinationPath: workspace.canonicalPath,
      repositoryId: workspace.repositoryId,
      baseRevision: workspace.baseRevision,
      branchName: workspace.branchName,
    };
    const inspection = await this.workspaces.inspectWorkspace(input);
    const result = inspection.exists
      ? await this.workspaces.createWorkspace(input)
      : workspace.state === 'preparing'
        ? await this.workspaces.createWorkspace(input)
        : inspection;
    const valid = result.exists && result.registered
      && result.canonicalPath === workspace.canonicalPath
      && result.repositoryId === workspace.repositoryId
      && result.branchName === workspace.branchName
      && result.headRevision === workspace.baseRevision
      && !result.reason;
    if (valid) {
      return workspace.state === 'preparing'
        ? this.transition(workspace, { state: 'active' })
        : workspace;
    }
    return this.transition(workspace, {
      state: 'failed',
      failureReason: result.reason ?? 'Repository Workspace preparation or recovery could not be proven.',
    });
  }

  private async transition(
    workspace: DurableRepositoryWorkspace,
    change: Pick<DurableRepositoryWorkspace, 'state'>
      & Partial<Pick<DurableRepositoryWorkspace, 'evidence' | 'failureReason'>>,
  ): Promise<DurableRepositoryWorkspace> {
    const { failureReason: _failureReason, ...withoutFailure } = workspace;
    const next: DurableRepositoryWorkspace = {
      ...withoutFailure,
      ...change,
      revision: workspace.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    await this.store.saveRepositoryWorkspaceTransition(next, workspace.revision);
    return next;
  }

  private async requireWriteJob(jobId: string): Promise<DurableJob & { repositoryId: string }> {
    const job = await this.store.getJob(jobId.trim());
    if (!job || executionModeForJob(job) !== 'repository-write-isolated'
      || !job.repositoryId || job.status !== 'ready') {
      throw new Error(`Job ${jobId} is not a ready repository write Job`);
    }
    return job as DurableJob & { repositoryId: string };
  }

  private async requireWorkspace(id: string): Promise<DurableRepositoryWorkspace> {
    const workspace = await this.store.getRepositoryWorkspace(id.trim());
    if (!workspace) throw new Error(`Repository Workspace not found: ${id}`);
    return workspace;
  }

  private async bindingPath(id: string): Promise<string> {
    const binding = (await this.store.listCheckoutBindings()).find(candidate => candidate.id === id);
    if (!binding) throw new Error(`Repository Workspace source checkout is unavailable: ${id}`);
    return binding.canonicalPath;
  }
}
