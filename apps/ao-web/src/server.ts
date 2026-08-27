import { createServer } from 'node:http';
import { CortextOSRuntimeAdapter } from '../../../packages/cortextos-adapter/src/index.js';
import { CortextOSExecutionAdapter } from '../../../packages/cortextos-execution-adapter/src/index.js';
import { CortextOSExecutionObserver } from '../../../packages/cortextos-execution-observer/src/index.js';
import { GitRepositoryAdapter } from '../../../packages/git-adapter/src/index.js';
import { OrchestrationService } from '../../../packages/agent-operations-core/src/index.js';
import { OperatorApplicationService } from '../../../packages/agent-operations-application/src/index.js';
import { SqliteAgentOperationsStateStore } from '../../../packages/sqlite-state-adapter/src/index.js';
import { OperatorWebApplication } from './app.js';

const host = '127.0.0.1';
const port = parsePort(process.env['AO_WEB_PORT'] ?? '4310');
const store = SqliteAgentOperationsStateStore.open();
const orchestration = new OrchestrationService(
  store,
  new CortextOSRuntimeAdapter(),
  new GitRepositoryAdapter(),
  new CortextOSExecutionAdapter(),
  new CortextOSExecutionObserver(),
);
const app = new OperatorWebApplication(new OperatorApplicationService(store, orchestration));

const server = createServer(async (request, response) => {
  try {
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await readBody(request);
    const webRequest = new Request(`http://${host}:${port}${request.url ?? '/'}`, {
      method: request.method,
      headers: requestHeaders(request.headers),
      ...(body ? { body } : {}),
    });
    const webResponse = await app.handle(webRequest);
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`Agent Operations is available at http://${host}:${port}`);
  console.log('Local-only mission control. Viewing and refreshing never Dispatch work.');
});

async function shutdown(): Promise<void> {
  server.close();
  await store.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('AO_WEB_PORT must be an integer from 1 to 65535');
  }
  return parsed;
}

async function readBody(request: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('Operator request body exceeds 64 KiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(headers: import('node:http').IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return [[name, Array.isArray(value) ? value.join(', ') : value]];
  }));
}
