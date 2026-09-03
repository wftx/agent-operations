import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import type {
  BoundedBrowserAdapter,
  BrowserCaptureRequest,
  BrowserCaptureResult,
  BrowserEvidenceAuditOperation,
  PreviewAuthenticationAdapter,
} from '../../agent-operations-contracts/src/index.js';

const MAX_TEXT = 32_768;
const MAX_FAILURES = 100;

export interface PlaywrightBoundedBrowserAdapterOptions {
  readonly authenticationRoot?: string;
}

export class PlaywrightBoundedBrowserAdapter implements BoundedBrowserAdapter, PreviewAuthenticationAdapter {
  private readonly authenticationRoot: string;
  private readonly pendingContexts = new Map<string, BrowserContext>();

  constructor(options: PlaywrightBoundedBrowserAdapterOptions = {}) {
    this.authenticationRoot = resolve(options.authenticationRoot
      ?? join(homedir(), '.agent-operations', 'preview-auth'));
  }

  async begin(input: { readonly sessionId: string; readonly origin: string }): Promise<void> {
    const origin = requireLoopbackOrigin(input.origin);
    const directory = this.sessionDirectory(input.sessionId);
    if (this.pendingContexts.has(input.sessionId)) throw new Error('Preview authentication is already open');
    mkdirSync(this.authenticationRoot, { recursive: true, mode: 0o700 });
    chmodSync(this.authenticationRoot, 0o700);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const context = await chromium.launchPersistentContext(directory, {
      headless: false,
      executablePath: resolveChromiumExecutable(),
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    this.pendingContexts.set(input.sessionId, context);
    try {
      await context.newPage().then(page => page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 }));
    } catch (error) {
      this.pendingContexts.delete(input.sessionId);
      await context.close();
      throw error;
    }
  }

  async verify(input: { readonly sessionId: string; readonly origin: string }): Promise<boolean> {
    const origin = requireLoopbackOrigin(input.origin);
    const context = this.pendingContexts.get(input.sessionId);
    if (!context) return false;
    const verified = context.pages().some(page => {
      try { return new URL(page.url()).origin === origin; } catch { return false; }
    });
    if (!verified) return false;
    this.pendingContexts.delete(input.sessionId);
    await context.close();
    chmodSync(this.sessionDirectory(input.sessionId), 0o700);
    return true;
  }

  async isUsable(input: { readonly sessionId: string; readonly origin: string }): Promise<boolean> {
    requireLoopbackOrigin(input.origin);
    return existsSync(this.sessionDirectory(input.sessionId));
  }

  async revoke(input: { readonly sessionId: string; readonly origin: string }): Promise<void> {
    requireLoopbackOrigin(input.origin);
    const pending = this.pendingContexts.get(input.sessionId);
    if (pending) {
      this.pendingContexts.delete(input.sessionId);
      await pending.close();
    }
    rmSync(this.sessionDirectory(input.sessionId), { recursive: true, force: true });
  }

  async capture(request: BrowserCaptureRequest): Promise<BrowserCaptureResult> {
    const origin = requireLoopbackOrigin(request.origin);
    const target = resolvePreviewTarget(origin, request.route);
    validateViewport(request.viewport.width, request.viewport.height);
    const browser = request.authenticationSessionId
      ? null
      : await chromium.launch({ headless: true, executablePath: resolveChromiumExecutable() });
    const context = request.authenticationSessionId
      ? await chromium.launchPersistentContext(this.sessionDirectory(request.authenticationSessionId), {
          headless: true, executablePath: resolveChromiumExecutable(), viewport: { ...request.viewport },
          acceptDownloads: false, serviceWorkers: 'block',
        })
      : await browser!.newContext({ viewport: { ...request.viewport }, acceptDownloads: false, serviceWorkers: 'block' });
    const page = await context.newPage();
    const consoleFailures: string[] = [];
    const failedResources: string[] = [];
    const audit: BrowserEvidenceAuditOperation[] = [];
    page.on('console', message => {
      if (message.type() === 'error') pushBounded(consoleFailures, message.text());
    });
    page.on('requestfailed', failed => pushBounded(failedResources, `${failed.method()} ${safeUrl(failed.url(), origin)} ${failed.failure()?.errorText ?? ''}`));
    page.on('download', download => {
      pushBounded(failedResources, `download blocked: ${download.suggestedFilename()}`);
      void download.cancel();
    });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (isAllowedPreviewResource(url, origin)) await route.continue();
      else {
        pushBounded(failedResources, `blocked external resource: ${safeUrl(url, origin)}`);
        await route.abort('blockedbyclient');
      }
    });
    try {
      const timestamp = () => new Date().toISOString();
      audit.push({ operation: 'navigate', target, occurredAt: timestamp() });
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      const finalUrl = page.url();
      if (new URL(finalUrl).origin !== origin) throw new Error('Preview navigation escaped the authorized loopback origin');
      audit.push({ operation: 'read-title', target: finalUrl, occurredAt: timestamp() });
      const title = bound(await page.title(), 1_000);
      audit.push({ operation: 'read-visible-text', target: finalUrl, occurredAt: timestamp() });
      const visibleText = bound(await page.locator('body').innerText({ timeout: 5_000 }), MAX_TEXT);
      audit.push({ operation: 'screenshot', target: finalUrl, occurredAt: timestamp() });
      const screenshot = await page.screenshot({ type: 'png', fullPage: false });
      return {
        title,
        finalUrl,
        screenshot: new Uint8Array(screenshot),
        screenshotWidth: request.viewport.width,
        screenshotHeight: request.viewport.height,
        visibleText,
        consoleFailures,
        failedResources,
        audit,
      };
    } finally {
      await context.close();
      await browser?.close();
    }
  }

  private sessionDirectory(sessionId: string): string {
    if (!/^preview-auth:[A-Za-z0-9-]+$/.test(sessionId)) throw new Error('Invalid Authenticated Preview Session ID');
    const directory = resolve(this.authenticationRoot, sessionId.replace(':', '-'));
    if (directory === this.authenticationRoot || !directory.startsWith(`${this.authenticationRoot}/`)) {
      throw new Error('Authenticated Preview Session escaped its secret root');
    }
    return directory;
  }
}

function resolveChromiumExecutable(): string {
  const candidates = [
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const executable = candidates.find(candidate => existsSync(candidate));
  if (!executable) throw new Error('No local Chromium browser is available for bounded evidence capture');
  return executable;
}

function requireLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Browser evidence origin must be an exact 127.0.0.1 HTTP origin');
  }
  return url.origin;
}

export function resolvePreviewTarget(origin: string, route: string): string {
  if (!/^\/(?!\/)/.test(route) || route.includes('\0') || route.includes('://')) throw new Error('Browser evidence route is invalid');
  const target = new URL(route, origin);
  if (target.origin !== origin) throw new Error('Browser evidence route escaped the authorized origin');
  return target.href;
}

export function isAllowedPreviewResource(value: string, origin: string): boolean {
  if (value.startsWith('data:') || value.startsWith('blob:')) return true;
  try { return new URL(value).origin === origin; } catch { return false; }
}

function safeUrl(value: string, origin: string): string {
  try {
    const url = new URL(value);
    return url.origin === origin ? url.pathname : `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return '[invalid URL]'; }
}

function validateViewport(width: number, height: number): void {
  if (!Number.isInteger(width) || width < 320 || width > 2_560
    || !Number.isInteger(height) || height < 240 || height > 2_560) throw new Error('Browser evidence viewport is outside bounds');
}

function pushBounded(values: string[], value: string): void {
  if (values.length < MAX_FAILURES) values.push(bound(value, 1_000));
}

function bound(value: string, limit: number): string {
  const redacted = value.replace(/(token|authorization|password|secret)[=:]\s*\S+/gi, '$1=[REDACTED]');
  return redacted.length > limit ? redacted.slice(0, limit) : redacted;
}
