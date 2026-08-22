import { describe, expect, it } from 'vitest';
import {
  createLocalRepositoryId,
  createRemoteRepositoryId,
  normalizeGitRemoteUrl,
} from '../src/index.js';

describe('Git remote normalization', () => {
  it('normalizes equivalent HTTPS, scp-like SSH, and SSH URL forms', () => {
    const values = [
      'https://github.com/wftx/agent-operations.git',
      'https://github.com/wftx/agent-operations',
      'git@github.com:wftx/agent-operations.git',
      'ssh://git@github.com/wftx/agent-operations.git',
    ].map(value => normalizeGitRemoteUrl(value).identity?.canonical);
    expect(new Set(values)).toEqual(new Set(['github.com/wftx/agent-operations']));
  });

  it('supports custom hosts and strips only the terminal .git suffix', () => {
    const normalized = normalizeGitRemoteUrl('ssh://git@git.example.test:2222/teams/platform/repo.git');
    expect(normalized.identity).toEqual({
      host: 'git.example.test:2222',
      repositoryPath: 'teams/platform/repo',
      canonical: 'git.example.test:2222/teams/platform/repo',
    });
    expect(createRemoteRepositoryId(normalized.identity!)).toBe(
      'remote:git.example.test:2222/teams/platform/repo',
    );
  });

  it('preserves malformed and local remotes without inventing portable identity', () => {
    expect(normalizeGitRemoteUrl('::not a valid remote::')).toEqual({
      sanitizedUrl: '::not a valid remote::',
    });
    expect(normalizeGitRemoteUrl('../nearby/repository.git').identity).toBeUndefined();
    expect(normalizeGitRemoteUrl('file:///srv/git/repository.git').identity).toBeUndefined();
  });

  it('removes URL-embedded credentials from observable output', () => {
    const normalized = normalizeGitRemoteUrl('https://user:secret@github.com/wftx/private.git?token=also-secret#fragment');
    expect(normalized.sanitizedUrl).not.toContain('user');
    expect(normalized.sanitizedUrl).not.toContain('secret');
    expect(normalized.sanitizedUrl).not.toContain('token');
    expect(normalized.identity?.canonical).toBe('github.com/wftx/private');
  });

  it('creates deterministic, explicitly local path identities without exposing the path', () => {
    const first = createLocalRepositoryId('/machine-one/checkouts/repository');
    expect(first).toBe(createLocalRepositoryId('/machine-one/checkouts/repository'));
    expect(first).not.toBe(createLocalRepositoryId('/machine-two/checkouts/repository'));
    expect(first).toMatch(/^local:[0-9a-f]{64}$/);
    expect(first).not.toContain('machine-one');
  });
});
