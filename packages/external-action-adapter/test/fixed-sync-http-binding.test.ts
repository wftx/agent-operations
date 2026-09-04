import { expect, it, vi } from 'vitest';
import { FixedSyncHttpBinding } from '../src/fixed-sync-http-binding.js';
it('pins destination, rejects redirects, keeps credentials inside transport, and never retries',async()=>{
  const transport=vi.fn(async()=>new Response('{"ok":true}',{status:200}));
  const binding=new FixedSyncHttpBinding('https://example.test/api/internal/sync',async()=>'secret-in-adapter',transport);
  expect(await binding.postOnce({payments:[]})).toEqual({ok:true});
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledWith('https://example.test/api/internal/sync',expect.objectContaining({method:'POST',redirect:'error',headers:expect.objectContaining({authorization:'Bearer secret-in-adapter'})}));
  expect(()=>new FixedSyncHttpBinding('https://example.test/other',async()=>'x')).toThrow();
  expect(()=>new FixedSyncHttpBinding('https://user:pass@example.test/api/internal/sync',async()=>'x')).toThrow();
});
it('never repeats a failed POST and bounds returned evidence',async()=>{
  const transport=vi.fn(async()=>new Response('failure',{status:500}));
  const binding=new FixedSyncHttpBinding('https://example.test/api/internal/sync',async()=>'test',transport);
  await expect(binding.postOnce({})).rejects.toThrow('failure');expect(transport).toHaveBeenCalledTimes(1);
  const oversized=new FixedSyncHttpBinding('https://example.test/api/internal/sync',async()=>'test',async()=>new Response('x'.repeat(65537)));
  await expect(oversized.readSummary()).rejects.toThrow('bound');
});
