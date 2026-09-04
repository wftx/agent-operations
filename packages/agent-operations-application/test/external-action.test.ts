import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAgentOperationsStateStore, type AgentOperationsStateStore, type ExternalActionExecutor, type ProjectAction } from '../../agent-operations-contracts/src/index.js';
import { SqliteAgentOperationsStateStore } from '../../sqlite-state-adapter/src/index.js';
import { ExternalActionService } from '../src/external-action-service.js';
import { OperatorRunner } from '../src/operator-runner.js';
import { JobLifecycleService, JobRetirementService } from '../../agent-operations-core/src/index.js';
import { OperatorApplicationService } from '../src/operator-application-service.js';
import { OrchestratorToolApplicationService } from '../src/orchestrator-tool-application-service.js';
import { OperatorWebApplication } from '../../../apps/ao-web/src/app.js';
import { AO_ORCHESTRATOR_DYNAMIC_TOOLS } from '../../../src/pty/codex-app-server-pty.js';
import { readFileSync } from 'node:fs';

const time = '2026-09-04T12:00:00.000Z';
const action: ProjectAction = {id:'action:sync-v1',projectId:'project:one',name:'Production sync',executorId:'sync/v1',bindingId:'binding:production',risk:'Red',
  systemsRead:['CRM production'],systemsWritten:['Dashboard production'],mutationScope:'Upsert financial rows and append sync history; no CRM writes',
  credentialRequirements:['crm-read','ingestion'],parameters:{mode:['full']},retryPolicy:'never',idempotency:'record-upsert-only',expectedEvidence:['counts','aggregate-readback']};
const cleanup: (() => unknown)[] = [];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse()) await f();});

for (const kind of ['memory','sqlite'] as const) describe(`external action ${kind}`,()=>{
  async function fixture(executor?: ExternalActionExecutor) {
    const dir = mkdtempSync(join(tmpdir(),'ao-external-'));
    cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
    const store: AgentOperationsStateStore = kind==='sqlite' ? SqliteAgentOperationsStateStore.open({databasePath:join(dir,'state.db')}) : new InMemoryAgentOperationsStateStore();
    cleanup.push(()=>store.close());
    await store.applyProjectConfiguration({project:{id:action.projectId,name:'Project',createdAt:time,updatedAt:time},repositories:[],checkoutBindings:[],runtimeAgentIds:[]});
    const execute = vi.fn(async()=>({status:'completed' as const,verification:'passed' as const,sideEffect:'crossed' as const,counts:{upserted:3}}));
    const service = new ExternalActionService(store,[executor ?? {id:'sync/v1',preflight:async()=>({ready:true}),execute}],()=>new Date(time));
    await service.register(action);
    const input={projectId:action.projectId,actionId:action.id,parameters:{mode:'full'},title:'Sync',task:'Run approved sync',acceptanceCriteria:'Verify exact results',requestKey:'intent:one'};
    const plan=await service.create(input);
    const approval={reference:'human-approval:original',actor:'human',approvedAt:time,scopeHash:plan.scopeHash};
    return {store,service,execute,input,plan,approval};
  }
  it('plans without a repository and requires exact Red approval; discoverable action is immutable',async()=>{
    const f=await fixture();
    expect((await f.store.getJob(f.plan.jobId))?.executionMode).toBe('external-action');
    expect((await f.service.list(action.projectId))[0]).toEqual(action);
    await expect(f.service.execute(f.plan.jobId)).rejects.toThrow('approval');
    await expect(f.service.approve(f.plan.jobId,{...f.approval,scopeHash:'other'})).rejects.toThrow('scope');
    await expect(f.service.register({...action,systemsWritten:['Other']})).rejects.toThrow('immutable');
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('rejects arbitrary action and parameter authority',async()=>{
    const f=await fixture();
    await expect(f.service.create({...f.input,requestKey:'other',actionId:'action:shell'})).rejects.toThrow('configured');
    await expect(f.service.create({...f.input,requestKey:'other',parameters:{mode:'full',command:'rm'}})).rejects.toThrow('parameters');
    expect(await f.store.listJobs()).toHaveLength(1);
  });
  it('invokes exactly once across duplicates, completes from immutable evidence, never uses Worker runner',async()=>{
    const f=await fixture();
    expect((await f.service.create(f.input)).jobId).toBe(f.plan.jobId);
    await f.service.approve(f.plan.jobId,f.approval);
    await f.service.approve(f.plan.jobId,f.approval);
    await Promise.all([f.service.execute(f.plan.jobId),f.service.execute(f.plan.jobId)]);
    const receipt=await f.service.execute(f.plan.jobId);
    expect(receipt?.status).toBe('completed');expect(f.execute).toHaveBeenCalledTimes(1);
    expect((await f.store.getJob(f.plan.jobId))?.status).toBe('completed');
    expect(await f.store.listAttemptsForJob(f.plan.jobId)).toEqual([]);
    await expect(f.store.finishExternalAction({...receipt!,counts:{upserted:4}})).rejects.toThrow('immutable');
    const runJob=vi.fn(); await new OperatorRunner(f.store,{runJob}).wake(); expect(runJob).not.toHaveBeenCalled();
  });
  it('records uncertainty without raw connector errors and never retries or retires it',async()=>{
    const execute=vi.fn(async()=>{throw new Error('SECRET_RAW_RESPONSE');});
    const f=await fixture({id:'sync/v1',preflight:async()=>({ready:true}),execute});
    await f.service.approve(f.plan.jobId,f.approval);
    const receipt=await f.service.execute(f.plan.jobId);
    expect(receipt?.status).toBe('uncertain');expect(JSON.stringify(receipt)).not.toContain('SECRET');
    await f.service.execute(f.plan.jobId);expect(execute).toHaveBeenCalledTimes(1);
    expect((await f.store.getOperatorRunForJob(f.plan.jobId))?.status).toBe('needs_human');
    expect((await new JobRetirementService(f.store, {} as never).assess(f.plan.jobId)).safe).toBe(false);
    await expect(new JobLifecycleService(f.store).cancelJob(f.plan.jobId)).rejects.toThrow('reconciliation');
  });
  it('blocked binding preserves authorization without invocation or duplicate escalation',async()=>{
    const execute=vi.fn();const f=await fixture({id:'sync/v1',preflight:async()=>({ready:false}),execute});
    await f.service.approve(f.plan.jobId,f.approval);
    await f.service.execute(f.plan.jobId);await f.service.execute(f.plan.jobId);
    expect(execute).not.toHaveBeenCalled();expect((await f.service.inspect(f.plan.jobId)).plan?.approval).toEqual(f.approval);
    expect((await f.store.listEscalations(f.plan.jobId)).filter(e=>e.reason==='policy_blocked')).toHaveLength(1);
  });
  it('a crash after durable claim cannot resend and is not picked up by Worker runner',async()=>{
    const f=await fixture();await f.service.approve(f.plan.jobId,f.approval);
    expect(await f.store.claimExternalAction(f.plan.jobId,time)).toBe(true);
    await expect(f.service.execute(f.plan.jobId)).rejects.toThrow('never retry');
    expect(await f.store.claimExternalAction(f.plan.jobId,time)).toBe(false);
    const runJob=vi.fn();await new OperatorRunner(f.store,{runJob}).wake();expect(runJob).not.toHaveBeenCalled();
    expect((await new JobRetirementService(f.store, {} as never).assess(f.plan.jobId)).safe).toBe(false);
    expect((await f.store.getExternalActionReceipt(f.plan.jobId))?.status).toBe('uncertain');
    expect((await f.store.getOperatorRunForJob(f.plan.jobId))?.status).toBe('needs_human');
  });
  it('atomically creates only one linked successor and preserves immutable original mode',async()=>{
    const f=await fixture();
    const life=new JobLifecycleService(f.store);
    const old=await life.createJob({projectId:action.projectId,title:'Misclassified sync',description:'Original human authorization',executionMode:'repository-write-isolated'});
    await life.markJobReady(old.id);
    const nextInput={...f.input,requestKey:`correction:${old.id}`,predecessorJobId:old.id};
    const next=await f.service.create(nextInput);
    expect((await f.service.create(nextInput)).jobId).toBe(next.jobId);
    const original=await f.store.getJob(old.id);
    expect(original?.status).toBe('cancelled');expect(original?.executionMode).toBe('repository-write-isolated');expect(original?.description).toBe('Original human authorization');
    expect((await f.store.getJobRetirement(old.id))?.evidenceReference).toBe(next.jobId);
    await expect(f.service.create({...nextInput,requestKey:'different'})).rejects.toThrow();
  });
  it('Orchestrator discovers and requests the exact action without repository or approval authority',async()=>{
    const f=await fixture();const operator=new OperatorApplicationService(f.store,{} as never,{deferRunnerWake:true});
    const tools=new OrchestratorToolApplicationService(operator,undefined,undefined,f.service);
    const discovery=await tools.execute({name:'ao.actions.list',arguments:{projectId:action.projectId}});
    expect(discovery.data).toEqual([action]);
    const args={projectId:action.projectId,title:'Sync through configured action',task:'Run sync',acceptanceCriteria:'Verify counts',executionMode:'external-action',actionId:action.id,actionParameters:{mode:'full'},requestKey:'orchestrator:one'};
    const result=await tools.execute({name:'ao.jobs.create',arguments:args});
    expect(result.ok).toBe(true);expect(result.relatedJobIds).toHaveLength(1);
    expect((await tools.execute({name:'ao.jobs.create',arguments:args})).relatedJobIds).toEqual(result.relatedJobIds);
    const p=await f.store.getExternalActionPlan(result.relatedJobIds[0]!);expect(p?.approval).toBeUndefined();expect(f.execute).not.toHaveBeenCalled();
    expect((await tools.execute({name:'ao.jobs.create',arguments:{...args,executionMode:'repository-write-isolated'}})).ok).toBe(false);
    const schema=JSON.stringify(AO_ORCHESTRATOR_DYNAMIC_TOOLS);
    expect(schema).toContain('actions_list');expect(schema).toContain('external-action');expect(schema).toContain('actionParameters');
    expect(schema).not.toContain('external_actions_approve');
    expect(readFileSync('scripts/ao-orchestrator-tool.ts','utf8')).toContain("'ao.actions.list'");
  });
  it('Web renders exact scope and receipt, GET never executes, duplicate POST cannot invoke twice',async()=>{
    const f=await fixture();const operator=new OperatorApplicationService(f.store,{} as never,{deferRunnerWake:true});
    const web=new OperatorWebApplication(operator,{}, {},undefined,undefined,undefined,undefined,undefined,undefined,f.service);
    const url=`http://127.0.0.1/jobs/${encodeURIComponent(f.plan.jobId)}`;
    const initial=await web.handle(new Request(url));expect(initial.status).toBe(200);
    expect(await initial.text()).toContain('Approve and Execute Once');expect(f.execute).not.toHaveBeenCalled();
    const post=()=>web.handle(new Request(`${url}/external-action`,{method:'POST',body:new URLSearchParams({scopeHash:f.plan.scopeHash,confirm:'execute-once'})}));
    expect((await post()).status).toBe(303);expect((await post()).status).toBe(303);expect(f.execute).toHaveBeenCalledTimes(1);
    const rendered=await (await web.handle(new Request(url))).text();expect(rendered).toContain('Immutable execution receipt');expect(rendered).toContain('completed');
    await expect(f.store.createAttempt({id:'attempt:forbidden',jobId:f.plan.jobId,status:'created',revision:0,createdAt:time,updatedAt:time})).rejects.toThrow('provider Attempts');
  });
});
