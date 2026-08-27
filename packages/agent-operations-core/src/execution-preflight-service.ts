import { resolve } from 'node:path';
import type {
  AgentOperationsStateStore,
  AgentRuntimeAdapter,
  AgentRuntimeDetail,
  DurableExecutionPlan,
  ExecutionPreflightFinding,
  ExecutionPreflightFindingCode,
  ExecutionPreflightFindingSeverity,
  ExecutionPreflightResult,
  RepositoryInventoryAdapter,
  RuntimeExecutionCapabilities,
  RuntimeExecutionContext,
  RuntimeExecutionPolicy,
} from '../../agent-operations-contracts/src/index.js';
import { resolveRuntimeExecutionPolicy } from '../../agent-operations-contracts/src/index.js';

export interface ExecutionPreflightServiceOptions {
  readonly requireExactTurnCorrelation?: boolean;
}

/** Current, read-only validation. It neither stores observations nor changes lifecycle state. */
export class ExecutionPreflightService {
  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly runtimes: AgentRuntimeAdapter,
    private readonly repositories: RepositoryInventoryAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly options: ExecutionPreflightServiceOptions = {},
  ) {}

  async preflight(planId: string): Promise<ExecutionPreflightResult> {
    const plan = await this.store.getExecutionPlan(planId.trim());
    if (!plan) throw new Error(`Execution Plan not found: ${planId}`);
    const checks: ExecutionPreflightFinding[] = [];
    await this.checkDurableState(plan, checks);
    const runtime = await this.checkRuntime(plan, checks);
    const effectivePolicy = this.checkRuntimePolicy(plan, runtime, checks);
    const effectiveCapabilities = this.checkRuntimeCapabilities(plan, runtime, checks);
    const executionContext = await this.checkRepository(
      plan,
      checks,
      runtime,
      effectivePolicy,
      effectiveCapabilities,
    );
    const dispatchable = !checks.some(check => check.severity === 'blocking');
    return {
      planId: plan.id,
      checkedAt: this.now().toISOString(),
      status: dispatchable
        ? checks.some(check => check.severity === 'warning') ? 'warning' : 'ready'
        : 'blocked',
      dispatchable,
      requestedPolicy: plan.requestedPolicy ? { ...plan.requestedPolicy } : null,
      effectivePolicy,
      requestedCapabilities: plan.requestedCapabilities ? { ...plan.requestedCapabilities } : null,
      effectiveCapabilities,
      executionContext,
      checks,
    };
  }

  private checkRuntimeCapabilities(
    plan: DurableExecutionPlan,
    runtime: AgentRuntimeDetail | null,
    checks: ExecutionPreflightFinding[],
  ): RuntimeExecutionCapabilities | null {
    const requested = plan.requestedCapabilities;
    if (!requested) {
      add(
        checks,
        plan.repositoryId ? 'repository-read-capability-required' : 'runtime-capabilities-unspecified',
        'blocking',
        plan.repositoryId
          ? 'Repository-bound Plan predates explicit repository-read capability and cannot be dispatched.'
          : 'Plan predates explicit runtime tool capabilities and cannot be dispatched.',
      );
      return null;
    }
    if (!requested.repositoryRead) {
      if (plan.repositoryId) {
        add(
          checks,
          'repository-read-capability-required',
          'blocking',
          'Repository-bound execution requires explicit repository-read capability.',
        );
      }
      return { ...requested };
    }
    const supported = runtime?.capabilities.includes('repository-read-tools') === true;
    add(
      checks,
      supported ? 'repository-read-capability-supported' : 'repository-read-capability-unsupported',
      supported ? 'pass' : 'blocking',
      supported
        ? `Runtime ${plan.runtimeAgentId} supports bounded repository-read tools.`
        : `Runtime ${plan.runtimeAgentId} cannot expose bounded repository-read tools.`,
    );
    return supported ? { ...requested } : null;
  }

  private checkRuntimePolicy(
    plan: DurableExecutionPlan,
    runtime: AgentRuntimeDetail | null,
    checks: ExecutionPreflightFinding[],
  ): RuntimeExecutionPolicy | null {
    if (!plan.requestedPolicy) {
      add(
        checks,
        'runtime-policy-unspecified',
        'blocking',
        'Plan predates runtime capability policy and cannot be dispatched by the Phase 15 boundary.',
      );
      return null;
    }
    if (!runtime) {
      add(
        checks,
        'runtime-policy-unsupported',
        'blocking',
        'Runtime policy cannot be evaluated because the runtime is unavailable.',
      );
      return null;
    }
    const resolution = resolveRuntimeExecutionPolicy(plan.requestedPolicy, runtime.capabilities);
    if (!resolution.supported) {
      add(checks, 'runtime-policy-unsupported', 'blocking', resolution.reason);
      return null;
    }
    add(
      checks,
      'runtime-policy-supported',
      'pass',
      `Runtime can enforce filesystem=${resolution.effectivePolicy.filesystem}, network=${resolution.effectivePolicy.network}, environment=${resolution.effectivePolicy.environment}.`,
    );
    return { ...resolution.effectivePolicy };
  }

  private async checkDurableState(
    plan: DurableExecutionPlan,
    checks: ExecutionPreflightFinding[],
  ): Promise<void> {
    const [job, attempt, installation] = await Promise.all([
      this.store.getJob(plan.jobId),
      this.store.getAttempt(plan.attemptId),
      this.store.getInstallation(),
    ]);
    if (!job) {
      add(checks, 'job-missing', 'blocking', `Job ${plan.jobId} no longer exists.`);
    } else {
      add(
        checks,
        job.status === 'ready' ? 'job-ready' : 'job-not-ready',
        job.status === 'ready' ? 'pass' : 'blocking',
        job.status === 'ready' ? `Job ${job.id} is ready.` : `Job ${job.id} is ${job.status}, not ready.`,
      );
      if (job.revision !== plan.jobRevisionAtPreparation) {
        add(
          checks,
          'plan-job-revision-stale',
          'blocking',
          `Job revision is ${job.revision}; the Plan captured ${plan.jobRevisionAtPreparation}.`,
        );
      }
    }
    if (!attempt) {
      add(checks, 'attempt-missing', 'blocking', `Attempt ${plan.attemptId} no longer exists.`);
    } else {
      add(
        checks,
        attempt.status === 'created' ? 'attempt-created' : 'attempt-not-created',
        attempt.status === 'created' ? 'pass' : 'blocking',
        attempt.status === 'created'
          ? `Attempt ${attempt.id} is created.`
          : `Attempt ${attempt.id} is ${attempt.status}, not created.`,
      );
      if (attempt.revision !== plan.attemptRevisionAtPreparation) {
        add(
          checks,
          'plan-attempt-revision-stale',
          'blocking',
          `Attempt revision is ${attempt.revision}; the Plan captured ${plan.attemptRevisionAtPreparation}.`,
        );
      }
    }
    const associationsValid = Boolean(
      job
      && attempt
      && job.id === plan.jobId
      && job.projectId === plan.projectId
      && job.repositoryId === plan.repositoryId
      && attempt.id === plan.attemptId
      && attempt.jobId === plan.jobId
      && attempt.runtimeAgentId === plan.runtimeAgentId
      && installation.id === plan.installationId,
    );
    add(
      checks,
      associationsValid ? 'plan-associations-valid' : 'plan-association-invalid',
      associationsValid ? 'pass' : 'blocking',
      associationsValid
        ? 'Plan identities still match its Job, Attempt, project, runtime, and installation.'
        : 'Plan identities no longer match current durable state.',
    );
  }

  private async checkRuntime(
    plan: DurableExecutionPlan,
    checks: ExecutionPreflightFinding[],
  ): Promise<AgentRuntimeDetail | null> {
    const runtimeIds = await this.store.listProjectRuntimeAgentIds(plan.projectId)
      .catch(() => [] as readonly string[]);
    const associated = runtimeIds.includes(plan.runtimeAgentId);
    add(
      checks,
      associated ? 'runtime-associated' : 'runtime-not-associated',
      associated ? 'pass' : 'blocking',
      associated
        ? `Runtime ${plan.runtimeAgentId} is associated with project ${plan.projectId}.`
        : `Runtime ${plan.runtimeAgentId} is no longer associated with project ${plan.projectId}.`,
    );

    try {
      const health = await this.runtimes.getHealth();
      if (health.state !== 'available') {
        add(
          checks,
          'runtime-adapter-unavailable',
          'blocking',
          `Runtime inventory is ${health.state}${health.reason ? `: ${health.reason}` : '.'}`,
        );
        return null;
      }
      add(checks, 'runtime-adapter-available', 'pass', 'Runtime inventory is currently available.');
      const runtime = await this.runtimes.getAgent(plan.runtimeAgentId);
      if (!runtime) {
        add(checks, 'runtime-missing', 'blocking', `Runtime ${plan.runtimeAgentId} was not observed.`);
        return null;
      }
      if (runtime.provider === 'unknown') {
        add(checks, 'runtime-provider-unknown', 'blocking', `Runtime ${runtime.id} has an unknown provider.`);
      }
      if (this.options.requireExactTurnCorrelation || Boolean(plan.repositoryId)) {
        const exactTurnCorrelation = runtime.capabilities.includes('exact-turn-correlation');
        add(
          checks,
          exactTurnCorrelation
            ? 'runtime-exact-turn-correlation-supported'
            : 'runtime-exact-turn-correlation-unsupported',
          exactTurnCorrelation ? 'pass' : 'blocking',
          exactTurnCorrelation
            ? `Runtime ${runtime.id} supports exact turn correlation.`
            : `Runtime ${runtime.id} cannot provide the exact turn correlation required for Dispatch.`,
        );
      }
      if (!runtime.configured) {
        add(checks, 'runtime-not-configured', 'blocking', `Runtime ${runtime.id} is not configured.`);
      }
      if (runtime.enabled === false) {
        add(checks, 'runtime-disabled', 'blocking', `Runtime ${runtime.id} is disabled.`);
      }
      const stateCode = `runtime-${runtime.health.state}` as ExecutionPreflightFindingCode;
      add(
        checks,
        stateCode,
        runtime.health.state === 'running' ? 'pass' : 'blocking',
        `Runtime ${runtime.id} is ${runtime.health.state}${runtime.health.reason ? `: ${runtime.health.reason}` : '.'}`,
      );
      return runtime;
    } catch (error) {
      add(
        checks,
        'runtime-adapter-unavailable',
        'blocking',
        `Runtime observation failed: ${message(error)}`,
      );
      return null;
    }
  }

  private async checkRepository(
    plan: DurableExecutionPlan,
    checks: ExecutionPreflightFinding[],
    runtime: AgentRuntimeDetail | null,
    effectivePolicy: RuntimeExecutionPolicy | null,
    effectiveCapabilities: RuntimeExecutionCapabilities | null,
  ): Promise<RuntimeExecutionContext | null> {
    if (!plan.repositoryId && !plan.checkoutBindingId) {
      add(checks, 'no-repository-target', 'pass', 'Plan has no repository target.');
      return null;
    }
    if (!plan.repositoryId || !plan.checkoutBindingId) {
      add(checks, 'checkout-missing', 'blocking', 'Plan repository and checkout identities are incomplete.');
      return null;
    }
    const repository = await this.store.getRepository(plan.repositoryId).catch(() => null);
    if (!repository) {
      add(checks, 'repository-observation-unavailable', 'blocking', `Logical repository ${plan.repositoryId} no longer exists.`);
      return null;
    }
    const repositoryIds = await this.store.listProjectRepositoryIds(plan.projectId)
      .catch(() => [] as readonly string[]);
    if (!repositoryIds.includes(plan.repositoryId)) {
      add(checks, 'repository-identity-mismatch', 'blocking', `Repository ${plan.repositoryId} is no longer associated with project ${plan.projectId}.`);
    }
    const bindings = await this.store.listCheckoutBindings().catch(() => []);
    const binding = bindings.find(candidate => candidate.id === plan.checkoutBindingId);
    if (!binding) {
      add(checks, 'checkout-missing', 'blocking', `Checkout ${plan.checkoutBindingId} is not configured.`);
      return null;
    }
    if (binding.installationId !== plan.installationId) {
      add(
        checks,
        'checkout-wrong-installation',
        'blocking',
        `Checkout ${binding.id} belongs to installation ${binding.installationId}.`,
      );
    }
    if (binding.repositoryId !== plan.repositoryId) {
      add(
        checks,
        'checkout-repository-mismatch',
        'blocking',
        `Checkout ${binding.id} is bound to repository ${binding.repositoryId}.`,
      );
    }
    if (binding.installationId === plan.installationId && binding.repositoryId === plan.repositoryId) {
      add(checks, 'checkout-binding-valid', 'pass', 'Checkout binding matches Plan installation and repository.');
    }
    const canSelectWorkingDirectory = runtime?.capabilities.includes('execution-working-directory') === true;
    add(
      checks,
      canSelectWorkingDirectory
        ? 'runtime-execution-working-directory-supported'
        : 'runtime-execution-working-directory-unsupported',
      canSelectWorkingDirectory ? 'pass' : 'blocking',
      canSelectWorkingDirectory
        ? `Runtime ${plan.runtimeAgentId} can establish a per-execution working directory.`
        : `Runtime ${plan.runtimeAgentId} cannot establish a proven per-execution working directory.`,
    );
    const restrictedRepositoryPolicy = effectivePolicy?.filesystem === 'read-only'
      && effectivePolicy.network === 'deny'
      && effectivePolicy.environment === 'empty';
    add(
      checks,
      restrictedRepositoryPolicy ? 'repository-read-only-policy' : 'repository-policy-unsafe',
      restrictedRepositoryPolicy ? 'pass' : 'blocking',
      restrictedRepositoryPolicy
        ? 'Repository execution is restricted to filesystem=read-only, network=deny, environment=empty.'
        : 'Phase 18 repository execution requires filesystem=read-only, network=deny, environment=empty.',
    );
    try {
      const observation = await this.repositories.inspectRepository(binding.canonicalPath);
      if (observation.availability === 'unavailable') {
        add(
          checks,
          'checkout-unavailable',
          'blocking',
          observation.reason ?? `Checkout path ${binding.canonicalPath} is unavailable.`,
        );
        return null;
      }
      if (observation.availability === 'not-a-repository') {
        add(checks, 'checkout-not-git', 'blocking', `${binding.canonicalPath} is not a Git repository.`);
        return null;
      }
      if (observation.availability === 'degraded') {
        add(
          checks,
          'repository-observation-unavailable',
          'blocking',
          observation.reason ?? `Repository observation for ${binding.canonicalPath} is degraded.`,
        );
        return null;
      }
      add(checks, 'checkout-available', 'pass', `Checkout path ${binding.canonicalPath} is available.`);
      const canonicalBindingPath = resolve(binding.canonicalPath);
      const observedRoot = observation.repositoryRoot
        ? resolve(observation.repositoryRoot)
        : resolve(observation.checkoutPath);
      const canonicalPathMatches = canonicalBindingPath === observedRoot
        && resolve(observation.checkoutPath) === observedRoot;
      add(
        checks,
        canonicalPathMatches ? 'runtime-checkout-match' : 'checkout-canonical-path-mismatch',
        canonicalPathMatches ? 'pass' : 'blocking',
        canonicalPathMatches
          ? `Canonical checkout root is ${observedRoot}.`
          : `Bound path ${canonicalBindingPath} does not resolve to observed Git root ${observedRoot}.`,
      );
      const readerRootValid = effectiveCapabilities?.repositoryRead === true
        && canonicalPathMatches
        && resolve(observedRoot) === observedRoot;
      add(
        checks,
        readerRootValid ? 'repository-read-root-valid' : 'repository-read-root-invalid',
        readerRootValid ? 'pass' : 'blocking',
        readerRootValid
          ? `Repository reader root is the canonical bound checkout ${observedRoot}.`
          : 'Repository reader root could not be proven from the canonical checkout binding.',
      );
      add(
        checks,
        observation.id === plan.repositoryId ? 'repository-identity-valid' : 'repository-identity-mismatch',
        observation.id === plan.repositoryId ? 'pass' : 'blocking',
        observation.id === plan.repositoryId
          ? `Observed repository identity matches ${plan.repositoryId}.`
          : `Observed repository ${observation.id} does not match ${plan.repositoryId}.`,
      );
      if (observation.workingTree === 'dirty') {
        add(checks, 'working-tree-dirty', 'warning', 'Checkout working tree is dirty.');
      }
      if (observation.detachedHead) {
        add(checks, 'detached-head', 'warning', 'Checkout is at a detached HEAD.');
      }
      return canonicalPathMatches && observation.id === plan.repositoryId
        && binding.installationId === plan.installationId
        && binding.repositoryId === plan.repositoryId
        && canSelectWorkingDirectory
        && restrictedRepositoryPolicy
        && readerRootValid
        ? { workingDirectory: observedRoot, repositoryReadRoot: observedRoot }
        : null;
    } catch (error) {
      add(
        checks,
        'repository-observation-unavailable',
        'blocking',
        `Repository observation failed: ${message(error)}`,
      );
      return null;
    }
  }
}

function add(
  checks: ExecutionPreflightFinding[],
  code: ExecutionPreflightFindingCode,
  severity: ExecutionPreflightFindingSeverity,
  messageText: string,
): void {
  checks.push({ code, severity, message: messageText });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
