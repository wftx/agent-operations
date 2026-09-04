import { randomUUID } from 'node:crypto';
import type { AgentOperationsStateStore, ExternalActionExecutor, ExternalActionPlan, ExternalActionReceipt, ExternalActionApproval, ExternalActionResult, ProjectAction } from '../../agent-operations-contracts/src/index.js';
import { EXTERNAL_ACTION_MAX_DURATION_MS, externalActionScopeHash, validateExternalResult } from '../../agent-operations-contracts/src/index.js';

export interface ExternalActionRequest {
  readonly projectId: string;
  readonly actionId: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly title: string;
  readonly task: string;
  readonly acceptanceCriteria: string;
  readonly requestKey: string;
  readonly predecessorJobId?: string;
}

/** No provider Worker, shell, filesystem, credential values, or connector catalog. */
export class ExternalActionService {
  constructor(private readonly store: AgentOperationsStateStore,
    private readonly executors: readonly ExternalActionExecutor[] = [],
    private readonly now: () => Date = () => new Date()) {}

  async list(projectId: string): Promise<readonly ProjectAction[]> { return this.store.listProjectActions(projectId); }
  async inspect(jobId: string) {
    return {plan:await this.store.getExternalActionPlan(jobId),receipt:await this.store.getExternalActionReceipt(jobId)};
  }
  async register(action: ProjectAction) { await this.store.registerProjectAction(action); }

  async create(input: ExternalActionRequest): Promise<ExternalActionPlan> {
    if (!input.requestKey.trim() || input.requestKey.length > 200 || !input.title.trim() || input.title.length > 200
      || !input.task.trim() || input.task.length > 16384 || !input.acceptanceCriteria.trim() || input.acceptanceCriteria.length > 8192) throw new Error('Invalid external action request');
    const prior = await this.store.findExternalActionRequest(input.requestKey);
    if (prior) {
      if (prior.action.projectId !== input.projectId || prior.action.id !== input.actionId
        || prior.scopeHash !== externalActionScopeHash(prior.action,input.parameters)) throw new Error('Request key already bound to another scope');
      return prior;
    }
    const action = (await this.list(input.projectId)).find(a => a.id === input.actionId);
    if (!action) throw new Error('Project does not have that configured external action. Do not substitute a repository Job.');
    const time = this.now().toISOString();
    const jobId = `job:${randomUUID()}`;
    const plan: ExternalActionPlan = {
      id:`external-plan:${randomUUID()}`, jobId, action, parameters:input.parameters,
      requestKey:input.requestKey, scopeHash:externalActionScopeHash(action,input.parameters),
      ...(input.predecessorJobId ? {predecessorJobId:input.predecessorJobId} : {}),
      createdAt:time,state:'awaiting-approval',revision:0,
    };
    try {
      await this.store.createExternalActionJob({id:jobId,projectId:input.projectId,title:input.title,description:input.task,
        acceptanceCriteria:input.acceptanceCriteria,executionMode:'external-action',status:'draft',revision:0,createdAt:time,updatedAt:time},plan);
    } catch (error) {
      const concurrent = await this.store.findExternalActionRequest(input.requestKey);
      if (concurrent?.scopeHash === plan.scopeHash && concurrent.predecessorJobId === plan.predecessorJobId) return concurrent;
      throw error;
    }
    return plan;
  }

  /** Human application authority only. Deliberately absent from Orchestrator tools. */
  async approve(jobId: string, approval: ExternalActionApproval) { await this.store.approveExternalAction(jobId,approval); }

  async execute(jobId: string): Promise<ExternalActionReceipt | null> {
    const existing = await this.store.getExternalActionReceipt(jobId);
    if (existing) return existing;
    const plan = await this.store.getExternalActionPlan(jobId);
    if (!plan?.approval) throw new Error('Exact human action approval is required');
    if (plan.state !== 'approved') throw new Error('External action already claimed. Reconcile evidence; never retry.');
    const executor = this.executors.find(e => e.id === plan.action.executorId);
    let ready = false;
    try { ready = !!executor && (await executor.preflight(plan)).ready; } catch { /* Do not surface connector errors or secrets. */ }
    if (!ready) {
      const summary = 'Configured external action binding is unavailable or failed exact scope validation. No external invocation occurred. Existing approval is preserved.';
      if (!(await this.store.listEscalations(jobId)).some(e => !e.resolvedAt && e.summary === summary)) {
        await this.store.createEscalation({id:`escalation:${randomUUID()}`,jobId,reason:'policy_blocked',summary,createdAt:this.now().toISOString()});
      }
      return null;
    }
    const time = this.now().toISOString();
    if (!await this.store.claimExternalAction(jobId,time)) return this.store.getExternalActionReceipt(jobId);
    let result: ExternalActionResult;
    const controller=new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('External action deadline exceeded'));},EXTERNAL_ACTION_MAX_DURATION_MS);});
      const raw = await Promise.race([executor!.execute({...plan,state:'executing',claimedAt:time},controller.signal),deadline]);
      validateExternalResult(raw);
      // Explicit projection excludes arbitrary connector payload/secret fields.
      result = {status:raw.status,verification:raw.verification,sideEffect:raw.sideEffect,counts:raw.counts,
        ...(raw.errorCode ? {errorCode:raw.errorCode} : {}), ...(raw.externalRunId ? {externalRunId:raw.externalRunId} : {}),
        ...(raw.payloadSha256 ? {payloadSha256:raw.payloadSha256} : {})};
    } catch {
      result = {status:'uncertain',verification:'unavailable',sideEffect:'possible',counts:{},errorCode:'outcome-uncertain'};
    } finally {
      if(timer)clearTimeout(timer);
    }
    const receipt: ExternalActionReceipt = {
      ...result,id:`external-receipt:${randomUUID()}`,planId:plan.id,jobId,projectId:plan.action.projectId,
      actionId:plan.action.id,executorId:plan.action.executorId,approval:plan.approval,scopeHash:plan.scopeHash,
      systemsRead:plan.action.systemsRead,systemsWritten:plan.action.systemsWritten,mutationScope:plan.action.mutationScope,
      executedAt:time,recordedAt:this.now().toISOString(),automaticRetries:0,
    };
    await this.store.finishExternalAction(receipt);
    return receipt;
  }
}
