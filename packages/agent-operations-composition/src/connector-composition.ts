import { readFileSync, fstatSync, openSync, closeSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorApplication } from '../../agent-operations-application/src/connector-application.js';
import type { ExternalActionExecutor } from '../../agent-operations-contracts/src/external-action.js';
import { SqliteAgentOperationsStateStore } from '../../sqlite-state-adapter/src/index.js';
import { ZohoConnector, DEFAULT_ZOHO_CALLBACK } from '../../external-action-adapter/src/zoho-connector.js';
import { NodeConnectorSecretStore } from '../../external-action-adapter/src/connector-secrets.js';
import { FixedSyncHttpBinding } from '../../external-action-adapter/src/fixed-sync-http-binding.js';
import { ConnectedZohoExecutor } from '../../external-action-adapter/src/connected-zoho-executor.js';

/** First trusted host integration. No model-controlled destination or credential path. */
export function createConnectorComposition(store:SqliteAgentOperationsStateStore,stateDirectory:string):{connectors:ConnectorApplication;executor:ExternalActionExecutor} {
  const callbackUrl=process.env['AO_ZOHO_CALLBACK_URL'] ?? DEFAULT_ZOHO_CALLBACK;
  const action=async ()=>(await store.listProjectActions('project:71f54b51-c324-4234-9412-1f12b1092311'))
    .find(a=>a.id==='action:frusterio-pulse:production-zoho-sync:v1' && a.bindingId==='binding:frusterio-pulse-production-sync') ?? null;
  const connector=store.getInstallation().then(i=>new ZohoConnector(store,new NodeConnectorSecretStore(join(stateDirectory,'connector-secrets')),i.id,{
    callbackUrl,onVerified:async b=>{const a=await action();if(a)await store.pinConnectorActionLink({actionBindingId:a.bindingId,connectorId:b.id,organizationId:b.organizationId,dataCenter:b.dataCenter});},
  }));
  const destination=new FixedSyncHttpBinding('https://frusterio-pulse.netlify.app/api/internal/sync',async()=>{
    const path=process.env['AO_PULSE_SYNC_SECRET_FILE'] ?? join(homedir(),'Documents/frusterio-pulse/.env.local');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const s=fstatSync(fd);
      if(!s.isFile() || s.nlink!==1 || s.uid!==process.getuid?.() || (s.mode & 0o077)!==0 || s.size>65536)throw new Error('Protected Pulse credential binding unavailable');
      const text=readFileSync(fd,'utf8'); const line=text.match(/^\s*SYNC_SECRET\s*=\s*(.+)\s*$/m)?.[1]?.trim();
      if(!line)throw new Error('Protected Pulse credential binding unavailable');
      return line.replace(/^(['"])(.*)\1$/,'$2');
    } finally {closeSync(fd);}
  });
  const executor=connector.then(c=>new ConnectedZohoExecutor(c,store,action,destination));
  return {connectors:{callbackUrl,inspect:async()=>(await connector).inspect(),configure:async i=>(await connector).configure(i),
    connect:async n=>(await connector).connect(n),callback:async(s,c,n)=>(await connector).callback(s,c,n),
    disconnect:async()=>(await connector).disconnect(),verify:async()=>(await connector).verify()},
    executor:{id:'zoho-invoice-normalized-sync/v1',preflight:async p=>(await executor).preflight(p),execute:async(p,s)=>(await executor).execute(p,s)}};
}
