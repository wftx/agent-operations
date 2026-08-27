import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DurableProjectConfiguration,
  RepositorySummary,
  RuntimeCapability,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRuntimeExecutionAdapter,
  InMemoryAgentOperationsStateStore,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import { GitRepositoryAdapter } from '../../git-adapter/src/index.js';
import {
  ExecutionPlanningService,
  ExecutionPreflightService,
  JobLifecycleService,
  ManualDispatchService,
} from '../src/index.js';

const TIME = '2026-08-26T12:00:00.000Z';
const INSTALLATION_ID = 'installation:repository-execution';
const PROJECT_ID = 'repository-execution';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'agent-operations/rehearsal';
const POLICY = { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const };

describe('repository-bound execution', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(remote = 'https://github.com/wftx/agent-operations.git'): string {
    const root = mkdtempSync(join(tmpdir(), 'ao-repository-execution-'));
    roots.push(root);
    const repository = join(root, 'checkout');
    mkdirSync(repository);
    git(repository, ['init', '-b', 'main']);
    git(repository, ['config', 'user.email', 'tests@example.test']);
    git(repository, ['config', 'user.name', 'Agent Operations Tests']);
    writeFileSync(join(repository, 'README.md'), '# fixture\n');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'fixture']);
    if (remote) git(repository, ['remote', 'add', 'origin', remote]);
    return repository;
  }

  function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    }).trim();
  }

  function runtimes(capabilities: readonly RuntimeCapability[] = [
    'session-resume',
    'exact-turn-correlation',
    'execution-working-directory',
    'repository-read-tools',
    'filesystem-read-only',
    'network-denial',
    'environment-empty',
  ]) {
    return new FakeAgentRuntimeAdapter([{
      id: RUNTIME_ID,
      name: 'rehearsal',
      organization: 'agent-operations',
      provider: 'codex',
      enabled: true,
      configured: true,
      capabilities,
      health: { state: 'running' },
      observedAt: TIME,
      workingDirectory: '/reusable/agent/workspace',
    }]);
  }

  async function configured(repository: RepositorySummary) {
    const store = new InMemoryAgentOperationsStateStore({
      installation: { id: INSTALLATION_ID, createdAt: TIME },
    });
    const canonicalPath = repository.repositoryRoot!;
    const bindingId = createRepositoryCheckoutBindingId(INSTALLATION_ID, canonicalPath);
    const configuration: DurableProjectConfiguration = {
      project: { id: PROJECT_ID, name: 'Repository Execution', createdAt: TIME, updatedAt: TIME },
      repositories: [{
        id: REPOSITORY_ID,
        identityKind: 'remote',
        name: 'agent-operations',
        canonicalRemote: 'github.com/wftx/agent-operations',
        createdAt: TIME,
        updatedAt: TIME,
      }],
      checkoutBindings: [{
        id: bindingId,
        repositoryId: REPOSITORY_ID,
        installationId: INSTALLATION_ID,
        canonicalPath,
        availability: 'available',
        firstSeenAt: TIME,
        lastSeenAt: TIME,
      }],
      runtimeAgentIds: [RUNTIME_ID],
    };
    await store.applyProjectConfiguration(configuration);
    return { store, configuration, bindingId };
  }

  async function planned(
    path: string,
    requestedCapabilities = { version: 1 as const, repositoryRead: true },
  ) {
    const repositories = new GitRepositoryAdapter({ now: () => new Date(TIME) });
    const observation = await repositories.inspectRepository(path);
    const setup = await configured(observation);
    const lifecycle = new JobLifecycleService(setup.store, {
      now: () => new Date(TIME),
      jobIdFactory: () => 'job:repository-execution',
      attemptIdFactory: () => 'attempt:repository-execution',
    });
    const job = await lifecycle.createJob({
      projectId: PROJECT_ID,
      title: 'Read repository contract',
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: RUNTIME_ID,
    });
    await lifecycle.markJobReady(job.id);
    const attempt = await lifecycle.createAttempt(job.id);
    const plan = await new ExecutionPlanningService(setup.store, {
      now: () => new Date(TIME),
      planIdFactory: () => 'plan:repository-execution',
    }).prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Inspect RuntimeExecutionPolicy read-only.',
      requestedPolicy: POLICY,
      requestedCapabilities,
      checkoutBindingId: setup.bindingId,
    });
    return { ...setup, repositories, observation, attempt, plan };
  }

  it('resolves a matching checkout into the exact canonical Dispatch working directory', async () => {
    const path = fixture('git@github.com:wftx/agent-operations.git');
    const setup = await planned(path);
    const preflight = new ExecutionPreflightService(
      setup.store,
      runtimes(),
      setup.repositories,
      () => new Date(TIME),
      { requireExactTurnCorrelation: true },
    );
    const preview = await preflight.preflight(setup.plan.id);
    expect(preview).toMatchObject({
      dispatchable: true,
      executionContext: { workingDirectory: realpathSync(path) },
      effectivePolicy: POLICY,
    });

    const execution = new FakeRuntimeExecutionAdapter();
    const result = await new ManualDispatchService(setup.store, preflight, execution, {
      now: () => new Date(TIME),
      dispatchIdFactory: () => 'dispatch:repository-execution',
    }).dispatchExecutionPlan(setup.plan.id);
    expect(result.status).toBe('accepted');
    expect(execution.requests).toHaveLength(1);
    expect(execution.requests[0]).toMatchObject({
      executionContext: { workingDirectory: realpathSync(path) },
      requestedPolicy: POLICY,
    });
  });

  it.each([
    ['wrong remote', 'https://github.com/other/repository.git', 'repository-identity-mismatch'],
    ['local-only repository', '', 'repository-identity-mismatch'],
  ] as const)('blocks %s identity', async (_label, remote, expectedCode) => {
    const setup = await planned(fixture(remote));
    const result = await new ExecutionPreflightService(
      setup.store,
      runtimes(),
      setup.repositories,
    ).preflight(setup.plan.id);
    expect(result.dispatchable).toBe(false);
    expect(result.executionContext).toBeNull();
    expect(result.checks.map(item => item.code)).toContain(expectedCode);
  });

  it('blocks a deleted checkout and a non-Git replacement at the bound path', async () => {
    for (const replaceWithDirectory of [false, true]) {
      const path = fixture();
      const setup = await planned(path);
      rmSync(path, { recursive: true, force: true });
      if (replaceWithDirectory) mkdirSync(path);
      const result = await new ExecutionPreflightService(
        setup.store,
        runtimes(),
        setup.repositories,
      ).preflight(setup.plan.id);
      expect(result.dispatchable).toBe(false);
      expect(result.checks.map(item => item.code)).toContain(
        replaceWithDirectory ? 'checkout-not-git' : 'checkout-unavailable',
      );
    }
  });

  it('supports a moved checkout only after a new canonical binding is selected', async () => {
    const original = fixture();
    const moved = join(original, '..', 'moved-checkout');
    renameSync(original, moved);
    const setup = await planned(moved);
    const result = await new ExecutionPreflightService(
      setup.store,
      runtimes(),
      setup.repositories,
    ).preflight(setup.plan.id);
    expect(result).toMatchObject({
      dispatchable: true,
      executionContext: { workingDirectory: realpathSync(moved) },
    });
  });

  it('blocks when the checkout moves after Plan creation', async () => {
    const original = fixture();
    const setup = await planned(original);
    renameSync(original, join(original, '..', 'moved-after-plan'));
    const result = await new ExecutionPreflightService(
      setup.store,
      runtimes(),
      setup.repositories,
    ).preflight(setup.plan.id);
    expect(result.dispatchable).toBe(false);
    expect(result.executionContext).toBeNull();
    expect(result.checks.map(item => item.code)).toContain('checkout-unavailable');
  });

  it('blocks a runtime that cannot establish a per-execution working directory', async () => {
    const setup = await planned(fixture());
    const result = await new ExecutionPreflightService(
      setup.store,
      runtimes([
        'exact-turn-correlation',
        'filesystem-read-only',
        'network-denial',
        'environment-empty',
      ]),
      setup.repositories,
    ).preflight(setup.plan.id);
    expect(result.dispatchable).toBe(false);
    expect(result.checks.map(item => item.code))
      .toContain('runtime-execution-working-directory-unsupported');
  });

  it('never submits or exposes a reader when repository-read capability is absent or unsupported', async () => {
    for (const [setup, adapter, expectedCode] of [
      [await planned(fixture(), { version: 1, repositoryRead: false }), runtimes(), 'repository-read-capability-required'],
      [await planned(fixture()), runtimes([
        'exact-turn-correlation',
        'execution-working-directory',
        'filesystem-read-only',
        'network-denial',
        'environment-empty',
      ]), 'repository-read-capability-unsupported'],
    ] as const) {
      const preflight = new ExecutionPreflightService(setup.store, adapter, setup.repositories);
      const preview = await preflight.preflight(setup.plan.id);
      expect(preview).toMatchObject({
        dispatchable: false,
        executionContext: null,
      });
      expect(preview.checks.map(item => item.code)).toContain(expectedCode);
      const execution = new FakeRuntimeExecutionAdapter();
      const result = await new ManualDispatchService(setup.store, preflight, execution)
        .dispatchExecutionPlan(setup.plan.id);
      expect(result).toMatchObject({ status: 'blocked', adapterInvoked: false, dispatch: null });
      expect(execution.callCount).toBe(0);
    }
  });

  it('canonicalizes symlink checkout discovery and does not bind the alias', async () => {
    const path = fixture();
    const alias = join(path, '..', 'checkout-alias');
    symlinkSync(path, alias, 'dir');
    const observation = await new GitRepositoryAdapter().inspectRepository(alias);
    expect(observation.checkoutPath).toBe(realpathSync(path));
    expect(observation.repositoryRoot).toBe(realpathSync(path));
  });

  it('keeps multiple checkout selection explicit', async () => {
    const first = fixture();
    const second = fixture();
    const repositories = new GitRepositoryAdapter();
    const firstObservation = await repositories.inspectRepository(first);
    const setup = await configured(firstObservation);
    const secondRoot = (await repositories.inspectRepository(second)).repositoryRoot!;
    await setup.store.applyProjectConfiguration({
      ...setup.configuration,
      checkoutBindings: [
        ...setup.configuration.checkoutBindings,
        {
          ...setup.configuration.checkoutBindings[0],
          id: createRepositoryCheckoutBindingId(INSTALLATION_ID, secondRoot),
          canonicalPath: secondRoot,
        },
      ],
    });
    const lifecycle = new JobLifecycleService(setup.store, {
      jobIdFactory: () => 'job:ambiguous',
      attemptIdFactory: () => 'attempt:ambiguous',
    });
    const job = await lifecycle.createJob({
      projectId: PROJECT_ID,
      title: 'Ambiguous checkout',
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: RUNTIME_ID,
    });
    await lifecycle.markJobReady(job.id);
    const attempt = await lifecycle.createAttempt(job.id);
    await expect(new ExecutionPlanningService(setup.store).prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Inspect read-only.',
      requestedPolicy: POLICY,
    })).rejects.toThrow('multiple checkouts');
  });
});
