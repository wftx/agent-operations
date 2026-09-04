import type { ConnectorBinding, ZohoDataCenter } from '../../agent-operations-contracts/src/connector.js';
export type { ConnectorBinding, ZohoDataCenter } from '../../agent-operations-contracts/src/connector.js';
/** Human HTTP boundary only. Not a model tool. All failures must be fixed safe messages. */
export interface ConnectorApplication {
  readonly callbackUrl: string;
  inspect(): Promise<ConnectorBinding | null>;
  configure(input: {clientId: string; clientSecret: string; dataCenter: ZohoDataCenter; organizationId: string}): Promise<void>;
  connect(browserNonce: string): Promise<string>;
  callback(state: string, code: string, browserNonce: string): Promise<void>;
  disconnect(): Promise<void>;
  verify(): Promise<boolean>;
}
