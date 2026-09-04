import { externalActionScopeHash, type ExternalActionExecutor, type ExternalActionPlan, type ProjectAction } from '../../agent-operations-contracts/src/external-action.js';
import type { ConnectorActionLinkStore } from '../../agent-operations-contracts/src/connector.js';
import { ZohoConnector } from './zoho-connector.js';
import { ZohoInvoiceSyncExecutor, type NormalizedSyncBinding } from './zoho-invoice-sync-executor.js';

/** Trusted host definition plus immutable node/account link; never model supplied transport. */
export class ConnectedZohoExecutor implements ExternalActionExecutor {
  readonly id='zoho-invoice-normalized-sync/v1';
  constructor(private readonly connector:ZohoConnector,private readonly links:ConnectorActionLinkStore,
    private readonly action:()=>Promise<ProjectAction|null>,private readonly destination:NormalizedSyncBinding & {ready?:()=>Promise<boolean>}) {}
  private async resolve(plan:ExternalActionPlan) {
    const action=await this.action();
    if(!action || action.id!==plan.action.id || action.bindingId!==plan.action.bindingId || action.executorId!==this.id
      || plan.parameters['mode']!=='full' || Object.keys(plan.parameters).length!==1
      || plan.scopeHash!==externalActionScopeHash(action,{mode:'full'}))return null;
    const link=await this.links.getConnectorActionLink(action.bindingId);const b=await this.connector.inspect();
    if(!link || !b || link.connectorId!==b.id || link.organizationId!==b.organizationId || link.dataCenter!==b.dataCenter)return null;
    const source=await this.connector.source();
    return source ? new ZohoInvoiceSyncExecutor(plan.scopeHash,source,this.destination) : null;
  }
  async preflight(plan:ExternalActionPlan) {
    // Binding/scope validation precedes any connector read. Normal token refresh is
    // not an action retry and never repeats a failed business request.
    if(!await this.resolve(plan))return {ready:false,reason:await this.reason()};
    if(this.destination.ready && !await this.destination.ready())return {ready:false};
    if(!await this.connector.verify())return {ready:false,reason:await this.reason()};
    return {ready:!!await this.resolve(plan)};
  }
  async execute(plan:ExternalActionPlan,signal:AbortSignal) {
    const executor=await this.resolve(plan);
    if(!executor)return {status:'failed',verification:'unavailable',sideEffect:'not-crossed',counts:{},errorCode:'preflight-blocked'} as const;
    return executor.execute(plan,signal);
  }
  private async reason():Promise<'connector-reauthentication-required'|'connector-disconnected'|'connector-unavailable'> {
    const b=await this.connector.inspect();
    return b?.status==='unauthorized'?'connector-reauthentication-required':!b || ['not-configured','disconnected','connecting'].includes(b.status)?'connector-disconnected':'connector-unavailable';
  }
}
