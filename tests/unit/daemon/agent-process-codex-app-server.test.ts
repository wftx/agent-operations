import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockCodexAppServerPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(24680),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
  setTelegramHandle: vi.fn(),
  canStartCorrelationSafeTurn: vi.fn().mockReturnValue(true),
  canEnforceExecutionPolicy: vi.fn().mockReturnValue(true),
  startCorrelationSafeTurn: vi.fn().mockResolvedValue({
    provider: 'codex',
    sessionId: 'thread-1',
    turnId: 'turn-1',
  }),
};

const mockAgentPty = {
  ...mockCodexAppServerPty,
  setTelegramHandle: undefined,
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockCodexAppServerPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-app-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-app-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  for (const pty of [mockCodexAppServerPty, mockAgentPty]) {
    pty.spawn.mockClear();
    pty.kill.mockClear();
    pty.write.mockClear();
    pty.getPid.mockClear();
    pty.isAlive.mockReset().mockReturnValue(true);
    pty.onExit.mockClear();
    pty.getOutputBuffer.mockClear();
  }
  mockCodexAppServerPty.setTelegramHandle.mockClear();
  mockCodexAppServerPty.canStartCorrelationSafeTurn.mockReset().mockReturnValue(true);
  mockCodexAppServerPty.canEnforceExecutionPolicy.mockReset().mockReturnValue(true);
  mockCodexAppServerPty.startCorrelationSafeTurn.mockReset().mockResolvedValue({
    provider: 'codex',
    sessionId: 'thread-1',
    turnId: 'turn-1',
  });
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('AgentProcess codex-app-server runtime', () => {
  it('selects CodexAppServerPTY for runtime codex-app-server', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();

    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledWith(
      'fresh',
      expect.stringContaining('You are starting a new session.'),
    );
    expect(ap.getStatus().pid).toBe(24680);
  });

  it('starts an idle conversational runtime without a bootstrap provider prompt', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, {
      runtime: 'codex-app-server',
      startup_behavior: 'idle-conversation',
    });

    await ap.start();

    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledWith('fresh', '');
    expect(ap.getStatus()).toMatchObject({ status: 'running', pid: 24680 });
  });

  it('submits exactly one correlated turn after an idle conversational start', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, {
      runtime: 'codex-app-server',
      startup_behavior: 'idle-conversation',
    });

    await ap.start();
    await expect(ap.injectCorrelatedMessageDetailed(
      'one explicit conversation',
      'conversation:idle-first',
    )).resolves.toMatchObject({
      ok: true,
      provider: 'codex',
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });

    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledOnce();
    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledWith('fresh', '');
    expect(mockCodexAppServerPty.startCorrelationSafeTurn).toHaveBeenCalledOnce();
    expect(mockCodexAppServerPty.startCorrelationSafeTurn).toHaveBeenCalledWith(
      'one explicit conversation',
      'conversation:idle-first',
      undefined,
      undefined,
      undefined,
    );
  });

  it('does not submit an unsolicited prompt when an idle runtime resumes', async () => {
    const codexThreadPath = '/tmp/test-ctx/state/codex-app-agent/codex-app-server-thread.json';
    fsMocks.existsSync.mockImplementation((path: string) => path === codexThreadPath);
    const ap = new AgentProcess('codex-app-agent', mockEnv, {
      runtime: 'codex-app-server',
      startup_behavior: 'idle-conversation',
    });

    await ap.start();

    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledWith('continue', '');
    expect(mockCodexAppServerPty.startCorrelationSafeTurn).not.toHaveBeenCalled();
  });

  it('halts without recovery when Codex reports an externally owned thread', async () => {
    vi.useFakeTimers();
    try {
      const ownershipError = Object.assign(
        new Error('thread-store conflict: thread thread-1 already has an active writer'),
        { code: 'CODEX_THREAD_OWNERSHIP_CONFLICT' },
      );
      mockCodexAppServerPty.spawn.mockImplementationOnce(async () => {
        // Mirror the old failure shape: an exit callback can race ahead of the
        // rejected spawn and schedule generic recovery. The typed catch must
        // still move the lifecycle to halted before that timer can fire.
        capturedOnExit?.(0, undefined);
        throw ownershipError;
      });
      const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });

      await ap.start();
      expect(ap.getStatus().status).toBe('halted');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockCodexAppServerPty.spawn).toHaveBeenCalledTimes(1);
      expect(ap.getStatus().status).toBe('halted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('wires Telegram handle to CodexAppServerPTY before start', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(mockCodexAppServerPty.setTelegramHandle).toHaveBeenCalledWith(api, '12345');
  });

  it('sends back-online Telegram directly from daemon on fresh start (issue #392)', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(sendMessage).toHaveBeenCalledWith('12345', 'Agent codex-app-agent is back online');
  });

  it('sends planned-restart msg1 but skips generic back-online Telegram on handoff restart', async () => {
    // Simulate handoff doc marker present at .handoff-doc-path so
    // consumeHandoffBlock() returns a non-empty fragment, marking the spawn
    // as a handoff restart that should suppress the daemon-direct ping.
    // existsSync must return true for BOTH the marker file and the doc path
    // it points at — consumeHandoffBlock checks both.
    const handoffDocPath = '/tmp/handoff-doc.md';
    fsMocks.existsSync.mockImplementation((path: string) =>
      typeof path === 'string'
      && (path.endsWith('.handoff-doc-path') || path === handoffDocPath),
    );
    fsMocks.readFileSync.mockReturnValue(handoffDocPath);

    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    const prompt = mockCodexAppServerPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('CONTEXT HANDOFF');
    expect(sendMessage).toHaveBeenCalledWith('12345', '🔄 codex-app-agent restarted (planned): no reason given');
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent codex-app-agent is back online');
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent codex-app-agent is back online (context handoff)');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not send daemon-direct back-online Telegram for claude-code runtime (issue #392)', async () => {
    // claude-code already executes the inline "Send a Telegram message..."
    // bootstrap instruction itself, so the daemon must not double up.
    const ap = new AgentProcess('claude-agent', mockEnv, { runtime: 'claude-code' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('uses direct kill path on stop, not Claude /exit choreography', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    const stopPromise = ap.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const writes = mockCodexAppServerPty.write.mock.calls.map((call: string[]) => call[0]);
    expect(writes).not.toContain('\x03');
    expect(writes).not.toContain('/exit\r\n');

    capturedOnExit!(0, 0);
    await stopPromise;
    expect(mockCodexAppServerPty.kill).toHaveBeenCalled();
  }, 10000);

  it('persists occupancy before starting a correlation-safe Codex turn', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();
    fsMocks.writeFileSync.mockClear();
    const policy = { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const };

    await expect(ap.injectCorrelatedMessageDetailed('bounded task', 'dispatch-plan:plan-1', policy))
      .resolves.toEqual({
        ok: true,
        provider: 'codex',
        sessionId: 'thread-1',
        turnId: 'turn-1',
        effectivePolicy: policy,
      });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      '/tmp/test-ctx/state/codex-app-agent/last_message_injected.flag',
      expect.stringMatching(/^\d+$/),
      'utf-8',
    );
    expect(fsMocks.writeFileSync.mock.invocationCallOrder.at(-1))
      .toBeLessThan(mockCodexAppServerPty.startCorrelationSafeTurn.mock.invocationCallOrder[0]);
    expect(mockCodexAppServerPty.startCorrelationSafeTurn)
      .toHaveBeenCalledWith('bounded task', 'dispatch-plan:plan-1', policy, undefined, undefined);
  });

  it('rejects a busy Codex runtime before marker or turn creation', async () => {
    mockCodexAppServerPty.canStartCorrelationSafeTurn.mockReturnValue(false);
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();
    fsMocks.writeFileSync.mockClear();

    const policy = { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const };
    await expect(ap.injectCorrelatedMessageDetailed('must not steer', 'dispatch-plan:plan-2', policy))
      .resolves.toMatchObject({ ok: false, code: 'RUNTIME_BUSY' });
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(mockCodexAppServerPty.canEnforceExecutionPolicy).not.toHaveBeenCalled();
    expect(mockCodexAppServerPty.startCorrelationSafeTurn).not.toHaveBeenCalled();
  });

  it('rejects unsupported policy before marker persistence or provider submission', async () => {
    mockCodexAppServerPty.canEnforceExecutionPolicy.mockReturnValue(false);
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();
    fsMocks.writeFileSync.mockClear();
    const policy = { version: 1 as const, filesystem: 'none' as const, network: 'deny' as const, environment: 'empty' as const };

    await expect(ap.injectCorrelatedMessageDetailed(
      'must not submit',
      'dispatch-plan:policy-unsupported',
      policy,
    )).resolves.toMatchObject({ ok: false, code: 'POLICY_UNSUPPORTED' });
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(mockCodexAppServerPty.startCorrelationSafeTurn).not.toHaveBeenCalled();
  });

  it('fails closed before turn creation when the occupancy marker cannot be written', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();
    fsMocks.writeFileSync.mockReset().mockImplementation(() => { throw new Error('read-only'); });

    await expect(ap.injectCorrelatedMessageDetailed('bounded task', 'dispatch-plan:plan-3'))
      .resolves.toMatchObject({ ok: false, code: 'MARKER_WRITE_FAILED' });
    expect(mockCodexAppServerPty.startCorrelationSafeTurn).not.toHaveBeenCalled();
  });

  it('reports ambiguity after turn creation may have started', async () => {
    mockCodexAppServerPty.startCorrelationSafeTurn.mockRejectedValue(new Error('connection lost'));
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();

    await expect(ap.injectCorrelatedMessageDetailed('bounded task', 'dispatch-plan:plan-4'))
      .resolves.toMatchObject({ ok: false, code: 'SUBMISSION_UNCERTAIN' });
  });

  it('ignores stale Claude JSONL when picking continue vs fresh — uses codex thread state only', async () => {
    // Regression: testorg codex-agent (runtime codex-app-server) had a leftover
    // Claude JSONL from a prior Claude-runtime tenure. shouldContinue used to
    // detect the JSONL and pick 'continue', which made startOrResumeThread
    // attempt thread/resume against a stale Codex thread, time out, and
    // exit_code=0 in a crash loop (2026-05-09, 05-14, 05-16). The runtime gate
    // means: codex-app-server checks ITS OWN thread state file, never the
    // Claude conversation dir.
    const codexThreadPath = '/tmp/test-ctx/state/codex-app-agent/codex-app-server-thread.json';

    // Stale Claude JSONL present but no codex-app-server thread state → fresh.
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('.force-fresh')) return false;
      if (path === codexThreadPath) return false;
      return false;
    });
    const apFresh = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await apFresh.start();
    expect(mockCodexAppServerPty.spawn).toHaveBeenLastCalledWith('fresh', expect.any(String));

    // Codex thread state present → continue.
    mockCodexAppServerPty.spawn.mockClear();
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('.force-fresh')) return false;
      if (path === codexThreadPath) return true;
      return false;
    });
    const apContinue = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await apContinue.start();
    expect(mockCodexAppServerPty.spawn).toHaveBeenLastCalledWith('continue', expect.any(String));
  });
});
