import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrchestratorToolName } from '../packages/agent-operations-application/src/index.js';
import { createAgentOperationsComposition } from '../packages/agent-operations-composition/src/index.js';
import { CortextOSConversationStateRepository } from '../packages/cortextos-conversation-adapter/src/index.js';

const TOOL_NAMES = new Set<OrchestratorToolName>([
  'ao.projects.list',
  'ao.projects.get',
  'ao.inputs.list',
  'ao.inputs.get',
  'ao.jobs.create',
  'ao.jobs.get',
  'ao.jobs.list',
  'ao.jobs.status',
  'ao.jobs.guide',
  'ao.jobs.authorize-one-more-attempt',
  'ao.previews.authenticate',
]);

async function main(): Promise<void> {
  const [tool, ...argumentsList] = process.argv.slice(2);
  if (!tool) throw new Error('AO tool name is required');
  const options = parseOptions(argumentsList);
  const argumentsValue = parseObject(options.inputJson);
  const state = new CortextOSConversationStateRepository(
    join(homedir(), '.cortextos', options.instance),
    'ao-orchestrator',
  );
  if (tool === 'ao.conversation.respond') {
    state.complete(
      options.turn,
      requiredText(argumentsValue, 'response'),
      argumentsValue['clarificationRequired'] === true,
      new Date().toISOString(),
    );
    console.log(JSON.stringify({ ok: true, relatedJobIds: state.get(options.turn)?.relatedJobIds ?? [] }));
    return;
  }
  if (!TOOL_NAMES.has(tool as OrchestratorToolName)) throw new Error(`Unsupported AO tool: ${tool}`);
  const composition = createAgentOperationsComposition({ deferRunnerWake: true });
  try {
    const result = await composition.tools.execute({
      name: tool as OrchestratorToolName,
      arguments: argumentsValue,
    });
    state.recordToolResult(options.turn, result);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await composition.close();
  }
}

function parseOptions(argumentsList: string[]): { turn: string; inputJson: string; instance: string } {
  const values = { turn: '', inputJson: '{}', instance: 'default' };
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!value) throw new Error(`Missing value for ${option ?? 'option'}`);
    if (option === '--turn') values.turn = value;
    else if (option === '--input-json') values.inputJson = value;
    else if (option === '--instance') values.instance = value;
    else throw new Error(`Unsupported option: ${option}`);
  }
  if (!/^conversation:[A-Za-z0-9-]{1,100}$/.test(values.turn)) throw new Error('Valid --turn is required');
  if (!/^[A-Za-z0-9_-]+$/.test(values.instance)) throw new Error('Invalid CortextOS instance');
  return values;
}

function parseObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('input-json must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('input-json must be one JSON object');
  }
  return value as Record<string, unknown>;
}

function requiredText(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${field} is required`);
  if (candidate.length > 16_384) throw new Error(`${field} exceeds 16384 characters`);
  return candidate.trim();
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
