import { randomBytes } from 'node:crypto';
import type { ConnectorApplication, ZohoDataCenter } from '../../../packages/agent-operations-application/src/index.js';
const BASE='/settings/connections';
const ZOHO=BASE+'/zoho-invoice';
const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
/** Secret-bearing routes never use generic error rendering or echo submitted fields. */
export async function connections(request:Request,app:ConnectorApplication):Promise<Response> {
  const url=new URL(request.url); const origin=new URL(app.callbackUrl).origin;
  const cookie=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('ao_connection='))?.slice(14) ?? '';
  const nonce=/^[a-f0-9]{64}$/.test(cookie)?cookie:randomBytes(32).toString('hex');
  const responseHeaders={...headers,'set-cookie':`ao_connection=${nonce}; HttpOnly; SameSite=Lax; Path=/settings/connections; Max-Age=1800${origin.startsWith('https:')?'; Secure':''}`};
  const redirect=()=>new Response(null,{status:303,headers:{...responseHeaders,location:ZOHO}});
  try {
    if(url.origin!==origin || (request.headers.has('host') && request.headers.get('host')!==new URL(origin).host))throw new Error();
    if(request.method==='GET' && url.pathname===ZOHO+'/callback') {
      // Do not render, log, or retain the authorization query in an error page.
      await app.callback(url.searchParams.get('state')??'',url.searchParams.get('code')??'',cookie);
      return redirect();
    }
    if(request.method==='POST') {
      if(request.headers.get('origin')!==origin || !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Error();
      const body=await request.text();if(body.length>8192)throw new Error();const form=new URLSearchParams(body);
      if(!/^[a-f0-9]{64}$/.test(cookie) || form.get('csrf')!==cookie)throw new Error();
      if(url.pathname===ZOHO+'/configure') await app.configure({clientId:form.get('clientId')??'',clientSecret:form.get('clientSecret')??'',dataCenter:form.get('dataCenter') as ZohoDataCenter,organizationId:form.get('organizationId')??''});
      else if(url.pathname===ZOHO+'/connect') return new Response(null,{status:303,headers:{...responseHeaders,location:await app.connect(cookie)}});
      else if(url.pathname===ZOHO+'/disconnect') await app.disconnect();
      else if(url.pathname===ZOHO+'/verify') await app.verify();
      else throw new Error();
      return redirect();
    }
    if(request.method!=='GET' || ![BASE,ZOHO].includes(url.pathname))return new Response('Not found',{status:404,headers});
    const b=await app.inspect();
    const labels={ 'not-configured':'Not configured',disconnected:'Ready to connect',connecting:'Connecting',connected:'Connected',expired:'Expired / refresh available',unauthorized:'Reauthentication required',unavailable:'Error: connection unavailable'};
    const csrf=`<input type="hidden" name="csrf" value="${nonce}">`;
    const button=(path:string,label:string)=>`<form method="post" action="${ZOHO}/${path}">${csrf}<button>${label}</button></form>`;
    const page=`<!doctype html><html><head><meta charset="utf-8"><title>Connections · Agent Operations</title><style>body{font:17px system-ui;max-width:760px;margin:40px auto;padding:24px;background:#fafafa;color:#172026}label{display:block;margin:18px 0}input,select,button{font:inherit;padding:8px}input{display:block;width:90%}form{margin:20px 0}code{overflow-wrap:anywhere}</style></head><body><a href="/">Agent Operations</a><h1>Settings / Connections</h1><h2>Zoho Invoice</h2><p><strong>${labels[b?.status??'not-configured']}</strong></p><p>${b?.health==='reauthentication-required'?'Zoho Invoice connection needs reauthentication.':'Connecting does not run a Job or sync.'}</p>
      ${b?`<p>Organization ID: ${escape(b.organizationId)} · Data center: ${escape(b.dataCenter)}</p><p>Verified: ${escape(b.verifiedAt??'Not yet')}</p><p>Read scopes: ${escape(b.scopes.join(', ')||'None verified')}</p>`:''}
      <p>Register a Zoho Server based Application. Exact callback: <code>${escape(app.callbackUrl)}</code></p>
      <p>Only payments, estimates and invoices may be read. No Zoho write access. Organization ID is verified through these reads; organization names are not fetched because that requires a broader scope.</p>
      <form method="post" action="${ZOHO}/configure" autocomplete="off">${csrf}
      <label>Client ID<input name="clientId" type="password" required autocomplete="off" maxlength="512"></label>
      <label>Client Secret<input name="clientSecret" type="password" required autocomplete="new-password" maxlength="512"></label>
      <label>Organization ID<input name="organizationId" required pattern="[0-9]{1,30}" maxlength="30"></label>
      <label>Data center<select name="dataCenter">${[['us','United States'],['eu','Europe'],['in','India'],['au','Australia'],['jp','Japan'],['ca','Canada']].map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><button>Save local configuration</button></form>
      ${b && b.status!=='not-configured'?button('connect','Connect Zoho Invoice')+button('verify','Verify / refresh connection')+button('disconnect','Disconnect and delete local credentials'):''}
      <p>Disconnect deletes credentials on this node. You may also revoke AO access in Zoho Accounts. It does not revoke credentials belonging to any other application.</p></body></html>`;
    return new Response(page,{headers:{...responseHeaders,'content-type':'text/html; charset=utf-8'}});
  } catch { return new Response('Connection request could not be completed. Return to Settings / Connections. No sync was executed.',{status:400,headers:{...responseHeaders,'content-type':'text/plain; charset=utf-8'}}); }
}
