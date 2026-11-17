import { createConfig } from '../../common/config.js';
import { openDatabase, HttpError, nowIso } from '../../common/db.js';
import { createFaultStore } from '../../common/faults.js';
import { createExchangeStore } from './store.js';
import { createExchangeService } from './app.js';
import { makeReceipt, receiptKey } from '../../common/receipts.js';
import { route } from '../../common/http.js';

/**
 * Extra exchange routes that belong to operations rather than the core
 * pipeline: fault injection, receipt replay and the receipt archive.
 * They must be registered before the catch-all handlers, hence the hook.
 */
function registerOperatorRoutes({ app, store, ingestReceipt, config }, faults) {
  app.get('/internal/faults', (req, res) => res.json({ faults: faults.list() }));

  /**
   * Faults understood by the exchange:
   *   drop_dispatch  stage=format|ingest  request never reaches the peer
   *   drop_receipt   stage=received       exchange's own received receipt lost
   *   inject_receipt params.receipt       replay a receipt (duplicate, stale,
   *                                       wrong batch, tampered signature)
   *   delay_receipt  params.delayMs       hold back the next receipt
   */
  app.post('/internal/faults', route(async (req, res) => {
    const body = req.body ?? {};
    if (body.kind === 'inject_receipt') {
      if (!body.receipt || typeof body.receipt !== 'object') {
        throw new HttpError(400, 'INVALID_BODY', 'inject_receipt 需要提供 receipt');
      }
      const result = ingestReceipt({ kind: body.receipt.kind, receipt: body.receipt }, { source: 'simulator' });
      return res.status(201).json({
        injected: true,
        disposition: result.disposition,
        reason: result.reason ?? null,
        detail: result.detail ?? null,
      });
    }
    const { kind, stage = null, remaining = 1, params = null, note = null } = body;
    if (typeof kind !== 'string' || kind === '') throw new HttpError(400, 'INVALID_BODY', 'kind 必填');
    const fault = faults.add({ kind, stage, remaining, params, note });
    return res.status(201).json({ fault });
  }));

  app.delete('/internal/faults', (req, res) => {
    faults.clear();
    res.json({ cleared: true });
  });

  app.get('/internal/receipts/:attemptId', route(async (req, res) => {
    const attempt = store.getAttempt(req.params.attemptId);
    if (!attempt) throw new HttpError(404, 'ATTEMPT_NOT_FOUND', '尝试不存在');
    res.json({
      attemptId: attempt.id,
      batchId: attempt.batchId,
      receipts: store.receiptsForAttempt(attempt.id),
      emitted: store.emittedForAttempt(attempt.id),
    });
  }));

  /** Mint a receipt exactly as a peer would, then post it to the inbox. */
  app.post('/internal/simulate/receipts', route(async (req, res) => {
    const { stage, attemptId, overrides = {} } = req.body ?? {};
    const attempt = attemptId ? store.getAttempt(attemptId) : null;
    if (!attempt) throw new HttpError(404, 'ATTEMPT_NOT_FOUND', '尝试不存在');
    const issuer = stage === 'format' ? 'validation' : stage === 'ingest' ? 'ingestion' : 'exchange';
    const payload = makeReceipt(config.secrets[issuer], {
      issuer,
      kind: stage,
      batchId: attempt.batchId,
      attemptId: attempt.id,
      token: attempt.token,
      seq: stage === 'received' ? 1 : stage === 'format' ? 2 : 3,
      outcome: stage === 'received' ? 'accepted' : stage === 'format' ? 'passed' : 'delivered',
      details: { summary: 'simulated receipt' },
      emittedAt: nowIso(),
      ...overrides,
    });
    const result = ingestReceipt({ kind: stage, receipt: payload });
    return res.status(201).json({
      receipt: payload,
      key: receiptKey(payload),
      disposition: result.disposition,
      reason: result.reason ?? null,
      batch: store.getBatch(attempt.batchId),
    });
  }));
}

export function makeExchangeService(config, store, faults) {
  return createExchangeService(config, {
    store,
    faults,
    registerExtraRoutes: (ctx) => registerOperatorRoutes(ctx, faults),
  });
}

export async function startExchangeService() {
  const config = createConfig();
  const db = openDatabase(`${config.dataRoot}/exchange/exchange.db`);
  const store = createExchangeStore(db);
  const faults = createFaultStore(db);
  const { app } = makeExchangeService(config, store, faults);
  const server = app.listen(config.ports.exchange, () => {
    console.log(
      JSON.stringify({ service: 'exchange', listening: config.ports.exchange, db: `${config.dataRoot}/exchange/exchange.db` }),
    );
  });
  return { server, config, store, faults };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startExchangeService();
}
