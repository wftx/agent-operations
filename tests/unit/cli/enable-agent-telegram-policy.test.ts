import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const telegram = vi.hoisted(() => ({
  validateCredentials: vi.fn(),
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    validateCredentials(chatId: string) {
      return telegram.validateCredentials(chatId);
    }
  },
  formatValidateError: vi.fn(() => 'validation failed'),
}));

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async isDaemonRunning() { return false; }
  },
}));

const { enableAgentCommand } = await import('../../../src/cli/enable-agent.js');

describe('enable agent Telegram transport policy', () => {
  let root: string;
  let home: string;
  let agentDirectory: string;
  const originalHome = process.env.HOME;
  const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-enable-policy-'));
    home = join(root, 'home');
    agentDirectory = join(root, 'framework', 'orgs', 'acme', 'agents', 'specialist');
    mkdirSync(home, { recursive: true });
    mkdirSync(agentDirectory, { recursive: true });
    process.env.HOME = home;
    process.env.CTX_FRAMEWORK_ROOT = join(root, 'framework');
    telegram.validateCredentials.mockReset();
    telegram.validateCredentials.mockResolvedValue({
      ok: true,
      botUsername: 'fixture_bot',
      botId: 123456,
      chatType: 'private',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('enables an agent with polling disabled and no Telegram credentials', async () => {
    writeAgent({ telegram_polling: false }, 'BOT_TOKEN=\nCHAT_ID=\n');

    await enable();

    expect(enabledRegistry()).toMatchObject({ specialist: { enabled: true, org: 'acme' } });
    expect(telegram.validateCredentials).not.toHaveBeenCalled();
  });

  it('enables an agent with polling enabled and valid Telegram credentials', async () => {
    writeAgent({ telegram_polling: true }, 'BOT_TOKEN=123456:fixture\nCHAT_ID=987654\n');

    await enable();

    expect(enabledRegistry()).toMatchObject({ specialist: { enabled: true, org: 'acme' } });
    expect(telegram.validateCredentials).toHaveBeenCalledOnce();
    expect(telegram.validateCredentials).toHaveBeenCalledWith('987654');
  });

  it('rejects polling enabled when the Telegram token is missing', async () => {
    writeAgent({ telegram_polling: true }, 'BOT_TOKEN=\nCHAT_ID=987654\n');
    const exit = rejectProcessExit();

    await expect(enable()).rejects.toThrow('process.exit(1)');

    expect(exit).toHaveBeenCalledWith(1);
    expect(telegram.validateCredentials).not.toHaveBeenCalled();
    expect(registryExists()).toBe(false);
  });

  it('rejects polling enabled when the Telegram chat ID is missing', async () => {
    writeAgent({ telegram_polling: true }, 'BOT_TOKEN=123456:fixture\nCHAT_ID=\n');
    const exit = rejectProcessExit();

    await expect(enable()).rejects.toThrow('process.exit(1)');

    expect(exit).toHaveBeenCalledWith(1);
    expect(telegram.validateCredentials).not.toHaveBeenCalled();
    expect(registryExists()).toBe(false);
  });

  function writeAgent(config: Record<string, unknown>, environment: string): void {
    writeFileSync(join(agentDirectory, 'config.json'), JSON.stringify(config));
    writeFileSync(join(agentDirectory, '.env'), environment);
  }

  function enable(): Promise<void> {
    return enableAgentCommand.parseAsync([
      'node', 'cli', 'specialist', '--org', 'acme', '--instance', 'test',
    ]) as Promise<void>;
  }

  function registryPath(): string {
    return join(home, '.cortextos', 'test', 'config', 'enabled-agents.json');
  }

  function registryExists(): boolean {
    return existsSync(registryPath());
  }

  function enabledRegistry(): Record<string, unknown> {
    return JSON.parse(readFileSync(registryPath(), 'utf-8')) as Record<string, unknown>;
  }

  function rejectProcessExit() {
    return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  }
});
