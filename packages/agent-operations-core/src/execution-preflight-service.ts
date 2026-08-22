import type {
  AgentOperationsStateStore,
  AgentRuntimeAdapter,
  DurableExecutionPlan,
  ExecutionPreflightFinding,
  ExecutionPreflightFindingCode,
  ExecutionPreflightFindingSeverity,
  ExecutionPreflightResult,
  RepositoryInventoryAdapter,
} from '../../agent-operations-contracts/src/index.js';

/** Current, read-only validation. It neither stores observations nor changes lifecycle state. */
export class ExecutionPreflightService {
  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly runtimes: AgentRuntimeAdapter,
    private readonly repositories: RepositoryInventoryAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preflight(planId: string): Promise<ExecutionPreflightResult> {
    const plan = await this.store.getExecutionPlan(planId.trim());
    if (!plan) throw new Error(`Execution Plan not found: ${planId}`);
    const checks: ExecutionPreflightFinding[] = [];
    await this.checkDurableState(plan, checks);
    await this.checkRuntime(plan, checks);
    await this.checkRepository(plan, checks);
    const dispatchable = !checks.some(check => check.severity === 'blocking');
    return {
      planId: plan.id,
      checkedAt: this.now().toISOString(),
      status: dispatchable
        ? checks.some(check => check.severity === 'warning') ? 'warning' : 'ready'
        : 'blocked',
      dispatchable,
      checks,
    };
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
  ): Promise<void> {
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
        return;
      }
      add(checks, 'runtime-adapter-available', 'pass', 'Runtime inventory is currently available.');
      const runtime = await this.runtimes.getAgent(plan.runtimeAgentId);
      if (!runtime) {
        add(checks, 'runtime-missing', 'blocking', `Runtime ${plan.runtimeAgentId} was not observed.`);
        return;
      }
      if (runtime.provider === 'unknown') {
        add(checks, 'runtime-provider-unknown', 'blocking', `Runtime ${runtime.id} has an unknown provider.`);
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
    } catch (error) {
      add(
        checks,
        'runtime-adapter-unavailable',
        'blocking',
        `Runtime observation failed: ${message(error)}`,
      );
    }
  }

  private async checkRepository(
    plan: DurableExecutionPlan,
    checks: ExecutionPreflightFinding[],
  ): Promise<void> {
    if (!plan.repositoryId && !plan.checkoutBindingId) {
      add(checks, 'no-repository-target', 'pass', 'Plan has no repository target.');
      return;
    }
    if (!plan.repositoryId || !plan.checkoutBindingId) {
      add(checks, 'checkout-missing', 'blocking', 'Plan repository and checkout identities are incomplete.');
      return;
    }
    const bindings = await this.store.listCheckoutBindings().catch(() => []);
    const binding = bindings.find(candidate => candidate.id === plan.checkoutBindingId);
    if (!binding) {
      add(checks, 'checkout-missing', 'blocking', `Checkout ${plan.checkoutBindingId} is not configured.`);
      return;
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
    try {
      const observation = await this.repositories.inspectRepository(binding.canonicalPath);
      if (observation.availability === 'unavailable') {
        add(
          checks,
          'checkout-unavailable',
          'blocking',
          observation.reason ?? `Checkout path ${binding.canonicalPath} is unavailable.`,
        );
        return;
      }
      if (observation.availability === 'not-a-repository') {
        add(checks, 'checkout-not-git', 'blocking', `${binding.canonicalPath} is not a Git repository.`);
        return;
      }
      if (observation.availability === 'degraded') {
        add(
          checks,
          'repository-observation-unavailable',
          'blocking',
          observation.reason ?? `Repository observation for ${binding.canonicalPath} is degraded.`,
        );
        return;
      }
      add(checks, 'checkout-available', 'pass', `Checkout path ${binding.canonicalPath} is available.`);
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
    } catch (error) {
      add(
        checks,
        'repository-observation-unavailable',
        'blocking',
        `Repository observation failed: ${message(error)}`,
      );
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
