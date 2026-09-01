import type {
  OperatorApplication,
  OrchestratorConversationService,
  ProjectApplication,
  InputApplication,
} from '../../../packages/agent-operations-application/src/index.js';
import { OperatorWebApplication } from './app.js';
import { createOperatorHttpServer } from './http-server.js';

export interface OperatorWebServerDependencies {
  readonly operator: OperatorApplication;
  readonly conversation: OrchestratorConversationService;
  readonly telegramConfigured: boolean;
  readonly projects?: ProjectApplication;
  readonly inputs?: InputApplication;
  close(): Promise<void>;
}

export function startOperatorWebServer(dependencies: OperatorWebServerDependencies) {
  const host = '127.0.0.1';
  const port = parsePort(process.env['AO_WEB_PORT'] ?? '4310');
  const app = new OperatorWebApplication(
    dependencies.operator,
    dependencies.conversation,
    { telegramConfigured: dependencies.telegramConfigured },
    dependencies.projects,
    dependencies.inputs,
  );
  const server = createOperatorHttpServer(app, { host, port });
  server.listen(port, host, () => {
    console.log(`Agent Operations is available at http://${host}:${port}`);
    console.log('Local only mission control. Viewing and refreshing never Dispatch work.');
  });
  const shutdown = async (): Promise<void> => {
    server.close();
    await dependencies.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  return server;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('AO_WEB_PORT must be an integer from 1 to 65535');
  }
  return parsed;
}
