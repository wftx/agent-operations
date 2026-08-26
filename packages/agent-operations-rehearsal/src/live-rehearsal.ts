import { randomUUID } from 'node:crypto';
import type {
  AgentOperationsStateStore,
  AgentRuntimeAdapter,
  AgentRuntimeDetail,
  DurableAttemptOutcomeDecision,
  DurableExecutionDispatch,
  DurableExecutionObservation,
  DurableExecutionPlan,
  DurableJob,
  DurableJobAttempt,
  ExecutionPreflightResult,
  RepositoryInventoryAdapter,
  RuntimeExecutionAdapter,
  RuntimeExecutionObservationAdapter,
  RuntimeInventoryHealth,
  RuntimeExecutionPolicy,
} from '../../agent-operations-contracts/src/index.js';
import {
  RESTRICTED_TEXT_EXECUTION_POLICY,
  resolveRuntimeExecutionPolicy,
} from '../../agent-operations-contracts/src/index.js';
import {
  ExecutionObservationService,
  ExecutionOutcomeService,
  ExecutionPlanningService,
  ExecutionPreflightService,
  JobLifecycleService,
  ManualDispatchService,
  type AttemptExecutionDetail,
  type ManualDispatchOutcome,
} from '../../agent-operations-core/src/index.js';

export const LIVE_REHEARSAL_CONFIRMATION = 'LIVE_REHEARSAL';
export const LIVE_REHEARSAL_PROJECT_ID = 'ao-live-rehearsal';

export interface RuntimeCandidateSafety {
  readonly safe: boolean;
  readonly reason: string;
  readonly activeWorkEvidence: readonly string[];
  readonly integrations: readonly string[];
}

export interface RuntimeCandidateSafetyInspector {
  inspect(runtime: AgentRuntimeDetail): Promise<RuntimeCandidateSafety>;
}

export interface LiveRehearsalCandidate {
  readonly runtime: AgentRuntimeDetail;
  readonly safety: RuntimeCandidateSafety;
}

export interface LiveRehearsalDiscovery {
  readonly health: RuntimeInventoryHealth;
  readonly configuredAgentIds: readonly string[];
  readonly enabledAgentIds: readonly string[];
  readonly runningAgentIds: readonly string[];
  readonly candidate: LiveRehearsalCandidate | null;
  readonly reason: string;
}

export interface LiveRehearsalPreview {
  readonly title: 'LIVE AGENT OPERATIONS REHEARSAL';
  readonly runtimeAgentId: string | null;
  readonly provider: string | null;
  readonly repository: null;
  readonly instruction: string;
  readonly nonce: string;
  readonly willContactRealRuntime: boolean;
  readonly willMutateGit: false;
  readonly runtimeFileWritesRequested: false;
  readonly requestedPolicy: RuntimeExecutionPolicy;
  readonly effectivePolicy: RuntimeExecutionPolicy | null;
  readonly policyEnforceable: boolean;
  readonly automaticallyInferSuccess: false;
  readonly outcomeAuthority: 'human confirmation';
  readonly executionAuthorized: boolean;
  readonly safetyConditionsSatisfied: boolean;
  readonly discoveryReason: string;
}

export interface LiveRehearsalRun {
  readonly projectId: string;
  readonly job: DurableJob;
  readonly attempt: DurableJobAttempt;
  readonly plan: DurableExecutionPlan;
  readonly dispatch: DurableExecutionDispatch | null;
  readonly preflight: ExecutionPreflightResult;
  readonly dispatchOutcome: ManualDispatchOutcome;
  readonly executionDetail: AttemptExecutionDetail | null;
  readonly nonce: string;
}

export interface LiveRehearsalExecutionResult {
  readonly preview: LiveRehearsalPreview;
  readonly discovery: LiveRehearsalDiscovery;
  readonly status: 'preview' | 'blocked' | 'accepted' | 'rejected' | 'uncertain';
  readonly operationsCreated: boolean;
  readonly run?: LiveRehearsalRun;
}

export interface LiveRehearsalOperationsOptions {
  readonly now?: () => Date;
  readonly jobIdFactory?: () => string;
  readonly attemptIdFactory?: () => string;
  readonly planIdFactory?: () => string;
  readonly dispatchIdFactory?: () => string;
  readonly outcomeDecisionIdFactory?: () => string;
}

export interface RunLiveRehearsalExecutionOptions {
  readonly execute: boolean;
  readonly confirmation?: string;
  readonly runtimes: AgentRuntimeAdapter;
  readonly safetyInspector: RuntimeCandidateSafetyInspector;
  readonly operationsFactory: () => Promise<LiveRehearsalOperations>;
  readonly nonceFactory?: () => string;
}

const PROVIDER_PREFERENCE = ['claude', 'codex', 'opencode', 'hermes'];

export async function discoverLiveRehearsalCandidate(
  runtimes: AgentRuntimeAdapter,
  safetyInspector: RuntimeCandidateSafetyInspector,
): Promise<LiveRehearsalDiscovery> {
  const health = await runtimes.getHealth();
  const summaries = await runtimes.listAgents();
  const configuredAgentIds = summaries.filter(item => item.configured).map(item => item.id);
  const enabledAgentIds = summaries.filter(item => item.enabled === true).map(item => item.id);
  const runningAgentIds = summaries
    .filter(item => item.health.state === 'running')
    .map(item => item.id);
  if (health.state !== 'available') {
    return {
      health,
      configuredAgentIds,
      enabledAgentIds,
      runningAgentIds,
      candidate: null,
      reason: `Runtime inventory is ${health.state}${health.reason ? `: ${health.reason}` : '.'}`,
    };
  }

  const eligible = summaries.filter(item => item.configured
    && item.enabled === true
    && item.provider !== 'unknown'
    && item.health.state === 'running');
  const inspected: LiveRehearsalCandidate[] = [];
  for (const summary of eligible) {
    const runtime = await runtimes.getAgent(summary.id);
    if (!runtime) continue;
    inspected.push({ runtime, safety: await safetyInspector.inspect(runtime) });
  }
  const safe = inspected.filter(item => item.safety.safe).sort((left, right) => {
    const provider = PROVIDER_PREFERENCE.indexOf(left.runtime.provider)
      - PROVIDER_PREFERENCE.indexOf(right.runtime.provider);
    return provider || left.runtime.id.localeCompare(right.runtime.id);
  });
  if (!safe.length) {
    const explanation = inspected.length
      ? inspected.map(item => `${item.runtime.id}: ${item.safety.reason}`).join('; ')
      : 'No configured, explicitly enabled, known-provider runtime is currently running.';
    return {
      health,
      configuredAgentIds,
      enabledAgentIds,
      runningAgentIds,
      candidate: null,
      reason: explanation,
    };
  }
  const candidate = safe[0];
  return {
    health,
    configuredAgentIds,
    enabledAgentIds,
    runningAgentIds,
    candidate,
    reason: safe.length === 1
      ? `Selected the only runtime with affirmative idle/safety evidence: ${candidate.runtime.id}.`
      : `Selected ${candidate.runtime.id} conservatively by provider preference and stable runtime ID.`,
  };
}

export async function runLiveRehearsalExecution(
  options: RunLiveRehearsalExecutionOptions,
): Promise<LiveRehearsalExecutionResult> {
  const nonce = normalizeNonce((options.nonceFactory ?? createLiveRehearsalNonce)());
  const discovery = await discoverLiveRehearsalCandidate(options.runtimes, options.safetyInspector);
  const authorized = options.execute && options.confirmation === LIVE_REHEARSAL_CONFIRMATION;
  const preview = createLiveRehearsalPreview(discovery, nonce, authorized);
  if (!authorized) return { preview, discovery, status: 'preview', operationsCreated: false };
  if (!discovery.candidate) return { preview, discovery, status: 'blocked', operationsCreated: false };

  const operations = await options.operationsFactory();
  const run = await operations.execute(discovery.candidate, nonce);
  const status = run.dispatchOutcome.status;
  return { preview, discovery, status, operationsCreated: true, run };
}

export class LiveRehearsalOperations {
  private readonly now: () => Date;
  private readonly lifecycle: JobLifecycleService;
  private readonly planning: ExecutionPlanningService;
  private readonly preflight: ExecutionPreflightService;
  private readonly dispatch: ManualDispatchService;
  private readonly observations: ExecutionObservationService;
  private readonly outcomes: ExecutionOutcomeService;

  constructor(
    private readonly store: AgentOperationsStateStore,
    runtimes: AgentRuntimeAdapter,
    repositories: RepositoryInventoryAdapter,
    execution: RuntimeExecutionAdapter,
    observer: RuntimeExecutionObservationAdapter,
    options: LiveRehearsalOperationsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.lifecycle = new JobLifecycleService(store, {
      now: this.now,
      ...(options.jobIdFactory ? { jobIdFactory: options.jobIdFactory } : {}),
      ...(options.attemptIdFactory ? { attemptIdFactory: options.attemptIdFactory } : {}),
    });
    this.planning = new ExecutionPlanningService(store, {
      now: this.now,
      ...(options.planIdFactory ? { planIdFactory: options.planIdFactory } : {}),
    });
    this.preflight = new ExecutionPreflightService(store, runtimes, repositories, this.now);
    this.dispatch = new ManualDispatchService(store, this.preflight, execution, {
      now: this.now,
      ...(options.dispatchIdFactory ? { dispatchIdFactory: options.dispatchIdFactory } : {}),
    });
    this.observations = new ExecutionObservationService(store, observer, this.now);
    this.outcomes = new ExecutionOutcomeService(store, this.observations, {
      now: this.now,
      ...(options.outcomeDecisionIdFactory
        ? { decisionIdFactory: options.outcomeDecisionIdFactory }
        : {}),
    });
  }

  async execute(candidate: LiveRehearsalCandidate, requestedNonce: string): Promise<LiveRehearsalRun> {
    if (!candidate.safety.safe) throw new Error(`Runtime candidate is not safe: ${candidate.safety.reason}`);
    const nonce = normalizeNonce(requestedNonce);
    const chain = await this.ensureDurableChain(candidate.runtime, nonce);
    const existingDispatch = await this.store.getExecutionDispatchForPlan(chain.plan.id);
    const preflight = await this.preflight.preflight(chain.plan.id);
    if (!preflight.dispatchable && !existingDispatch) {
      return {
        ...chain,
        dispatch: null,
        preflight,
        dispatchOutcome: {
          status: 'blocked',
          dispatch: null,
          preflight,
          adapterInvoked: false,
          attemptRunning: false,
          requiresReconciliation: false,
          message: 'Current preflight blocks the live rehearsal.',
        },
        executionDetail: null,
        nonce,
      };
    }

    let dispatchOutcome = await this.dispatch.dispatchExecutionPlan(chain.plan.id);
    if (dispatchOutcome.status === 'accepted' && dispatchOutcome.requiresReconciliation
      && dispatchOutcome.dispatch) {
      dispatchOutcome = await this.dispatch.reconcileAcceptedDispatch(dispatchOutcome.dispatch.id);
    }
    const currentAttempt = await this.requireAttempt(chain.attempt.id);
    const executionDetail = dispatchOutcome.status === 'accepted' && currentAttempt.status === 'running'
      ? (await this.observations.observeAttemptExecution(currentAttempt.id)).detail
      : dispatchOutcome.status === 'accepted' && (currentAttempt.status === 'completed' || currentAttempt.status === 'failed')
        ? await this.observations.getAttemptExecutionDetail(currentAttempt.id)
        : null;
    return {
      ...chain,
      attempt: currentAttempt,
      dispatch: dispatchOutcome.dispatch,
      preflight,
      dispatchOutcome,
      executionDetail,
      nonce: extractNonce(chain.plan.input.instruction) ?? nonce,
    };
  }

  async confirmSuccess(attemptId: string): Promise<AttemptExecutionDetail> {
    return this.outcomes.confirmAttemptSucceeded(attemptId, {
      summary: 'Human verified the expected harmless Agent Operations live rehearsal response.',
      overrideWithoutExactCompletionEvidence: true,
    });
  }

  async confirmFailure(attemptId: string, reason: string): Promise<AttemptExecutionDetail> {
    return this.outcomes.confirmAttemptFailed(attemptId, { reason: required(reason, 'Failure reason') });
  }

  async completeJob(jobId: string): Promise<DurableJob> {
    return this.lifecycle.completeJob(jobId);
  }

  async getExecutionDetail(attemptId: string): Promise<AttemptExecutionDetail> {
    return this.observations.getAttemptExecutionDetail(attemptId);
  }

  private async ensureDurableChain(
    runtime: AgentRuntimeDetail,
    nonce: string,
  ): Promise<{
    projectId: string;
    job: DurableJob;
    attempt: DurableJobAttempt;
    plan: DurableExecutionPlan;
  }> {
    const existingProject = await this.store.getProject(LIVE_REHEARSAL_PROJECT_ID);
    if (!existingProject) {
      const timestamp = this.now().toISOString();
      await this.store.applyProjectConfiguration({
        project: {
          id: LIVE_REHEARSAL_PROJECT_ID,
          name: 'Agent Operations Live Rehearsal',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        repositories: [],
        checkoutBindings: [],
        runtimeAgentIds: [runtime.id],
      });
    }
    const repositoryIds = await this.store.listProjectRepositoryIds(LIVE_REHEARSAL_PROJECT_ID);
    if (repositoryIds.length) throw new Error('Live rehearsal project must remain repository-free');
    const runtimeIds = await this.store.listProjectRuntimeAgentIds(LIVE_REHEARSAL_PROJECT_ID);
    if (!runtimeIds.includes(runtime.id)) {
      throw new Error(`Existing live rehearsal project is associated with another runtime`);
    }

    const jobs = await this.store.listJobs(LIVE_REHEARSAL_PROJECT_ID);
    if (jobs.length > 1) throw new Error('Multiple live rehearsal Jobs exist; refusing to choose automatically');
    if (jobs.length === 1) return this.loadExistingChain(jobs[0], runtime.id);

    const job = await this.lifecycle.createJob({
      projectId: LIVE_REHEARSAL_PROJECT_ID,
      title: `Controlled live rehearsal ${nonce}`,
      description: `Repository-free, no-tool rehearsal. Expected nonce response: ${expectedResponse(nonce)}`,
      preferredRuntimeAgentId: runtime.id,
    });
    const ready = await this.lifecycle.markJobReady(job.id);
    const attempt = await this.lifecycle.createAttempt(ready.id, { runtimeAgentId: runtime.id });
    const plan = await this.planning.prepareExecutionPlan({
      projectId: LIVE_REHEARSAL_PROJECT_ID,
      attemptId: attempt.id,
      instruction: createLiveRehearsalInstruction(nonce),
      requestedPolicy: RESTRICTED_TEXT_EXECUTION_POLICY,
    });
    return { projectId: LIVE_REHEARSAL_PROJECT_ID, job: ready, attempt, plan };
  }

  private async loadExistingChain(
    job: DurableJob,
    runtimeAgentId: string,
  ): Promise<{
    projectId: string;
    job: DurableJob;
    attempt: DurableJobAttempt;
    plan: DurableExecutionPlan;
  }> {
    if (job.repositoryId) throw new Error(`Existing live rehearsal Job ${job.id} is repository-bound`);
    if (job.preferredRuntimeAgentId !== runtimeAgentId) {
      throw new Error(`Existing live rehearsal Job ${job.id} belongs to another runtime`);
    }
    const attempts = await this.store.listAttemptsForJob(job.id);
    if (attempts.length !== 1) {
      throw new Error(`Existing live rehearsal Job ${job.id} must have exactly one Attempt`);
    }
    const plan = await this.store.getExecutionPlanForAttempt(attempts[0].id);
    if (!plan) throw new Error(`Existing live rehearsal Attempt ${attempts[0].id} has no Execution Plan`);
    if (plan.repositoryId || plan.checkoutBindingId) {
      throw new Error(`Existing live rehearsal Plan ${plan.id} is not repository-free`);
    }
    return { projectId: LIVE_REHEARSAL_PROJECT_ID, job, attempt: attempts[0], plan };
  }

  private async requireAttempt(attemptId: string): Promise<DurableJobAttempt> {
    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
    return attempt;
  }
}

export interface LiveRehearsalDurableSummary {
  readonly job: DurableJob;
  readonly attempt: DurableJobAttempt;
  readonly plan: DurableExecutionPlan;
  readonly dispatch: DurableExecutionDispatch;
  readonly observations: readonly DurableExecutionObservation[];
  readonly outcomeDecision: DurableAttemptOutcomeDecision | null;
}

export function createLiveRehearsalPreview(
  discovery: LiveRehearsalDiscovery,
  nonce: string,
  authorized: boolean,
): LiveRehearsalPreview {
  const resolution = discovery.candidate
    ? resolveRuntimeExecutionPolicy(
        RESTRICTED_TEXT_EXECUTION_POLICY,
        discovery.candidate.runtime.capabilities,
      )
    : null;
  return {
    title: 'LIVE AGENT OPERATIONS REHEARSAL',
    runtimeAgentId: discovery.candidate?.runtime.id ?? null,
    provider: discovery.candidate?.runtime.provider ?? null,
    repository: null,
    instruction: createLiveRehearsalInstruction(nonce),
    nonce,
    willContactRealRuntime: authorized && Boolean(discovery.candidate),
    willMutateGit: false,
    runtimeFileWritesRequested: false,
    requestedPolicy: { ...RESTRICTED_TEXT_EXECUTION_POLICY },
    effectivePolicy: resolution?.supported ? { ...resolution.effectivePolicy } : null,
    policyEnforceable: resolution?.supported === true,
    automaticallyInferSuccess: false,
    outcomeAuthority: 'human confirmation',
    executionAuthorized: authorized,
    safetyConditionsSatisfied: Boolean(discovery.candidate),
    discoveryReason: discovery.reason,
  };
}

export function createLiveRehearsalInstruction(nonce: string): string {
  const clean = normalizeNonce(nonce);
  return [
    'This is a controlled Agent Operations execution rehearsal.',
    '',
    'Do not use tools.',
    'Do not modify or create files.',
    'Do not run shell commands.',
    'Do not use Git.',
    'Do not contact external services.',
    '',
    'Reply with exactly this one line and nothing else:',
    expectedResponse(clean),
  ].join('\n');
}

export function createLiveRehearsalNonce(): string {
  return randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase();
}

export function expectedResponse(nonce: string): string {
  return `AGENT_OPERATIONS_REHEARSAL_OK ${normalizeNonce(nonce)}`;
}

function extractNonce(instruction: string): string | undefined {
  return instruction.match(/AGENT_OPERATIONS_REHEARSAL_OK ([A-Z0-9_-]+)/)?.[1];
}

function normalizeNonce(value: string): string {
  const clean = value.trim();
  if (!/^[A-Z0-9_-]{8,80}$/.test(clean)) {
    throw new Error('Live rehearsal nonce must be 8-80 uppercase letters, digits, underscores, or hyphens');
  }
  return clean;
}

function required(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  return clean;
}
