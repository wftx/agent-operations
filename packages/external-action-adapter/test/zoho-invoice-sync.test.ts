import { describe, expect, it, vi } from 'vitest';
import { ZohoInvoiceSyncExecutor } from '../src/zoho-invoice-sync-executor.js';
import type { ExternalActionPlan } from '../../agent-operations-contracts/src/index.js';
const plan = {scopeHash:'exact',parameters:{mode:'full'},action:{executorId:'zoho-invoice-normalized-sync/v1'}} as unknown as ExternalActionPlan;
const raw = {
  payments:{payment_id:'p1',customer_name:'Example',date:'2026-09-04',amount:12},
  estimates:{estimate_id:'e1',estimate_number:'1',customer_name:'Example',date:'2026-09-04',total:30,status:'sent'},
  invoices:{invoice_id:'i1',invoice_number:'1',customer_name:'Example',date:'2026-09-04',total:20,balance:10,status:'overdue'},
};
const readPage = vi.fn(async(kind: keyof typeof raw,page:number)=>({page,records:[raw[kind]],hasMore:false}));
const summary = {asOf:'2026-09-04',monthToDate:{start:'2026-09-01',paymentsCents:1200},activeSentPipeline:{count:1,cents:3000},openInvoices:{count:1,totalCents:1000},lastSuccessfulSyncAt:'2026-09-04T12:00:00.000Z'};
const postResult = {ok:true,mode:'full',rejected:0,upserted:{payments:1,estimates:1,invoices:1},syncedAt:'2026-09-04T12:00:00.000Z'};
describe('bounded Zoho normalized sync',()=>{
  it('reads every kind, sends one normalized payload, verifies counts and aggregates',async()=>{
    const postOnce=vi.fn(async()=>postResult);const readSummary=vi.fn(async()=>summary);
    const e=new ZohoInvoiceSyncExecutor('exact',{organizationId:'verified-org',readPage},{postOnce,readSummary});
    const result=await e.execute(plan);
    expect(result.status).toBe('completed');expect(result.counts.paymentsUpserted).toBe(1);
    expect(postOnce).toHaveBeenCalledTimes(1);expect(readSummary).toHaveBeenCalledTimes(1);
    const payload=(postOnce.mock.calls as unknown[][])[0]![0] as Record<string,unknown>;
    expect(payload['payments']).toEqual([expect.objectContaining({zohoPaymentId:'p1',amount:12,paymentDate:'2026-09-04'})]);
    expect(result.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('refuses missing account binding or altered action scope before all external access',async()=>{
    const e=new ZohoInvoiceSyncExecutor('exact',null,null);
    expect((await e.preflight(plan)).ready).toBe(false);
    expect((await e.execute(plan)).sideEffect).toBe('not-crossed');
    const postOnce=vi.fn();const e2=new ZohoInvoiceSyncExecutor('different',{organizationId:'org',readPage},{postOnce,readSummary:vi.fn()});
    await e2.execute(plan);expect(postOnce).not.toHaveBeenCalled();
  });
  it('invalid pagination or a duplicate page cannot cause a partial upload',async()=>{
    const postOnce=vi.fn();const read=vi.fn(async(_kind:string,page:number)=>({page,records:[raw.payments],hasMore:true}));
    const e=new ZohoInvoiceSyncExecutor('exact',{organizationId:'org',readPage:read},{postOnce,readSummary:vi.fn()});
    expect((await e.execute(plan)).sideEffect).toBe('not-crossed');expect(postOnce).not.toHaveBeenCalled();expect(read).toHaveBeenCalledTimes(2);
  });
  it('timeout or error after POST is uncertain and never triggers a second POST',async()=>{
    const postOnce=vi.fn(async()=>{throw new Error('secret payload');});
    const e=new ZohoInvoiceSyncExecutor('exact',{organizationId:'org',readPage},{postOnce,readSummary:vi.fn()});
    const result=await e.execute(plan);expect(result.status).toBe('uncertain');expect(postOnce).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('a database failure response or divergent readback cannot claim no writes or success',async()=>{
    for(const response of [{ok:false,error:'sync_failed'},postResult]) {
      const e=new ZohoInvoiceSyncExecutor('exact',{organizationId:'org',readPage},{postOnce:async()=>response,readSummary:async()=>({...summary,openInvoices:{count:2,totalCents:1000}})});
      const result=await e.execute(plan);expect(result.status).toBe('uncertain');expect(result.sideEffect).toBe('possible');
    }
  });
});
