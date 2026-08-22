import type {
  RepositoryInventoryAdapter,
  RepositorySummary,
} from '../repository.js';

const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';

function cloneRepository(repository: RepositorySummary): RepositorySummary {
  const remotes = repository.remotes.map(remote => ({
    ...remote,
    ...(remote.identity ? { identity: { ...remote.identity } } : {}),
  }));
  const primaryRemote = repository.primaryRemote
    ? remotes.find(remote => remote.name === repository.primaryRemote?.name)
    : undefined;
  return {
    ...repository,
    remotes,
    ...(primaryRemote ? { primaryRemote } : {}),
  };
}

export function createRepositoryInventoryFixtures(): readonly RepositorySummary[] {
  return [
    {
      id: 'remote:github.com/example/clean',
      identityKind: 'remote',
      name: 'clean',
      checkoutPath: '/fixtures/clean',
      repositoryRoot: '/fixtures/clean',
      availability: 'available',
      branch: 'main',
      detachedHead: false,
      headCommit: '1111111111111111111111111111111111111111',
      workingTree: 'clean',
      remotes: [{
        name: 'origin',
        fetchUrl: 'https://github.com/example/clean.git',
        identity: {
          host: 'github.com',
          repositoryPath: 'example/clean',
          canonical: 'github.com/example/clean',
        },
      }],
      observedAt: FIXTURE_TIME,
    },
    {
      id: 'remote:git.example.test/example/dirty',
      identityKind: 'remote',
      name: 'dirty',
      checkoutPath: '/fixtures/dirty',
      repositoryRoot: '/fixtures/dirty',
      availability: 'available',
      branch: 'feature/inventory',
      detachedHead: false,
      headCommit: '2222222222222222222222222222222222222222',
      workingTree: 'dirty',
      remotes: [{
        name: 'origin',
        fetchUrl: 'git@git.example.test:example/dirty.git',
        identity: {
          host: 'git.example.test',
          repositoryPath: 'example/dirty',
          canonical: 'git.example.test/example/dirty',
        },
      }],
      observedAt: FIXTURE_TIME,
    },
    {
      id: 'local:detached-fixture',
      identityKind: 'local',
      name: 'detached',
      checkoutPath: '/fixtures/detached',
      repositoryRoot: '/fixtures/detached',
      availability: 'available',
      detachedHead: true,
      headCommit: '3333333333333333333333333333333333333333',
      workingTree: 'clean',
      remotes: [],
      observedAt: FIXTURE_TIME,
    },
    {
      id: 'local:unavailable-fixture',
      identityKind: 'local',
      name: 'unavailable',
      checkoutPath: '/fixtures/unavailable',
      availability: 'unavailable',
      detachedHead: false,
      workingTree: 'unknown',
      remotes: [],
      observedAt: FIXTURE_TIME,
      reason: 'Fixture path is unavailable',
    },
  ];
}

export class FakeRepositoryInventoryAdapter implements RepositoryInventoryAdapter {
  private readonly repositories: Map<string, RepositorySummary>;
  private readonly errors: ReadonlyMap<string, string>;

  constructor(
    repositories: readonly RepositorySummary[] = createRepositoryInventoryFixtures(),
    errors: ReadonlyMap<string, string> = new Map(),
  ) {
    this.repositories = new Map(
      repositories.map(repository => [repository.checkoutPath, cloneRepository(repository)]),
    );
    this.errors = new Map(errors);
  }

  async inspectRepository(checkoutPath: string): Promise<RepositorySummary> {
    const error = this.errors.get(checkoutPath);
    if (error) throw new Error(error);
    const repository = this.repositories.get(checkoutPath);
    if (repository) return cloneRepository(repository);
    return {
      id: `local:unconfigured:${encodeURIComponent(checkoutPath)}`,
      identityKind: 'local',
      name: checkoutPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'repository',
      checkoutPath,
      availability: 'unavailable',
      detachedHead: false,
      workingTree: 'unknown',
      remotes: [],
      observedAt: FIXTURE_TIME,
      reason: 'No fake repository fixture configured for this path',
    };
  }
}
