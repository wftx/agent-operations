import { createAgentOperationsComposition } from '../packages/agent-operations-composition/src/index.js';
import { JobInputToolService } from '../packages/project-input-adapter/src/index.js';

async function main(): Promise<void> {
  const [tool, ...argumentList] = process.argv.slice(2);
  if (!tool || !['list', 'read', 'copy_to_repository'].includes(tool)) throw new Error('Unsupported Input tool');
  const options = parseOptions(argumentList);
  const allowed = parseAllowed(options.allowedInputsJson);
  const input = parseObject(options.inputJson);
  const composition = createAgentOperationsComposition({ deferRunnerWake: true });
  try {
    const service = new JobInputToolService(composition.inputs, allowed, options.repositoryWriteRoot);
    if (tool === 'list') {
      console.log(JSON.stringify(await service.list()));
      return;
    }
    const inputId = requiredInputId(input, allowed);
    if (tool === 'read') {
      const offset = boundedInteger(input['offset'], 0, Number.MAX_SAFE_INTEGER, 0, 'offset');
      const length = boundedInteger(input['length'], 1, 65_536, 65_536, 'length');
      console.log(JSON.stringify(await service.read(inputId, offset, length)));
      return;
    }
    const relativePath = requiredText(input, 'path');
    console.log(JSON.stringify(await service.copyToRepository(inputId, relativePath)));
  } finally {
    await composition.close();
  }
}

function parseOptions(values: string[]) {
  const options: { inputJson: string; allowedInputsJson: string; instance: string; repositoryWriteRoot?: string } = {
    inputJson: '{}', allowedInputsJson: '[]', instance: 'default',
  };
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index]; const value = values[index + 1];
    if (!value) throw new Error(`Missing value for ${option ?? 'option'}`);
    if (option === '--input-json') options.inputJson = value;
    else if (option === '--allowed-inputs-json') options.allowedInputsJson = value;
    else if (option === '--instance') options.instance = value;
    else if (option === '--repository-write-root') options.repositoryWriteRoot = value;
    else throw new Error(`Unsupported option: ${option}`);
  }
  return options;
}

function parseObject(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Input arguments must be one object');
  return value as Record<string, unknown>;
}

function parseAllowed(raw: string): readonly string[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || !value.length || value.length > 20
    || value.some(id => typeof id !== 'string' || !/^input:[A-Za-z0-9-]+$/.test(id))) {
    throw new Error('Input allowlist is invalid');
  }
  return [...new Set(value as string[])];
}

function requiredInputId(value: Record<string, unknown>, allowed: readonly string[]): string {
  const inputId = requiredText(value, 'inputId');
  if (!allowed.includes(inputId)) throw new Error('Input is not attached to this exact Job execution');
  return inputId;
}

function requiredText(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${field} is required`);
  return candidate.trim();
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${field} is out of bounds`);
  return Number(value);
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
