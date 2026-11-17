import { resolve } from 'node:path';

/**
 * Runtime configuration shared by the four processes. Peer URLs are read at
 * call time (not captured once) so a test or supervisor can bind services to
 * ephemeral ports first and publish the addresses afterwards.
 */
export function createConfig(overrides = {}) {
  const env = process.env;
  const base = {
    dataRoot: resolve(env.DATA_DIR || 'data'),
    internalToken: env.INTERNAL_TOKEN || 'dev-internal-token',
    secrets: {
      exchange: env.RECEIPT_SECRET_EXCHANGE || 'dev-exchange-receipt-secret',
      validation: env.RECEIPT_SECRET_VALIDATION || 'dev-validation-receipt-secret',
      ingestion: env.RECEIPT_SECRET_INGESTION || 'dev-ingestion-receipt-secret',
    },
    urls: {
      exchange: env.EXCHANGE_URL || 'http://127.0.0.1:4101',
      validation: env.VALIDATION_URL || 'http://127.0.0.1:4102',
      ingestion: env.INGESTION_URL || 'http://127.0.0.1:4103',
    },
    ports: {
      exchange: Number(env.EXCHANGE_PORT || 4101),
      validation: Number(env.VALIDATION_PORT || 4102),
      ingestion: Number(env.INGESTION_PORT || 4103),
      console: Number(env.CONSOLE_PORT || 4180),
    },
    // After this long without the expected receipt the UI labels a stage as
    // overdue and points at reconciliation.
    awaitingReceiptMs: Number(env.AWAITING_RECEIPT_MS || 2500),
    validationDelayMs: Number(env.VALIDATION_DELAY_MS || 150),
    dispatchTimeoutMs: Number(env.DISPATCH_TIMEOUT_MS || 5000),
    // A lost ingest response is indistinguishable from a lost request, so
    // reconciliation asks the ledger rather than guessing.
    reconcileTimeoutMs: Number(env.RECONCILE_TIMEOUT_MS || 5000),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024),
  };
  return {
    ...base,
    ...overrides,
    dataRoot: overrides.dataRoot ?? base.dataRoot,
    secrets: { ...base.secrets, ...(overrides.secrets || {}) },
    urls: { ...base.urls, ...(overrides.urls || {}) },
    ports: { ...base.ports, ...(overrides.ports || {}) },
  };
}

export const REQUIRED_COLUMNS = ['record_id', 'account_no', 'amount', 'currency', 'occurred_at'];
export const ALLOWED_CURRENCIES = ['USD', 'EUR', 'CNY', 'JPY', 'GBP'];
export const MAX_RECORDS = 5000;
export const MAX_AMOUNT = 1_000_000;
export const BLOCKED_ACCOUNT_PREFIX = 'BLOCKED-';

export function dbFile(config, service) {
  return resolve(config.dataRoot, service, `${service}.db`);
}
