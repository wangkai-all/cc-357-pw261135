import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createConfig } from '../common/config.js';
import { HttpError, newId, nowIso } from '../common/db.js';
import { requestJson, RemoteError } from '../common/internal.js';
import { makeReceipt } from '../common/receipts.js';
import { createApp, errorHandler, notFoundHandler, route } from '../common/http.js';

const PUBLIC_DIR = resolve(process.cwd(), 'public');
const FIXTURE_DIR = resolve(process.cwd(), 'fixtures');

/**
 * Console: UI-facing proxy plus a scenario driver. It owns no acceptance
 * state. Every "action" translates into a real HTTP round-trip against the
 * exchange, validation or ingestion service; the UI renders whatever those
 * services report, including "still waiting" and "we do not know".
 */
export function createConsoleService(config) {
  const app = createApp('console');

  async function call(service, path, options = {}) {
    const url = `${config.urls[service]}${path}`;
    try {
      const result = await requestJson(url, {
        token: config.internalToken,
        timeoutMs: options.timeoutMs ?? 8000,
        ...options,
      });
      return result.body;
    } catch (error) {
      if (error instanceof RemoteError) {
        // A 4xx from a peer is a verdict, not an outage: relay the peer's own
        // code/message (BATCH_SUPERSEDED, TOKEN_MISMATCH, ...) so the UI can
        // explain what actually happened instead of a generic 502. The receipt
        // inbox answers 422 with {disposition, reason, detail} rather than an
        // error envelope, so both shapes are understood.
        const peerError = error.body?.error;
        const verdict = error.body?.disposition ? error.body : null;
        const remoteStatus = error.status >= 400 && error.status < 500 ? error.status : 502;
        const code = peerError?.code || verdict?.reason || error.code || 'UPSTREAM_ERROR';
        const detail = peerError?.message || verdict?.detail || error.message;
        throw new HttpError(
          remoteStatus,
          code,
          peerError?.message ? `${service}：${peerError.message}` : `${service}：${detail}`,
          peerError?.details ?? (verdict ? { disposition: verdict.disposition, reason: verdict.reason } : null),
        );
      }
      throw error;
    }
  }

  // ------------------------------------------------------------- static UI

  app.get('/', (req, res) => res.redirect('/app/index.html'));

  app.get('/app', (req, res) => {
    res.redirect('/app/index.html');
  });

  app.use('/app', (req, res, next) => {
    const rel = req.path.replace(/^\/+/, '');
    const target = resolve(PUBLIC_DIR, rel === '' ? 'index.html' : rel);
    if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
      return next(new HttpError(403, 'FORBIDDEN', 'path escapes app root'));
    }
    if (!existsSync(target)) return next(new HttpError(404, 'NOT_FOUND', `no static file ${rel}`));
    return res.sendFile(target, (error) => {
      if (error) next();
    });
  });

  app.get('/fixtures/:name', (req, res, next) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return next(new HttpError(400, 'INVALID_NAME', '非法文件名'));
    const target = resolve(FIXTURE_DIR, name);
    if (!target.startsWith(FIXTURE_DIR + sep)) return next(new HttpError(403, 'FORBIDDEN', 'path escapes fixture root'));
    if (!existsSync(target)) return next(new HttpError(404, 'FIXTURE_NOT_FOUND', '虚构样例文件不存在'));
    return res.sendFile(target);
  });

  // ---------------------------------------------------------------- health

  app.get('/api/fixtures', route(async (req, res) => {
    const manifest = JSON.parse(await readFile(resolve(FIXTURE_DIR, 'manifest.json'), 'utf8'));
    res.json({
      fixtures: manifest.map(({ name, label, expected, note, sizeBytes, preview }) => ({
        name, label, expected, note, sizeBytes, preview,
      })),
    });
  }));

  app.get('/api/fixtures/:name', route(async (req, res) => {
    const manifest = JSON.parse(await readFile(resolve(FIXTURE_DIR, 'manifest.json'), 'utf8'));
    const fixture = manifest.find((f) => f.name === req.params.name);
    if (!fixture) throw new HttpError(404, 'FIXTURE_NOT_FOUND', '样例不存在');
    res.json(fixture);
  }));

  app.get('/api/health', route(async (req, res) => {
    const services = {};
    await Promise.all(
      ['exchange', 'validation', 'ingestion'].map(async (name) => {
        try {
          const health = await requestJson(`${config.urls[name]}/health`, { timeoutMs: 1500 });
          services[name] = { ...health.body, url: config.urls[name] };
        } catch (error) {
          services[name] = { ok: false, error: error.message, url: config.urls[name] };
        }
      }),
    );
    res.json({ console: { ok: true, time: nowIso() }, services });
  }));

  // --------------------------------------------------------------- batches

  app.get('/api/batches', route(async (req, res) => {
    res.json(await call('exchange', '/internal/batches'));
  }));

  app.get('/api/batches/:id', route(async (req, res) => {
    res.json(await call('exchange', `/internal/batches/${encodeURIComponent(req.params.id)}`));
  }));

  app.get('/api/batches/:id/file/:attemptId', route(async (req, res) => {
    res.json(await call('exchange', `/internal/batches/${encodeURIComponent(req.params.id)}/file/${encodeURIComponent(req.params.attemptId)}`));
  }));

  app.post('/api/batches', route(async (req, res) => {
    const result = await call('exchange', '/internal/batches', { method: 'POST', body: req.body ?? {} });
    res.status(201).json(result);
  }));

  app.post('/api/batches/:id/revisions', route(async (req, res) => {
    res.status(201).json(
      await call('exchange', `/internal/batches/${encodeURIComponent(req.params.id)}/revisions`, { method: 'POST', body: req.body ?? {} }),
    );
  }));

  app.post('/api/batches/:id/replacement', route(async (req, res) => {
    res.status(201).json(
      await call('exchange', `/internal/batches/${encodeURIComponent(req.params.id)}/replacement`, { method: 'POST', body: req.body ?? {} }),
    );
  }));

  app.post('/api/batches/:id/reconcile', route(async (req, res) => {
    res.json(await call('exchange', `/internal/batches/${encodeURIComponent(req.params.id)}/reconcile`, { method: 'POST', body: req.body ?? {} }));
  }));

  app.post('/api/batches/:id/retry', route(async (req, res) => {
    res.json(await call('exchange', `/internal/batches/${encodeURIComponent(req.params.id)}/retry`, { method: 'POST', body: req.body ?? {} }));
  }));

  app.post('/api/batches/:id/cancel', route(async (req, res) => {
    res.json(await call('exchange', `/internal/batches/${encodeURIComponent(req.params.id)}/cancel`, { method: 'POST', body: req.body ?? {} }));
  }));

  /**
   * Undo work that reached the ledger: roll back this attempt's rows in the
   * ingestion service, then void the batch in the exchange. Both steps are
   * real remote calls and either can fail; nothing is reported as undone
   * unless the ledger says the rollback happened.
   */
  app.post('/api/batches/:id/rollback-ingested', route(async (req, res) => {
    const { batch } = await call('exchange', `/internal/batches/${encodeURIComponent(req.params.id)}`);
    const attempts = batch?.attempts ?? [];
    const target = req.body?.attemptId
      ? attempts.find((a) => a.id === req.body.attemptId)
      : attempts.find((a) => a.stages.ingest.state === 'delivered');
    if (!target) throw new HttpError(409, 'NOT_INGESTED', '该批次没有已入库的尝试可撤销');
    const rollback = await call('ingestion', `/internal/ingest/${encodeURIComponent(target.id)}/rollback`, {
      method: 'POST',
      body: { reason: req.body?.reason ?? 'UI 撤销已入库数据' },
    });
    const voided = await call('exchange', `/internal/batches/${encodeURIComponent(req.params.id)}/void`, {
      method: 'POST',
      body: { reason: `已撤销 ${rollback.rolledBack} 条入库记录` },
    });
    res.json({ rollback, voided: voided.batch, attemptId: target.id });
  }));

  // ----------------------------------------------------------- diagnostics

  app.get('/api/diagnostics', route(async (req, res) => {
    const [validation, ingestion, exchange, faults] = await Promise.all([
      call('validation', '/internal/jobs').catch((error) => ({ error: error.message })),
      call('ingestion', '/internal/ledger').catch((error) => ({ error: error.message })),
      call('exchange', '/internal/anomalies').catch((error) => ({ error: error.message })),
      call('exchange', '/internal/faults').catch((error) => ({ error: error.message })),
    ]);
    res.json({ validation, ingestion, exchange, faults });
  }));

  app.get('/api/faults', route(async (req, res) => {
    const per = await Promise.all(
      ['exchange', 'validation', 'ingestion'].map(async (service) => {
        try {
          const body = await call(service, '/internal/faults');
          return [service, body.faults ?? []];
        } catch (error) {
          return [service, { error: error.message }];
        }
      }),
    );
    res.json({ faults: Object.fromEntries(per) });
  }));

  app.post('/api/faults', route(async (req, res) => {
    const { service, ...fault } = req.body ?? {};
    if (!['exchange', 'validation', 'ingestion'].includes(service)) {
      throw new HttpError(400, 'INVALID_SERVICE', 'service 必须是 exchange/validation/ingestion');
    }
    const result = await call(service, '/internal/faults', { method: 'POST', body: fault });
    res.status(201).json({ service, ...result });
  }));

  app.delete('/api/faults', route(async (req, res) => {
    const results = await Promise.allSettled(
      ['exchange', 'validation', 'ingestion'].map((service) => call(service, '/internal/faults', { method: 'DELETE' })),
    );
    res.json({ cleared: results.map((r) => r.status) });
  }));

  // --------------------------------------------------------------- receipts

  app.get('/api/receipts/:attemptId', route(async (req, res) => {
    res.json(await call('exchange', `/internal/receipts/${encodeURIComponent(req.params.attemptId)}`));
  }));

  /**
   * Deliver a receipt straight to the exchange inbox. The UI uses this to
   * replay a receipt that a peer stored but could not deliver.
   */
  app.post('/api/receipts', route(async (req, res) => {
    res.json(await call('exchange', '/internal/receipts', { method: 'POST', body: req.body ?? {} }));
  }));

  // -------------------------------------------------------------- simulator

  /**
   * Deterministic fault scenarios. Each one changes real service state:
   * queues a real fault in a real service, or sends a real receipt to the real
   * inbox. Nothing here fabricates a "success" the services did not produce.
   */
  app.post('/api/simulate', route(async (req, res) => {
    const { scenario, batchId, attemptId, stage = 'format', contentBase64 = null } = req.body ?? {};
    const batch = batchId ? (await call('exchange', `/internal/batches/${encodeURIComponent(batchId)}`)).batch : null;
    const attempt = attemptId
      ? batch?.attempts.find((a) => a.id === attemptId)
      : batch?.current ?? batch?.attempts?.[0] ?? null;

    const handlers = {
      /** Lose the next receipt a peer tries to deliver. */
      async lose_next_receipt() {
        if (!['format', 'ingest'].includes(stage)) throw new HttpError(400, 'INVALID_STAGE', 'stage 必须是 format 或 ingest');
        const target = stage === 'ingest' ? 'ingestion' : 'validation';
        const result = await call(target, '/internal/faults', {
          method: 'POST',
          body: {
            kind: 'delivery',
            stage,
            remaining: 1,
            params: { mode: 'drop' },
            note: '模拟：下一份回执在传输中丢失',
          },
        });
        return {
          note: `已让 ${target === 'ingestion' ? '入库' : '校验'}服务丢弃下一份 ${stage} 回执。现在上传一个新的合规批次（或对该批次补交），页面会停在“等待回执”。`,
          result,
        };
      },

      /** The peer received the receipt, but its HTTP response was cut. */
      async disconnect_after_send() {
        const target = stage === 'ingest' ? 'ingestion' : 'validation';
        const result = await call(target, '/internal/faults', {
          method: 'POST',
          body: {
            kind: 'delivery',
            stage,
            remaining: 1,
            params: { mode: 'disconnect_after_send' },
            note: '模拟：对端已收到回执，但响应断开',
          },
        });
        return {
          note: '下一次回执其实已经送进交换服务，只是响应断开。用“对账”观察：它应当被识别为重复，而不是被当成失败重来。',
          result,
        };
      },

      /** Ledger commits, then the process dies before sending the receipt. */
      async lose_receipt_after_commit() {
        const result = await call('ingestion', '/internal/faults', {
          method: 'POST',
          body: {
            kind: 'crash_after_commit',
            stage: 'ingest',
            remaining: 1,
            note: '模拟：入库提交成功后与交换服务断开',
          },
        });
        return {
          note: '下一次入库会真正写库，但不发回执。页面对账必须查入库服务的账本，不能凭“没收到回执”判定失败。',
          result,
        };
      },

      /** Real rows are posted out of order: ingest receipt arrives before format. */
      async out_of_order() {
        if (!attempt) throw new HttpError(400, 'ATTEMPT_REQUIRED', '需要选择一个批次');
        const content = contentBase64 ?? (await call('exchange', `/internal/batches/${encodeURIComponent(batch.id)}/file/${encodeURIComponent(attempt.id)}`)).contentBase64;
        if (!content) throw new HttpError(409, 'NO_CONTENT', '无法取得该尝试的文件内容');
        if (attempt.stages.format.state === 'pending') {
          // Post rows directly, which makes ingestion emit its receipt first.
          const ingest = await call('ingestion', '/internal/ingest', {
            method: 'POST',
            body: {
              attemptId: attempt.id,
              batchId: attempt.batchId,
              token: attempt.token,
              filename: attempt.filename,
              contentBase64: content,
              fingerprint: attempt.fingerprint,
            },
          }).catch((error) => ({ error: { message: error.message, details: error.details } }));
          const stored = await call('validation', `/internal/jobs/${encodeURIComponent(attempt.id)}`).catch(() => null);
          let replay = null;
          if (stored?.receipt) {
            replay = await call('exchange', '/internal/receipts', { method: 'POST', body: { kind: 'format', receipt: stored.receipt } });
          }
          return {
            note: '已先让入库服务提交数据并投递入库回执（此时格式回执尚未到达，回执被暂存），再补投格式回执。观察暂存回执在格式落定后被重放。',
            ingest,
            replay,
          };
        }
        throw new HttpError(409, 'NOT_PENDING', '该尝试的格式阶段已有结果；请先用“丢失回执”场景制造等待状态');
      },

      /** Re-send a receipt that is already recorded, unchanged. */
      async duplicate_receipt() {
        if (!attempt) throw new HttpError(400, 'ATTEMPT_REQUIRED', '需要选择一个批次');
        const stored = stage === 'format'
          ? await call('validation', `/internal/jobs/${encodeURIComponent(attempt.id)}`).catch(() => null)
          : stage === 'ingest'
            ? await call('ingestion', `/internal/ingest/${encodeURIComponent(attempt.id)}`).catch(() => null)
            : null;
        const receipt = stored?.receipt ?? null;
        if (!receipt) throw new HttpError(409, 'NO_RECEIPT', '对端没有该阶段的回执可重复投递');
        const result = await call('exchange', '/internal/receipts', { method: 'POST', body: { kind: stage, receipt } });
        return { note: '已把对端保存的同一份回执再投一次；应识别为重复且不改变任何状态。', result };
      },

      /** Signed receipt that names the wrong batch. */
      async wrong_batch_reference() {
        if (!attempt) throw new HttpError(400, 'ATTEMPT_REQUIRED', '需要选择一个批次');
        const receipt = mint(stage, attempt, { batchId: `bat_${'f'.repeat(24)}` });
        const result = await call('exchange', '/internal/receipts', { method: 'POST', body: { kind: stage, receipt } }).catch((error) => ({
          error: { status: error.status, code: error.code, message: error.message },
        }));
        return { note: '签名本身合法，但回执声明的批次号与尝试不符，应被拒绝并记入异常。', result };
      },

      /** Signed receipt carrying another attempt's token. */
      async wrong_token() {
        if (!attempt) throw new HttpError(400, 'ATTEMPT_REQUIRED', '需要选择一个批次');
        const receipt = mint(stage, attempt, { token: 'tok_000000000000000000000000' });
        const result = await call('exchange', '/internal/receipts', { method: 'POST', body: { kind: stage, receipt } }).catch((error) => ({
          error: { status: error.status, code: error.code, message: error.message },
        }));
        return { note: '签名合法但 token 不属于该尝试，应被拒绝；这正是旧批次回执不能误伤新批次的机制。', result };
      },

      /** Body changed after signing. */
      async tampered_receipt() {
        if (!attempt) throw new HttpError(400, 'ATTEMPT_REQUIRED', '需要选择一个批次');
        const receipt = mint(stage, attempt, {});
        receipt.outcome = stage === 'format' ? 'failed' : stage === 'ingest' ? 'failed' : 'accepted';
        receipt.details = { summary: '被篡改的回执' };
        const result = await call('exchange', '/internal/receipts', { method: 'POST', body: { kind: stage, receipt } }).catch((error) => ({
          error: { status: error.status, code: error.code, message: error.message },
        }));
        return { note: '回执内容被改动，HMAC 不再匹配，应被拒绝。', result };
      },

      /** Replacement batch, then the old batch tries to report success. */
      async replace_then_old_receipt() {
        if (!batch) throw new HttpError(400, 'BATCH_REQUIRED', '需要选择一个批次');
        const content = contentBase64 ?? (await call('exchange', `/internal/batches/${encodeURIComponent(batch.id)}/file/${encodeURIComponent(attempt.id)}`)).contentBase64;
        if (!content) throw new HttpError(409, 'NO_CONTENT', '无法取得该尝试的文件内容');
        const oldReceipt = mint(stage, attempt, {});
        const replacement = await call('exchange', `/internal/batches/${encodeURIComponent(batch.id)}/replacement`, {
          method: 'POST',
          body: { filename: `replacement-${Date.now()}.csv`, contentBase64: content, note: '模拟：替代批次' },
        });
        const stale = await call('exchange', '/internal/receipts', { method: 'POST', body: { kind: stage, receipt: oldReceipt } }).catch((error) => ({
          error: { status: error.status, code: error.code, message: error.message },
        }));
        return {
          note: '替代批次已创建；随后投递旧批次签发的回执。它应被归档为过期（stale），绝不能把替代批次判成功。',
          replacement: { id: replacement.batch?.id, status: replacement.batch?.status },
          stale,
        };
      },
    };

    const handler = handlers[scenario];
    if (!handler) throw new HttpError(400, 'UNKNOWN_SCENARIO', `未知演练场景 ${scenario}`);
    if (!attempt && !['lose_next_receipt', 'lose_receipt_after_commit', 'disconnect_after_send'].includes(scenario)) {
      throw new HttpError(400, 'ATTEMPT_REQUIRED', '该场景需要选择一个批次尝试');
    }
    const output = await handler();
    const refreshed = batchId ? (await call('exchange', `/internal/batches/${encodeURIComponent(batchId)}`)).batch : null;
    res.json({ scenario, ...output, batch: refreshed });
  }));

  function mint(stage, attempt, overrides) {
    const issuer = stage === 'format' ? 'validation' : stage === 'ingest' ? 'ingestion' : 'exchange';
    const seq = stage === 'received' ? 1 : stage === 'format' ? 2 : 3;
    return makeReceipt(config.secrets[issuer], {
      issuer,
      kind: stage,
      batchId: attempt.batchId,
      attemptId: attempt.id,
      token: attempt.token,
      seq,
      outcome: stage === 'received' ? 'accepted' : stage === 'format' ? 'passed' : 'delivered',
      details: { summary: '演练投递的回执', recordsOk: 0, posted: 0 },
      emittedAt: nowIso(),
      ...overrides,
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app };
}

export async function startConsoleService() {
  const config = createConfig();
  const { app } = createConsoleService(config);
  return new Promise((resolvePromise) => {
    const server = app.listen(config.ports.console, () => {
      console.log(
        JSON.stringify({ service: 'console', listening: config.ports.console, url: `http://127.0.0.1:${config.ports.console}/` }),
      );
      resolvePromise({ server, config });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startConsoleService();
}
