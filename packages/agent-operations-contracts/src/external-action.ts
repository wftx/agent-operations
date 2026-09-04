import { createHash } from 'node:crypto';
import type { DurableJob } from './work.js';
export const EXTERNAL_ACTION_MAX_DURATION_MS = 15 * 60_000;

/** Public capability metadata. Bindings are opaque IDs, never credentials or URLs. */
export interface ProjectAction {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly executorId: string;
  readonly bindingId: string;
  readonly risk: 'Green' | 'Yellow' | 'Red';
  readonly systemsRead: readonly string[];
  readonly systemsWritten: readonly string[];
  readonly mutationScope: string;
  readonly credentialRequirements: readonly string[];
  /** Small, closed parameter vocabulary. No arbitrary objects, paths, or commands. */
  readonly parameters: Readonly<Record<string, readonly string[]>>;
  readonly retryPolicy: 'never';
  readonly idempotency: 'unknown' | 'record-upsert-only';
  readonly expectedEvidence: readonly string[];
}

export interface ExternalActionApproval {
  readonly reference: string;
  readonly actor: string;
  readonly approvedAt: string;
  readonly scopeHash: string;
}

export interface ExternalActionPlan {
  readonly id: string;
  readonly jobId: string;
  readonly action: ProjectAction;
  readonly parameters: Readonly<Record<string, string>>;
  readonly scopeHash: string;
  readonly predecessorJobId?: string;
  readonly createdAt: string;
  readonly requestKey: string;
  readonly approval?: ExternalActionApproval;
  readonly state: 'awaiting-approval' | 'approved' | 'executing' | 'completed' | 'failed' | 'uncertain';
  readonly claimedAt?: string;
  readonly revision: number;
}

export interface ExternalActionResult {
  readonly status: 'completed' | 'failed' | 'uncertain';
  readonly verification: 'passed' | 'failed' | 'unavailable';
  readonly sideEffect: 'not-crossed' | 'crossed' | 'possible';
  readonly counts: Readonly<Record<string, number>>;
  /** Fixed safe codes only. Never persist connector error messages or bodies. */
  readonly errorCode?: 'preflight-blocked' | 'external-failure' | 'outcome-uncertain' | 'verification-failed';
  readonly externalRunId?: string;
  readonly payloadSha256?: string;
}

export interface ExternalActionReceipt extends ExternalActionResult {
  readonly id: string;
  readonly planId: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly actionId: string;
  readonly executorId: string;
  readonly approval: ExternalActionApproval;
  readonly scopeHash: string;
  readonly systemsRead: readonly string[];
  readonly systemsWritten: readonly string[];
  readonly mutationScope: string;
  readonly executedAt: string;
  readonly recordedAt: string;
  readonly automaticRetries: 0;
}

export interface ExternalActionExecutor {
  readonly id: string;
  /** Resolves only a preconfigured binding and validates exact allowed scope. No side effects. */
  preflight(plan: ExternalActionPlan): Promise<{ readonly ready: boolean; readonly reason?: 'connector-reauthentication-required' | 'connector-disconnected' | 'connector-unavailable' }>;
  /** Invoked only after the durable, exclusive execution claim. Never retried. */
  execute(plan: ExternalActionPlan, signal: AbortSignal): Promise<ExternalActionResult>;
}

export interface ExternalActionStateStore {
  registerProjectAction(action: ProjectAction): Promise<void>;
  listProjectActions(projectId: string): Promise<readonly ProjectAction[]>;
  createExternalActionJob(job: DurableJob, plan: ExternalActionPlan): Promise<void>;
  getExternalActionPlan(jobId: string): Promise<ExternalActionPlan | null>;
  findExternalActionRequest(requestKey: string): Promise<ExternalActionPlan | null>;
  approveExternalAction(jobId: string, approval: ExternalActionApproval): Promise<void>;
  claimExternalAction(jobId: string, timestamp: string): Promise<boolean>;
  finishExternalAction(receipt: ExternalActionReceipt): Promise<void>;
  getExternalActionReceipt(jobId: string): Promise<ExternalActionReceipt | null>;
}

export function validateExternalReceipt(plan: ExternalActionPlan, receipt: ExternalActionReceipt): void {
  onlyKeys(receipt, ['id','planId','jobId','projectId','actionId','executorId','approval','scopeHash','systemsRead','systemsWritten','mutationScope','executedAt','recordedAt','automaticRetries','status','verification','sideEffect','counts','errorCode','externalRunId','payloadSha256']);
  if (plan.state !== 'executing' || !plan.approval || receipt.planId !== plan.id || receipt.jobId !== plan.jobId
    || receipt.actionId !== plan.action.id || receipt.projectId !== plan.action.projectId
    || receipt.executorId !== plan.action.executorId || receipt.scopeHash !== plan.scopeHash
    || canonical(receipt.approval) !== canonical(plan.approval) || receipt.automaticRetries !== 0
    || receipt.executedAt !== plan.claimedAt || !Number.isFinite(Date.parse(receipt.recordedAt))
    || canonical(receipt.systemsRead) !== canonical(plan.action.systemsRead)
    || canonical(receipt.systemsWritten) !== canonical(plan.action.systemsWritten)
    || receipt.mutationScope !== plan.action.mutationScope) throw new Error('External receipt correlation failed');
  validateExternalResult(receipt);
}
export function validateExternalResult(result: ExternalActionResult): void {
  if (!['completed', 'failed', 'uncertain'].includes(result.status)
    || !['passed', 'failed', 'unavailable'].includes(result.verification)
    || !['not-crossed', 'crossed', 'possible'].includes(result.sideEffect)
    || (result.status === 'completed' && result.verification !== 'passed')
    || (result.errorCode && !['preflight-blocked', 'external-failure', 'outcome-uncertain', 'verification-failed'].includes(result.errorCode))
    || Object.entries(result.counts).length > 30
    || Object.entries(result.counts).some(([key, value]) => !/^[a-zA-Z][a-zA-Z0-9]{0,50}$/.test(key) || !Number.isSafeInteger(value) || value < 0)
    || (result.externalRunId && !/^[a-zA-Z0-9:._-]{1,100}$/.test(result.externalRunId))
    || (result.payloadSha256 && !/^[a-f0-9]{64}$/.test(result.payloadSha256))) throw new Error('Invalid bounded external result');
}

export function externalActionScopeHash(action: ProjectAction, parameters: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(canonical({ action, parameters })).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateProjectAction(action: ProjectAction): void {
  onlyKeys(action, ['id','projectId','name','executorId','bindingId','risk','systemsRead','systemsWritten','mutationScope','credentialRequirements','parameters','retryPolicy','idempotency','expectedEvidence']);
  if (!action.id.startsWith('action:') || !action.projectId.startsWith('project:')
    || !/^[a-z0-9][a-z0-9:/._-]{0,159}$/i.test(action.executorId)
    || !/^[a-z0-9][a-z0-9:._-]{0,159}$/i.test(action.bindingId)
    || !['Green', 'Yellow', 'Red'].includes(action.risk) || action.retryPolicy !== 'never'
    || !['unknown', 'record-upsert-only'].includes(action.idempotency)) throw new Error('Invalid bounded action definition');
  if (JSON.stringify(action).length > 8000) throw new Error('Action metadata exceeds bound');
  if (!action.name.trim() || !action.mutationScope.trim() || [action.systemsRead,action.systemsWritten,action.credentialRequirements,action.expectedEvidence]
    .some(values => !Array.isArray(values) || values.length > 20 || values.some(v => typeof v !== 'string' || !v.trim() || v.length > 500))) throw new Error('Invalid public action metadata');
  for (const [key, values] of Object.entries(action.parameters)) {
    if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(key) || !Array.isArray(values) || !values.length
      || values.some(value => !/^[a-z0-9_-]{1,80}$/i.test(value))) throw new Error('Invalid closed action parameter schema');
  }
}
export function validateExternalActionPlan(job: DurableJob, plan: ExternalActionPlan): void {
  validateProjectAction(plan.action);
  if (job.executionMode !== 'external-action' || job.projectId !== plan.action.projectId || job.id !== plan.jobId
    || job.status !== 'draft' || job.revision !== 0 || job.repositoryId || job.preferredRuntimeAgentId
    || plan.state !== 'awaiting-approval' || plan.approval || plan.revision !== 0 || !plan.id.startsWith('external-plan:')
    || !plan.requestKey.trim() || plan.requestKey.length > 200
    || plan.scopeHash !== externalActionScopeHash(plan.action, plan.parameters)) throw new Error('Invalid external action plan');
  if (canonical(Object.keys(plan.parameters).sort()) !== canonical(Object.keys(plan.action.parameters).sort())
    || Object.entries(plan.parameters).some(([key, value]) => !plan.action.parameters[key]?.includes(value))) {
    throw new Error('Action parameters are outside configured capability');
  }
}
export function validateExternalApproval(plan: ExternalActionPlan, approval: ExternalActionApproval): void {
  onlyKeys(approval,['reference','actor','approvedAt','scopeHash']);
  if (approval.scopeHash !== plan.scopeHash || !approval.actor.trim() || !approval.reference.trim()
    || approval.reference.length > 500 || approval.actor.length > 100 || !Number.isFinite(Date.parse(approval.approvedAt))) {
    throw new Error('Approval must bind the exact action scope');
  }
}
function onlyKeys(value: object, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected field in bounded external action evidence');
}
