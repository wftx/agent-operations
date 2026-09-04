import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { expectedRuntimeRevision } from '../src/agent-operations-composition.js';
it('compares the actual daemon executable, not the CLI supervisor, and detects changed daemon bytes',()=>{
  vi.stubEnv('AO_EXPECTED_RUNTIME_REVISION','');
  const root=mkdtempSync(join(tmpdir(),'ao-revision-'));
  try {
    mkdirSync(join(root,'dist'));writeFileSync(join(root,'dist/cli.js'),'supervisor');writeFileSync(join(root,'dist/daemon.js'),'actual writer');
    const hash=(s:string)=>`sha256:${createHash('sha256').update(s).digest('hex')}`;
    expect(expectedRuntimeRevision(root).expectedRevision).toBe(hash('actual writer'));
    writeFileSync(join(root,'dist/daemon.js'),'new writer');
    expect(expectedRuntimeRevision(root).expectedRevision).toBe(hash('new writer'));
  } finally {rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs();}
});
