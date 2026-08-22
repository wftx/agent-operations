import { execFileSync } from 'node:child_process';
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
});
