import type {
  AgentOperationsStateStore,
  DurableExecutionDispatch,
  DurableExecutionPlan,
  ExecutionPreflightResult,
  RuntimeDispatchResult,
  RuntimeExecutionAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  createExecutionDispatchId,
  createExecutionDispatchIdempotencyKey,
  isRuntimeExecutionCapabilitiesNoBroaderThan,
  isRuntimeExecutionPolicyNoBroaderThan,
} from '../../agent-operations-contracts/src/index.js';
import { ExecutionPreflightService } from './execution-preflight-service.js';
import { JobLifecycleService } from './job-lifecycle-service.js';

export type ManualDispatchOutcomeStatus = 'blocked' | 'accepted' | 'rejected' | 'uncertain';

export interface ManualDispatchOutcome {
  readonly status: ManualDispatchOutcomeStatus;
  readonly dispatch: DurableExecutionDispatch | null;
  readonly preflight: ExecutionPreflightResult | null;
  readonly adapterInvoked: boolean;
  readonly attemptRunning: boolean;
  readonly requiresReconciliation: boolean;
  readonly message?: string;
}

export interface ManualDispatchServiceOptions {
  readonly now?: () => Date;
  readonly dispatchIdFactory?: () => string;
}

/** Explicit one-Plan manual action. This class contains no polling, retry, or scheduling. */
export class ManualDispatchService {
  private readonly now: () => Date;
  private readonly dispatchIdFactory: () => string;
  private readonly lifecycle: JobLifecycleService;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly preflight: ExecutionPreflightService,
    private readonly execution: RuntimeExecutionAdapter,
    options: ManualDispatchServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.dispatchIdFactory = options.dispatchIdFactory ?? (() => createExecutionDispatchId());
    this.lifecycle = new JobLifecycleService(store, { now: this.now });
  }

  async dispatchExecutionPlan(planId: string): Promise<ManualDispatchOutcome> {
    const cleanPlanId = planId.trim();
    if (!cleanPlanId) throw new Error('Execution Plan ID is required');
    const plan = await this.store.getExecutionPlan(cleanPlanId);
    if (!plan) throw new Error(`Execution Plan not found: ${cleanPlanId}`);

    let dispatch = await this.store.getExecutionDispatchForPlan(plan.id);
    if (dispatch && dispatch.status !== 'prepared') {
      return this.existingOutcome(dispatch);
    }

    const preflight = await this.preflight.preflight(plan.id);
    if (!preflight.dispatchable) {
      return {
        status: 'blocked',
        dispatch,
        preflight,
        adapterInvoked: false,
        attemptRunning: false,
        requiresReconciliation: false,
        message: 'Current preflight blocks manual dispatch.',
      };
    }

    const attempt = await this.store.getAttempt(plan.attemptId);
    if (!attempt || attempt.status !== 'created') {
      return {
        status: 'blocked',
        dispatch,
        preflight,
        adapterInvoked: false,
        attemptRunning: attempt?.status === 'running',
        requiresReconciliation: false,
        message: `Attempt ${plan.attemptId} is not created.`,
      };
    }

    if (!dispatch) {
      dispatch = this.newDispatch(plan);
      try {
        await this.store.createExecutionDispatch(dispatch);
      } catch (error) {
        const raced = await this.store.getExecutionDispatchForPlan(plan.id);
        if (!raced) throw error;
        return this.existingOutcome(raced, 'Another manual dispatch request created this Plan\'s Dispatch.');
      }
    }

    const submitting = this.transition(dispatch, {
      status: 'submitting',
      submittedAt: this.now().toISOString(),
    });
    try {
      await this.store.saveExecutionDispatchTransition(submitting, dispatch.revision);
    } catch (error) {
      const latest = await this.store.getExecutionDispatch(dispatch.id);
      if (!latest) throw error;
      return this.existingOutcome(latest, 'Another caller already claimed this Dispatch for submission.');
    }

    let result: RuntimeDispatchResult;
    try {
      if (!plan.requestedPolicy || !preflight.effectivePolicy
        || !plan.requestedCapabilities || !preflight.effectiveCapabilities) {
        throw new Error('Dispatch requires requested and effective runtime policy and capabilities');
      }
      if (plan.repositoryId && !preflight.executionContext) {
        throw new Error('Repository-bound Dispatch requires a proven execution working directory');
      }
      result = await this.execution.dispatch({
        dispatchId: submitting.id,
        idempotencyKey: submitting.idempotencyKey,
        runtimeAgentId: submitting.runtimeAgentId,
        executionPlanId: submitting.executionPlanId,
        input: { ...plan.input },
        requestedPolicy: { ...plan.requestedPolicy },
        requestedCapabilities: { ...plan.requestedCapabilities },
        ...(preflight.executionContext
          ? { executionContext: { ...preflight.executionContext } }
          : {}),
      });
    } catch (error) {
      result = {
        status: 'uncertain',
        message: `Execution adapter threw after submission began: ${errorMessage(error)}`,
      };
    }

    if (result.status === 'accepted') {
      if (!result.effectivePolicy) {
        result = {
          status: 'uncertain',
          code: 'SUBMISSION_UNCERTAIN',
          message: 'Runtime accepted execution without reporting its effective policy.',
        };
      } else if (!plan.requestedPolicy
        || !isRuntimeExecutionPolicyNoBroaderThan(result.effectivePolicy, plan.requestedPolicy)) {
        result = {
          status: 'uncertain',
          code: 'SUBMISSION_UNCERTAIN',
          message: 'Runtime reported an effective policy broader than the immutable Plan.',
        };
      } else if (!result.effectiveCapabilities) {
        result = {
          status: 'uncertain',
          code: 'SUBMISSION_UNCERTAIN',
          message: 'Runtime accepted execution without reporting its effective tool capabilities.',
        };
      } else if (!plan.requestedCapabilities
        || !isRuntimeExecutionCapabilitiesNoBroaderThan(
          result.effectiveCapabilities,
          plan.requestedCapabilities,
        )) {
        result = {
          status: 'uncertain',
          code: 'SUBMISSION_UNCERTAIN',
          message: 'Runtime reported tool capabilities broader than the immutable Plan.',
        };
      }
    }

    const terminal = this.terminalDispatch(submitting, result);
    try {
      await this.store.saveExecutionDispatchTransition(terminal, submitting.revision);
    } catch (error) {
      return {
        status: 'uncertain',
        dispatch: submitting,
        preflight,
        adapterInvoked: true,
        attemptRunning: false,
        requiresReconciliation: false,
        message: `Runtime result could not be persisted; submission must be resolved manually: ${errorMessage(error)}`,
      };
    }

    if (terminal.status !== 'accepted') {
      return {
        status: terminal.status === 'rejected' ? 'rejected' : 'uncertain',
        dispatch: terminal,
        preflight,
        adapterInvoked: true,
        attemptRunning: false,
        requiresReconciliation: false,
        ...(terminal.message ? { message: terminal.message } : {}),
      };
    }

    try {
      await this.lifecycle.startAttempt(plan.attemptId);
      return {
        status: 'accepted',
        dispatch: terminal,
        preflight,
        adapterInvoked: true,
        attemptRunning: true,
        requiresReconciliation: false,
        ...(terminal.message ? { message: terminal.message } : {}),
      };
    } catch (error) {
      return {
        status: 'accepted',
        dispatch: terminal,
        preflight,
        adapterInvoked: true,
        attemptRunning: false,
        requiresReconciliation: true,
        message: `Runtime accepted the Dispatch, but the Attempt transition needs reconciliation: ${errorMessage(error)}`,
      };
    }
  }

  /** Local repair only. It never invokes the external execution adapter. */
  async reconcileAcceptedDispatch(dispatchId: string): Promise<ManualDispatchOutcome> {
    const dispatch = await this.store.getExecutionDispatch(dispatchId.trim());
    if (!dispatch) throw new Error(`Execution Dispatch not found: ${dispatchId}`);
    if (dispatch.status !== 'accepted') {
      throw new Error(`Only an accepted Dispatch can reconcile an Attempt; ${dispatch.id} is ${dispatch.status}`);
    }
    const attempt = await this.store.getAttempt(dispatch.attemptId);
    if (!attempt) throw new Error(`Attempt not found for Dispatch ${dispatch.id}: ${dispatch.attemptId}`);
    if (attempt.status === 'running') return this.existingOutcome(dispatch);
    if (attempt.status !== 'created') {
      throw new Error(`Accepted Dispatch ${dispatch.id} cannot reconcile Attempt in ${attempt.status}`);
    }
    await this.lifecycle.startAttempt(attempt.id);
    return {
      status: 'accepted',
      dispatch,
      preflight: null,
      adapterInvoked: false,
      attemptRunning: true,
      requiresReconciliation: false,
      message: 'Accepted Dispatch reconciled locally without external resubmission.',
    };
  }

  private newDispatch(plan: DurableExecutionPlan): DurableExecutionDispatch {
    const timestamp = this.now().toISOString();
    return {
      id: this.dispatchIdFactory(),
      executionPlanId: plan.id,
      attemptId: plan.attemptId,
      jobId: plan.jobId,
      runtimeAgentId: plan.runtimeAgentId,
      idempotencyKey: createExecutionDispatchIdempotencyKey(plan.id),
      status: 'prepared',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private transition(
    dispatch: DurableExecutionDispatch,
    change: Partial<DurableExecutionDispatch> & Pick<DurableExecutionDispatch, 'status'>,
  ): DurableExecutionDispatch {
    return {
      ...dispatch,
      ...change,
      revision: dispatch.revision + 1,
      updatedAt: this.now().toISOString(),
    };
  }

  private terminalDispatch(
    submitting: DurableExecutionDispatch,
    result: RuntimeDispatchResult,
  ): DurableExecutionDispatch {
    const resolvedAt = this.now().toISOString();
    return this.transition(submitting, {
      status: result.status,
      ...(result.status === 'accepted' && result.effectivePolicy
        ? { effectivePolicy: { ...result.effectivePolicy } }
        : {}),
      ...(result.status === 'accepted' && result.effectiveCapabilities
        ? { effectiveCapabilities: { ...result.effectiveCapabilities } }
        : {}),
      ...(cleanOptional(result.externalReference) ? { externalReference: cleanOptional(result.externalReference) } : {}),
      ...(cleanOptional(result.message) ? { message: cleanOptional(result.message) } : {}),
      ...(result.status === 'accepted' ? { acceptedAt: resolvedAt } : {}),
      resolvedAt,
    });
  }

  private async existingOutcome(
    dispatch: DurableExecutionDispatch,
    message?: string,
  ): Promise<ManualDispatchOutcome> {
    const attempt = await this.store.getAttempt(dispatch.attemptId);
    const attemptRunning = attempt?.status === 'running';
    if (dispatch.status === 'accepted') {
      return {
        status: 'accepted',
        dispatch,
        preflight: null,
        adapterInvoked: false,
        attemptRunning,
        requiresReconciliation: attempt?.status === 'created',
        message: message ?? (attempt?.status === 'created'
          ? 'Dispatch is accepted; the created Attempt requires local reconciliation.'
          : 'Plan was already accepted; no external resubmission occurred.'),
      };
    }
    if (dispatch.status === 'rejected') {
      return {
        status: 'rejected',
        dispatch,
        preflight: null,
        adapterInvoked: false,
        attemptRunning,
        requiresReconciliation: false,
        message: message ?? 'Plan was already rejected; create a new Attempt and Plan to try again.',
      };
    }
    return {
      status: 'uncertain',
      dispatch,
      preflight: null,
      adapterInvoked: false,
      attemptRunning,
      requiresReconciliation: false,
      message: message ?? `Dispatch is ${dispatch.status}; human resolution is required and resubmission is blocked.`,
    };
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
