import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAgentOperationsStateStore } from '../../sqlite-state-adapter/src/index.js';
import { NodeConnectorSecretStore } from '../src/connector-secrets.js';
import { ZohoConnector, DEFAULT_ZOHO_CALLBACK } from '../src/zoho-connector.js';
import { ZOHO_READ_SCOPES } from '../../agent-operations-contracts/src/connector.js';
import { ConnectedZohoExecutor } from '../src/connected-zoho-executor.js';
import { externalActionScopeHash, type ProjectAction, type ExternalActionPlan } from '../../agent-operations-contracts/src/external-action.js';
import { ExternalActionService } from '../../agent-operations-application/src/external-action-service.js';
const dirs:string[]=[];const stores:SqliteAgentOperationsStateStore[]=[];
afterEach(async()=>{for(const s of stores.splice(0))await s.close();for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
const client={clientId:'fake-client-id',clientSecret:'fake-client-secret',organizationId:'12345',dataCenter:'us' as const};
const nonce='a'.repeat(64);
function fixture(options:{scope?:string;callbackUrl?:string;onVerified?:NonNullable<ConstructorParameters<typeof ZohoConnector>[3]>['onVerified']}={}) {
  const root=mkdtempSync(join(tmpdir(),'ao-connector-'));dirs.push(root);
  const store=SqliteAgentOperationsStateStore.open({databasePath:join(root,'state.db')});stores.push(store);
  const vault=new NodeConnectorSecretStore(join(root,'secret-store'));let now=Date.parse('2026-09-04T12:00:00Z');
  let failRefresh=false;let failRead=false;let omitRefreshScope=false;let scope=options.scope??ZOHO_READ_SCOPES.join(' ');
  const calls:{url:URL;init:RequestInit}[]=[];
  const transport=vi.fn(async(input:URL|string|Request,init:RequestInit={})=>{
    const url=new URL(String(input));calls.push({url,init});
    if(url.pathname==='/oauth/v2/token'){
      const refresh=new URLSearchParams(String(init.body)).get('grant_type')==='refresh_token';
      return Response.json(refresh&&failRefresh?{error:'invalid_grant'}:{access_token:'fake-access-token',...(!refresh?{refresh_token:'fake-refresh-token'}:{}),...(!refresh||!omitRefreshScope?{scope}:{}),expires_in:3600,api_domain:'https://www.zohoapis.com'});
    }
    if(failRead)return Response.json({message:'fake-access-token'},{status:403});
    const kind=url.pathname.split('/').at(-1)!;
    return Response.json({code:0,[kind]:[],page_context:{page:Number(url.searchParams.get('page')),has_more_page:false}});
  }) as unknown as typeof fetch;
  const c=new ZohoConnector(store,vault,'installation:test',{transport,now:()=>now,...options});
  const login=async()=>{await c.configure(client);const u=new URL(await c.connect(nonce));await c.callback(u.searchParams.get('state')!,'fake-auth-code',nonce);return u;};
  return {c,store,vault,root,calls,login,expire:()=>{now+=3600_000;},failRefresh:()=>{failRefresh=true;},failRead:()=>{failRead=true;},omitRefreshScope:()=>{omitRefreshScope=true;},scope:(v:string)=>{scope=v;}};
}
describe('node scoped Zoho connection',()=>{
  it('connects without execution, then permits one exact approved sync and no duplicate invocation',async()=>{
    const f=fixture();const time='2026-09-04T12:00:00.000Z';
    await f.store.applyProjectConfiguration({project:{id:'project:test',name:'Fake project',createdAt:time,updatedAt:time},repositories:[],checkoutBindings:[],runtimeAgentIds:[]});
    const action:ProjectAction={id:'action:test',projectId:'project:test',name:'Fake sync',executorId:'zoho-invoice-normalized-sync/v1',bindingId:'binding:test',risk:'Red',systemsRead:['Fake Zoho'],systemsWritten:['Fake Pulse'],mutationScope:'One normalized payload',credentialRequirements:['fake'],parameters:{mode:['full']},retryPolicy:'never',idempotency:'record-upsert-only',expectedEvidence:['counts']};
    await f.store.registerProjectAction(action);
    const postOnce=vi.fn(async()=>({ok:true,mode:'full',rejected:0,upserted:{payments:0,estimates:0,invoices:0},syncedAt:time}));
    const readSummary=vi.fn(async()=>({asOf:'2026-09-04',monthToDate:{start:'2026-09-01',paymentsCents:0},activeSentPipeline:{count:0,cents:0},openInvoices:{count:0,totalCents:0},lastSuccessfulSyncAt:time}));
    const executor=new ConnectedZohoExecutor(f.c,f.store,async()=>action,{postOnce,readSummary});
    const service=new ExternalActionService(f.store,[executor],()=>new Date(time));
    const p=await service.create({projectId:action.projectId,actionId:action.id,parameters:{mode:'full'},title:'Fake sync',task:'Test',acceptanceCriteria:'Verify',requestKey:'fake:one'});
    await f.login();const b=(await f.c.inspect())!;await f.store.pinConnectorActionLink({actionBindingId:action.bindingId,connectorId:b.id,organizationId:b.organizationId,dataCenter:b.dataCenter});
    expect(postOnce).not.toHaveBeenCalled();expect(await f.store.getExternalActionReceipt(p.jobId)).toBeNull();
    await service.approve(p.jobId,{actor:'fake-human',approvedAt:time,reference:'fake:approval',scopeHash:p.scopeHash});
    const receipt=await service.execute(p.jobId);expect(receipt?.status).toBe('completed');
    expect(await service.execute(p.jobId)).toEqual(receipt);expect(postOnce).toHaveBeenCalledTimes(1);
    expect(await f.store.listAttemptsForJob(p.jobId)).toHaveLength(0);expect(JSON.stringify(receipt)).not.toMatch(/fake-access-token|fake-refresh-token|fake-client-secret/);
    expect(f.calls.every(c=>c.url.pathname==='/oauth/v2/token'||c.init.method==='GET')).toBe(true);
  });
  it('stores only validated metadata in SQLite and protects client configuration on disk',async()=>{
    const f=fixture();await f.c.configure(client);const b=(await f.c.inspect())!;
    expect(b.status).toBe('disconnected');expect(JSON.stringify(b)).not.toMatch(/fake-client|fake-access|fake-refresh/);
    expect(statSync(join(f.root,'secret-store')).mode&0o777).toBe(0o700);
    const file=readdirSync(join(f.root,'secret-store'))[0]!;expect(statSync(join(f.root,'secret-store',file)).mode&0o777).toBe(0o600);
    expect(f.vault.read(b.secretReference)?.clientSecret).toBe(client.clientSecret);
    await expect(f.store.saveConnector({...b,clientSecret:'forbidden'} as typeof b)).rejects.toThrow('Invalid safe');
    expect(readFileSync(join(f.root,'state.db')).includes(Buffer.from(client.clientSecret))).toBe(false);
    await expect(f.vault.exclusive('secret:../../escape',async()=>{})).rejects.toThrow();
  });
  it('requests exact read scopes and offline consent, exchanges once and verifies only three APIs',async()=>{
    const f=fixture();const url=await f.login();expect(url.searchParams.get('scope')).toBe(ZOHO_READ_SCOPES.join(','));
    expect(url.searchParams.get('access_type')).toBe('offline');expect(url.searchParams.get('redirect_uri')).toBe(DEFAULT_ZOHO_CALLBACK);
    expect(f.calls.map(c=>[c.url.pathname,c.init.method])).toEqual([['/oauth/v2/token','POST'],['/invoice/v3/customerpayments','GET'],['/invoice/v3/estimates','GET'],['/invoice/v3/invoices','GET']]);
    expect(f.calls.slice(1).every(c=>c.url.searchParams.get('organization_id')==='12345')).toBe(true);
    expect(await f.c.inspect()).toMatchObject({status:'connected',organizationId:'12345',scopes:[...ZOHO_READ_SCOPES]});
    const before=f.calls.length;await expect(f.c.callback(url.searchParams.get('state')!,'fake-auth-code',nonce)).rejects.toThrow('state');expect(f.calls.length).toBe(before);
  });
  it('rejects state from another browser or expired flow before exchange',async()=>{
    const f=fixture();await f.c.configure(client);const u=new URL(await f.c.connect(nonce));
    await expect(f.c.callback('b'.repeat(64),'fake-auth-code',nonce)).rejects.toThrow('state');
    await expect(f.c.callback(u.searchParams.get('state')!,'fake-auth-code','b'.repeat(64))).rejects.toThrow('state');
    f.expire();await expect(f.c.callback(u.searchParams.get('state')!,'fake-auth-code',nonce)).rejects.toThrow('state');expect(f.calls).toHaveLength(0);
  });
  it.each(['', 'ZohoInvoice.invoices.READ',ZOHO_READ_SCOPES.join(' ')+ ' ZohoInvoice.invoices.CREATE'])('fails closed on missing or wrong scopes: %s',async scope=>{
    const f=fixture({scope});await expect(f.login()).rejects.toThrow('could not be verified');expect(await f.c.inspect()).toMatchObject({status:'unauthorized'});expect(f.calls).toHaveLength(1);
  });
  it('refreshes after an hour, retains refresh token and does not refresh merely on view',async()=>{
    const f=fixture();await f.login();f.expire();expect((await f.c.inspect())?.status).toBe('expired');expect(f.calls).toHaveLength(4);
    expect(await f.c.verify()).toBe(true);expect(f.calls.filter(c=>c.url.pathname==='/oauth/v2/token')).toHaveLength(2);
    expect(f.vault.read((await f.c.inspect())!.secretReference)?.refreshToken).toBe('fake-refresh-token');
    expect((await f.c.inspect())?.status).toBe('connected');
  });
  it('permanent refresh failure is actionable and does not retry',async()=>{
    const f=fixture();await f.login();f.expire();f.failRefresh();expect(await f.c.verify()).toBe(false);
    expect(await f.c.inspect()).toMatchObject({status:'unauthorized',health:'reauthentication-required'});expect(f.calls).toHaveLength(5);
    expect(await f.c.verify()).toBe(false);expect(f.calls).toHaveLength(5);
  });
  it('accepts omitted unchanged refresh scopes only from an already verified grant',async()=>{
    const f=fixture();await f.login();f.expire();f.omitRefreshScope();expect(await f.c.verify()).toBe(true);
    expect((await f.c.inspect())?.scopes).toEqual(ZOHO_READ_SCOPES);
    f.expire();f.scope('ZohoInvoice.invoices.CREATE');
    // Explicit broader scopes must still fail, tested separately from omission.
    const g=fixture();await g.login();g.expire();g.scope('ZohoInvoice.invoices.CREATE');expect(await g.c.verify()).toBe(false);
  });
  it('preserves node metadata across reopen and refuses account substitution',async()=>{
    const f=fixture();await f.login();const b=(await f.c.inspect())!;
    await f.store.pinConnectorActionLink({actionBindingId:'binding:test',connectorId:b.id,organizationId:b.organizationId,dataCenter:b.dataCenter});
    const reopened=SqliteAgentOperationsStateStore.open({databasePath:join(f.root,'state.db')});stores.push(reopened);
    expect(await reopened.getConnector(b.id)).toEqual(b);
    await f.store.saveConnector({...b,organizationId:'98765'});
    await expect(f.store.pinConnectorActionLink({actionBindingId:'binding:test',connectorId:b.id,organizationId:'98765',dataCenter:b.dataCenter})).rejects.toThrow('already pinned');
    expect((await reopened.getConnectorActionLink('binding:test'))?.organizationId).toBe('12345');
  });
  it('does not retry a forbidden API and never exposes its body',async()=>{
    const f=fixture();await f.login();f.failRead();const source=(await f.c.source())!;
    await expect(source.readPage('invoices',1,200,new AbortController().signal)).rejects.toThrow('No request was retried');
    expect(f.calls).toHaveLength(5);expect(JSON.stringify(await f.c.inspect())).not.toContain('fake-access-token');
    expect((await f.c.inspect())?.status).toBe('unauthorized');
  });
  it('disconnect deletes this node credential material and blocks reads',async()=>{
    const f=fixture();await f.login();const ref=(await f.c.inspect())!.secretReference;
    await f.c.disconnect();expect(f.vault.read(ref)).toBeNull();expect(await f.c.source()).toBeNull();expect((await f.c.inspect())?.status).toBe('not-configured');
  });
  it('callback placement does not change binding identity',async()=>{
    const f=fixture();await f.c.configure(client);const remote=new ZohoConnector(f.store,f.vault,'installation:test',{callbackUrl:'https://ao.example/settings/connections/zoho-invoice/callback'});
    expect(remote.id).toBe(f.c.id);expect(()=>new ZohoConnector(f.store,f.vault,'installation:test',{callbackUrl:'http://attacker.example/callback'})).toThrow();
  });
  it('refuses insecure credential files, symlinks and overlapping refresh locks',async()=>{
    const f=fixture();await f.c.configure(client);const ref=(await f.c.inspect())!.secretReference;const file=join(f.root,'secret-store',ref.slice(7)+'.json');
    chmodSync(file,0o644);expect(()=>f.vault.read(ref)).toThrow('Protected');chmodSync(file,0o600);
    await f.vault.exclusive(ref,async()=>{await expect(f.vault.exclusive(ref,async()=>{})).rejects.toThrow('busy');});
    const target=file+'.original';const data=readFileSync(file);rmSync(file);symlinkSync(target,file);expect(()=>f.vault.read(ref)).toThrow('Protected');expect(data.length).toBeGreaterThan(0);
  });
  it('pins exact verified account for an action and denies unrelated action or capability',async()=>{
    const f=fixture();await f.login();const b=(await f.c.inspect())!;
    const action={id:'action:test',bindingId:'binding:test',executorId:'zoho-invoice-normalized-sync/v1'} as ProjectAction;
    const plan={action,scopeHash:externalActionScopeHash(action,{mode:'full'}),parameters:{mode:'full'}} as unknown as ExternalActionPlan;
    const dest={postOnce:vi.fn(),readSummary:vi.fn()};const e=new ConnectedZohoExecutor(f.c,f.store,async()=>action,dest);
    expect((await e.preflight(plan)).ready).toBe(false);
    await f.store.pinConnectorActionLink({actionBindingId:action.bindingId,connectorId:b.id,organizationId:b.organizationId,dataCenter:b.dataCenter});
    expect((await e.preflight(plan)).ready).toBe(true);
    expect((await e.preflight({...plan,action:{...action,id:'action:other'}})).ready).toBe(false);
    const source=(await f.c.source())!;const before=f.calls.length;
    await expect(source.readPage('delete' as 'invoices',1,200,new AbortController().signal)).rejects.toThrow();expect(f.calls.length).toBe(before);
    expect(dest.postOnce).not.toHaveBeenCalled();
  });
});
