import type { NormalizedSyncBinding } from './zoho-invoice-sync-executor.js';

/** Private host binding. Neither the destination nor its secret is a model argument. */
export class FixedSyncHttpBinding implements NormalizedSyncBinding {
  private readonly endpoint: string;
  constructor(endpoint: string, private readonly secret: () => Promise<string>, private readonly transport: typeof fetch = fetch) {
    const url=new URL(endpoint);
    if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash
      || (url.port && url.port!=='443') || url.pathname!=='/api/internal/sync') throw new Error('Invalid fixed sync endpoint');
    this.endpoint=url.href;
  }
  async ready(): Promise<boolean> {
    try { const token=await this.secret();return !!token.trim() && !/[\r\n]/.test(token); } catch { return false; }
  }
  async postOnce(payload: Readonly<Record<string,unknown>>, signal?: AbortSignal): Promise<unknown> {
    const body=JSON.stringify(payload);
    if (Buffer.byteLength(body)>20*1024*1024) throw new Error('Sync payload exceeds bound');
    return this.request('POST',body,signal);
  }
  async readSummary(signal?: AbortSignal): Promise<unknown> { return this.request('GET',undefined,signal); }
  private async request(method:'GET'|'POST',body?:string,signal?:AbortSignal):Promise<unknown> {
    const token=await this.secret();
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('Sync credential unavailable');
    signal?.throwIfAborted();
    const deadline=AbortSignal.timeout(60_000);
    const response=await this.transport(this.endpoint,{method,redirect:'error',signal:signal ? AbortSignal.any([signal,deadline]) : deadline,
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body}:{})});
    if (!response.ok || !response.body) throw new Error('Sync endpoint returned a failure');
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try {
      for (;;) { const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>65536)throw new Error('Sync evidence exceeds bound');chunks.push(value); }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
}
