import { createHash } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  LocalFolderInspection,
  ProjectDocumentationEntry,
  ProjectResourceInspectionAdapter,
} from '../../agent-operations-contracts/src/index.js';

const DOCS: ReadonlyArray<readonly [string, ProjectDocumentationEntry['kind'], boolean]> = [
  ['AGENTS.md', 'agents', false], ['CLAUDE.md', 'claude', true], ['README.md', 'readme', false],
  ['CONTRIBUTING.md', 'contributing', false], ['ARCHITECTURE.md', 'architecture', false],
  ['netlify.toml', 'deployment', false], ['vercel.json', 'deployment', false],
];

/** Bounded metadata inspection only. It never executes discovered commands. */
export class LocalProjectResourceInspector implements ProjectResourceInspectionAdapter {
  async inspectLocalFolder(path: string): Promise<LocalFolderInspection> {
    const requested = resolve(path);
    const canonicalPath = await realpath(requested);
    const details = await stat(canonicalPath);
    if (!details.isDirectory()) throw new Error('Project Resource path is not a directory');
    await access(canonicalPath);
    const names = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
      'next.config.js', 'next.config.mjs', 'next.config.ts', ...DOCS.map(value => value[0])];
    const present = new Set<string>();
    for (const name of names) {
      const candidate = join(canonicalPath, name);
      if ((await stat(candidate).catch(() => null))?.isFile()) present.add(name);
    }
    let packageManager: string | undefined;
    if (present.has('pnpm-lock.yaml')) packageManager = 'pnpm';
    else if (present.has('yarn.lock')) packageManager = 'yarn';
    else if (present.has('bun.lockb')) packageManager = 'bun';
    else if (present.has('package-lock.json')) packageManager = 'npm';
    const scripts: Record<string, unknown> = {};
    const warnings: string[] = [];
    if (present.has('package.json')) {
      try {
        const raw = await readFile(join(canonicalPath, 'package.json'), 'utf8');
        if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('package.json exceeds inspection limit');
        const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
        Object.assign(scripts, parsed.scripts ?? {});
      } catch (error) {
        warnings.push(`Could not inspect package.json: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const command = (name: string) => typeof scripts[name] === 'string' && packageManager
      ? `${packageManager} run ${name}` : null;
    const select = (candidates: readonly string[]) => candidates.flatMap(name => {
      const value = command(name); return value ? [value] : [];
    });
    const documentation = DOCS.flatMap(([name, kind, providerSpecific]) => present.has(name)
      ? [{ path: name, kind, providerSpecific }] : []);
    const detectedStack = [
      ...(present.has('package.json') ? ['Node.js'] : []),
      ...(present.has('next.config.js') || present.has('next.config.mjs') || present.has('next.config.ts') ? ['Next.js'] : []),
    ];
    return {
      canonicalPath,
      fingerprint: createHash('sha256').update(canonicalPath).digest('hex'),
      readable: true,
      profile: {
        detectedStack,
        ...(packageManager ? { packageManager } : {}),
        buildCommandCandidates: select(['build', 'typecheck']),
        testCommandCandidates: select(['test', 'check', 'lint']),
        previewCommandCandidates: select(['dev', 'start', 'preview']),
        deploymentClues: documentation.filter(value => value.kind === 'deployment').map(value => value.path),
        documentation,
        warnings,
        knownConstraints: ['Detected commands are candidates only and have not been executed.'],
        agentsFileSuggestion: !present.has('AGENTS.md'),
        inspectedAt: new Date().toISOString(),
      },
    };
  }
}
