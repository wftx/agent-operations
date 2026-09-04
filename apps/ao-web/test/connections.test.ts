import { describe, expect, it, vi } from 'vitest';
import { connections } from '../src/connections.js';
import type { ConnectorApplication } from '../../../packages/agent-operations-application/src/index.js';
const base='http://127.0.0.1:4310/settings/connections/zoho-invoice';
function fixture(){return {callbackUrl:base+'/callback',inspect:vi.fn(async()=>null),configure:vi.fn(),connect:vi.fn(async()=> 'https://accounts.zoho.com/oauth/v2/auth'),callback:vi.fn(),disconnect:vi.fn(),verify:vi.fn(async()=>true)} satisfies ConnectorApplication;}
describe('local secret entry connection UI',()=>{
  it('shows setup without secrets; GET/refresh never connects or executes',async()=>{
    const app=fixture();const r=await connections(new Request(base),app);const text=await r.text();
    expect(text).toContain('Not configured');expect(text).toContain('type="password"');expect(text).toContain(base+'/callback');
    expect(r.headers.get('cache-control')).toBe('no-store');expect(r.headers.get('referrer-policy')).toBe('no-referrer');expect(r.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax');
    expect(app.connect).not.toHaveBeenCalled();expect(app.verify).not.toHaveBeenCalled();expect(app.configure).not.toHaveBeenCalled();
  });
  it('saves only on same origin POST with matching browser CSRF and never echoes secrets',async()=>{
    const app=fixture();const get=await connections(new Request(base),app);const cookie=get.headers.get('set-cookie')!.split(';')[0]!;const csrf=cookie.split('=')[1]!;
    const form={csrf,clientId:'fake-client-id',clientSecret:'DO-NOT-ECHO-SECRET',organizationId:'123',dataCenter:'us'};
    const request=(origin:string,body=form)=>new Request(base+'/configure',{method:'POST',headers:{origin,cookie},body:new URLSearchParams(body)});
    expect((await connections(request('https://evil.example'),app)).status).toBe(400);
    expect((await connections(request('http://127.0.0.1:4310',{...form,csrf:'wrong'}),app)).status).toBe(400);
    expect(app.configure).not.toHaveBeenCalled();const ok=await connections(request('http://127.0.0.1:4310'),app);expect(ok.status).toBe(303);expect(await ok.text()).not.toContain(form.clientSecret);
    expect(app.configure).toHaveBeenCalledTimes(1);expect(app.configure).toHaveBeenCalledWith({clientId:form.clientId,clientSecret:form.clientSecret,organizationId:'123',dataCenter:'us'});
    app.configure.mockRejectedValue(new Error(form.clientSecret));const failed=await connections(request('http://127.0.0.1:4310'),app);expect(await failed.text()).not.toContain(form.clientSecret);
  });
  it('does not echo authorization codes or provider errors on callback failure',async()=>{
    const app=fixture();app.callback.mockRejectedValue(new Error('secret-token'));const r=await connections(new Request(base+'/callback?code=secret-code&state=secret-state'),app);
    expect(r.status).toBe(400);expect(await r.text()).not.toMatch(/secret-token|secret-code|secret-state/);
  });
  it('rejects DNS rebinding Host and unconfigured callback origins',async()=>{
    const app=fixture();expect((await connections(new Request(base,{headers:{host:'evil.example'}}),app)).status).toBe(400);
    expect((await connections(new Request('https://evil.example/settings/connections'),app)).status).toBe(400);
  });
});
