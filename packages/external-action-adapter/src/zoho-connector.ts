import { createHash, randomBytes } from 'node:crypto';
import { ZOHO_READ_SCOPES, exactZohoScopes, type ConnectorBinding, type ConnectorMetadataStore, type ZohoDataCenter } from '../../agent-operations-contracts/src/connector.js';
import type { ConnectorApplication } from '../../agent-operations-application/src/connector-application.js';
import { NodeConnectorSecretStore, type ConnectorSecrets } from './connector-secrets.js';
import type { ZohoInvoiceReadBinding, ZohoRecordKind } from './zoho-invoice-sync-executor.js';

const DOMAINS: Record<ZohoDataCenter, {accounts: string; api: string}> = {
  us:{accounts:'https://accounts.zoho.com',api:'https://www.zohoapis.com'},
  eu:{accounts:'https://accounts.zoho.eu',api:'https://www.zohoapis.eu'},
  in:{accounts:'https://accounts.zoho.in',api:'https://www.zohoapis.in'},
  au:{accounts:'https://accounts.zoho.com.au',api:'https://www.zohoapis.com.au'},
  jp:{accounts:'https://accounts.zoho.jp',api:'https://www.zohoapis.jp'},
  ca:{accounts:'https://accounts.zohocloud.ca',api:'https://www.zohoapis.ca'},
};
const ENDPOINTS = {payments:'customerpayments',estimates:'estimates',invoices:'invoices'} as const;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const DEFAULT_ZOHO_CALLBACK = 'http://127.0.0.1:4310/settings/connections/zoho-invoice/callback';
class ZohoFailure extends Error {
  constructor(readonly permanent: boolean) { super(permanent ? 'Zoho Invoice connection needs reauthentication.' : 'Zoho Invoice connection is unavailable.'); }
}

/** Closed OAuth and three read operations. No generic URL, API, or credential tool. */
export class ZohoConnector implements ConnectorApplication {
  readonly callbackUrl: string;
  readonly id: string;
  private readonly reference: string;
  constructor(private readonly store: ConnectorMetadataStore, private readonly secrets: NodeConnectorSecretStore,
    private readonly installationId: string, options: {callbackUrl?: string; transport?: typeof fetch; now?: () => number; onVerified?: (b:ConnectorBinding)=>Promise<void>} = {}) {
    this.callbackUrl = options.callbackUrl ?? DEFAULT_ZOHO_CALLBACK;
    const url = new URL(this.callbackUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && this.callbackUrl !== DEFAULT_ZOHO_CALLBACK)) throw new Error('Invalid connector callback');
    this.transport = options.transport ?? fetch; this.now = options.now ?? Date.now;
    this.onVerified=options.onVerified;
    const key = hash(`zoho-invoice:${installationId}`); this.id = `connector:${key}`; this.reference = `secret:${key}`;
  }
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  private readonly onVerified?: (b:ConnectorBinding)=>Promise<void>;
  async inspect(): Promise<ConnectorBinding | null> {
    const b = await this.store.getConnector(this.id);
    // Viewing never refreshes a token, mutates metadata, or executes an action.
    return b?.status === 'connected' && Date.parse(b.expiresAt ?? '') <= this.now()
      ? {...b,status:'expired',health:'unknown'} : b;
  }
  async configure(input: {clientId: string; clientSecret: string; dataCenter: ZohoDataCenter; organizationId: string}): Promise<void> {
    if (!Object.hasOwn(DOMAINS,input.dataCenter) || !/^\d{1,30}$/.test(input.organizationId)
      || !/^[A-Za-z0-9._-]{8,512}$/.test(input.clientId) || !/^[A-Za-z0-9._-]{8,512}$/.test(input.clientSecret)) throw new Error('Valid local client configuration and Organization ID are required.');
    await this.secrets.exclusive(this.reference, async () => {
      const old = await this.store.getConnector(this.id);
      this.secrets.write(this.reference,{clientId:input.clientId,clientSecret:input.clientSecret});
      await this.store.saveConnector({id:this.id,provider:'zoho-invoice',installationId:this.installationId,secretReference:this.reference,
        dataCenter:input.dataCenter,organizationId:input.organizationId,scopes:[],status:'disconnected',health:'unknown',createdAt:old?.createdAt ?? new Date(this.now()).toISOString()});
    });
  }
  async connect(browserNonce: string): Promise<string> {
    return this.secrets.exclusive(this.reference, async () => {
      const b = await this.requireBinding(); const secret = this.requireSecret();
      if (!/^[a-f0-9]{64}$/.test(browserNonce)) throw new Error('Invalid connection browser session');
      const state = randomBytes(32).toString('hex');
      this.secrets.write(this.reference,{...secret,stateHash:hash(state),browserHash:hash(browserNonce),stateExpiresAt:this.now()+600_000});
      await this.store.saveConnector({...b,status:'connecting',health:'unknown'});
      const url = new URL('/oauth/v2/auth',DOMAINS[b.dataCenter].accounts);
      url.search = new URLSearchParams({client_id:secret.clientId,response_type:'code',redirect_uri:this.callbackUrl,
        scope:ZOHO_READ_SCOPES.join(','),access_type:'offline',prompt:'consent',state}).toString();
      return url.href;
    });
  }
  async callback(state: string, code: string, browserNonce: string): Promise<void> {
    await this.secrets.exclusive(this.reference, async () => {
      const b = await this.requireBinding(); let secret = this.requireSecret();
      if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(browserNonce) || hash(state) !== secret.stateHash
        || hash(browserNonce) !== secret.browserHash || (secret.stateExpiresAt ?? 0) <= this.now() || b.status !== 'connecting') throw new Error('Invalid or expired OAuth state. Connect again.');
      // Consume state before any external operation. Failed/uncertain exchanges are never replayed.
      delete secret.stateHash; delete secret.browserHash; delete secret.stateExpiresAt; this.secrets.write(this.reference,secret);
      try {
        if (!/^[A-Za-z0-9._-]{8,2048}$/.test(code)) throw new ZohoFailure(true);
        secret = await this.token(b,secret,{grant_type:'authorization_code',code,redirect_uri:this.callbackUrl});
        this.secrets.write(this.reference,secret);
        await this.probe(b,secret);
        await this.healthy(b,secret);
      } catch (e) { await this.failed(b,e); throw new Error('Zoho connection could not be verified. Check Connections.'); }
    });
  }
  async disconnect(): Promise<void> {
    await this.secrets.exclusive(this.reference, async () => {
      const b = await this.store.getConnector(this.id); this.secrets.remove(this.reference);
      if (b) await this.store.saveConnector({...b,status:'not-configured',health:'unknown',scopes:[],verifiedAt:undefined,expiresAt:undefined});
    });
  }
  async verify(): Promise<boolean> {
    try { return await this.secrets.exclusive(this.reference, async () => {
      const b = await this.requireBinding();
      if (['not-configured','disconnected','connecting','unauthorized'].includes(b.status)) return false;
      try { const secret = await this.fresh(b); await this.probe(b,secret); await this.healthy(b,secret); return true; }
      catch (e) { await this.failed(b,e); return false; }
    }); } catch { return false; }
  }
  async source(): Promise<ZohoInvoiceReadBinding | null> {
    const b = await this.inspect();
    if (!b || !['connected','expired'].includes(b.status) || !exactZohoScopes(b.scopes)) return null;
    const organizationId = b.organizationId; const dataCenter = b.dataCenter;
    return {organizationId,readPage:async (kind,page,pageSize,signal) => this.secrets.exclusive(this.reference,async () => {
      const current = await this.requireBinding();
      if (current.organizationId !== organizationId || current.dataCenter !== dataCenter || !exactZohoScopes(current.scopes)
        || !['connected','expired'].includes(current.status)) throw new Error('Exact connector identity unavailable');
      try { const secret = await this.fresh(current); return await this.page(current,secret,kind,page,pageSize,signal); }
      catch (e) { await this.failed(current,e); throw new Error('Zoho read failed. No request was retried.'); }
    })};
  }
  private async fresh(b: ConnectorBinding): Promise<ConnectorSecrets> {
    const secret = this.requireSecret();
    if (secret.accessToken && (secret.expiresAt ?? 0) > this.now()+60_000) return secret;
    if (!secret.refreshToken) throw new ZohoFailure(true);
    await this.store.saveConnector({...b,status:'expired',health:'unknown'});
    const next = await this.token(b,secret,{grant_type:'refresh_token',refresh_token:secret.refreshToken});
    this.secrets.write(this.reference,next); await this.healthy(b,next); return next;
  }
  private async token(b: ConnectorBinding, secret: ConnectorSecrets, fields: Record<string,string>): Promise<ConnectorSecrets> {
    const value = await this.json(new URL('/oauth/v2/token',DOMAINS[b.dataCenter].accounts),{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({...fields,client_id:secret.clientId,client_secret:secret.clientSecret}).toString()},65536);
    if (value.error) throw new ZohoFailure(['invalid_grant','invalid_client','invalid_code','invalid_client_secret','invalid_scope','invalid_token'].includes(String(value.error)));
    const scopes = typeof value.scope === 'string' ? value.scope.split(/[ ,]+/).filter(Boolean)
      : fields.grant_type==='refresh_token' && value.scope===undefined ? b.scopes : [];
    // OAuth refresh may omit an unchanged scope. Only an already verified exact
    // grant can supply it; initial exchanges never infer a missing scope.
    // Missing/incorrect scope evidence fails closed rather than inventing a grant.
    if (!exactZohoScopes(scopes) || (value.api_domain !== undefined && value.api_domain !== DOMAINS[b.dataCenter].api)) throw new ZohoFailure(true);
    const access = value.access_token; const refresh = value.refresh_token ?? secret.refreshToken;
    if (typeof access !== 'string' || !/^[A-Za-z0-9._-]{8,4096}$/.test(access)
      || typeof refresh !== 'string' || !/^[A-Za-z0-9._-]{8,4096}$/.test(refresh)
      || typeof value.expires_in !== 'number' || value.expires_in <= 0 || value.expires_in > 86400) throw new ZohoFailure(true);
    return {clientId:secret.clientId,clientSecret:secret.clientSecret,accessToken:access,refreshToken:refresh,expiresAt:this.now()+value.expires_in*1000};
  }
  private async probe(b: ConnectorBinding, secret: ConnectorSecrets): Promise<void> {
    // Organization enumeration requires settings.READ, intentionally not granted.
    // Prove access to the exact operator-selected organization with each allowed API.
    for (const kind of ['payments','estimates','invoices'] as const) await this.page(b,secret,kind,1,1);
  }
  private async page(b: ConnectorBinding, secret: ConnectorSecrets, kind: ZohoRecordKind, page: number, size: number, signal?: AbortSignal) {
    if (!Object.hasOwn(ENDPOINTS,kind) || !Number.isSafeInteger(page) || page<1 || page>100 || ![1,200].includes(size)) throw new ZohoFailure(true);
    const endpoint=ENDPOINTS[kind]; const url=new URL(`/invoice/v3/${endpoint}`,DOMAINS[b.dataCenter].api);
    url.search=new URLSearchParams({organization_id:b.organizationId,page:String(page),per_page:String(size)}).toString();
    const value=await this.json(url,{method:'GET',headers:{Authorization:`Zoho-oauthtoken ${secret.accessToken}`},...(signal?{signal}:{})},4*1024*1024);
    if (value.code !== 0) throw new ZohoFailure([14,57].includes(Number(value.code)));
    const records=value[endpoint]; const context=value.page_context as Record<string,unknown> | undefined;
    if (!Array.isArray(records) || records.length>size || !context || context.page!==page || typeof context.has_more_page!=='boolean'
      || records.some(r=>!r || typeof r!=='object' || Array.isArray(r))) throw new ZohoFailure(false);
    return {records:records as Record<string,unknown>[],page,hasMore:context.has_more_page};
  }
  private async json(url: URL, init: RequestInit, limit: number): Promise<Record<string,unknown>> {
    try {
      const timeout=AbortSignal.timeout(30_000);
      const response=await this.transport(url,{...init,redirect:'error',signal:init.signal ? AbortSignal.any([init.signal,timeout]) : timeout});
      if ([401,403].includes(response.status)) throw new ZohoFailure(true);
      if (!response.ok && response.status!==400) throw new ZohoFailure(false);
      if (!response.body) throw new ZohoFailure(false);
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      try { for (;;) {const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>limit)throw new ZohoFailure(false);chunks.push(r.value);} }
      finally {await reader.cancel();}
      const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value!=='object' || Array.isArray(value)) throw new ZohoFailure(false);
      return value as Record<string,unknown>;
    } catch(e) { if(e instanceof ZohoFailure)throw e;throw new ZohoFailure(false); }
  }
  private async healthy(b: ConnectorBinding,s: ConnectorSecrets) {
    const verified:ConnectorBinding={...b,status:'connected',health:'healthy',scopes:[...ZOHO_READ_SCOPES],verifiedAt:new Date(this.now()).toISOString(),expiresAt:new Date(s.expiresAt!).toISOString()};
    await this.store.saveConnector(verified); await this.onVerified?.(verified);
  }
  private async failed(b: ConnectorBinding,e:unknown) { const permanent=e instanceof ZohoFailure && e.permanent;await this.store.saveConnector({...b,status:permanent?'unauthorized':'unavailable',health:permanent?'reauthentication-required':'unavailable'}); }
  private async requireBinding() { const b=await this.store.getConnector(this.id);if(!b || b.installationId!==this.installationId || b.secretReference!==this.reference)throw new Error('Zoho Invoice is not configured.');return b; }
  private requireSecret() {const s=this.secrets.read(this.reference);if(!s)throw new ZohoFailure(true);return s;}
}
