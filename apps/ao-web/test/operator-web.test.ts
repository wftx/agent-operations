import { describe, expect, it } from 'vitest';
import type {
  OperatorApplication,
  OperatorJobDetail,
  OperatorJobList,
  OperatorJobSummary,
  OperatorProjectOption,
  OperatorRunSession,
  OperatorTaskInput,
  OperatorTaskPreview,
  RuntimeStartResult,
  PreviewApplication,
  TrustProfileApplication,
} from '../../../packages/agent-operations-application/src/index.js';
import {
  OPERATOR_ISOLATED_WRITE_DEFAULTS,
  OPERATOR_READ_ONLY_DEFAULTS,
} from '../../../packages/agent-operations-application/src/index.js';
import { OperatorWebApplication } from '../src/app.js';
import { createOperatorHttpServer } from '../src/http-server.js';

const TIME = '2026-08-27T06:00:00.000Z';
const PROJECT_ID = 'project:ao';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const JOB_ID = 'job:operator-test';

class StubOperatorApplication implements OperatorApplication {
  previewCalls = 0;
  runCalls = 0;
  guidanceCalls = 0;
  extensionCalls = 0;
  extensionGuidance: string | undefined;
  cancelCalls = 0;
  reconcileCalls = 0;
  startRuntimeCalls = 0;
  retireCalls = 0;
  restoreApprovalCalls = 0;

  constructor(private readonly runtimeReady = true) {}

  startRunner(): void {}

  async getRuntimeStatus() {
    return this.runtimeReady
      ? { state: 'ready' as const, label: 'Ready' }
      : { state: 'offline' as const, label: 'Offline', reason: 'Runtime is not running.' };
  }

  async startRuntime(): Promise<RuntimeStartResult> {
    this.startRuntimeCalls += 1;
    return {
      status: 'started',
      instanceId: 'default',
      message: 'Runtime is ready with one configured agent.',
      inventory: {
        configuredAgents: [{ id: 'agent-operations/rehearsal', provider: 'codex', enabled: true }],
        configuredCronCount: 0,
        configuredIntegrationCount: 0,
      },
      daemonPid: 123,
    };
  }

  async listProjects(): Promise<readonly OperatorProjectOption[]> {
    return [PROJECT];
  }

  async previewTask(input: OperatorTaskInput): Promise<OperatorTaskPreview> {
    this.previewCalls += 1;
    const writeMode = input.executionMode === 'repository-write-isolated';
    return {
      project: PROJECT.project,
      repository: PROJECT.repositories[0],
      runtimeAgentId: 'agent-operations/rehearsal',
      task: input.task,
      acceptanceCriteria: input.acceptanceCriteria,
      executionMode: writeMode ? 'repository-write-isolated' : 'repository-read-only',
      defaults: writeMode ? OPERATOR_ISOLATED_WRITE_DEFAULTS : OPERATOR_READ_ONLY_DEFAULTS,
      executionAuthorized: false,
    };
  }

  async runOperatorJob(): Promise<OperatorRunSession> {
    this.runCalls += 1;
    return { jobId: JOB_ID, status: 'running', startedAt: TIME };
  }

  async waitForRun(): Promise<OperatorRunSession> {
    return { jobId: JOB_ID, status: 'done', startedAt: TIME, finishedAt: TIME };
  }

  async provideGuidanceAndContinue(): Promise<OperatorRunSession> {
    this.guidanceCalls += 1;
    return { jobId: SUMMARY_ESCALATED.job.id, status: 'pending', startedAt: TIME };
  }

  async authorizeOneMoreWorkerAttempt(_escalationId: string, instruction?: string): Promise<OperatorRunSession> {
    this.extensionCalls += 1;
    this.extensionGuidance = instruction;
    return { jobId: SUMMARY_ESCALATED.job.id, status: 'pending', startedAt: TIME };
  }

  async cancelEscalatedJob(): Promise<OperatorRunSession> {
    this.cancelCalls += 1;
    return { jobId: SUMMARY_ESCALATED.job.id, status: 'cancelled', startedAt: TIME, finishedAt: TIME };
  }

  async reconcileTimedOutExecution(): Promise<OperatorRunSession> {
    this.reconcileCalls += 1;
    return { jobId: SUMMARY_ESCALATED.job.id, status: 'pending', startedAt: TIME };
  }

  async listJobs(filter: OperatorJobList = 'all'): Promise<readonly OperatorJobSummary[]> {
    if (filter === 'running') return [SUMMARY_RUNNING];
    if (filter === 'needs-human') return [SUMMARY_ESCALATED];
    if (filter === 'done') return [SUMMARY_DONE];
    return [SUMMARY_NEW, SUMMARY_RUNNING, SUMMARY_ESCALATED, SUMMARY_DONE];
  }

  async retireJob() {
    this.retireCalls += 1;
    return { jobId: JOB_ID, disposition: 'retired' as const, reason: 'Historical proof', actor: 'operator', retiredAt: TIME };
  }

  async listRepositoryRestoreActions() {
    return [{
      id: 'repository-restore:one', projectId: PROJECT_ID, repositoryId: REPOSITORY_ID,
      checkoutBindingId: 'checkout:one', state: 'pending-approval' as const,
      preconditions: {
        repositoryId: REPOSITORY_ID, checkoutBindingId: 'checkout:one', canonicalPath: '/repo',
        branch: 'main', headRevision: 'a'.repeat(40),
        restorePaths: [{ path: 'main.py', indexStatus: 'unmodified' as const, worktreeStatus: 'modified' as const, workingTreeSha256: 'b'.repeat(64), headSha256: 'c'.repeat(64) }],
        preserveUntrackedPaths: [{ path: 'PLAN.md', sha256: 'd'.repeat(64) }],
        statusEntries: [], evidenceHash: 'e'.repeat(64),
      },
      approvalSummary: 'Discard main.py and preserve PLAN.md.', requestedBy: 'operator',
      createdAt: TIME, revision: 0,
    }];
  }

  async prepareRepositoryRestore() { return (await this.listRepositoryRestoreActions())[0]; }

  async approveAndExecuteRepositoryRestore() {
    this.restoreApprovalCalls += 1;
    return { ...(await this.listRepositoryRestoreActions())[0], state: 'completed' as const,
      approvedAt: TIME, approvedBy: 'human-operator', result: { beforeEvidenceHash: 'e'.repeat(64), afterEvidenceHash: 'f'.repeat(64), restoredPaths: ['main.py'], preservedUntrackedPaths: [{ path: 'PLAN.md', sha256: 'd'.repeat(64) }], completedAt: TIME }, revision: 2 };
  }

  async getRepositoryRestoreExecutionReceipt() {
    return {
      actionId: 'repository-restore:one', operation: 'repository.restore_tracked_paths' as const,
      projectId: PROJECT_ID, repositoryId: REPOSITORY_ID, checkoutBindingId: 'checkout:one',
      approvedPaths: ['main.py'], approvedBy: 'human-operator', approvedAt: TIME,
      executedAt: TIME, recordedAt: TIME, evidenceSource: 'captured-during-execution' as const,
      branchBefore: 'main', branchAfter: 'main', headBefore: 'a'.repeat(40), headAfter: 'a'.repeat(40),
      approvedFileHashesBefore: [{ path: 'main.py', sha256: 'b'.repeat(64) }],
      restoredFileHashesAfter: [{ path: 'main.py', sha256: 'c'.repeat(64) }],
      preservedUntrackedFileHashesBefore: [{ path: 'PLAN.md', sha256: 'd'.repeat(64) }],
      preservedUntrackedFileHashesAfter: [{ path: 'PLAN.md', sha256: 'd'.repeat(64) }],
      finalStatus: [{ path: 'PLAN.md', indexStatus: 'unmodified' as const, worktreeStatus: 'untracked' as const }],
      beforeEvidenceHash: 'e'.repeat(64), afterEvidenceHash: 'f'.repeat(64),
      commitPerformed: false as const, pushPerformed: false as const, deployPerformed: false as const,
      verificationResult: 'passed' as const,
    };
  }

  async getJobDetail(jobId: string): Promise<OperatorJobDetail> {
    if (jobId === SUMMARY_ESCALATED.job.id) return ESCALATED_DETAIL;
    return DETAIL;
  }
}

describe('OperatorWebApplication', () => {
  it('renders exact Red approvals and binds execution to the selected action', async () => {
    const service = new StubOperatorApplication();
    const app = new OperatorWebApplication(service);
    const page = await app.handle(new Request('http://127.0.0.1/approvals'));
    const body = await page.text();
    expect(body).toContain('Selective tracked file restore');
    expect(body).toContain('main.py');
    expect(body).toContain('PLAN.md');
    expect(body).toContain('Approve Exact Restore');
    expect(service.restoreApprovalCalls).toBe(0);

    const response = await app.handle(new Request('http://127.0.0.1/repository-restores/repository-restore%3Aone/approve', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ approvedBy: 'human-operator' }),
    }));
    expect(response.status).toBe(303);
    expect(service.restoreApprovalCalls).toBe(1);

    const detail = await app.handle(new Request('http://127.0.0.1/repository-restores/repository-restore%3Aone'));
    const detailBody = await detail.text();
    expect(detailBody).toContain('Immutable execution receipt');
    expect(detailBody).toContain('main.py');
    expect(detailBody).toContain('PLAN.md');
    expect(detailBody).toContain('Commit');
    expect(detailBody).toContain('no');
  });

  it('renders Jobs, Running, Needs Me, Done, and detail from read-only GETs', async () => {
    const service = new StubOperatorApplication();
    const app = new OperatorWebApplication(service);

    const pages = await Promise.all([
      app.handle(new Request('http://127.0.0.1/')),
      app.handle(new Request('http://127.0.0.1/running')),
      app.handle(new Request('http://127.0.0.1/needs-me')),
      app.handle(new Request('http://127.0.0.1/done')),
      app.handle(new Request(`http://127.0.0.1/jobs/${encodeURIComponent(JOB_ID)}`)),
    ]);
    const bodies = await Promise.all(pages.map(page => page.text()));

    expect(bodies[0]).toContain('What should Agent Operations do?');
    expect(bodies[0]).toContain('Runtime');
    expect(bodies[0]).toContain('Ready');
    expect(bodies[0]).toContain('Done Today');
    expect(bodies[0]).toContain('New Job');
    expect(bodies[1]).toContain('Reviewer running');
    expect(bodies[2]).toContain('What happened');
    expect(bodies[2]).toContain('Choose whether to revise the task.');
    expect(bodies[2]).toContain('Clarify the intended source boundary.');
    expect(bodies[2]).toContain('Provide Guidance + Continue');
    expect(bodies[2]).toContain('Cancel Job');
    expect(bodies[3]).toContain('Final answer: PASS / REVISION_REQUIRED / ESCALATE');
    expect(bodies[3]).toContain('All acceptance criteria are satisfied.');
    expect(bodies[3]).toContain('2 Worker executions');
    expect(bodies[3]).toContain('2 historical Attempts');
    expect(bodies[4]).toContain('2 of 2 automatic slots consumed');
    expect(bodies[4]).toContain('Historical Worker Attempt 1');
    expect(bodies[4]).toContain('REVISION_REQUIRED');
    expect(bodies[4]).toContain('Historical Worker Attempt 2');
    expect(bodies[4]).toContain('PASS');
    const escalationDetail = await app.handle(new Request(`http://127.0.0.1/jobs/${encodeURIComponent(SUMMARY_ESCALATED.job.id)}`));
    expect(await escalationDetail.text()).toContain('Choose whether to revise the task.');
    expect(service.previewCalls).toBe(0);
    expect(service.runCalls).toBe(0);
    expect(service.startRuntimeCalls).toBe(0);
  });

  it('shows and updates bounded Trust Profile presets only through explicit POST', async () => {
    const saved: unknown[] = [];
    const conservative = {
      readOnlyJobsAutoRun: false, isolatedWriteJobsAutoRun: false,
      maxGreenWorkerExecutions: 2, maxYellowWorkerExecutions: 2,
      maxGreenReviewerCycles: 2, maxYellowReviewerCycles: 2,
      validatedPreviewsAutoStart: false, authenticatedPreviewsAllowed: false,
      staleRuntimeAutoRestart: false, buildsAndTestsAllowed: true,
      assetTransformationsAllowed: false, redActionsRequireHumanApproval: true as const,
    };
    const trust: TrustProfileApplication = {
      list: async () => [],
      save: async input => {
        saved.push(input);
        return { id: 'trust-profile:global', scope: 'global', name: 'Daily Driver global policy',
          preset: 'daily-driver', policy: { ...conservative, readOnlyJobsAutoRun: true },
          revision: 0, createdAt: TIME, updatedAt: TIME };
      },
      effectiveForProject: async () => ({ profile: null, policy: conservative, source: 'conservative-fallback' }),
      effectiveForJob: async () => ({ profile: null, policy: conservative, source: 'conservative-fallback' }),
    };
    const app = new OperatorWebApplication(new StubOperatorApplication(), {}, {}, undefined, undefined, undefined, trust);

    const page = await app.handle(new Request('http://localhost/trust'));
    const body = await page.text();
    expect(body).toContain('Trust Profiles');
    expect(body).toContain('Daily Driver');
    expect(body).toContain('Red actions always require human approval');
    expect(saved).toHaveLength(0);

    const response = await app.handle(new Request('http://localhost/trust', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ scope: 'project', scopeId: PROJECT_ID, preset: 'daily-driver' }),
    }));
    expect(response.status).toBe(303);
    expect(saved).toEqual([{ scope: 'project', scopeId: PROJECT_ID, preset: 'daily-driver' }]);
  });

  it('shows retained preflight history separately from the Worker execution budget', async () => {
    const service = new StubOperatorApplication();
    const cancelledOne = { ...WORKER_ONE, status: 'cancelled' as const, summary: undefined };
    const cancelledTwo = { ...WORKER_TWO, status: 'cancelled' as const, summary: undefined };
    service.getJobDetail = async () => ({
      ...ESCALATED_DETAIL,
      summary: {
        ...SUMMARY_ESCALATED,
        latestAttempt: cancelledTwo,
        workerAttemptCount: 2,
        workerExecutionCount: 0,
      },
      workerAttempts: [
        { attempt: cancelledOne, executionPlanId: 'plan:preflight-1' },
        { attempt: cancelledTwo, executionPlanId: 'plan:preflight-2' },
      ],
    });

    const response = await new OperatorWebApplication(service)
      .handle(new Request(`http://127.0.0.1/jobs/${encodeURIComponent(SUMMARY_ESCALATED.job.id)}`));
    const body = await response.text();

    expect(body).toContain('0 of 2 automatic slots consumed');
    expect(body).toContain('2 historical Worker Attempts retained for audit');
    expect(body).toContain('Historical Worker Attempt 1');
    expect(body).toContain('Historical Worker Attempt 2');
    expect(body).toContain('Provide Guidance + Continue');
  });

  it('renders late observation reconciliation as a no-resend explicit action', async () => {
    const service = new StubOperatorApplication();
    const detail: OperatorJobDetail = {
      ...ESCALATED_DETAIL,
      escalations: [{
        ...ESCALATED_DETAIL.escalations[0],
        reason: 'observation_timeout',
        summary: 'The accepted Worker turn exceeded the observation window.',
      }],
      escalationActions: { 'escalation:1': ['reconcile-execution'] },
      escalationKinds: { 'escalation:1': 'actionable-continuation' },
    };
    service.getJobDetail = async () => detail;
    const response = await new OperatorWebApplication(service)
      .handle(new Request('http://127.0.0.1/needs-me'));
    const body = await response.text();
    expect(body).toContain('Check Execution Again');
    expect(body).toContain('does not resend the task');
    expect(body).toContain('Actionable Continuation');
    expect(body).toContain('/escalations/escalation%3A1/reconcile');
  });

  it('maps explicit Needs Me actions to application commands and never from GET', async () => {
    const service = new StubOperatorApplication();
    const app = new OperatorWebApplication(service);
    await app.handle(new Request('http://127.0.0.1/needs-me'));
    expect(service.guidanceCalls).toBe(0);
    expect(service.cancelCalls).toBe(0);

    const guidance = await app.handle(new Request(
      `http://127.0.0.1/escalations/${encodeURIComponent('escalation:1')}/guidance`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ instruction: 'Use the documented contract.' }),
      },
    ));
    expect(guidance.status).toBe(303);
    expect(service.guidanceCalls).toBe(1);

    const cancel = await app.handle(new Request(
      `http://127.0.0.1/escalations/${encodeURIComponent('escalation:1')}/cancel`,
      { method: 'POST' },
    ));
    expect(cancel.status).toBe(303);
    expect(service.cancelCalls).toBe(1);

    const reconcile = await app.handle(new Request(
      `http://127.0.0.1/escalations/${encodeURIComponent('escalation:1')}/reconcile`,
      { method: 'POST' },
    ));
    expect(reconcile.status).toBe(303);
    expect(service.reconcileCalls).toBe(1);
  });

  it('offers one explicit budget extension with Reviewer feedback and optional guidance', async () => {
    const service = new StubOperatorApplication();
    const exhausted: OperatorJobDetail = {
      ...ESCALATED_DETAIL,
      summary: {
        ...SUMMARY_ESCALATED,
        workerAttemptCount: 2,
        workerExecutionCount: 2,
        latestReviewDecision: 'REVISION_REQUIRED',
      },
      workerAttempts: [
        { attempt: { ...WORKER_ONE, jobId: SUMMARY_ESCALATED.job.id } },
        { attempt: { ...WORKER_TWO, jobId: SUMMARY_ESCALATED.job.id }, review: {
          ...REVIEW_ONE,
          jobId: SUMMARY_ESCALATED.job.id,
          workerAttemptId: WORKER_TWO.id,
          feedback: 'Correct the source boundary before the next review.',
        } },
      ],
      finalReview: {
        ...REVIEW_ONE,
        jobId: SUMMARY_ESCALATED.job.id,
        workerAttemptId: WORKER_TWO.id,
        feedback: 'Correct the source boundary before the next review.',
      },
      escalations: [{
        id: 'escalation:budget', jobId: SUMMARY_ESCALATED.job.id,
        attemptId: WORKER_TWO.id, reviewId: REVIEW_ONE.id,
        reason: 'review_failed_after_budget',
        summary: 'Worker execution budget of 2 is exhausted.', createdAt: TIME,
      }],
      escalationActions: {
        'escalation:budget': ['authorize-worker-budget-extension', 'cancel-job'],
      },
      escalationKinds: { 'escalation:budget': 'budget-extension-required' },
    };
    service.getJobDetail = async () => exhausted;
    const app = new OperatorWebApplication(service);

    const first = await (await app.handle(new Request(
      `http://127.0.0.1/jobs/${encodeURIComponent(SUMMARY_ESCALATED.job.id)}`,
    ))).text();
    await app.handle(new Request(`http://127.0.0.1/jobs/${encodeURIComponent(SUMMARY_ESCALATED.job.id)}`));
    expect(first).toContain('Reviewer feedback');
    expect(first).toContain('Correct the source boundary before the next review.');
    expect(first).toContain('Optional guidance for the next Worker');
    expect(first).toContain('Authorize 1 More Attempt + Continue');
    expect(first).toContain('Cancel Job');
    expect(service.extensionCalls).toBe(0);

    const response = await app.handle(new Request(
      `http://127.0.0.1/escalations/${encodeURIComponent('escalation:budget')}/extend-worker-budget`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ instruction: 'Keep the layout and address the review.' }),
      },
    ));
    expect(response.status).toBe(303);
    expect(service.extensionCalls).toBe(1);
    expect(service.extensionGuidance).toBe('Keep the layout and address the review.');
  });

  it('does not offer continuation for a genuinely terminal Needs Me state', async () => {
    const service = new StubOperatorApplication();
    service.getJobDetail = async () => ({
      ...ESCALATED_DETAIL,
      escalations: [{
        id: 'escalation:terminal', jobId: SUMMARY_ESCALATED.job.id,
        reason: 'dispatch_uncertain', summary: 'Provider acceptance cannot be determined.', createdAt: TIME,
      }],
      escalationActions: { 'escalation:terminal': ['cancel-job'] },
      escalationKinds: { 'escalation:terminal': 'terminal' },
    });
    const body = await (await new OperatorWebApplication(service).handle(new Request(
      `http://127.0.0.1/jobs/${encodeURIComponent(SUMMARY_ESCALATED.job.id)}`,
    ))).text();
    expect(body).toContain('Cancel Job');
    expect(body).not.toContain('Authorize 1 More Attempt + Continue');
    expect(body).not.toContain('Provide Guidance + Continue');
  });

  it('labels human approval without offering a continuation action', async () => {
    const service = new StubOperatorApplication();
    service.getJobDetail = async () => ({
      ...ESCALATED_DETAIL,
      escalations: [{
        id: 'escalation:approval', jobId: SUMMARY_ESCALATED.job.id,
        reason: 'human_judgment_required',
        summary: 'Ready for Approval. Review the bounded evidence.', createdAt: TIME,
      }],
      escalationActions: { 'escalation:approval': ['cancel-job'] },
      escalationKinds: { 'escalation:approval': 'human-approval' },
    });
    const body = await (await new OperatorWebApplication(service).handle(new Request(
      'http://127.0.0.1/needs-me',
    ))).text();
    expect(body).toContain('Human Approval');
    expect(body).toContain('AO will not continue or publish automatically.');
    expect(body).not.toContain('Authorize 1 More Attempt + Continue');
    expect(body).not.toContain('Provide Guidance + Continue');
  });

  it('shows an offline runtime without starting it and rejects invalid action requests', async () => {
    const service = new StubOperatorApplication(false);
    service.provideGuidanceAndContinue = async () => { throw new Error('Guidance is not valid here'); };
    const app = new OperatorWebApplication(service);

    const landing = await app.handle(new Request('http://127.0.0.1/'));
    const body = await landing.text();
    expect(body).toContain('Offline');
    expect(body).toContain('Runtime is not running.');
    expect(body).toContain('Start Runtime');
    expect(service.startRuntimeCalls).toBe(0);
    expect(service.runCalls).toBe(0);

    const invalid = await app.handle(new Request(
      `http://127.0.0.1/escalations/${encodeURIComponent('escalation:1')}/guidance`,
      { method: 'POST', body: new URLSearchParams({ instruction: 'Invalid.' }) },
    ));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('Guidance is not valid here');
  });

  it('starts the runtime only through the explicit POST action and only once', async () => {
    const service = new StubOperatorApplication(false);
    const app = new OperatorWebApplication(service);

    await app.handle(new Request('http://127.0.0.1/'));
    await app.handle(new Request('http://127.0.0.1/'));
    expect(service.startRuntimeCalls).toBe(0);

    const response = await app.handle(new Request('http://127.0.0.1/runtime/start', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Runtime is ready with one configured agent.');
    expect(service.startRuntimeCalls).toBe(1);
  });

  it('serves a useful local landing page over an isolated fake HTTP server', async () => {
    const service = new StubOperatorApplication();
    const server = createOperatorHttpServer(new OperatorWebApplication(service), {
      host: '127.0.0.1', port: 0,
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fake AO server has no TCP address');
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('Agent Operations');
      expect(body).toContain('Running');
      expect(body).toContain('Needs Me');
      expect(body).toContain('Done Today');
      expect(service.runCalls).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('shows Telegram configuration status without exposing configuration values', async () => {
    const service = new StubOperatorApplication();
    const response = await new OperatorWebApplication(service, { telegramConfigured: true })
      .handle(new Request('http://127.0.0.1/'));
    const body = await response.text();
    expect(body).toContain('Notifications');
    expect(body).toContain('Telegram: Configured');
    expect(body).not.toContain('AO_TELEGRAM_BOT_TOKEN');
    expect(body).not.toContain('AO_TELEGRAM_CHAT_ID');
  });

  it('keeps preview non-executing and makes Run the only execution entry', async () => {
    const service = new StubOperatorApplication();
    const app = new OperatorWebApplication(service);
    const fields = new URLSearchParams({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      task: 'Inspect reviews.',
      acceptanceCriteria: 'Name all decisions.',
      intent: 'preview',
      executionMode: 'repository-write-isolated',
    });

    const preview = await app.handle(formRequest(fields));
    expect(preview.status).toBe(200);
    const previewBody = await preview.text();
    expect(previewBody).toContain('no Job or Dispatch created');
    expect(previewBody).toContain('workspace write in isolated AO worktree');
    expect(previewBody).toContain('human approval required after PASS');
    expect(service.previewCalls).toBe(1);
    expect(service.runCalls).toBe(0);

    fields.set('intent', 'run');
    const run = await app.handle(formRequest(fields));
    expect(run.status).toBe(303);
    expect(run.headers.get('location')).toBe(`/jobs/${encodeURIComponent(JOB_ID)}`);
    expect(service.runCalls).toBe(1);

    await app.handle(new Request('http://127.0.0.1/running'));
    await app.handle(new Request('http://127.0.0.1/running'));
    expect(service.runCalls).toBe(1);
  });
});

function formRequest(fields: URLSearchParams): Request {
  return new Request('http://127.0.0.1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields,
  });
}

const PROJECT: OperatorProjectOption = {
  project: { id: PROJECT_ID, name: 'Agent Operations', createdAt: TIME, updatedAt: TIME },
  repositories: [{
    id: REPOSITORY_ID,
    identityKind: 'remote',
    name: 'agent-operations',
    canonicalRemote: 'github.com/wftx/agent-operations',
    createdAt: TIME,
    updatedAt: TIME,
  }],
  runtimeAgentIds: ['agent-operations/rehearsal'],
  runnable: true,
};

function summary(
  id: string,
  title: string,
  state: string,
  status: 'draft' | 'ready' | 'completed' = 'ready',
  needsHuman = false,
): OperatorJobSummary {
  return {
    job: {
      id,
      projectId: PROJECT_ID,
      title,
      description: title,
      acceptanceCriteria: 'Name the authoritative file and all decisions.',
      automaticReadOnlyCompletion: true,
      status,
      repositoryId: REPOSITORY_ID,
      revision: status === 'draft' ? 0 : 1,
      createdAt: TIME,
      updatedAt: TIME,
    },
    projectName: 'Agent Operations',
    repositoryName: 'agent-operations',
    latestAttempt: null,
    currentRole: state.includes('Reviewer') ? 'reviewer' : state.includes('Worker') ? 'worker' : null,
    orchestrationState: state,
    workerAttemptCount: status === 'completed' ? 2 : 0,
    workerExecutionCount: status === 'completed' ? 2 : 0,
    automaticWorkerExecutionLimit: 2,
    humanWorkerBudgetExtensionCount: 0,
    authorizedWorkerExecutionLimit: 2,
    latestReviewDecision: status === 'completed' ? 'PASS' : null,
    needsHuman,
    operatorRun: {
      id: `operator-run:${id}`,
      jobId: id,
      status: status === 'completed' ? 'completed' : needsHuman ? 'needs_human' : state.includes('running') ? 'running' : 'pending',
      revision: 1,
      createdAt: TIME,
      updatedAt: TIME,
      ...(state.includes('running') || status === 'completed' || needsHuman ? { startedAt: TIME } : {}),
      ...(status === 'completed' || needsHuman ? { finishedAt: TIME } : {}),
    },
    currentStage: status === 'completed' ? 'Completed' : needsHuman ? 'Needs Me'
      : state.includes('Reviewer') ? 'Executing Reviewer'
      : state.includes('Worker') ? 'Executing Worker' : 'Accepted',
    ...(state.includes('running') || status === 'completed' ? { startedAt: TIME } : {}),
    ...(status === 'completed' ? { finishedAt: TIME, durationMs: 60_000 } : {}),
  };
}

const SUMMARY_NEW = summary('job:new', 'New Job', 'New', 'draft');
const SUMMARY_RUNNING = summary('job:running', 'Running Job', 'Reviewer running');
const SUMMARY_ESCALATED = summary('job:escalated', 'Escalated Job', 'Needs Me', 'ready', true);
const SUMMARY_DONE = summary(JOB_ID, 'Final accepted result', 'Done', 'completed');

const WORKER_ONE = {
  id: 'attempt:worker-1', jobId: JOB_ID, sequence: 1, roleSequence: 1, executionRole: 'worker' as const,
  runtimeAgentId: 'agent-operations/rehearsal', status: 'completed' as const, revision: 2,
  createdAt: TIME, updatedAt: TIME, startedAt: TIME, finishedAt: TIME,
};
const WORKER_TWO = { ...WORKER_ONE, id: 'attempt:worker-2', sequence: 3, roleSequence: 2 };
const REVIEW_ONE = {
  id: 'review:1', jobId: JOB_ID, workerAttemptId: WORKER_ONE.id, reviewerAttemptId: 'attempt:reviewer-1',
  reviewerRuntimeAgentId: 'agent-operations/rehearsal', decision: 'REVISION_REQUIRED' as const,
  summary: 'One criterion is missing.', feedback: 'Name the third decision.', createdAt: TIME,
};
const REVIEW_TWO = {
  ...REVIEW_ONE, id: 'review:2', workerAttemptId: WORKER_TWO.id, reviewerAttemptId: 'attempt:reviewer-2',
  decision: 'PASS' as const, summary: 'All acceptance criteria are satisfied.', feedback: undefined,
};

const DETAIL: OperatorJobDetail = {
  summary: SUMMARY_DONE,
  acceptanceCriteria: 'Name the authoritative file and all decisions.',
  workerAttempts: [
    { attempt: WORKER_ONE, resultText: 'First answer', review: REVIEW_ONE, executionPlanId: 'plan:1', dispatchId: 'dispatch:1', externalReference: 'turn:1' },
    { attempt: WORKER_TWO, resultText: 'Final answer: PASS / REVISION_REQUIRED / ESCALATE', review: REVIEW_TWO, executionPlanId: 'plan:2', dispatchId: 'dispatch:2', externalReference: 'turn:2' },
  ],
  reviewerAttempts: [],
  reviews: [REVIEW_ONE, REVIEW_TWO],
  escalations: [],
  guidance: [],
  workerBudgetExtensions: [],
  notificationDeliveries: [],
  escalationKinds: {},
  escalationActions: {},
  finalWorkerResult: 'Final answer: PASS / REVISION_REQUIRED / ESCALATE',
  finalReview: REVIEW_TWO,
  completedAt: TIME,
};

const ESCALATED_DETAIL: OperatorJobDetail = {
  ...DETAIL,
  summary: SUMMARY_ESCALATED,
  workerAttempts: [],
  reviews: [],
  finalWorkerResult: undefined,
  finalReview: {
    ...REVIEW_ONE,
    jobId: SUMMARY_ESCALATED.job.id,
    decision: 'ESCALATE',
    summary: 'The task boundary is ambiguous.',
    feedback: 'Clarify the intended source boundary.',
  },
  completedAt: undefined,
  escalations: [{
    id: 'escalation:1', jobId: SUMMARY_ESCALATED.job.id, reason: 'human_judgment_required',
    summary: 'Choose whether to revise the task.', createdAt: TIME,
  }],
  guidance: [],
  workerBudgetExtensions: [],
  notificationDeliveries: [],
  escalationActions: { 'escalation:1': ['provide-guidance', 'cancel-job'] },
  escalationKinds: { 'escalation:1': 'guidance-required' },
};

describe('Job Preview HTTP actions', () => {
  it('keeps GET read only and starts or captures only through explicit POST actions', async () => {
    const operator = new StubOperatorApplication();
    let starts = 0;
    let captures = 0;
    let requirements = 0;
    let profiles = 0;
    let authenticationBegins = 0;
    let authenticationVerifications = 0;
    let authenticationRevocations = 0;
    const preview: PreviewApplication = {
      setJobEvidenceRequirement: async (_jobId, requirement) => {
        requirements += 1;
        expect(requirement).toEqual({
          kind: 'browser-render', route: '/dashboard', viewport: { width: 1440, height: 900 },
        });
      },
      setJobPreviewProfile: async (_jobId, command) => {
        profiles += 1;
        expect(command).toBe('npm exec --offline -- next dev');
        throw new Error('profile fixture');
      },
      beginPreviewAuthentication: async () => { authenticationBegins += 1; throw new Error('begin fixture'); },
      verifyPreviewAuthentication: async () => { authenticationVerifications += 1; throw new Error('verify fixture'); },
      revokePreviewAuthentication: async () => { authenticationRevocations += 1; throw new Error('revoke fixture'); },
      startJobPreview: async jobId => {
        starts += 1;
        return { id: 'preview-session:test', jobId, projectId: PROJECT_ID, repositoryId: REPOSITORY_ID,
          installationId: 'installation:test', profileId: 'preview-profile:test',
          workspaceKind: 'read-only-detached-worktree', workspacePath: '/ao/preview',
          revisionCommit: '1'.repeat(40), sourceStateHash: '2'.repeat(64),
          origin: 'http://127.0.0.1:4311', route: '/', port: 4311, pid: 10, state: 'running',
          logs: '', revision: 1, createdAt: TIME, updatedAt: TIME };
      },
      refreshJobEvidence: async () => {
        captures += 1;
        throw new Error('capture fixture');
      },
      ensureJobEvidence: async () => { throw new Error('not used'); },
      getJobPreview: async () => ({ requirement: null, profile: null, session: null, evidence: [], authentication: null }),
    };
    const app = new OperatorWebApplication(operator, {}, {}, undefined, undefined, preview);

    expect((await app.handle(new Request(`http://localhost/jobs/${encodeURIComponent(JOB_ID)}`))).status).toBe(200);
    expect(requirements).toBe(0);
    expect(starts).toBe(0);
    const required = await app.handle(new Request(
      `http://localhost/jobs/${encodeURIComponent(JOB_ID)}/preview/requirement`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ route: '/dashboard' }),
      },
    ));
    expect(required.status).toBe(303);
    expect(requirements).toBe(1);
    const profiled = await app.handle(new Request(
      `http://localhost/jobs/${encodeURIComponent(JOB_ID)}/preview/profile`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ command: 'npm exec --offline -- next dev' }),
      },
    ));
    expect(profiled.status).toBe(400);
    expect(profiles).toBe(1);
    const started = await app.handle(new Request(
      `http://localhost/jobs/${encodeURIComponent(JOB_ID)}/preview/start`, { method: 'POST' },
    ));
    expect(started.status).toBe(303);
    expect(starts).toBe(1);
    const captured = await app.handle(new Request(
      `http://localhost/jobs/${encodeURIComponent(JOB_ID)}/preview/evidence`, { method: 'POST' },
    ));
    expect(captured.status).toBe(400);
    expect(captures).toBe(1);
    const authenticationActions = await Promise.all([
      app.handle(new Request(`http://localhost/jobs/${encodeURIComponent(JOB_ID)}/preview/authentication/begin`, { method: 'POST' })),
      app.handle(new Request(`http://localhost/jobs/${encodeURIComponent(JOB_ID)}/preview/authentication/verify`, { method: 'POST' })),
      app.handle(new Request(`http://localhost/jobs/${encodeURIComponent(JOB_ID)}/preview/authentication/revoke`, { method: 'POST' })),
    ]);
    expect(authenticationActions.map(response => response.status)).toEqual([400, 400, 400]);
    expect(authenticationBegins).toBe(1);
    expect(authenticationVerifications).toBe(1);
    expect(authenticationRevocations).toBe(1);
  });
});
