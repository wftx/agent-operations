import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

type Authorize = (
  credentials: Partial<Record<'username' | 'password', unknown>>,
  request: Request,
) => Promise<{ id: string; name?: string | null } | null>;

const captured = vi.hoisted(() => ({ config: null as unknown }));

vi.mock('next-auth', () => ({
  default: (config: unknown) => {
    captured.config = config;
    return {
      handlers: {},
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
    };
  },
}));

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-security-'));
process.env.CTX_ROOT = rootTmp;
process.env.CTX_INSTANCE_ID = 'auth-security';
process.env.ADMIN_USERNAME = 'security-admin';
process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';

let authorize: Authorize;

beforeAll(async () => {
  await import('@/lib/auth');
  const config = captured.config as {
    providers: Array<{ options: { authorize: Authorize } }>;
  };
  authorize = config.providers[0].options.authorize;
});

afterAll(async () => {
  const { db } = await import('@/lib/db');
  db.close();
  fs.rmSync(rootTmp, { recursive: true, force: true });
  delete process.env.CTX_ROOT;
  delete process.env.CTX_INSTANCE_ID;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
});

function requestFrom(ip: string): Request {
  return new Request('http://localhost/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'x-real-ip': ip },
  });
}

describe('Credentials authorization security boundary', () => {
  it('accepts valid credentials and returns the expected identity', async () => {
    const user = await authorize(
      { username: 'security-admin', password: 'correct-horse-battery-staple' },
      requestFrom('127.0.0.10'),
    );

    expect(user).toMatchObject({ name: 'security-admin' });
    expect(user?.id).toMatch(/^\d+$/);
  });

  it('fails closed for an invalid password', async () => {
    const user = await authorize(
      { username: 'security-admin', password: 'definitely-wrong' },
      requestFrom('127.0.0.11'),
    );

    expect(user).toBeNull();
  });

  it('fails closed for an unknown user or missing credentials', async () => {
    await expect(authorize(
      { username: 'missing-user', password: 'irrelevant' },
      requestFrom('127.0.0.12'),
    )).resolves.toBeNull();

    await expect(authorize(
      { username: 'security-admin' },
      requestFrom('127.0.0.13'),
    )).resolves.toBeNull();
  });
});
