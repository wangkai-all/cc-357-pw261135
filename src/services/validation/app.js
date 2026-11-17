import { createConfig, dbFile } from '../../common/config.js';
import { openDatabase, HttpError, nowIso } from '../../common/db.js';
import { makeReceipt, receiptKey, RECEIPT_ISSUERS } from '../../common/receipts.js';
import { decodeBase64Strict, requestJson } from '../../common/internal.js';
import { createApp, errorHandler, notFoundHandler, route } from '../../common/http.js';
import { validateCsvPayload } from '../../common/records.js';
import { createValidationStore } from './store.js';
import { createFaultStore } from '../../common/faults.js';

/**
 * Validation service. Completely stateless with respect to acceptance: it
 * looks at the file, records a result, and reports it via a signed receipt.
 * It does not know whether the receipt reached the exchange.
 */
export function createValidationService(config, deps = {}) {
  const store = deps.store;
  const faults = deps.faults;
  const now = () => new Date().toISOString();

  function receiptFor(job) {
    return makeReceipt(config.secrets.validation, {
      issuer: RECEIPT_ISSUERS.VALIDATION,
      kind: 'format',
      batchId: job.batchId,
      attemptId: job.attemptId,
      token: job.token,
      seq: 2,
      outcome: job.outcome,
      details: {
        summary: job.summary,
        errorCount: job.errorCount,
        recordsOk: job.result?.records?.length ?? 0,
        errors: (job.result?.errors ?? []).slice(0, 50),
        filename: job.filename,
      },
      emittedAt: now(),
    });
  }

  /**
   * Deliver the receipt to the exchange. Faults:
   *   drop_receipt/stage=format   -> never delivered (lost in transit)
   *   disconnect_after_send       -> POST reaches the exchange, but the
   *                                 response is lost; retry is then a
   *                                 duplicate receipt the exchange must absorb
   *   delay_receipt               -> arrives late
   */
  async function deliver(job, receipt) {
    const fault = faults.take('delivery', 'format', job.attemptId) ?? faults.take('delivery', 'format', null);
    if (fault?.params?.mode === 'drop') {
      store.setDelivery(job.attemptId, 'dropped', '模拟故障：格式回执在传输中丢失');
      return { delivered: false, mode: 'drop' };
    }
    if (fault?.params?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, fault.params.delayMs));
    }
    try {
      await requestJson(`${config.urls.exchange}/internal/receipts`, {
        method: 'POST',
        token: config.internalToken,
        timeoutMs: config.dispatchTimeoutMs,
        body: { kind: 'format', receipt },
      });
      store.setDelivery(job.attemptId, 'delivered', null);
      return { delivered: true, mode: 'ok' };
    } catch (error) {
      if (fault?.params?.mode === 'disconnect_after_send') {
        store.setDelivery(job.attemptId, 'response_lost', '模拟故障：交换服务已收下回执，但响应在返回途中断开');
        return { delivered: false, mode: 'disconnect_after_send' };
      }
      store.setDelivery(job.attemptId, 'failed', error.message);
      return { delivered: false, mode: 'error', error: error.message };
    }
  }

  async function process(job) {
    store.setStatus(job.attemptId, 'processing');
    await new Promise((resolve) => setTimeout(resolve, config.validationDelayMs));
    const buffer = Buffer.from(store.contentOf(job.attemptId), 'base64');
    const result = validateCsvPayload(buffer);
    let outcome = result.outcome;
    let summary = result.summary;
    let errorCount = result.errorCount;
    let errors = result.errors;

    const forced = faults.take('force_format', 'format', job.attemptId);
    if (forced) {
      outcome = forced.params?.outcome ?? 'failed';
      summary = `${summary}（模拟故障：强制结果为 ${outcome}）`;
      if (outcome === 'failed' && errors.length === 0) {
        errors = [{ line: 0, field: 'file', code: 'SIMULATED_REJECT', message: '模拟故障：校验服务判定文件不合格' }];
        errorCount = 1;
      }
    }

    const completed = store.complete(job.attemptId, {
      outcome,
      errorCount,
      summary,
      result: { ...result, errors, errorCount, outcome },
    });
    const receipt = receiptFor(completed);
    store.saveReceipt(completed.attemptId, receipt, receiptKey(receipt));
    const delivery = await deliver(completed, receipt);
    return { job: store.get(completed.attemptId), delivery };
  }

  const app = createApp('validation');

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'validation', time: now() });
  });

  app.get('/internal/jobs', (req, res) => {
    res.json({ jobs: store.list(40), stats: store.stats() });
  });

  app.get('/internal/jobs/:attemptId', (req, res, next) => {
    const job = store.get(req.params.attemptId);
    if (!job) return next(new HttpError(404, 'JOB_NOT_FOUND', '校验任务不存在'));
    return res.json({ job, receipt: job.receipt });
  });

  /** Exchange submits a file. Returns once the receipt delivery is attempted. */
  app.post('/internal/jobs', route(async (req, res) => {
    const body = req.body ?? {};
    const { attemptId, batchId, token, filename } = body;
    if (typeof attemptId !== 'string' || typeof batchId !== 'string' || typeof token !== 'string') {
      throw new HttpError(400, 'INVALID_BODY', 'attemptId, batchId, token 必填');
    }
    const buffer = decodeBase64Strict(body.contentBase64);
    if (!buffer) throw new HttpError(400, 'INVALID_CONTENT', 'contentBase64 不合法');

    const existing = store.get(attemptId);
    if (existing) {
      // Duplicate dispatch from the exchange: never validate twice.
      return res.status(200).json({ jobId: attemptId, deduplicated: true, job: existing });
    }
    store.create({ attemptId, batchId, token, filename: filename ?? 'unknown.csv', contentBase64: body.contentBase64 });
    // Run inline so the response reflects an attempted delivery; the exchange
    // treats a fast reply as "dispatched", never as "accepted".
    await process(store.get(attemptId));
    return res.status(202).json({ jobId: attemptId, deduplicated: false, job: store.get(attemptId) });
  }));

  /** Simulated or operator-triggered re-delivery of the stored receipt. */
  app.post('/internal/jobs/:attemptId/redeliver', route(async (req, res, next) => {
    const job = store.get(req.params.attemptId);
    if (!job) return next(new HttpError(404, 'JOB_NOT_FOUND', '校验任务不存在'));
    if (!job.receipt) return next(new HttpError(409, 'NO_RECEIPT', '任务尚未产出回执'));
    const delivery = await deliver(job, job.receipt);
    return res.json({ job, delivery });
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

export async function startValidationService() {
  const config = createConfig();
  const db = openDatabase(dbFile(config, 'validation'));
  const store = createValidationStore(db);
  const faults = createFaultStore(db);
  const { app } = createValidationService(config, { store, faults });
  const server = app.listen(config.ports.validation, () => {
    console.log(JSON.stringify({ service: 'validation', listening: config.ports.validation, db: dbFile(config, 'validation') }));
  });
  return { server, config, store, faults };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startValidationService();
}
