import { join } from 'node:path';
import {
  FileTelegramNotificationTestRecorder,
  TELEGRAM_NOTIFICATION_TEST_CONFIRMATION,
  loadAgentOperationsTelegramEnvironmentFile,
  runTelegramNotificationTest,
} from '../packages/telegram-notification-adapter/src/index.js';
import { resolveAgentOperationsStateLocation } from '../packages/sqlite-state-adapter/src/state-location.js';

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  loadAgentOperationsTelegramEnvironmentFile();
  const recorder = new FileTelegramNotificationTestRecorder(
    join(resolveAgentOperationsStateLocation().stateDirectory, 'notification-tests'),
  );
  const receipt = await runTelegramNotificationTest({
    send: flags.send,
    ...(flags.confirmation ? { confirmation: flags.confirmation } : {}),
    recorder,
  });
  console.log(`AO_TELEGRAM_BOT_TOKEN configured: ${process.env['AO_TELEGRAM_BOT_TOKEN']?.trim() ? 'yes' : 'no'}`);
  console.log(`AO_TELEGRAM_CHAT_ID configured: ${process.env['AO_TELEGRAM_CHAT_ID']?.trim() ? 'yes' : 'no'}`);
  console.log(`Mode: ${flags.send ? 'explicit real send' : 'dry run'}`);
  console.log(`Delivery claimed: ${receipt.deliveryClaimed ? 'yes' : 'no'}`);
  console.log(`Delivery status: ${receipt.status}`);
  console.log(`Real Telegram requests: ${receipt.realRequestCount}`);
  console.log(`Recorded at: ${receipt.updatedAt}`);
  if (receipt.message) console.log(`Result: ${receipt.message}`);
  if (receipt.status === 'failed') process.exitCode = 1;
}

function parseFlags(args: readonly string[]): { readonly send: boolean; readonly confirmation?: string } {
  let send = false;
  let confirmation: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--send') {
      if (send) throw new Error('--send may be provided only once');
      send = true;
      continue;
    }
    if (flag === '--confirm') {
      if (confirmation !== undefined) throw new Error('--confirm may be provided only once');
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--confirm requires a value');
      confirmation = value;
      index += 1;
      continue;
    }
    throw new Error(`Unsupported Telegram test option: ${flag}`);
  }
  if (send && confirmation !== TELEGRAM_NOTIFICATION_TEST_CONFIRMATION) {
    throw new Error(`Real Telegram testing requires --send --confirm ${TELEGRAM_NOTIFICATION_TEST_CONFIRMATION}`);
  }
  if (!send && confirmation) throw new Error('--confirm is valid only with --send');
  return { send, ...(confirmation ? { confirmation } : {}) };
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  console.log('Real Telegram requests: 0');
  process.exitCode = 1;
});
