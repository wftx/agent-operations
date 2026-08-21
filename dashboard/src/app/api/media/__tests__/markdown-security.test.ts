import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-security-'));
process.env.CTX_ROOT = rootTmp;
process.env.CTX_FRAMEWORK_ROOT = rootTmp;

type MediaRoute = typeof import('../[...filepath]/route');
let media: MediaRoute;

beforeAll(async () => {
  media = await import('../[...filepath]/route');
});

afterAll(() => {
  fs.rmSync(rootTmp, { recursive: true, force: true });
  delete process.env.CTX_ROOT;
  delete process.env.CTX_FRAMEWORK_ROOT;
});

async function renderMarkdown(name: string, markdown: string): Promise<Response> {
  const relativePath = path.join('reports', name);
  const fullPath = path.join(rootTmp, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, markdown);

  const request = new NextRequest(
    `http://localhost/api/media/${relativePath}?render=true`,
  );
  return media.GET(request, {
    params: Promise.resolve({ filepath: relativePath.split(path.sep) }),
  });
}

describe('agent-authored Markdown rendering security', () => {
  it('renders ordinary Markdown through the real preview route', async () => {
    const response = await renderMarkdown(
      'ordinary.md',
      '# Status\n\n**Complete** with [details](https://example.com/report).',
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<h1>Status</h1>');
    expect(html).toContain('<strong>Complete</strong>');
    expect(html).toContain('href="https://example.com/report"');
  });

  it('removes dangerous elements, attributes, and URL protocols', async () => {
    const response = await renderMarkdown(
      'injection.md',
      [
        '<script>alert(1)</script>',
        '<iframe src="https://attacker.invalid"></iframe>',
        '<img src="x" onerror="alert(2)" style="display:block">',
        '<a href="javascript:alert(3)" onclick="alert(4)">click</a>',
      ].join('\n'),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toMatch(/<script|<iframe/i);
    expect(html).not.toMatch(/onerror|onclick|style=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain('click');
  });

  it('safely parses the three-byte Marked recursion advisory payload', async () => {
    const response = await renderMarkdown('advisory.md', '\x09\x0b\n');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBeTypeOf('string');
  });

  it('keeps bounded deeply nested Markdown functional', async () => {
    const nested = `${'> '.repeat(64)}nested but bounded`;
    const response = await renderMarkdown('nested.md', nested);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('nested but bounded');
  });
});
