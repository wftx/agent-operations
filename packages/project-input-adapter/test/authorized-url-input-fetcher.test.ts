import { describe, expect, it, vi } from 'vitest';
import { SecureAuthorizedUrlInputFetcher } from '../src/index.js';

describe('SecureAuthorizedUrlInputFetcher', () => {
  it('blocks private destinations before retrieval', async () => {
    const fetchImplementation = vi.fn();
    const fetcher = new SecureAuthorizedUrlInputFetcher({
      fetchImplementation, resolveHost: async () => ['127.0.0.1'],
    });
    await expect(fetcher.fetch('https://internal.example/file')).rejects.toThrow('private or local');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('revalidates redirects and enforces streamed byte bounds', async () => {
    const fetchImplementation = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('first')
        ? new Response(null, { status: 302, headers: { location: 'https://public.example/second' } })
        : new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
    const fetcher = new SecureAuthorizedUrlInputFetcher({
      fetchImplementation: fetchImplementation as typeof fetch,
      resolveHost: async () => ['203.0.113.10'], maximumBytes: 3,
    });
    await expect(fetcher.fetch('https://public.example/first')).rejects.toThrow('size limit');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('rejects URL credentials and non HTTP protocols', async () => {
    const fetcher = new SecureAuthorizedUrlInputFetcher({ resolveHost: async () => ['203.0.113.10'] });
    await expect(fetcher.fetch('https://user:secret@example.com/file')).rejects.toThrow('credentials');
    await expect(fetcher.fetch('file:///etc/passwd')).rejects.toThrow('HTTP or HTTPS');
  });
});
