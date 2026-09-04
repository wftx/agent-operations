import { createHash } from 'node:crypto';
import type { ExternalActionExecutor, ExternalActionPlan, ExternalActionResult } from '../../agent-operations-contracts/src/index.js';

export type ZohoRecordKind = 'payments' | 'estimates' | 'invoices';
export interface ZohoInvoiceReadBinding {
  /** Verified account identity belongs to this binding, not a model parameter. */
  readonly organizationId: string;
  readPage(kind: ZohoRecordKind, page: number, pageSize: 200, signal: AbortSignal): Promise<{
    readonly records: readonly Readonly<Record<string, unknown>>[];
    readonly hasMore: boolean;
    readonly page: number;
  }>;
}
export interface NormalizedSyncBinding {
  /** Exact configured HTTPS destination and credential are private to the adapter. */
  postOnce(payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  readSummary(signal: AbortSignal): Promise<unknown>;
}

/** Closed workflow: three paginated READs, one normalized POST, one aggregate GET.
 * No generic MCP call, shell, file access, mutable Zoho method or retry surface.
 * A host must supply authenticated, account verified bindings. Codex plugin
 * availability is NOT proof that the AO server possesses such a binding.
 */
export class ZohoInvoiceSyncExecutor implements ExternalActionExecutor {
  readonly id = 'zoho-invoice-normalized-sync/v1';
  constructor(private readonly scopeHash: string, private readonly source: ZohoInvoiceReadBinding | null,
    private readonly destination: NormalizedSyncBinding | null) {}

  async preflight(plan: ExternalActionPlan) {
    return {ready: plan.scopeHash === this.scopeHash && plan.parameters['mode'] === 'full'
      && plan.action.executorId === this.id && !!this.source?.organizationId && !!this.destination};
  }
  async execute(plan: ExternalActionPlan, signal: AbortSignal = new AbortController().signal): Promise<ExternalActionResult> {
    if (!(await this.preflight(plan)).ready) return fail('not-crossed','preflight-blocked');
    const rows: Record<ZohoRecordKind, Readonly<Record<string, unknown>>[]> = {payments:[],estimates:[],invoices:[]};
    try {
      for (const kind of ['payments','estimates','invoices'] as const) {
        const ids = new Set<string>();
        for (let page=1; ; page++) {
          if (page > 100) throw new Error('Pagination bound exceeded');
          signal.throwIfAborted();
          const response = await this.source!.readPage(kind,page,200,signal);
          if (response.page !== page || typeof response.hasMore !== 'boolean' || response.records.length > 200
            || (response.hasMore && !response.records.length)) throw new Error('Invalid pagination');
          for (const record of response.records) {
            const normalized = normalize(kind,record);
            const id = String(normalized[{payments:'zohoPaymentId',estimates:'zohoEstimateId',invoices:'zohoInvoiceId'}[kind]]);
            // Duplicate pages or unstable pagination require reconciliation, not a partial upload.
            if (ids.has(id)) throw new Error('Duplicate record in full scan');
            ids.add(id); rows[kind].push(normalized);
          }
          if (!response.hasMore) break;
        }
      }
    } catch { return fail('not-crossed','external-failure'); }
    const payload = {...rows,sync:{source:'zoho-mcp-agent',mode:'full',completedAt:new Date().toISOString()}};
    const payloadSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    let response: Record<string,unknown>;
    try {
      signal.throwIfAborted();
      response = object(await this.destination!.postOnce(payload,signal));
    } catch { return {...fail('possible','outcome-uncertain'),payloadSha256}; }
    const counts: Record<string,number> = {paymentsRead:rows.payments.length,estimatesRead:rows.estimates.length,invoicesRead:rows.invoices.length};
    try {
      if (response['ok'] !== true || response['rejected'] !== 0 || response['mode'] !== 'full') throw new Error('Sync did not fully succeed');
      const upserted = object(response['upserted']);
      for (const kind of ['payments','estimates','invoices'] as const) {
        if (upserted[kind] !== rows[kind].length) throw new Error('Upsert count mismatch');
        counts[`${kind}Upserted`] = rows[kind].length;
      }
      const summary = object(await this.destination!.readSummary(signal));
      verifySummary(rows,summary);
      if (typeof summary['lastSuccessfulSyncAt'] !== 'string' || typeof response['syncedAt'] !== 'string'
        || !Number.isFinite(Date.parse(summary['lastSuccessfulSyncAt']))
        || Math.abs(Date.parse(summary['lastSuccessfulSyncAt'])-Date.parse(response['syncedAt'])) > 60000) throw new Error('Sync timestamp mismatch');
      return {status:'completed',verification:'passed',sideEffect:'crossed',counts,payloadSha256,externalRunId:response['syncedAt']};
    } catch {
      return {status:'uncertain',verification:'failed',sideEffect:'possible',counts,payloadSha256,errorCode:'verification-failed'};
    }
  }
}

function fail(sideEffect: ExternalActionResult['sideEffect'], errorCode: NonNullable<ExternalActionResult['errorCode']>): ExternalActionResult {
  return {status:sideEffect==='not-crossed'?'failed':'uncertain',verification:'unavailable',sideEffect,counts:{},errorCode};
}
function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  return value as Record<string,unknown>;
}
const text = (v: unknown): string | null => v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
function required(value: unknown): string { const result = text(value); if (!result) throw new Error('Required source field missing'); return result; }
function day(value: unknown): string { const result = required(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error('Invalid business date'); return result; }
function money(value: unknown): number {
  if (!['number','string'].includes(typeof value) || String(value).trim()==='' || !Number.isFinite(Number(value)) || Number(value)<0) throw new Error('Invalid money');
  return Number(value);
}
function normalize(kind: ZohoRecordKind, r: Readonly<Record<string,unknown>>): Readonly<Record<string,unknown>> {
  const modified = text(r['last_modified_time'])?.replace(/([+-]\d{2})(\d{2})$/,'$1:$2') ?? null;
  if (modified && !Number.isFinite(Date.parse(modified))) throw new Error('Invalid instant');
  const common = {customerId:text(r['customer_id']),customerName:required(r['customer_name']),sourceModifiedAt:modified};
  if (kind==='payments') return {...common,zohoPaymentId:required(r['payment_id']),paymentNumber:text(r['payment_number']),
    amount:money(r['amount']),paymentDate:day(r['date']),paymentMode:text(r['payment_mode']),gateway:text(r['payment_gateway']),
    referenceNumber:text(r['reference_number']),designer:text(r['cf_designer']),invoiceNumbers:text(r['invoice_numbers'])};
  const status = required(r['status']).toLowerCase();
  if (kind==='estimates') {
    if (!['draft','sent','viewed','accepted','invoiced','converted','declined','rejected','expired'].includes(status)) throw new Error('Unknown estimate status');
    return {...common,zohoEstimateId:required(r['estimate_id']),estimateNumber:required(r['estimate_number']),amount:money(r['total']),
      estimateDate:day(r['date']),status,acceptedDate:text(r['accepted_date']) ? day(r['accepted_date']) : null,
      serviceType:text(r['cf_service']),planNumber:text(r['cf_plan_number']),location:text(r['cf_location'])};
  }
  if (!['draft','sent','viewed','unpaid','overdue','partially_paid','paid','void','written_off'].includes(status)) throw new Error('Unknown invoice status');
  return {...common,zohoInvoiceId:required(r['invoice_id']),invoiceNumber:required(r['invoice_number']),total:money(r['total']),balance:money(r['balance']),
    invoiceDate:day(r['date']),dueDate:text(r['due_date']) ? day(r['due_date']) : null,status,
    serviceType:text(r['cf_service']),designer:text(r['cf_designer']),expectedCompletionDate:text(r['cf_expected_completion_date_unformatted']) ? day(r['cf_expected_completion_date_unformatted']) : null};
}
function verifySummary(rows: Record<ZohoRecordKind, Readonly<Record<string,unknown>>[]>, summary: Record<string,unknown>) {
  const active = rows.estimates.filter(r => ['sent','viewed'].includes(String(r['status'])));
  const open = rows.invoices.filter(r => !['draft','void','written_off','paid'].includes(String(r['status'])) && Number(r['balance'])>0);
  const pipeline = object(summary['activeSentPipeline']);
  const invoices = object(summary['openInvoices']);
  const month = object(summary['monthToDate']);
  const start = day(month['start']); const end = day(summary['asOf']);
  const cents = (items: readonly Readonly<Record<string,unknown>>[], field: string) => items.reduce((sum,r) => sum+Math.round(Number(r[field])*100),0);
  const payments = rows.payments.filter(r => String(r['paymentDate'])>=start && String(r['paymentDate'])<=end);
  if (pipeline['count']!==active.length || pipeline['cents']!==cents(active,'amount') || invoices['count']!==open.length
    || invoices['totalCents']!==cents(open,'balance') || month['paymentsCents']!==cents(payments,'amount')) throw new Error('Aggregate reconciliation mismatch');
}
