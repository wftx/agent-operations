import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { jwtVerify } from 'jose';

vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }));
vi.mock('jose', () => ({ jwtVerify: vi.fn() }));

import { middleware } from '@/middleware';

const mockedGetToken = vi.mocked(getToken);
const mockedJwtVerify = vi.mocked(jwtVerify);

function request(
  pathname: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = 'test-auth-secret-with-sufficient-entropy';
  delete process.env.NEXTAUTH_SECRET;
  mockedGetToken.mockResolvedValue(null);
});

describe('dashboard middleware authorization boundary', () => {
  it('allows a protected route with a verified session', async () => {
    mockedGetToken.mockResolvedValue({ sub: '1', name: 'security-admin' });

    const response = await middleware(request('/api/tasks'));

    expect(response.status).toBe(200);
    expect(mockedGetToken).toHaveBeenCalledOnce();
  });

  it('keeps protected API and page routes closed without authorization', async () => {
    const apiResponse = await middleware(request('/api/tasks'));
    const pageResponse = await middleware(request('/tasks'));

    expect(apiResponse.status).toBe(401);
    expect(pageResponse.status).toBe(307);
    expect(pageResponse.headers.get('location')).toContain('/login?callbackUrl=%2Ftasks');
  });

  it('fails closed when a malformed session cookie makes getToken throw', async () => {
    mockedGetToken.mockRejectedValue(new Error('malformed token'));
    const malformed = request('/api/tasks', {
      headers: { cookie: 'authjs.session-token=not-a-jwe' },
    });

    await expect(middleware(malformed)).resolves.toMatchObject({ status: 401 });
  });

  it('rejects a malformed bearer token without crashing', async () => {
    mockedJwtVerify.mockRejectedValue(new Error('invalid compact JWT'));
    const malformed = request('/api/tasks', {
      headers: { authorization: 'Bearer definitely-not-a-jwt' },
    });

    await expect(middleware(malformed)).resolves.toMatchObject({ status: 401 });
    expect(mockedJwtVerify).toHaveBeenCalledOnce();
  });

  it('fails closed when the authentication secret is missing', async () => {
    delete process.env.AUTH_SECRET;

    const response = await middleware(request('/api/tasks'));

    expect(response.status).toBe(500);
    expect(mockedGetToken).not.toHaveBeenCalled();
  });

  it('keeps explicitly public health and auth routes available', async () => {
    delete process.env.AUTH_SECRET;

    const health = await middleware(request('/api/workflows/health'));
    const auth = await middleware(request('/api/auth/csrf'));

    expect(health.status).toBe(200);
    expect(auth.status).toBe(200);
  });
});
