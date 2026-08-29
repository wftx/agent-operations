import { describe, expect, it } from 'vitest';
import type {
  DurableAttemptOutcomeDecision,
  DurableAttemptReview,
  DurableProjectConfiguration,
  RuntimeDispatchRequest,
  RuntimeDispatchResult,
  RuntimeExecutionAdapter,
  RuntimeExecutionObservation,
  RuntimeExecutionObservationAdapter,
  RuntimeExecutionObservationRequest,
  RepositoryWorkspaceAdapter,
  RepositoryWorkspaceInspection,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  InMemoryAgentOperationsStateStore,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import {
  JobLifecycleService,
  MVP_OBSERVATION_TIMEOUT_MS,
  OrchestrationService,
  parseReviewerResult,
  readWorkerExecutionBudget,
  RepositoryWorkspaceService,
} from '../src/index.js';

const TIME = '2026-08-27T03:00:00.000Z';
const PROJECT_ID = 'orchestration-fixture';
const JOB_ID = 'job:orchestration-fixture';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'agent-operations/rehearsal';
const INSTALLATION_ID = 'installation:orchestration-fixture';
const CHECKOUT = '/fixtures/agent-operations';
const WORKSPACE = '/ao-state/workspaces/orchestration-fixture';
const POLICY = { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const };
const CAPABILITIES = { version: 1 as const, repositoryRead: true };
const WRONG_RESULT = 'The contract is src/types/index.ts RuntimeExecutionPolicyEnvelope with filesystem, network, and environment.';
const CORRECT_RESULT = 'The authoritative Agent Operations RuntimeExecutionPolicy is defined in packages/agent-operations-contracts/src/execution.ts. Its dimensions are filesystem, network, and environment.';
const REVISION = JSON.stringify({
  decision: 'REVISION_REQUIRED',
  summary: 'The Worker selected the CortextOS transport envelope instead of the AO contract.',
  feedback: 'Search packages/agent-operations-contracts and identify RuntimeExecutionPolicy in execution.ts; do not substitute RuntimeExecutionPolicyEnvelope.',
});
const PASS = JSON.stringify({
  decision: 'PASS',
  summary: 'The authoritative AO contract, source file, and all three dimensions are correct.',
});

type ObservationFixture =
  | {
      readonly kind: 'completed';
      readonly resultText?: string;
      readonly correlatedDispatchId?: string;
      readonly externalReference?: string;
      readonly workingDirectory?: string;
      readonly policy?: typeof POLICY | {
        readonly version: 1;
        readonly filesystem: 'workspace-write';
        readonly network: 'deny';
        readonly environment: 'empty';
      };
      readonly capabilities?: RuntimeExecutionObservation['effectiveCapabilities'];
      readonly repositoryWriteRoot?: string;
      readonly toolOperations?: RuntimeExecutionObservation['toolOperations'];
    }
  | { readonly kind: 'runtime-failure' }
  | { readonly kind: 'missing-correlation' };

class ScriptedExecutionAdapter implements RuntimeExecutionAdapter {
  readonly requests: RuntimeDispatchRequest[] = [];
  private index = 0;

  constructor(private readonly results: readonly ('accepted' | 'rejected' | 'uncertain')[] = []) {}

  async dispatch(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResult> {
    this.requests.push(request);
    const index = this.index++;
    const status = this.results[index] ?? 'accepted';
    if (status !== 'accepted') {
      return { status, externalReference: `fixture:${status}:${index + 1}`, message: `fixture ${status}` };
    }
    return {
      status: 'accepted',
      effectivePolicy: { ...request.requestedPolicy },
      effectiveCapabilities: { ...request.requestedCapabilities },
      externalReference: `cortextos:codex-turn:v1:thread-${index + 1}:turn-${index + 1}`,
    };
  }
}

class ScriptedObservationAdapter implements RuntimeExecutionObservationAdapter {
  readonly requests: RuntimeExecutionObservationRequest[] = [];
  private index = 0;

  constructor(private readonly fixtures: readonly ObservationFixture[]) {}

  async observe(request: RuntimeExecutionObservationRequest): Promise<readonly RuntimeExecutionObservation[]> {
    this.requests.push(request);
    const fixture = this.fixtures[this.index++];
    if (!fixture) return [];
    if (fixture.kind === 'runtime-failure') {
      return [{
        source: 'fixture-runtime',
        sourceEventId: `failure:${request.dispatchId}`,
        kind: 'runtime-crashed',
        correlation: 'exact',
        correlatedDispatchId: request.dispatchId,
        externalReference: request.externalReference,
        observedAt: TIME,
        message: 'Fixture runtime failed.',
        executionContext: { workingDirectory: CHECKOUT, repositoryReadRoot: CHECKOUT },
        effectivePolicy: POLICY,
        effectiveCapabilities: CAPABILITIES,
      }];
    }
    if (fixture.kind === 'missing-correlation') {
      return [{
        source: 'fixture-runtime',
        sourceEventId: `weak:${request.dispatchId}`,
        kind: 'turn-completed',
        correlation: 'runtime-session',
        runtimeSessionId: 'fixture-session',
        observedAt: TIME,
      }];
    }
    return [{
      source: 'fixture-runtime',
      sourceEventId: `completed:${request.dispatchId}`,
      kind: 'turn-completed',
      correlation: 'exact',
      correlatedDispatchId: fixture.correlatedDispatchId ?? request.dispatchId,
      externalReference: fixture.externalReference ?? request.externalReference,
      runtimeSessionId: `session:${request.dispatchId}`,
      observedAt: TIME,
      executionContext: {
        workingDirectory: fixture.workingDirectory ?? CHECKOUT,
        repositoryReadRoot: fixture.workingDirectory ?? CHECKOUT,
        ...(fixture.repositoryWriteRoot ? { repositoryWriteRoot: fixture.repositoryWriteRoot } : {}),
      },
      effectivePolicy: fixture.policy ?? POLICY,
      effectiveCapabilities: fixture.capabilities ?? CAPABILITIES,
      ...(fixture.toolOperations ? { toolOperations: fixture.toolOperations } : {}),
      ...(fixture.resultText ? { resultText: fixture.resultText } : {}),
    }];
  }
}

class CrashOnceStore extends InMemoryAgentOperationsStateStore {
  failOutcomeOnce = false;
  failReviewOnce = false;

  override async createAttemptOutcomeDecision(decision: DurableAttemptOutcomeDecision): Promise<void> {
    if (this.failOutcomeOnce) {
      this.failOutcomeOnce = false;
      throw new Error('simulated crash before outcome persistence');
    }
    return super.createAttemptOutcomeDecision(decision);
  }

  override async createAttemptReview(review: DurableAttemptReview): Promise<void> {
    if (this.failReviewOnce) {
      this.failReviewOnce = false;
      throw new Error('simulated crash before Review persistence');
    }
    return super.createAttemptReview(review);
  }
}

async function harness(
  observationFixtures: readonly ObservationFixture[],
  dispatchResults: readonly ('accepted' | 'rejected' | 'uncertain')[] = [],
  runtimePolicySupported = true,
  writeMode = false,
) {
  const store = new CrashOnceStore({
    installation: { id: INSTALLATION_ID, createdAt: TIME },
  });
  const bindingId = createRepositoryCheckoutBindingId(INSTALLATION_ID, CHECKOUT);
  const configuration: DurableProjectConfiguration = {
    project: { id: PROJECT_ID, name: 'Orchestration Fixture', createdAt: TIME, updatedAt: TIME },
    repositories: [{
      id: REPOSITORY_ID,
      identityKind: 'remote',
      name: 'agent-operations',
      canonicalRemote: 'github.com/wftx/agent-operations',
      createdAt: TIME,
      updatedAt: TIME,
    }],
    checkoutBindings: [{
      id: bindingId,
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      canonicalPath: CHECKOUT,
      availability: 'available',
      firstSeenAt: TIME,
      lastSeenAt: TIME,
    }],
    runtimeAgentIds: [RUNTIME_ID],
  };
  await store.applyProjectConfiguration(configuration);
  const lifecycle = new JobLifecycleService(store, {
    now: () => new Date(TIME),
    jobIdFactory: () => JOB_ID,
  });
  const job = await lifecycle.createJob({
    projectId: PROJECT_ID,
    title: 'Identify the authoritative RuntimeExecutionPolicy contract',
    description: 'Report the AO source file and the three policy dimensions.',
    acceptanceCriteria: [
      'Must identify RuntimeExecutionPolicy.',
      'Must identify packages/agent-operations-contracts/src/execution.ts.',
      'Must report filesystem, network, and environment.',
      'Must not substitute RuntimeExecutionPolicyEnvelope.',
    ].join('\n'),
    automaticReadOnlyCompletion: true,
    ...(writeMode
      ? { executionMode: 'repository-write-isolated' as const, automaticReadOnlyCompletion: false }
      : {}),
    repositoryId: REPOSITORY_ID,
    preferredRuntimeAgentId: RUNTIME_ID,
  });
  await lifecycle.markJobReady(job.id);

  const runtimeCapabilities = runtimePolicySupported
    ? [
        'session-resume',
        'exact-turn-correlation',
        'execution-working-directory',
        'repository-read-tools',
        ...(writeMode ? ['repository-write-tools', 'test-run-tools', 'git-inspection-tools'] as const : []),
        'filesystem-read-only',
        ...(writeMode ? ['filesystem-workspace-write'] as const : []),
        'network-denial',
        'environment-empty',
      ] as const
    : ['session-resume'] as const;
  const runtimes = new FakeAgentRuntimeAdapter([{
    id: RUNTIME_ID,
    name: 'rehearsal',
    organization: 'agent-operations',
    provider: 'codex',
    enabled: true,
    configured: true,
    capabilities: runtimeCapabilities,
    health: { state: 'running' },
    observedAt: TIME,
  }]);
  const repositories = new FakeRepositoryInventoryAdapter([{
    id: REPOSITORY_ID,
    identityKind: 'remote',
    name: 'agent-operations',
    checkoutPath: CHECKOUT,
    repositoryRoot: CHECKOUT,
    availability: 'available',
    branch: 'main',
    detachedHead: false,
    headCommit: '1111111111111111111111111111111111111111',
    workingTree: 'clean',
    remotes: [{
      name: 'origin',
      fetchUrl: 'https://github.com/wftx/agent-operations.git',
      identity: {
        host: 'github.com',
        repositoryPath: 'wftx/agent-operations',
        canonical: 'github.com/wftx/agent-operations',
      },
    }],
    observedAt: TIME,
  }, ...(writeMode ? [{
    id: REPOSITORY_ID,
    identityKind: 'remote' as const,
    name: 'agent-operations',
    checkoutPath: WORKSPACE,
    repositoryRoot: WORKSPACE,
    availability: 'available' as const,
    branch: 'ao/job-orchestration-fixture',
    detachedHead: false,
    headCommit: '1111111111111111111111111111111111111111',
    workingTree: 'dirty' as const,
    remotes: [],
    observedAt: TIME,
  }] : [])]);
  const execution = new ScriptedExecutionAdapter(dispatchResults);
  const observer = new ScriptedObservationAdapter(observationFixtures);
  let review = 0;
  let escalation = 0;
  let outcome = 0;
  let workspaceExists = false;
  const workspaceAdapter: RepositoryWorkspaceAdapter = {
    inspectWorkspace: async input => workspaceExists
      ? ({
          exists: true, registered: true, canonicalPath: input.destinationPath,
          repositoryId: input.repositoryId, branchName: input.branchName, headRevision: input.baseRevision,
        })
      : ({ exists: false, registered: false } satisfies RepositoryWorkspaceInspection),
    createWorkspace: async input => {
      workspaceExists = true;
      return {
        exists: true, registered: true, canonicalPath: input.destinationPath,
        repositoryId: input.repositoryId, branchName: input.branchName, headRevision: input.baseRevision,
      };
    },
    captureEvidence: async () => ({
      changedFiles: ['README.md'], diffStat: '1 file changed', diffText: '+safe change', diffTruncated: false,
    }),
    removeWorkspace: async () => {
      workspaceExists = false;
      return { exists: false, registered: false };
    },
  };
  const workspaceService = writeMode
    ? new RepositoryWorkspaceService(store, repositories, workspaceAdapter, {
        stateDirectory: '/ao-state', now: () => new Date(TIME),
      })
    : undefined;
  const service = new OrchestrationService(store, runtimes, repositories, execution, observer, {
    now: () => new Date(TIME),
    observationIntervalMs: 0,
    observationTimeoutMs: 0,
    sleep: async () => undefined,
    attemptReviewIdFactory: () => `review:${++review}`,
    escalationIdFactory: () => `escalation:${++escalation}`,
    outcomeDecisionIdFactory: () => `outcome:${++outcome}`,
    ...(workspaceService ? { workspaceService } : {}),
  });
  return { store, service, execution, observer, runtimes, repositories, job, workspaceService };
}

function resumedService(setup: Awaited<ReturnType<typeof harness>>): OrchestrationService {
  return new OrchestrationService(
    setup.store,
    setup.runtimes,
    setup.repositories,
    setup.execution,
    setup.observer,
    {
      now: () => new Date(TIME),
      observationIntervalMs: 0,
      observationTimeoutMs: 0,
      sleep: async () => undefined,
    },
  );
}

describe('OrchestrationService', () => {
  it('allows a bounded repository-read turn up to five minutes by default', () => {
    expect(MVP_OBSERVATION_TIMEOUT_MS).toBe(300_000);
  });

  it('completes a correct Worker result only after a distinct exact Reviewer PASS', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: PASS },
    ]);
    const result = await setup.service.runJob(JOB_ID);

    expect(result.finalDecision).toBe('PASS');
    expect(result.job.status).toBe('completed');
    expect(result.workerAttempts).toHaveLength(1);
    expect(result.reviewerAttempts).toHaveLength(1);
    expect(result.workerAttempts[0]).toMatchObject({ executionRole: 'worker', roleSequence: 1, status: 'completed' });
    expect(result.reviewerAttempts[0]).toMatchObject({ executionRole: 'reviewer', roleSequence: 1, status: 'completed' });
    expect(result.reviews).toEqual([expect.objectContaining({ decision: 'PASS' })]);
    expect(result.escalations).toEqual([]);
    expect(setup.execution.requests).toHaveLength(2);
    expect(setup.execution.requests[1].input.instruction).toContain('For PASS, omit feedback');
    expect(setup.execution.requests[1].input.instruction)
      .toContain('For REVISION_REQUIRED, feedback is required and must contain concrete corrective guidance');
    expect(new Set(setup.execution.requests.map(request => request.executionPlanId)).size).toBe(2);
    expect(setup.observer.requests.map(request => request.externalReference)).toEqual([
      'cortextos:codex-turn:v1:thread-1:turn-1',
      'cortextos:codex-turn:v1:thread-2:turn-2',
    ]);
  });

  it('keeps an isolated write PASS ready for human approval without commit or Job completion', async () => {
    const writeCapabilities = {
      version: 1 as const, repositoryRead: true, repositoryPatch: true, testRun: true, gitInspect: true,
    };
    const reviewCapabilities = {
      version: 1 as const, repositoryRead: true, repositoryPatch: false, testRun: false, gitInspect: true,
    };
    const setup = await harness([
      {
        kind: 'completed', resultText: 'Updated README.md safely.', workingDirectory: WORKSPACE,
        repositoryWriteRoot: WORKSPACE,
        policy: { version: 1, filesystem: 'workspace-write', network: 'deny', environment: 'empty' },
        capabilities: writeCapabilities,
        toolOperations: [{
          namespace: 'test', operation: 'run', success: true, occurredAt: TIME,
          commandId: 'typecheck', command: 'npm run typecheck', exitCode: 0,
          durationMs: 10, stdout: 'ok', stderr: '',
        }],
      },
      {
        kind: 'completed', resultText: PASS, workingDirectory: WORKSPACE,
        policy: POLICY, capabilities: reviewCapabilities,
      },
    ], [], true, true);

    const result = await setup.service.runJob(JOB_ID);
    expect(result.finalDecision).toBe('ESCALATED');
    expect(result.job.status).toBe('ready');
    expect(result.reviews).toEqual([expect.objectContaining({ decision: 'PASS' })]);
    expect(result.escalations).toEqual([expect.objectContaining({
      reason: 'human_judgment_required', summary: expect.stringContaining('Ready for Approval'),
    })]);
    expect(setup.execution.requests).toHaveLength(2);
    expect(setup.execution.requests[0]).toMatchObject({
      requestedPolicy: { filesystem: 'workspace-write', network: 'deny', environment: 'empty' },
      requestedCapabilities: writeCapabilities,
      executionContext: { workingDirectory: WORKSPACE, repositoryWriteRoot: WORKSPACE },
    });
    expect(setup.execution.requests[1]).toMatchObject({
      requestedPolicy: { filesystem: 'read-only', network: 'deny', environment: 'empty' },
      requestedCapabilities: reviewCapabilities,
      executionContext: { workingDirectory: WORKSPACE },
    });
    const workspace = await setup.store.getRepositoryWorkspaceForJob(JOB_ID);
    expect(workspace).toMatchObject({
      state: 'ready_for_approval', branchName: 'ao/job-orchestration-fixture',
      evidence: { changedFiles: ['README.md'], testResults: [expect.objectContaining({ commandId: 'typecheck', status: 'passed' })] },
    });

    await setup.store.resolveEscalation(result.escalations[0].id, TIME);
    const reconciled = await setup.service.runJob(JOB_ID);
    expect(reconciled.finalDecision).toBe('ESCALATED');
    expect(reconciled.escalations).toEqual([
      expect.objectContaining({ reason: 'human_judgment_required', resolvedAt: TIME }),
      expect.objectContaining({ reason: 'human_judgment_required', summary: expect.stringContaining('Ready for Approval') }),
    ]);
    expect(reconciled.escalations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'runtime_failure' }),
    ]));
    expect(setup.execution.requests).toHaveLength(2);
    expect(setup.observer.requests).toHaveLength(2);
    await expect(setup.store.getRepositoryWorkspaceForJob(JOB_ID)).resolves.toEqual(workspace);

    const pending = await setup.workspaceService!.requestCleanup(workspace!.id);
    expect(pending).toMatchObject({ state: 'cleanup_pending', evidence: workspace!.evidence });
    await expect(setup.workspaceService!.cleanup(workspace!.id)).resolves.toMatchObject({
      state: 'cleaned',
      evidence: workspace!.evidence,
    });
  });

  it('uses a fresh Worker and Plan for write revision while preserving the same isolated workspace', async () => {
    const writeCapabilities = {
      version: 1 as const, repositoryRead: true, repositoryPatch: true, testRun: true, gitInspect: true,
    };
    const reviewCapabilities = {
      version: 1 as const, repositoryRead: true, repositoryPatch: false, testRun: false, gitInspect: true,
    };
    const worker = (resultText: string): ObservationFixture => ({
      kind: 'completed', resultText, workingDirectory: WORKSPACE,
      repositoryWriteRoot: WORKSPACE,
      policy: { version: 1, filesystem: 'workspace-write', network: 'deny', environment: 'empty' },
      capabilities: writeCapabilities,
    });
    const reviewer = (resultText: string): ObservationFixture => ({
      kind: 'completed', resultText, workingDirectory: WORKSPACE,
      policy: POLICY, capabilities: reviewCapabilities,
    });
    const setup = await harness([
      worker('{"summary":"first","filesChanged":["README.md"],"testsRun":[],"unresolvedIssues":[]}'),
      reviewer(REVISION),
      worker('{"summary":"revised","filesChanged":["README.md"],"testsRun":[],"unresolvedIssues":[]}'),
      reviewer(PASS),
    ], [], true, true);

    const result = await setup.service.runJob(JOB_ID);
    expect(result.finalDecision).toBe('ESCALATED');
    expect(result.workerAttempts).toHaveLength(2);
    expect(result.reviewerAttempts).toHaveLength(2);
    expect(result.reviews.map(review => review.decision)).toEqual(['REVISION_REQUIRED', 'PASS']);
    expect(new Set(setup.execution.requests.map(request => request.executionPlanId)).size).toBe(4);
    expect(new Set(setup.execution.requests.map(request => request.executionContext!.workingDirectory)))
      .toEqual(new Set([WORKSPACE]));
    const plans = await Promise.all([
      ...result.workerAttempts,
      ...result.reviewerAttempts,
    ].map(attempt => setup.store.getExecutionPlanForAttempt(attempt.id)));
    const workspaceIds = plans.map(plan => plan?.repositoryWorkspaceId);
    expect(new Set(workspaceIds).size).toBe(1);
    expect(workspaceIds[0]).toMatch(/^workspace:/);
    await expect(setup.store.getRepositoryWorkspaceForJob(JOB_ID)).resolves.toMatchObject({
      state: 'ready_for_approval',
      branchName: 'ao/job-orchestration-fixture',
    });
  });

  it('uses human guidance to revise a Ready for Approval write result only through a fresh Worker', async () => {
    const writeCapabilities = {
      version: 1 as const, repositoryRead: true, repositoryPatch: true, testRun: true, gitInspect: true,
    };
    const reviewCapabilities = {
      version: 1 as const, repositoryRead: true, repositoryPatch: false, testRun: false, gitInspect: true,
    };
    const worker = (resultText: string): ObservationFixture => ({
      kind: 'completed', resultText, workingDirectory: WORKSPACE,
      repositoryWriteRoot: WORKSPACE,
      policy: { version: 1, filesystem: 'workspace-write', network: 'deny', environment: 'empty' },
      capabilities: writeCapabilities,
    });
    const reviewer = (resultText: string): ObservationFixture => ({
      kind: 'completed', resultText, workingDirectory: WORKSPACE,
      policy: POLICY, capabilities: reviewCapabilities,
    });
    const setup = await harness([
      worker('{"summary":"first","filesChanged":["README.md"],"testsRun":[],"unresolvedIssues":[]}'),
      reviewer(PASS),
      worker('{"summary":"guided","filesChanged":["README.md"],"testsRun":[],"unresolvedIssues":[]}'),
      reviewer(PASS),
    ], [], true, true);

    const first = await setup.service.runJob(JOB_ID);
    const escalation = first.escalations[0];
    await setup.store.createHumanGuidanceAndResolveEscalation({
      id: 'guidance:ready-revision',
      jobId: JOB_ID,
      escalationId: escalation.id,
      instruction: 'Replace the remote image with the supplied local asset.',
      createdAt: TIME,
    }, TIME);

    const resumed = await setup.service.runJob(JOB_ID);
    expect(resumed.finalDecision).toBe('ESCALATED');
    expect(resumed.workerAttempts).toHaveLength(2);
    expect(resumed.reviewerAttempts).toHaveLength(2);
    expect(resumed.reviews.map(review => review.decision)).toEqual(['PASS', 'PASS']);
    expect(setup.execution.requests).toHaveLength(4);
    expect(setup.execution.requests[2].input.instruction)
      .toContain('<human_guidance>\nReplace the remote image with the supplied local asset.\n</human_guidance>');
    expect(new Set(setup.execution.requests.map(request => request.executionPlanId)).size).toBe(4);
    expect(await setup.store.getRepositoryWorkspaceForJob(JOB_ID)).toMatchObject({
      state: 'ready_for_approval',
      branchName: 'ao/job-orchestration-fixture',
    });
    expect(resumed.escalations.filter(candidate => !candidate.resolvedAt)).toEqual([
      expect.objectContaining({
        reason: 'human_judgment_required',
        summary: expect.stringContaining('Ready for Approval'),
      }),
    ]);
  });

  it('keeps isolated evidence in reviewing when the Reviewer escalates', async () => {
    const writeCapabilities = {
      version: 1 as const, repositoryRead: true, repositoryPatch: true, testRun: true, gitInspect: true,
    };
    const reviewCapabilities = {
      version: 1 as const, repositoryRead: true, repositoryPatch: false, testRun: false, gitInspect: true,
    };
    const setup = await harness([
      {
        kind: 'completed', resultText: '{"summary":"change","filesChanged":["README.md"],"testsRun":[],"unresolvedIssues":[]}',
        workingDirectory: WORKSPACE, repositoryWriteRoot: WORKSPACE,
        policy: { version: 1, filesystem: 'workspace-write', network: 'deny', environment: 'empty' },
        capabilities: writeCapabilities,
      },
      {
        kind: 'completed',
        resultText: JSON.stringify({ decision: 'ESCALATE', summary: 'Human product judgment is required.' }),
        workingDirectory: WORKSPACE, policy: POLICY, capabilities: reviewCapabilities,
      },
    ], [], true, true);

    const result = await setup.service.runJob(JOB_ID);
    expect(result.finalDecision).toBe('ESCALATED');
    expect(result.reviews).toEqual([expect.objectContaining({ decision: 'ESCALATE' })]);
    await expect(setup.store.getRepositoryWorkspaceForJob(JOB_ID)).resolves.toMatchObject({
      state: 'reviewing',
      evidence: { changedFiles: ['README.md'] },
    });
  });

  it('dogfoods the exact wrong-envelope failure, creates fresh Attempt 2, then passes and completes', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: WRONG_RESULT },
      { kind: 'completed', resultText: REVISION },
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: PASS },
    ]);
    const result = await setup.service.runJob(JOB_ID);

    expect(result.finalDecision).toBe('PASS');
    expect(result.job.status).toBe('completed');
    expect(result.workerAttempts).toHaveLength(2);
    expect(result.workerAttempts.map(attempt => attempt.roleSequence)).toEqual([1, 2]);
    expect(result.workerAttempts.map(attempt => attempt.status)).toEqual(['completed', 'completed']);
    expect(result.reviewerAttempts).toHaveLength(2);
    expect(result.reviews.map(review => review.decision)).toEqual(['REVISION_REQUIRED', 'PASS']);
    expect(setup.execution.requests).toHaveLength(4);
    expect(new Set(setup.execution.requests.map(request => request.executionPlanId)).size).toBe(4);
    expect(setup.execution.requests[2].input.instruction).toContain(WRONG_RESULT);
    expect(setup.execution.requests[2].input.instruction).toContain('Search packages/agent-operations-contracts');
    expect(setup.execution.requests.every(request =>
      request.requestedPolicy.filesystem === 'read-only'
      && request.requestedPolicy.network === 'deny'
      && request.requestedPolicy.environment === 'empty'
      && request.requestedCapabilities.repositoryRead)).toBe(true);
    expect(await readWorkerExecutionBudget(setup.store, result.workerAttempts, 2)).toMatchObject({
      consumed: 2,
      remaining: 0,
      exhausted: true,
    });
  });

  it('stops after two Worker Attempts and persists a needs-human escalation', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: WRONG_RESULT },
      { kind: 'completed', resultText: REVISION },
      { kind: 'completed', resultText: WRONG_RESULT },
      { kind: 'completed', resultText: REVISION },
    ]);
    const result = await setup.service.runJob(JOB_ID);

    expect(result.finalDecision).toBe('ESCALATED');
    expect(result.job.status).toBe('ready');
    expect(result.workerAttempts).toHaveLength(2);
    expect(result.escalations).toEqual([expect.objectContaining({ reason: 'review_failed_after_budget' })]);
    expect(await setup.service.listNeedsHuman()).toEqual([
      expect.objectContaining({
        escalation: expect.objectContaining({ reason: 'review_failed_after_budget' }),
        job: expect.objectContaining({ id: JOB_ID }),
        latestReview: expect.objectContaining({ decision: 'REVISION_REQUIRED' }),
      }),
    ]);
    expect(setup.execution.requests).toHaveLength(4);
    expect(await readWorkerExecutionBudget(setup.store, result.workerAttempts, 2)).toMatchObject({
      consumed: 2,
      remaining: 0,
      exhausted: true,
    });
  });

  it('escalates malformed Reviewer output instead of guessing', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: 'PASS - looks good' },
    ]);
    const result = await setup.service.runJob(JOB_ID);
    expect(result.finalDecision).toBe('ESCALATED');
    expect(result.reviews).toEqual([]);
    expect(result.escalations).toEqual([expect.objectContaining({ reason: 'reviewer_uncertain' })]);
    expect(result.workerAttempts[0].status).toBe('completed');
    expect(result.reviewerAttempts[0].status).toBe('failed');
  });

  it('normalizes the exact live PASS contract with empty feedback to no feedback', async () => {
    const liveShape = JSON.stringify({
      decision: 'PASS',
      summary: 'The Worker correctly identified the authoritative RuntimeExecutionPolicy contract and its dimensions.',
      feedback: '',
    });
    expect(parseReviewerResult(liveShape)).toEqual({
      decision: 'PASS',
      summary: 'The Worker correctly identified the authoritative RuntimeExecutionPolicy contract and its dimensions.',
    });
    expect(parseReviewerResult(JSON.stringify({
      decision: 'PASS',
      summary: '  The result satisfies the acceptance criteria.  ',
      feedback: '   ',
    }))).toEqual({
      decision: 'PASS',
      summary: 'The result satisfies the acceptance criteria.',
    });
  });

  it('still requires concrete non-empty feedback for REVISION_REQUIRED', () => {
    for (const feedback of [undefined, '', '   ']) {
      expect(() => parseReviewerResult(JSON.stringify({
        decision: 'REVISION_REQUIRED',
        summary: 'The Worker selected the transport envelope.',
        ...(feedback === undefined ? {} : { feedback }),
      }))).toThrow('REVISION_REQUIRED needs concrete feedback');
    }
  });

  it('accepts the exact live PASS shape and auto-completes without escalation', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: JSON.stringify({
        decision: 'PASS',
        summary: 'The Worker correctly identified the authoritative RuntimeExecutionPolicy contract and its dimensions.',
        feedback: '',
      }) },
    ]);
    const result = await setup.service.runJob(JOB_ID);
    expect(result.finalDecision).toBe('PASS');
    expect(result.job.status).toBe('completed');
    expect(result.workerAttempts[0].status).toBe('completed');
    expect(result.reviews).toEqual([expect.objectContaining({ decision: 'PASS' })]);
    expect(result.reviews[0]).not.toHaveProperty('feedback');
    expect(result.escalations).toEqual([]);
  });

  it('persists a valid Reviewer ESCALATE decision and stops for human judgment', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: JSON.stringify({
        decision: 'ESCALATE',
        summary: 'The acceptance criteria require human interpretation.',
        feedback: 'An operator must decide which contract is authoritative.',
      }) },
    ]);
    const result = await setup.service.runJob(JOB_ID);
    expect(result.reviews).toEqual([expect.objectContaining({ decision: 'ESCALATE' })]);
    expect(result.escalations).toEqual([expect.objectContaining({ reason: 'human_judgment_required' })]);
    expect(setup.execution.requests).toHaveLength(2);
  });

  it.each([
    ['rejected', 'dispatch_rejected'],
    ['uncertain', 'dispatch_uncertain'],
  ] as const)('never resends a %s Dispatch', async (status, reason) => {
    const setup = await harness([], [status]);
    const result = await setup.service.runJob(JOB_ID);
    expect(result.finalDecision).toBe('ESCALATED');
    expect(result.escalations).toEqual([expect.objectContaining({ reason })]);
    expect(setup.execution.requests).toHaveLength(1);
    const attempt = result.workerAttempts[0];
    const plan = await setup.store.getExecutionPlanForAttempt(attempt.id);
    expect(plan).not.toBeNull();
    expect(await setup.store.getExecutionDispatchForPlan(plan!.id)).toMatchObject({ status });
    expect(await readWorkerExecutionBudget(setup.store, result.workerAttempts, 2)).toMatchObject({
      consumed: 1,
      remaining: 1,
      exhausted: false,
    });
    await setup.service.runJob(JOB_ID);
    expect(setup.execution.requests).toHaveLength(1);
  });

  it('recovers an accepted Worker result after restart without resending its Dispatch', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: PASS },
    ]);
    setup.store.failOutcomeOnce = true;
    await expect(setup.service.runJob(JOB_ID)).rejects.toThrow('simulated crash');
    expect(setup.execution.requests).toHaveLength(1);

    const result = await resumedService(setup).runJob(JOB_ID);
    expect(result.finalDecision).toBe('PASS');
    expect(result.job.status).toBe('completed');
    expect(setup.execution.requests).toHaveLength(2);
    expect(new Set(setup.execution.requests.map(request => request.executionPlanId)).size).toBe(2);
  });

  it('recovers a captured Reviewer result and reconciles PASS after restart', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: PASS },
    ]);
    setup.store.failReviewOnce = true;
    await expect(setup.service.runJob(JOB_ID)).rejects.toThrow('simulated crash before Review');
    expect(setup.execution.requests).toHaveLength(2);

    const result = await resumedService(setup).runJob(JOB_ID);
    expect(result.finalDecision).toBe('PASS');
    expect(result.reviews).toEqual([expect.objectContaining({ decision: 'PASS' })]);
    expect(setup.execution.requests).toHaveLength(2);
  });

  it('uses resolved Human Guidance only in a fresh Worker Attempt', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: JSON.stringify({
        decision: 'ESCALATE',
        summary: 'The intended source boundary needs an operator decision.',
      }) },
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: PASS },
    ]);
    const first = await setup.service.runJob(JOB_ID);
    const escalation = first.escalations[0];
    await setup.store.createHumanGuidanceAndResolveEscalation({
      id: 'guidance:restart',
      jobId: JOB_ID,
      escalationId: escalation.id,
      instruction: 'Treat the contracts package as authoritative.',
      createdAt: TIME,
    }, TIME);

    const result = await resumedService(setup).runJob(JOB_ID);
    expect(result.finalDecision).toBe('PASS');
    expect(result.workerAttempts).toHaveLength(2);
    expect(setup.execution.requests[2].input.instruction)
      .toContain('<human_guidance>\nTreat the contracts package as authoritative.\n</human_guidance>');
    expect(setup.execution.requests[0].input.instruction).not.toContain('human_guidance');
  });

  it('escalates runtime failure with no new Dispatch', async () => {
    const setup = await harness([{ kind: 'runtime-failure' }]);
    const result = await setup.service.runJob(JOB_ID);
    expect(result.escalations).toEqual([expect.objectContaining({ reason: 'runtime_failure' })]);
    expect(setup.execution.requests).toHaveLength(1);
  });

  it('bounds observation and escalates without polling forever or resending', async () => {
    const setup = await harness([]);
    const result = await setup.service.runJob(JOB_ID);
    expect(result.escalations).toEqual([expect.objectContaining({ reason: 'observation_timeout' })]);
    expect(setup.execution.requests).toHaveLength(1);
    expect(setup.observer.requests).toHaveLength(1);
  });

  it('imports late exact completion into the same timed-out Worker without redispatch', async () => {
    const setup = await harness([]);
    const timedOut = await setup.service.runJob(JOB_ID);
    const escalation = timedOut.escalations[0];
    const worker = timedOut.workerAttempts[0];
    const dispatch = await setup.store.getExecutionDispatchForPlan(
      (await setup.store.getExecutionPlanForAttempt(worker.id))!.id,
    );
    const lateObserver = new ScriptedObservationAdapter([{ kind: 'completed', resultText: CORRECT_RESULT }]);
    const reconciler = new OrchestrationService(
      setup.store, setup.runtimes, setup.repositories, setup.execution, lateObserver,
      { now: () => new Date(TIME), outcomeDecisionIdFactory: () => 'outcome:late-completion' },
    );

    const first = await reconciler.reconcileTimedOutExecution(escalation.id);
    const second = await reconciler.reconcileTimedOutExecution(escalation.id);

    expect(first).toMatchObject({
      status: 'completed', attemptId: worker.id, dispatchId: dispatch!.id,
      resultText: CORRECT_RESULT, alreadyReconciled: false,
    });
    expect(second).toMatchObject({ status: 'completed', alreadyReconciled: true });
    expect(await setup.store.getAttempt(worker.id)).toMatchObject({ status: 'completed' });
    expect(await setup.store.getAttemptOutcomeDecision(worker.id)).toMatchObject({
      outcome: 'completed', source: 'runtime-evidence', dispatchId: dispatch!.id,
    });
    expect(setup.execution.requests).toHaveLength(1);
    expect(lateObserver.requests).toHaveLength(1);
    expect(lateObserver.requests[0].externalReference).toBe(dispatch!.externalReference);
  });

  it('reconciles the known oversized observation failure without redispatch', async () => {
    const setup = await harness([]);
    const timedOut = await setup.service.runJob(JOB_ID);
    const timeout = timedOut.escalations[0];
    const worker = timedOut.workerAttempts[0];
    await setup.store.resolveEscalationAndCreateEscalation(
      timeout.id,
      TIME,
      'Reclassified after deterministic diagnosis.',
      {
        id: 'escalation:oversized-observation',
        jobId: JOB_ID,
        attemptId: worker.id,
        reason: 'runtime_failure',
        summary: 'Runtime observation failed: Observation text exceeds 4000 characters',
        createdAt: TIME,
      },
    );
    const lateObserver = new ScriptedObservationAdapter([{
      kind: 'completed',
      resultText: CORRECT_RESULT,
      toolOperations: [{
        namespace: 'test', operation: 'run', success: false, occurredAt: TIME,
        commandId: 'agent-operations-tests', stderr: 'x'.repeat(10_000),
      }],
    }]);
    const reconciler = new OrchestrationService(
      setup.store, setup.runtimes, setup.repositories, setup.execution, lateObserver,
      { now: () => new Date(TIME), outcomeDecisionIdFactory: () => 'outcome:oversized-observation' },
    );

    const result = await reconciler.reconcileTimedOutExecution('escalation:oversized-observation');

    expect(result).toMatchObject({ status: 'completed', attemptId: worker.id });
    expect(setup.execution.requests).toHaveLength(1);
    expect((await setup.store.listExecutionObservationsForDispatch(result.dispatchId))[0]
      .toolOperations?.find(operation => operation.namespace === 'test'))
      .toMatchObject({ outputTruncated: true, stderr: 'x'.repeat(4_000) });
  });

  it('reconciles an isolated write Worker against its exact workspace without redispatch', async () => {
    const setup = await harness([], [], true, true);
    const timedOut = await setup.service.runJob(JOB_ID);
    const escalation = timedOut.escalations[0];
    const worker = timedOut.workerAttempts[0];
    const lateObserver = new ScriptedObservationAdapter([{
      kind: 'completed',
      resultText: '{"summary":"updated","filesChanged":["README.md"],"testsRun":[],"unresolvedIssues":[]}',
      workingDirectory: WORKSPACE,
      repositoryWriteRoot: WORKSPACE,
      policy: { version: 1, filesystem: 'workspace-write', network: 'deny', environment: 'empty' },
      capabilities: {
        version: 1, repositoryRead: true, repositoryPatch: true, testRun: true, gitInspect: true,
      },
    }]);
    const reconciler = new OrchestrationService(
      setup.store, setup.runtimes, setup.repositories, setup.execution, lateObserver,
      {
        now: () => new Date(TIME),
        outcomeDecisionIdFactory: () => 'outcome:late-write',
        workspaceService: setup.workspaceService,
      },
    );

    const result = await reconciler.reconcileTimedOutExecution(escalation.id);

    expect(result).toMatchObject({ status: 'completed', attemptId: worker.id });
    expect(setup.execution.requests).toHaveLength(1);
    expect(await setup.store.getAttempt(worker.id)).toMatchObject({ status: 'completed' });
  });

  it('continues a reconciled Worker through exactly one fresh Reviewer submission', async () => {
    const setup = await harness([]);
    const timedOut = await setup.service.runJob(JOB_ID);
    const escalation = timedOut.escalations[0];
    const worker = timedOut.workerAttempts[0];
    const lateObserver = new ScriptedObservationAdapter([
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: PASS },
    ]);
    const reconciler = new OrchestrationService(
      setup.store, setup.runtimes, setup.repositories, setup.execution, lateObserver,
      {
        now: () => new Date(TIME),
        outcomeDecisionIdFactory: (() => { let value = 0; return () => `outcome:late-${++value}`; })(),
        attemptReviewIdFactory: () => 'review:late',
      },
    );

    await reconciler.reconcileTimedOutExecution(escalation.id);
    await setup.store.resolveEscalation(
      escalation.id,
      TIME,
      'Resolved by late exact completion; no task was resent.',
    );
    const result = await reconciler.runJob(JOB_ID);

    expect(result.finalDecision).toBe('PASS');
    expect(result.workerAttempts).toEqual([expect.objectContaining({ id: worker.id, status: 'completed' })]);
    expect(result.reviewerAttempts).toHaveLength(1);
    expect(result.reviews).toEqual([expect.objectContaining({ decision: 'PASS' })]);
    expect(setup.execution.requests).toHaveLength(2);
    expect(setup.execution.requests[0].executionPlanId).toBe(timedOut.workerAttempts.length
      ? (await setup.store.getExecutionPlanForAttempt(worker.id))!.id
      : 'unreachable');
    expect(setup.execution.requests[1].input.instruction).toContain(CORRECT_RESULT);
    expect(lateObserver.requests).toHaveLength(2);
  });

  it('imports exact late runtime failure into the same Attempt and never redispatches', async () => {
    const setup = await harness([]);
    const timedOut = await setup.service.runJob(JOB_ID);
    const escalation = timedOut.escalations[0];
    const worker = timedOut.workerAttempts[0];
    const lateObserver = new ScriptedObservationAdapter([{ kind: 'runtime-failure' }]);
    const reconciler = new OrchestrationService(
      setup.store, setup.runtimes, setup.repositories, setup.execution, lateObserver,
      { now: () => new Date(TIME), outcomeDecisionIdFactory: () => 'outcome:late-failure' },
    );

    const result = await reconciler.reconcileTimedOutExecution(escalation.id);

    expect(result).toMatchObject({ status: 'failed', attemptId: worker.id, reason: 'Fixture runtime failed.' });
    expect(await setup.store.getAttempt(worker.id)).toMatchObject({ status: 'failed' });
    expect(await setup.store.getAttemptOutcomeDecision(worker.id)).toMatchObject({ outcome: 'failed' });
    expect(setup.execution.requests).toHaveLength(1);
    expect(lateObserver.requests).toHaveLength(1);
  });

  it('retains the timeout when late observation has no trustworthy terminal evidence', async () => {
    const setup = await harness([]);
    const timedOut = await setup.service.runJob(JOB_ID);
    const escalation = timedOut.escalations[0];
    const worker = timedOut.workerAttempts[0];
    const lateObserver = new ScriptedObservationAdapter([{ kind: 'missing-correlation' }]);
    const reconciler = new OrchestrationService(
      setup.store, setup.runtimes, setup.repositories, setup.execution, lateObserver,
      { now: () => new Date(TIME) },
    );

    const result = await reconciler.reconcileTimedOutExecution(escalation.id);

    expect(result).toMatchObject({ status: 'unresolved', attemptId: worker.id });
    expect(await setup.store.getAttempt(worker.id)).toMatchObject({ status: 'running' });
    expect(await setup.store.getAttemptOutcomeDecision(worker.id)).toBeNull();
    expect((await setup.store.getEscalation(escalation.id))?.resolvedAt).toBeUndefined();
    expect(setup.execution.requests).toHaveLength(1);
  });

  it.each([
    ['wrong Dispatch correlation', { kind: 'completed' as const, resultText: CORRECT_RESULT, correlatedDispatchId: 'dispatch:other' }],
    ['wrong external turn', { kind: 'completed' as const, resultText: CORRECT_RESULT, externalReference: 'cortextos:codex-turn:v1:other:turn' }],
    ['repository root escape', { kind: 'completed' as const, resultText: CORRECT_RESULT, workingDirectory: '/fixtures/outside' }],
    ['broader filesystem policy', {
      kind: 'completed' as const,
      resultText: CORRECT_RESULT,
      policy: { version: 1 as const, filesystem: 'workspace-write' as const, network: 'deny' as const, environment: 'empty' as const },
    }],
    ['missing bounded result', { kind: 'completed' as const }],
  ])('fails closed for late %s evidence', async (_label, fixture) => {
    const setup = await harness([]);
    const timedOut = await setup.service.runJob(JOB_ID);
    const escalation = timedOut.escalations[0];
    const worker = timedOut.workerAttempts[0];
    const lateObserver = new ScriptedObservationAdapter([fixture]);
    const reconciler = new OrchestrationService(
      setup.store, setup.runtimes, setup.repositories, setup.execution, lateObserver,
      { now: () => new Date(TIME) },
    );

    const result = await reconciler.reconcileTimedOutExecution(escalation.id);

    expect(result.status).toBe('unresolved');
    expect(await setup.store.getAttempt(worker.id)).toMatchObject({ status: 'running' });
    expect(await setup.store.getAttemptOutcomeDecision(worker.id)).toBeNull();
    expect((await setup.store.getEscalation(escalation.id))?.resolvedAt).toBeUndefined();
    expect(setup.execution.requests).toHaveLength(1);
  });

  it('escalates non-exact completion evidence', async () => {
    const setup = await harness([{ kind: 'missing-correlation' }]);
    const result = await setup.service.runJob(JOB_ID);
    expect(result.escalations).toEqual([expect.objectContaining({ reason: 'exact_correlation_missing' })]);
    expect(setup.execution.requests).toHaveLength(1);
  });

  it('blocks before Dispatch when the runtime cannot enforce the repository policy', async () => {
    const setup = await harness([], [], false);
    const result = await setup.service.runJob(JOB_ID);
    expect(result.escalations).toEqual([expect.objectContaining({ reason: 'policy_blocked' })]);
    expect(result.workerAttempts[0].status).toBe('cancelled');
    expect(setup.execution.requests).toHaveLength(0);
  });

  it('uses no budget for two policy-blocked preflight Attempts and then executes a fresh Worker', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: CORRECT_RESULT },
      { kind: 'completed', resultText: PASS },
    ], [], false);
    const blocked = await setup.service.runJob(JOB_ID);
    const firstBlockedAttempt = blocked.workerAttempts[0];
    const firstBlockedPlan = await setup.store.getExecutionPlanForAttempt(firstBlockedAttempt.id);
    const firstEscalation = blocked.escalations[0];
    expect(firstBlockedAttempt.status).toBe('cancelled');
    expect(firstBlockedPlan).not.toBeNull();
    expect(await setup.store.getExecutionDispatchForPlan(firstBlockedPlan!.id)).toBeNull();
    expect(setup.execution.requests).toHaveLength(0);

    await setup.store.createHumanGuidanceAndResolveEscalation({
      id: 'guidance:retry-preflight',
      jobId: JOB_ID,
      escalationId: firstEscalation.id,
      instruction: 'Try a fresh preflight after infrastructure repair.',
      createdAt: TIME,
    }, TIME);
    const blockedAgain = await setup.service.runJob(JOB_ID);
    const secondBlockedAttempt = blockedAgain.workerAttempts[1];
    const secondBlockedPlan = await setup.store.getExecutionPlanForAttempt(secondBlockedAttempt.id);
    const secondEscalation = blockedAgain.escalations.find(candidate => !candidate.resolvedAt)!;
    expect(blockedAgain.workerAttempts).toHaveLength(2);
    expect(secondBlockedAttempt).toMatchObject({ roleSequence: 2, status: 'cancelled' });
    expect(secondBlockedAttempt.id).not.toBe(firstBlockedAttempt.id);
    expect(secondBlockedPlan).not.toBeNull();
    expect(secondBlockedPlan!.id).not.toBe(firstBlockedPlan!.id);
    expect(await setup.store.getExecutionDispatchForPlan(secondBlockedPlan!.id)).toBeNull();
    expect(await readWorkerExecutionBudget(setup.store, blockedAgain.workerAttempts, 2)).toMatchObject({
      consumed: 0,
      remaining: 2,
      exhausted: false,
    });
    expect(setup.execution.requests).toHaveLength(0);

    await setup.store.createHumanGuidanceAndResolveEscalation({
      id: 'guidance:runtime-recovered',
      jobId: JOB_ID,
      escalationId: secondEscalation.id,
      instruction: 'The runtime is now available. Continue under the original read-only policy.',
      createdAt: TIME,
    }, TIME);
    const healthyRuntime = new FakeAgentRuntimeAdapter([{
      id: RUNTIME_ID,
      name: 'rehearsal',
      organization: 'agent-operations',
      provider: 'codex',
      enabled: true,
      configured: true,
      capabilities: [
        'session-resume',
        'exact-turn-correlation',
        'execution-working-directory',
        'repository-read-tools',
        'filesystem-read-only',
        'network-denial',
        'environment-empty',
      ],
      health: { state: 'running' },
      observedAt: TIME,
    }]);
    const resumed = new OrchestrationService(
      setup.store,
      healthyRuntime,
      setup.repositories,
      setup.execution,
      setup.observer,
      {
        now: () => new Date(TIME),
        observationIntervalMs: 0,
        observationTimeoutMs: 0,
        sleep: async () => undefined,
      },
    );

    const result = await resumed.runJob(JOB_ID);
    expect(result.finalDecision).toBe('PASS');
    expect(result.job.status).toBe('completed');
    expect(result.workerAttempts).toHaveLength(3);
    expect(result.workerAttempts.map(attempt => attempt.status)).toEqual(['cancelled', 'cancelled', 'completed']);
    expect(result.workerAttempts[2].id).not.toBe(firstBlockedAttempt.id);
    expect(result.workerAttempts[2].id).not.toBe(secondBlockedAttempt.id);
    expect(result.reviewerAttempts).toHaveLength(1);
    expect(setup.execution.requests).toHaveLength(2);
    expect(setup.execution.requests[0].input.instruction).toContain(
      '<human_guidance>\nThe runtime is now available. Continue under the original read-only policy.\n</human_guidance>',
    );
    expect(new Set(setup.execution.requests.map(request => request.executionPlanId)).size).toBe(2);
    expect(await setup.store.getExecutionPlan(firstBlockedPlan!.id)).toMatchObject({
      attemptId: firstBlockedAttempt.id,
    });
    expect(await setup.store.getExecutionPlan(secondBlockedPlan!.id)).toMatchObject({
      attemptId: secondBlockedAttempt.id,
    });
    expect(await setup.store.getExecutionDispatchForPlan(firstBlockedPlan!.id)).toBeNull();
    expect(await setup.store.getExecutionDispatchForPlan(secondBlockedPlan!.id)).toBeNull();
    expect(await readWorkerExecutionBudget(setup.store, result.workerAttempts, 2)).toMatchObject({
      consumed: 1,
      remaining: 1,
      exhausted: false,
    });
  });

  it('returns a human-guided continuation to Needs Me after Reviewer revision without another Worker', async () => {
    const setup = await harness([
      { kind: 'completed', resultText: WRONG_RESULT },
      { kind: 'completed', resultText: REVISION },
    ], [], false);
    const blocked = await setup.service.runJob(JOB_ID);
    const blockedWorker = blocked.workerAttempts[0];
    const blockedPlan = await setup.store.getExecutionPlanForAttempt(blockedWorker.id);
    await setup.store.createHumanGuidanceAndResolveEscalation({
      id: 'guidance:single-worker-continuation',
      jobId: JOB_ID,
      escalationId: blocked.escalations[0].id,
      instruction: 'The runtime is healthy. Execute exactly one fresh Worker and review it.',
      createdAt: TIME,
    }, TIME);
    const healthyRuntime = new FakeAgentRuntimeAdapter([{
      id: RUNTIME_ID,
      name: 'rehearsal',
      organization: 'agent-operations',
      provider: 'codex',
      enabled: true,
      configured: true,
      capabilities: [
        'session-resume',
        'exact-turn-correlation',
        'execution-working-directory',
        'repository-read-tools',
        'filesystem-read-only',
        'network-denial',
        'environment-empty',
      ],
      health: { state: 'running' },
      observedAt: TIME,
    }]);
    const resumed = new OrchestrationService(
      setup.store,
      healthyRuntime,
      setup.repositories,
      setup.execution,
      setup.observer,
      {
        now: () => new Date(TIME),
        observationIntervalMs: 0,
        observationTimeoutMs: 0,
        sleep: async () => undefined,
      },
    );

    const result = await resumed.runJob(JOB_ID);

    expect(result.finalDecision).toBe('ESCALATED');
    expect(result.workerAttempts).toHaveLength(2);
    expect(result.workerAttempts.map(attempt => attempt.status)).toEqual(['cancelled', 'completed']);
    expect(result.reviewerAttempts).toHaveLength(1);
    expect(result.reviews).toEqual([expect.objectContaining({ decision: 'REVISION_REQUIRED' })]);
    expect(result.escalations.filter(escalation => !escalation.resolvedAt)).toEqual([
      expect.objectContaining({
        reason: 'human_judgment_required',
        attemptId: result.workerAttempts[1].id,
        reviewId: result.reviews[0].id,
        summary: expect.stringContaining('one Worker execution authorized by Human Guidance'),
      }),
    ]);
    expect(setup.execution.requests).toHaveLength(2);
    expect(result.workerAttempts[1].id).not.toBe(blockedWorker.id);
    expect((await setup.store.getExecutionPlanForAttempt(result.workerAttempts[1].id))!.id)
      .not.toBe(blockedPlan!.id);
    expect(await setup.store.getExecutionDispatchForPlan(blockedPlan!.id)).toBeNull();
    expect(await readWorkerExecutionBudget(setup.store, result.workerAttempts, 2)).toMatchObject({
      consumed: 1,
      remaining: 1,
      exhausted: false,
    });
  });

  it('previews without creating Attempts, Plans, Dispatches, Reviews, or Escalations', async () => {
    const setup = await harness([]);
    const preview = await setup.service.preview(JOB_ID);
    expect(preview).toMatchObject({
      eligible: true,
      executionAuthorized: false,
      repositoryRead: true,
      maxWorkerAttempts: 2,
      maxReviewerPassesPerAttempt: 1,
      autoCompleteAllowed: true,
    });
    expect(await setup.store.listAttemptsForJob(JOB_ID)).toEqual([]);
    expect(await setup.store.listAttemptReviewsForJob(JOB_ID)).toEqual([]);
    expect(await setup.store.listEscalations(JOB_ID)).toEqual([]);
    expect(setup.execution.requests).toEqual([]);
  });
});
