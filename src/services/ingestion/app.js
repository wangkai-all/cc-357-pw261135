import { createConfig, dbFile } from '../../common/config.js';
import { openDatabase, HttpError, nowIso } from '../../common/db.js';
import { makeReceipt, receiptKey, RECEIPT_ISSUERS } from '../../common/receipts.js';
import { decodeBase64Strict, requestJson } from '../../common/internal.js';
import { createApp, errorHandler, notFoundHandler, route } from '../../common/http.js';
import { validateCsvPayload } from '../../common/records.js';
import { createIngestionStore } from './store.js';
import { createFaultStore } from '../../common/faults.js';

/**
 * Ingestion service. The only service whose commit makes a batch "accepted".
 *
 * The ledger commit and the receipt delivery are deliberately separate steps,
 * so "ledger committed, receipt never arrived" is a real, reachable state.
 * The console must resolve it by asking the ledger; it may never infer success
 * from the fact that the upload request returned.
 */
export function createIngestionService(config, deps = {}) {
  const store = deps.store;
  const faults = deps.faults;
  const now = () => new Date().toISOString();

  function receiptFor({ attemptId, batchId, token, outcome, details }) {
    return makeReceipt(config.secrets.ingestion, {
      issuer: RECEIPT_ISSUERS.INGESTION,
      kind: 'ingest',
      batchId,
      attemptId,
      token,
      seq: 3,
      outcome,
      details,
      emittedAt: now(),
    });
  }

  async function deliver(attemptId, receipt, behaviour) {
    const fault = faults.take('delivery', 'ingest', attemptId) ?? faults.take('delivery', 'ingest', null);
    const mode = fault?.params?.mode ?? behaviour?.mode ?? null;
    if (mode === 'drop' || behaviour?.dropReceipt) {
      store.setDelivery(attemptId, 'dropped', '模拟故障：入库回执在传输中丢失');
      store.event({ attemptId, batchId: receipt.batchId, type: 'receipt_dropped', message: '入库回执被模拟故障丢弃' });
      return { delivered: false, mode: 'drop' };
    }
    if (mode === 'disconnect_after_send') {
      try {
        await requestJson(`${config.urls.exchange}/internal/receipts`, {
          method: 'POST',
          token: config.internalToken,
          timeoutMs: config.dispatchTimeoutMs,
          body: { kind: 'ingest', receipt },
        });
      } catch {
        /* The exchange recorded it; only the reply was lost. */
      }
      store.setDelivery(attemptId, 'response_lost', '模拟故障：交换服务已收下入库回执，但响应在返回途中断开');
      store.event({ attemptId, batchId: receipt.batchId, type: 'receipt_response_lost', message: '入库回执已送达但响应断开' });
      return { delivered: false, mode: 'disconnect_after_send' };
    }
    try {
      await requestJson(`${config.urls.exchange}/internal/receipts`, {
        method: 'POST',
        token: config.internalToken,
        timeoutMs: config.dispatchTimeoutMs,
        body: { kind: 'ingest', receipt },
      });
      store.setDelivery(attemptId, 'delivered', null);
      return { delivered: true, mode: 'ok' };
    } catch (error) {
      store.setDelivery(attemptId, 'failed', error.message);
      store.event({ attemptId, batchId: receipt.batchId, type: 'receipt_delivery_failed', message: `入库回执投递失败：${error.message}` });
      return { delivered: false, mode: 'error', error: error.message };
    }
  }

  async function ingest(body) {
    const { attemptId, batchId, token, filename, contentBase64, behaviour } = body;
    if (typeof attemptId !== 'string' || typeof batchId !== 'string' || typeof token !== 'string') {
      throw new HttpError(400, 'INVALID_BODY', 'attemptId, batchId, token 必填');
    }

    const existing = store.stateOf(attemptId);
    // A completed or rolled-back attempt is replayed, never re-posted. A
    // partial commit (rows live, pending still 'pending', no receipt) is NOT
    // complete: fall through so the remaining rows are posted and a receipt
    // is finally produced. postRecords is idempotent on (batch, record).
    if (
      existing.state === 'rolled_back' ||
      (existing.state === 'posted' && existing.pending?.status === 'posted')
    ) {
      return {
        deduplicated: true,
        state: existing,
        receipt: existing.receiptState?.receipt ?? null,
      };
    }
    if (existing.state === 'unknown') {
      const buffer = decodeBase64Strict(contentBase64);
      if (!buffer) throw new HttpError(400, 'INVALID_CONTENT', 'contentBase64 不合法');
      // 按约定再次复核：上游说通过不等于把资金规则trusted。
      const validation = validateCsvPayload(buffer);
      store.insertPending({
        attemptId,
        batchId,
        token,
        fingerprint: body.fingerprint ?? 'unknown',
        records: validation.records,
      });
      if (validation.outcome !== 'passed') {
        store.markPending(attemptId, 'rejected');
        const receipt = receiptFor({
          attemptId,
          batchId,
          token,
          outcome: 'failed',
          details: {
            summary: `入库前复核未通过：${validation.summary}`,
            errors: validation.errors.slice(0, 20),
            posted: 0,
          },
        });
        store.saveReceipt({ attemptId, batchId, receipt, receiptKey: receiptKey(receipt), outcome: 'failed' });
        store.event({ attemptId, batchId, type: 'ingest_rejected', message: `入库前复核拒绝：${validation.summary}` });
        const delivery = await deliver(attemptId, receipt, behaviour);
        return { state: store.stateOf(attemptId), receipt, delivery };
      }
    }

    const pending = store.getPending(attemptId);
    if (!pending) throw new HttpError(500, 'INGEST_STATE', '入库状态异常：缺少待入库记录');
    if (pending.status === 'rejected') {
      const receipt = store.getReceipt(attemptId);
      return { state: store.stateOf(attemptId), receipt: receipt?.receipt ?? null, deduplicated: true };
    }

    const partialFault = faults.take('ingest_commit', 'ingest', attemptId);
    if (partialFault?.params?.commitFirst) {
      const limit = partialFault.params.commitFirst;
      // A short commit that then aborts: the rows really are in the ledger
      // while the caller believes the whole operation failed. This is the
      // "page must not assume failure == nothing happened" case.
      store.postRecords({ attemptId, batchId, records: pending.records, commitLimit: limit });
      store.event({
        attemptId,
        batchId,
        type: 'ingest_partial_commit',
        message: `模拟故障：${limit} 条记录已提交，随后入库中断`,
        detail: { committed: limit, total: pending.records.length },
      });
      throw new HttpError(500, 'INGESTION_INTERRUPTED', `入库中断：已有 ${limit} 条记录提交成功，其余未提交`);
    }

    const preview = store.stateOf(attemptId);
    const result = store.postRecords({ attemptId, batchId, records: pending.records });
    store.markPending(attemptId, 'posted');
    store.event({
      attemptId,
      batchId,
      type: 'ingest_posted',
      message: `${result.posted} 条记录入账${result.skipped ? `，${result.skipped} 条已存在跳过` : ''}`,
      detail: { posted: result.posted, skipped: result.skipped, batchLiveRows: result.batchLiveRows },
    });

    const receipt = receiptFor({
      attemptId,
      batchId,
      token,
      outcome: 'delivered',
      details: {
        summary: `${result.posted} 条记录已入账${result.skipped ? `（${result.skipped} 条重复跳过）` : ''}`,
        posted: result.posted,
        skipped: result.skipped,
        batchLiveRows: result.batchLiveRows,
        batchAmountCents: result.batchAmountCents,
        filename: filename ?? null,
      },
    });
    store.saveReceipt({ attemptId, batchId, receipt, receiptKey: receiptKey(receipt), outcome: 'delivered' });

    // Simulation: process dies between the commit and the receipt. The ledger
    // has rows, the exchange has nothing. Only reconciliation can settle it.
    const crash = faults.take('crash_after_commit', 'ingest', attemptId);
    if (crash) {
      store.event({
        attemptId,
        batchId,
        type: 'crash_after_commit',
        message: '模拟故障：入库提交成功，但发送回执前与交换服务断开',
        detail: { posted: result.posted },
      });
      return { state: store.stateOf(attemptId), receipt, delivery: { delivered: false, mode: 'crash_after_commit' } };
    }

    const delivery = await deliver(attemptId, receipt, behaviour);
    void preview;
    return { state: store.stateOf(attemptId), receipt, delivery };
  }

  const app = createApp('ingestion');

  app.get('/health', (req, res) => res.json({ ok: true, service: 'ingestion', time: now() }));

  app.get('/internal/ledger', (req, res) => {
    res.json({ stats: store.stats(), events: store.recentEvents(60) });
  });

  app.get('/internal/ingest/:attemptId', (req, res, next) => {
    const state = store.stateOf(req.params.attemptId);
    if (state.state === 'unknown') return next(new HttpError(404, 'ATTEMPT_NOT_FOUND', '入库服务没有该尝试的记录'));
    return res.json({
      state: state.state,
      live: state.live,
      all: state.all,
      batchLiveRows: state.batchLiveRows,
      batchAmount: state.batchAmountCents / 100,
      rows: store.liveRows(req.params.attemptId),
      receipt: state.receiptState?.receipt ?? null,
      receiptOutcome: state.receiptState?.outcome ?? null,
      deliveryState: state.receiptState?.deliveryState ?? null,
      pendingStatus: state.pending?.status ?? null,
    });
  });

  app.get('/internal/batches/:batchId/live', (req, res) => {
    res.json({ batchId: req.params.batchId, ...store.batchLive(req.params.batchId) });
  });

  app.post('/internal/ingest', route(async (req, res) => {
    const result = await ingest(req.body ?? {});
    return res.status(201).json(result);
  }));

  /** Re-deliver a stored receipt: recovery path for a lost reply. */
  app.post('/internal/ingest/:attemptId/redeliver', route(async (req, res, next) => {
    const receiptState = store.getReceipt(req.params.attemptId);
    if (!receiptState) return next(new HttpError(404, 'NO_RECEIPT', '该尝试没有入库回执'));
    const delivery = await deliver(req.params.attemptId, receiptState.receipt, {});
    return res.json({ delivery, receipt: receiptState.receipt });
  }));

  /** Operator rollback of what an attempt posted. */
  app.post('/internal/ingest/:attemptId/rollback', route(async (req, res, next) => {
    const pending = store.getPending(req.params.attemptId);
    if (!pending) return next(new HttpError(404, 'ATTEMPT_NOT_FOUND', '入库服务没有该尝试的记录'));
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : 'operator_rollback';
    const result = store.rollbackAttempt({ attemptId: req.params.attemptId, reason });
    store.event({
      attemptId: req.params.attemptId,
      batchId: pending.batchId,
      type: 'ingest_rolled_back',
      message: `撤销入库 ${result.rolledBack} 条记录（${reason}）`,
    });
    if (result.rolledBack === 0) {
      return res.status(409).json({ error: { code: 'NOTHING_TO_ROLLBACK', message: '该尝试没有在账记录可撤销' } });
    }
    return res.json({ rolledBack: result.rolledBack, state: store.stateOf(req.params.attemptId) });
  }));

  /** Roll back every live row of a batch. */
  app.post('/internal/batches/:batchId/rollback', route(async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : 'operator_rollback';
    const result = store.rollbackBatch({ batchId: req.params.batchId, reason });
    store.event({ batchId: req.params.batchId, type: 'batch_rolled_back', message: `撤销批次入库 ${result.rolledBack} 条记录（${reason}）` });
    res.json({ rolledBack: result.rolledBack, ...store.batchLive(req.params.batchId) });
  }));

  app.get('/internal/faults', (req, res) => res.json({ faults: faults.list() }));

  app.post('/internal/faults', route(async (req, res) => {
    const { kind, stage = null, attemptId = null, remaining = 1, params = null, note = null } = req.body ?? {};
    if (typeof kind !== 'string' || kind === '') throw new HttpError(400, 'INVALID_BODY', 'kind 必填');
    res.status(201).json({ fault: faults.add({ kind, stage, attemptId, remaining, params, note }) });
  }));

  app.delete('/internal/faults', (req, res) => {
    faults.clear();
    res.json({ cleared: true });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, store, faults };
}

export async function startIngestionService() {
  const config = createConfig();
  const db = openDatabase(dbFile(config, 'ingestion'));
  const store = createIngestionStore(db);
  const faults = createFaultStore(db);
  const { app } = createIngestionService(config, { store, faults });
  const server = app.listen(config.ports.ingestion, () => {
    console.log(JSON.stringify({ service: 'ingestion', listening: config.ports.ingestion, db: dbFile(config, 'ingestion') }));
  });
  return { server, config, store, faults };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startIngestionService();
}
