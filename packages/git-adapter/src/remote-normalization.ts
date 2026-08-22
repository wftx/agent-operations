import type { RemoteRepositoryIdentity } from '../../agent-operations-contracts/src/index.js';

export interface NormalizedGitRemoteUrl {
  readonly sanitizedUrl: string;
  readonly identity?: RemoteRepositoryIdentity;
}

function normalizeRepositoryPath(value: string): string | null {
  let path = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // Preserve encoded paths that are not valid percent-encoding.
  }
  path = path.replace(/\.git$/i, '').replace(/\/{2,}/g, '/');
  return path || null;
}

function createIdentity(hostValue: string, pathValue: string): RemoteRepositoryIdentity | undefined {
  const host = hostValue.trim().toLowerCase();
  const repositoryPath = normalizeRepositoryPath(pathValue);
  if (!host || !repositoryPath) return undefined;
  return {
    host,
    repositoryPath,
    canonical: `${host}/${repositoryPath}`,
  };
}

function looksLikeLocalPath(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('~/')
    || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Normalize identity across URL and scp-like Git transports without contacting
 * the remote. Unknown/local transports are preserved but receive no portable
 * remote identity.
 */
export function normalizeGitRemoteUrl(rawValue: string): NormalizedGitRemoteUrl {
  const raw = rawValue.trim();
  if (!raw) return { sanitizedUrl: rawValue };

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    try {
      const url = new URL(raw);
      const isFile = url.protocol === 'file:';
      const identity = isFile ? undefined : createIdentity(url.host, url.pathname);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return {
        sanitizedUrl: url.toString(),
        ...(identity ? { identity } : {}),
      };
    } catch {
      return { sanitizedUrl: raw };
    }
  }

  if (!looksLikeLocalPath(raw)) {
    const scpLike = /^(?:[^@\s/:]+@)?([^:\s/]+):(.+)$/.exec(raw);
    if (scpLike) {
      const identity = createIdentity(scpLike[1], scpLike[2]);
      return {
        sanitizedUrl: raw,
        ...(identity ? { identity } : {}),
      };
    }
  }

  return { sanitizedUrl: raw };
}
