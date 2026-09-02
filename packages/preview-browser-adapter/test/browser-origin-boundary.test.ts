import { describe, expect, it } from 'vitest';
import { isAllowedPreviewResource, resolvePreviewTarget } from '../src/index.js';

describe('bounded preview browser origin', () => {
  const origin = 'http://127.0.0.1:4311';

  it('allows only the exact origin plus nonnetwork page resources', () => {
    expect(isAllowedPreviewResource(`${origin}/_next/app.js`, origin)).toBe(true);
    expect(isAllowedPreviewResource('data:image/png;base64,AA==', origin)).toBe(true);
    expect(isAllowedPreviewResource('blob:http://127.0.0.1:4311/id', origin)).toBe(true);
    expect(isAllowedPreviewResource('https://example.com/tracker', origin)).toBe(false);
    expect(isAllowedPreviewResource('http://127.0.0.1:4312/private', origin)).toBe(false);
    expect(isAllowedPreviewResource('file:///etc/passwd', origin)).toBe(false);
  });

  it('rejects route and redirect style origin escapes', () => {
    expect(resolvePreviewTarget(origin, '/dashboard')).toBe(`${origin}/dashboard`);
    expect(() => resolvePreviewTarget(origin, '//example.com')).toThrow('route is invalid');
    expect(() => resolvePreviewTarget(origin, 'https://example.com')).toThrow('route is invalid');
  });
});
