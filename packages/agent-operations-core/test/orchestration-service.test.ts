import { describe, expect, it } from 'vitest';
import type {
  DurableProjectConfiguration,
  RuntimeDispatchRequest,
  RuntimeDispatchResult,
  RuntimeExecutionAdapter,
  RuntimeExecutionObservation,
  RuntimeExecutionObservationAdapter,
  RuntimeExecutionObservationRequest,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  InMemoryAgentOperationsStateStore,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import { JobLifecycleService, OrchestrationService, parseReviewerResult } from '../src/index.js';

const TIME = '2026-08-27T03:00:00.000Z';
const PROJECT_ID = 'orchestration-fixture';
const JOB_ID = 'job:orchestration-fixture';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'agent-operations/rehearsal';
const INSTALLATION_ID = 'installation:orchestration-fixture';
const CHECKOUT = '/fixtures/agent-operations';
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
  | { readonly kind: 'completed'; readonly resultText: string }
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
      correlatedDispatchId: request.dispatchId,
      externalReference: request.externalReference,
      runtimeSessionId: `session:${request.dispatchId}`,
      observedAt: TIME,
      executionContext: { workingDirectory: CHECKOUT, repositoryReadRoot: CHECKOUT },
      effectivePolicy: POLICY,
      effectiveCapabilities: CAPABILITIES,
      resultText: fixture.resultText,
    }];
  }
}

async function harness(
  observationFixtures: readonly ObservationFixture[],
  dispatchResults: readonly ('accepted' | 'rejected' | 'uncertain')[] = [],
  runtimePolicySupported = true,
) {
  const store = new InMemoryAgentOperationsStateStore({
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
        'filesystem-read-only',
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
  }]);
  const execution = new ScriptedExecutionAdapter(dispatchResults);
  const observer = new ScriptedObservationAdapter(observationFixtures);
  let review = 0;
  let escalation = 0;
  let outcome = 0;
  const service = new OrchestrationService(store, runtimes, repositories, execution, observer, {
    now: () => new Date(TIME),
    observationIntervalMs: 0,
    observationTimeoutMs: 0,
    sleep: async () => undefined,
    attemptReviewIdFactory: () => `review:${++review}`,
    escalationIdFactory: () => `escalation:${++escalation}`,
    outcomeDecisionIdFactory: () => `outcome:${++outcome}`,
  });
  return { store, service, execution, observer, job };
}

describe('OrchestrationService', () => {
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
