import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Agent Operations import boundary', () => {
  it('rejects direct imports of high-collision CortextOS internals', () => {
    const output = execFileSync(
      process.execPath,
      [join(process.cwd(), 'scripts', 'check-agent-operations-boundary.mjs')],
      { encoding: 'utf8' },
    );
    expect(output).toContain('Agent Operations import boundary: OK');
  });

  it('keeps AO Web free of concrete infrastructure assembly', () => {
    const source = readFileSync(join(process.cwd(), 'apps', 'ao-web', 'src', 'server.ts'), 'utf8');
    for (const forbidden of [
      'sqlite-state-adapter',
      'git-adapter',
      'cortextos-adapter',
      'cortextos-execution-adapter',
      'cortextos-execution-observer',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('OperatorWebServerDependencies');
  });

  it('ships a disabled and capability restricted AO Orchestrator profile', () => {
    const root = join(process.cwd(), 'templates', 'ao-orchestrator');
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({
      enabled: false,
      runtime: 'codex-app-server',
      tool_profile: 'agent-operations-orchestrator',
      dangerously_skip_permissions: false,
      startup_behavior: 'idle-conversation',
      telegram_polling: false,
      crons: [],
    });
    const adapter = readFileSync(join(process.cwd(), 'src', 'pty', 'codex-app-server-pty.ts'), 'utf8');
    expect(adapter).toContain("tool_profile === 'agent-operations-orchestrator'");
    expect(adapter).toContain('agentOperationsControl: true');
    expect(adapter).toContain("sandbox: 'read-only'");
  });

  it('keeps the dedicated AO Orchestrator dormant when registered from its template', () => {
    const addAgent = readFileSync(join(process.cwd(), 'src', 'cli', 'add-agent.ts'), 'utf8');
    expect(addAgent).toContain("options.template === 'orchestrator' || options.template === 'ao-orchestrator'");
    expect(addAgent).toContain('enabledByTemplate = agentConfig.enabled !== false');
    expect(addAgent).toContain('enabled: enabledByTemplate');
  });

});
