import { CortextOSRuntimeAdapter } from '../../../packages/cortextos-adapter/src/index.js';
import { CortextOSExecutionAdapter } from '../../../packages/cortextos-execution-adapter/src/index.js';
import { CortextOSExecutionObserver } from '../../../packages/cortextos-execution-observer/src/index.js';
import { GitRepositoryAdapter } from '../../../packages/git-adapter/src/index.js';
import { OrchestrationService } from '../../../packages/agent-operations-core/src/index.js';
import { OperatorApplicationService } from '../../../packages/agent-operations-application/src/index.js';
import { NoopOperatorNotifier } from '../../../packages/agent-operations-application/src/index.js';
import { SqliteAgentOperationsStateStore } from '../../../packages/sqlite-state-adapter/src/index.js';
import {
  TelegramOperatorNotifier,
  loadAgentOperationsTelegramEnvironmentFile,
  loadTelegramOperatorNotificationConfig,
} from '../../../packages/telegram-notification-adapter/src/index.js';
import { OperatorWebApplication } from './app.js';
import { createOperatorHttpServer } from './http-server.js';

const host = '127.0.0.1';
const port = parsePort(process.env['AO_WEB_PORT'] ?? '4310');
const store = SqliteAgentOperationsStateStore.open();
const runtime = new CortextOSRuntimeAdapter();
const orchestration = new OrchestrationService(
  store,
  runtime,
  new GitRepositoryAdapter(),
  new CortextOSExecutionAdapter(),
  new CortextOSExecutionObserver(),
);
const notification = loadNotifier();
const application = new OperatorApplicationService(store, orchestration, {
  runtime,
  notifier: notification.notifier,
});
application.startRunner();
const app = new OperatorWebApplication(application, {
  telegramConfigured: notification.configured,
});

const server = createOperatorHttpServer(app, { host, port });

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

function loadNotifier() {
  try {
    loadAgentOperationsTelegramEnvironmentFile();
    const config = loadTelegramOperatorNotificationConfig();
    return {
      notifier: config ? new TelegramOperatorNotifier(config) : new NoopOperatorNotifier(),
      configured: config !== null,
    };
  } catch (error) {
    console.warn(`Agent Operations Telegram notifications disabled: ${error instanceof Error ? error.message : String(error)}`);
    return { notifier: new NoopOperatorNotifier(), configured: false };
  }
}
