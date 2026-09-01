import type {
  AgentOperationsStateStore,
  DurableExecutionDispatch,
  DurableJobAttempt,
  DurableWorkerBudgetExtension,
} from '../../agent-operations-contracts/src/index.js';

export interface WorkerExecutionBudget {
  /** Every durable Worker Attempt, including preparation-only failures. */
  readonly historicalAttempts: readonly DurableJobAttempt[];
  /** Worker Attempts whose Dispatch crossed, or may have crossed, submission. */
  readonly consumingAttempts: readonly DurableJobAttempt[];
  readonly automaticMaximum: number;
  readonly humanExtensions: readonly DurableWorkerBudgetExtension[];
  readonly authorizedMaximum: number;
  readonly consumed: number;
  readonly automaticBudgetExhausted: boolean;
  readonly remaining: number;
  readonly exhausted: boolean;
}

/**
 * `prepared` is local intent only. `submitting` is persisted immediately before
 * the provider adapter is invoked, so it and every terminal Dispatch state
 * conservatively consume one execution slot for exactly-once safety.
 */
export function dispatchConsumesWorkerExecutionBudget(
  dispatch: Pick<DurableExecutionDispatch, 'status' | 'submittedAt'>,
): boolean {
  return dispatch.status !== 'prepared' || dispatch.submittedAt !== undefined;
}

export async function readWorkerExecutionBudget(
  store: AgentOperationsStateStore,
  attempts: readonly DurableJobAttempt[],
  maximum: number,
): Promise<WorkerExecutionBudget> {
  if (!Number.isInteger(maximum) || maximum < 0) {
    throw new Error('Worker execution budget maximum must be a non-negative integer');
  }
  const historicalAttempts = attempts.filter(attempt => attempt.executionRole === 'worker');
  const consumingAttempts: DurableJobAttempt[] = [];
  for (const attempt of historicalAttempts) {
    const plan = await store.getExecutionPlanForAttempt(attempt.id);
    const dispatch = plan ? await store.getExecutionDispatchForPlan(plan.id) : null;
    if (dispatch && dispatchConsumesWorkerExecutionBudget(dispatch)) {
      consumingAttempts.push(attempt);
    }
  }
  const consumed = consumingAttempts.length;
  const jobId = historicalAttempts[0]?.jobId;
  const humanExtensions = jobId ? await store.listWorkerBudgetExtensions(jobId) : [];
  const authorizedMaximum = maximum + humanExtensions.reduce(
    (total, extension) => total + extension.additionalWorkerExecutions,
    0,
  );
  return {
    historicalAttempts,
    consumingAttempts,
    automaticMaximum: maximum,
    humanExtensions,
    authorizedMaximum,
    consumed,
    automaticBudgetExhausted: consumed >= maximum,
    remaining: Math.max(0, authorizedMaximum - consumed),
    exhausted: consumed >= authorizedMaximum,
  };
}
