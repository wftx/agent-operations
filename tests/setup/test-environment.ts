import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const root = mkdtempSync(join(tmpdir(), `cortextos-vitest-${process.pid}-`));
const home = join(root, 'home');
const ctxRoot = join(root, 'cortextos');
const aoRoot = join(root, 'agent-operations');

mkdirSync(home, { recursive: true });
mkdirSync(ctxRoot, { recursive: true });
mkdirSync(aoRoot, { recursive: true });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CTX_INSTANCE_ID = `vitest-${process.pid}`;
process.env.CTX_ROOT = ctxRoot;
process.env.AGENT_OPERATIONS_STATE_DIR = aoRoot;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
