import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from '../src/common/config.js';
import { openDatabase } from '../src/common/db.js';
import { createFaultStore } from '../src/common/faults.js';
import { createExchangeStore } from '../src/services/exchange/store.js';
import { makeExchangeService } from '../src/services/exchange/server.js';
import { createValidationStore } from '../src/services/validation/store.js';
import { createValidationService } from '../src/services/validation/app.js';
import { createIngestionStore } from '../src/services/ingestion/store.js';
import { createIngestionService } from '../src/services/ingestion/app.js';

/**
 * Boots the three services in-process on ephemeral ports. Each gets its own
 * SQLite file inside a temp directory, mirroring the production topology.
 */
export async function startCluster(overrides = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'batch-console-'));
  const config = createConfig({
    dataRoot,
    awaitingReceiptMs: 120,
    validationDelayMs: 5,
    dispatchTimeoutMs: 3000,
    reconcileTimeoutMs: 3000,
    ...overrides,
  });

  const exchangeDb = openDatabase(join(dataRoot, 'exchange', 'exchange.db'));
  const exchangeStore = createExchangeStore(exchangeDb);
  const exchangeFaults = createFaultStore(exchangeDb);
  const exchange = makeExchangeService(config, exchangeStore, exchangeFaults);

  const validationDb = openDatabase(join(dataRoot, 'validation', 'validation.db'));
  const validationStore = createValidationStore(validationDb);
  const validationFaults = createFaultStore(validationDb);
  const validation = createValidationService(config, { store: validationStore, faults: validationFaults });

  const ingestionDb = openDatabase(join(dataRoot, 'ingestion', 'ingestion.db'));
  const ingestionStore = createIngestionStore(ingestionDb);
  const ingestionFaults = createFaultStore(ingestionDb);
  const ingestion = createIngestionService(config, { store: ingestionStore, faults: ingestionFaults });

  const servers = [];
  async function listen(app) {
    return new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
  }
  const exchangeServer = await listen(exchange.app);
  const validationServer = await listen(validation.app);
  const ingestionServer = await listen(ingestion.app);
  servers.push(exchangeServer, validationServer, ingestionServer);

  config.urls.exchange = `http://127.0.0.1:${exchangeServer.address().port}`;
  config.urls.validation = `http://127.0.0.1:${validationServer.address().port}`;
  config.urls.ingestion = `http://127.0.0.1:${ingestionServer.address().port}`;

  async function stop() {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
    try {
      exchangeDb.close();
      validationDb.close();
      ingestionDb.close();
    } catch {
      /* already closed */
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }

  return {
    config,
    exchange,
    exchangeStore,
    exchangeFaults,
    validation,
    validationStore,
    validationFaults,
    ingestion,
    ingestionStore,
    ingestionFaults,
    urls: config.urls,
    stop,
  };
}

export async function api(url, { method = 'GET', body, token = 'dev-internal-token', timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { 'x-internal-token': token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

export function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

export const CSV_HEADER = 'record_id,account_no,amount,currency,occurred_at\n';

export function csv(rows) {
  return CSV_HEADER + rows.map((r) => r.join(',')).join('\n') + (rows.length ? '\n' : '');
}

export async function uploadBatch(cluster, { filename = 'batch.csv', content, idempotencyKey, note } = {}) {
  return api(`${cluster.urls.exchange}/internal/batches`, {
    method: 'POST',
    body: { filename, contentBase64: base64(content), idempotencyKey, note },
  });
}

export async function getBatch(cluster, batchId) {
  return api(`${cluster.urls.exchange}/internal/batches/${batchId}`);
}

export async function waitFor(fn, { timeoutMs = 4000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)?.slice(0, 600)}`);
}
