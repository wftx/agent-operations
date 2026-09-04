/** Nonsecret, node scoped connection identity. Never a credential payload or path. */
export const ZOHO_READ_SCOPES = ['ZohoInvoice.customerpayments.READ', 'ZohoInvoice.estimates.READ', 'ZohoInvoice.invoices.READ'] as const;
export type ConnectorStatus = 'not-configured' | 'disconnected' | 'connecting' | 'connected' | 'expired' | 'unauthorized' | 'unavailable';
export type ZohoDataCenter = 'us' | 'eu' | 'in' | 'au' | 'jp' | 'ca';
export interface ConnectorBinding {
  readonly id: string;
  readonly provider: 'zoho-invoice';
  readonly installationId: string;
  readonly secretReference: string;
  readonly dataCenter: ZohoDataCenter;
  readonly status: ConnectorStatus;
  readonly organizationId: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly verifiedAt?: string;
  readonly expiresAt?: string;
  readonly health: 'unknown' | 'healthy' | 'reauthentication-required' | 'unavailable';
}
export interface ConnectorMetadataStore {
  getConnector(id: string): Promise<ConnectorBinding | null>;
  saveConnector(binding: ConnectorBinding): Promise<void>;
}
export interface ConnectorActionLink {
  readonly actionBindingId: string;
  readonly connectorId: string;
  readonly organizationId: string;
  readonly dataCenter: ZohoDataCenter;
}
export interface ConnectorActionLinkStore {
  getConnectorActionLink(actionBindingId: string): Promise<ConnectorActionLink | null>;
  pinConnectorActionLink(link: ConnectorActionLink): Promise<void>;
}
export function exactZohoScopes(scopes: readonly string[]): boolean {
  return scopes.length === ZOHO_READ_SCOPES.length && new Set(scopes).size === scopes.length
    && ZOHO_READ_SCOPES.every(scope => scopes.includes(scope));
}
export function validateConnector(b: ConnectorBinding): void {
  const keys = ['id','provider','installationId','secretReference','dataCenter','status','organizationId','scopes','createdAt','verifiedAt','expiresAt','health'];
  if (Object.keys(b).some(k => !keys.includes(k)) || b.provider !== 'zoho-invoice'
    || !/^connector:[a-f0-9]{64}$/.test(b.id) || !/^secret:[a-f0-9]{64}$/.test(b.secretReference)
    || !/^[a-zA-Z0-9:._-]{1,100}$/.test(b.installationId)
    || !['us','eu','in','au','jp','ca'].includes(b.dataCenter)
    || !['not-configured','disconnected','connecting','connected','expired','unauthorized','unavailable'].includes(b.status)
    || !['unknown','healthy','reauthentication-required','unavailable'].includes(b.health)
    || !/^\d{1,30}$/.test(b.organizationId)
    || !(b.scopes.length === 0 || exactZohoScopes(b.scopes))
    || [b.createdAt,b.verifiedAt,b.expiresAt].some(t => t !== undefined && !Number.isFinite(Date.parse(t)))
    || (b.status === 'connected' && (!b.verifiedAt || b.health !== 'healthy' || !exactZohoScopes(b.scopes)))) {
    throw new Error('Invalid safe connector metadata');
  }
}
