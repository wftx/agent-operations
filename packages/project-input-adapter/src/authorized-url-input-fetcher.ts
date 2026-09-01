import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { AuthorizedUrlFetchResult, AuthorizedUrlInputFetcher } from '../../agent-operations-contracts/src/index.js';

export interface SecureAuthorizedUrlInputFetcherOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly maximumBytes?: number;
  readonly maximumRedirects?: number;
  readonly timeoutMs?: number;
}

/** Explicit user authorized HTTP retrieval with SSRF, redirect, size, and time bounds. */
export class SecureAuthorizedUrlInputFetcher implements AuthorizedUrlInputFetcher {
  private readonly fetchImplementation: typeof fetch;
  private readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  private readonly maximumBytes: number;
  private readonly maximumRedirects: number;
  private readonly timeoutMs: number;

  constructor(options: SecureAuthorizedUrlInputFetcherOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.resolveHost = options.resolveHost ?? (async hostname => (await lookup(hostname, { all: true })).map(value => value.address));
    this.maximumBytes = options.maximumBytes ?? 10 * 1024 * 1024;
    this.maximumRedirects = options.maximumRedirects ?? 3;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async fetch(value: string): Promise<AuthorizedUrlFetchResult> {
    let url = validateUrl(value);
    for (let redirects = 0; redirects <= this.maximumRedirects; redirects += 1) {
      await this.assertPublic(url);
      const response = await this.fetchImplementation(url, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: '*/*', 'user-agent': 'AgentOperationsInputFetcher/1' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === this.maximumRedirects) throw new Error('Authorized URL redirect limit exceeded');
        url = validateUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Authorized URL returned HTTP ${response.status}`);
      const claimed = Number(response.headers.get('content-length'));
      if (Number.isFinite(claimed) && claimed > this.maximumBytes) throw new Error('Authorized URL response exceeds size limit');
      if (!response.body) throw new Error('Authorized URL response has no body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > this.maximumBytes) { await reader.cancel(); throw new Error('Authorized URL response exceeds size limit'); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return {
        bytes,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        finalUrl: url.toString(),
        displayName: decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? 'download'),
      };
    }
    throw new Error('Authorized URL redirect limit exceeded');
  }

  private async assertPublic(url: URL): Promise<void> {
    const addresses = isIP(url.hostname) ? [url.hostname] : await this.resolveHost(url.hostname);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('Authorized URL resolves to a private or local address');
  }
}

function validateUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Authorized URL must use HTTP or HTTPS');
  if (url.username || url.password) throw new Error('Authorized URL must not contain credentials');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('Authorized URL must not target localhost');
  return url;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice('::ffff:'.length));
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:')
    || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 0 || first === 10 || first === 127 || first >= 224
    || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31
    || first === 192 && second === 168
    || first === 100 && second >= 64 && second <= 127;
}
