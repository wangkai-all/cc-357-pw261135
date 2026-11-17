import {
  fileFingerprint,
  makeReceipt,
  receiptKey,
  RECEIPT_ISSUERS,
  verifyReceipt,
} from '../../common/receipts.js';
import { HttpError, newId, nowIso, transaction } from '../../common/db.js';
import { decodeBase64Strict, requestJson } from '../../common/internal.js';
import { createApp, errorHandler, notFoundHandler, route } from '../../common/http.js';

/**
 * Exchange service: the batch ledger and receipt inbox.
 *
 * Traceability rules:
 *  - "revision" keeps the batch id. The previous attempt is closed as
 *    `superseded_attempt`; only the newest active attempt can advance.
 *  - "replacement" mints a new batch. Both rows record the link
 *    (supersedes / superseded_by). Any receipt naming the old batch or its
 *    token is archived as `stale` and can never advance the replacement.
 *  - Receipts are adjudicated by identity (issuer, kind, batch, attempt,
 *    token, signature) rather than arrival order; duplicates, late arrivals
 *    and mismatched references are recorded but cannot change a stage that
 *    is already final.
 */
const STAGE_OF_RECEIPT = new Set(['received', 'format', 'ingest']);

export function createExchangeService(config, deps = {}) {
  const store = deps.store;
  const faults = deps.faults;
  const now = () => new Date().toISOString();
  const secretOf = (issuer) => config.secrets[issuer];

  // ---------------------------------------------------------------- views

  function publicReceipt(receipt) {
    return {
      kind: receipt.kind,
      issuer: receipt.issuer,
      outcome: receipt.outcome,
      seq: receipt.seq,
      emittedAt: receipt.emittedAt,
      receivedAt: receipt.receivedAt,
      application: receipt.application,
      details: receipt.details,
    };
  }

  function stageView(kind, attempt, receipts) {
    const receipt = receipts.find((r) => r.kind === kind);
    const state = kind === 'received' ? attempt.receivedState : kind === 'format' ? attempt.formatState : attempt.ingestState;
    const at = kind === 'received' ? attempt.receivedAt : kind === 'format' ? attempt.formatAt : attempt.ingestAt;
    const pendingSince =
      kind === 'received'
        ? attempt.createdAt
        : kind === 'format'
          ? attempt.formatDispatchedAt
          : attempt.ingestDispatchedAt;
    const overdue =
      state === 'pending' &&
      attempt.status === 'active' &&
      Boolean(pendingSince) &&
      Date.now() - Date.parse(pendingSince) > config.awaitingReceiptMs;
    const view = {
      kind,
      state,
      at,
      pendingSince: state === 'pending' ? pendingSince : null,
      overdue,
      receipt: receipt ? publicReceipt(receipt) : null,
    };
    if (kind === 'format') {
      view.summary = attempt.formatSummary;
      view.errors = attempt.formatErrors;
      view.dispatchError = attempt.formatDispatchError;
    }
    if (kind === 'ingest') {
      view.summary = attempt.ingestSummary;
      view.dispatchState = attempt.ingestDispatchState;
      view.dispatchError = attempt.ingestDispatchError;
    }
    return view;
  }

  function terminalState(attempt, batch) {
    if (batch.status === 'superseded') return 'superseded';
    if (attempt.status === 'superseded_attempt') return 'replaced_by_attempt';
    if (attempt.status === 'superseded_batch') return 'superseded';
    if (attempt.ingestState === 'delivered') return 'accepted';
    if (attempt.status === 'failed') return 'failed';
    if (attempt.status === 'cancelled') return 'cancelled';
    return 'in_progress';
  }

  function attemptView(attempt, batch) {
    const receipts = store.receiptsForAttempt(attempt.id);
    return {
      id: attempt.id,
      batchId: attempt.batchId,
      attemptNo: attempt.attemptNo,
      mode: attempt.mode,
      status: attempt.status,
      filename: attempt.filename,
      fingerprint: attempt.fingerprint,
      sizeBytes: attempt.sizeBytes,
      // The stage token is the identity a receipt must carry. It is not a
      // secret; it is what makes a stale receipt from an older attempt
      // recognisable instead of being credited to the current one.
      token: attempt.token,
      createdAt: attempt.createdAt,
      closedAt: attempt.closedAt,
      stages: {
        received: stageView('received', attempt, receipts),
        format: stageView('format', attempt, receipts),
        ingest: stageView('ingest', attempt, receipts),
      },
      receipts: receipts.map(publicReceipt),
      emitted: store.emittedForAttempt(attempt.id).map((e) => ({
        kind: e.kind,
        deliveryState: e.deliveryState,
        emittedAt: e.emittedAt,
      })),
      terminal: terminalState(attempt, batch),
    };
  }

  function batchView(batch) {
    const attempts = store.listAttempts(batch.id);
    const current = attempts.find((a) => a.id === batch.currentAttemptId) ?? attempts.at(-1) ?? null;
    return {
      ...batch,
      attempts: attempts.map((a) => attemptView(a, batch)).sort((a, b) => b.attemptNo - a.attemptNo),
      current: current ? attemptView(current, batch) : null,
      anomalies: store.anomaliesForBatch(batch.id, 30),
      events: store.eventsForBatch(batch.id, 60),
    };
  }

  // ------------------------------------------------------------- helpers

  function readUpload(body) {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
    const { filename, contentBase64 } = body;
    if (typeof filename !== 'string' || filename.trim() === '' || filename.length > 200) {
      throw new HttpError(400, 'INVALID_FILENAME', 'filename 必须是 1-200 字符的非空字符串');
    }
    const buffer = decodeBase64Strict(contentBase64);
    if (!buffer) throw new HttpError(400, 'INVALID_CONTENT', 'contentBase64 不是合法 base64');
    if (buffer.length === 0) throw new HttpError(400, 'EMPTY_FILE', '文件内容为空');
    if (buffer.length > config.maxUploadBytes) {
      throw new HttpError(413, 'FILE_TOO_LARGE', `文件超过 ${config.maxUploadBytes} 字节上限`);
    }
    return { filename, contentBase64, sizeBytes: buffer.length, fingerprint: fileFingerprint(contentBase64) };
  }

  function addEvent(batchId, attemptId, type, message, { level = 'info', detail = null } = {}) {
    store.event({ batchId, attemptId, type, level, message, detail });
  }

  // ------------------------------------------------------ stage emission

  /**
   * The exchange signs its own "received" receipt. A dropped copy is
   * recoverable from the stored file, so the fault only hides the audit
   * copy rather than wedging the pipeline; reconciliation re-emits it.
   */
  function emitReceivedReceipt(attempt) {
    const payload = makeReceipt(secretOf('exchange'), {
      issuer: RECEIPT_ISSUERS.EXCHANGE,
      kind: 'received',
      batchId: attempt.batchId,
      attemptId: attempt.id,
      token: attempt.token,
      seq: 1,
      outcome: 'accepted',
      details: {
        filename: attempt.filename,
        sizeBytes: attempt.sizeBytes,
        fingerprint: attempt.fingerprint,
      },
      emittedAt: now(),
    });
    const fault = faults.take('drop_receipt', 'received');
    if (fault) {
      store.rememberEmitted(attempt.id, payload, 'dropped_by_fault');
      addEvent(attempt.batchId, attempt.id, 'receipt_dropped', '模拟故障：收件回执被丢弃（文件仍在交换服务，可重建）', {
        level: 'warn',
        detail: { kind: 'received', faultId: fault.id },
      });
      return null;
    }
    store.rememberEmitted(attempt.id, payload, 'inbox');
    return payload;
  }

  async function dispatchValidation(attempt) {
    const fault = faults.take('drop_dispatch', 'format');
    if (fault) {
      const error = '模拟故障：转交校验服务的请求在网络中丢失';
      store.raw.setFormatDispatched.run(now(), error, attempt.id);
      addEvent(attempt.batchId, attempt.id, 'dispatch_lost', `转交校验失败：${error}`, {
        level: 'error',
        detail: { stage: 'format', faultId: fault.id },
      });
      return { ok: false, error };
    }
    store.raw.setFormatDispatched.run(now(), null, attempt.id);
    try {
      const response = await requestJson(`${config.urls.validation}/internal/jobs`, {
        method: 'POST',
        token: config.internalToken,
        timeoutMs: config.dispatchTimeoutMs,
        body: {
          attemptId: attempt.id,
          batchId: attempt.batchId,
          token: attempt.token,
          filename: attempt.filename,
          contentBase64: attempt.contentBase64,
          behaviour: fault?.params ?? null,
        },
      });
      addEvent(attempt.batchId, attempt.id, 'dispatched_validation', '文件已转交校验服务', {
        detail: { jobId: response.body?.jobId ?? null },
      });
      return { ok: true };
    } catch (error) {
      store.raw.setFormatDispatched.run(now(), error.message, attempt.id);
      addEvent(attempt.batchId, attempt.id, 'dispatch_failed', `转交校验服务失败：${error.message}`, {
        level: 'error',
        detail: { code: error.code, status: error.status },
      });
      return { ok: false, error: error.message };
    }
  }

  async function dispatchIngestion(attempt) {
    if (attempt.ingestDispatchState === 'in_flight' || attempt.ingestDispatchState === 'sent') {
      // Sent previously: do not blindly re-send. Reconciliation decides
      // whether the ledger has the rows, whether to replay a receipt, or
      // whether the request truly never landed.
      return { ok: true, skipped: true };
    }
    const fault = faults.take('drop_dispatch', 'ingest');
    store.raw.setIngestDispatch.run(now(), 'in_flight', null, attempt.id);
    if (fault) {
      const error = '模拟故障：转交入库的请求在网络中丢失';
      store.raw.setIngestDispatch.run(now(), 'unknown', error, attempt.id);
      addEvent(attempt.batchId, attempt.id, 'dispatch_lost', `转交入库状态未知：${error}`, {
        level: 'error',
        detail: { stage: 'ingest', faultId: fault.id },
      });
      return { ok: false, error };
    }
    try {
      const response = await requestJson(`${config.urls.ingestion}/internal/ingest`, {
        method: 'POST',
        token: config.internalToken,
        timeoutMs: config.dispatchTimeoutMs,
        body: {
          attemptId: attempt.id,
          batchId: attempt.batchId,
          token: attempt.token,
          filename: attempt.filename,
          contentBase64: attempt.contentBase64,
          fingerprint: attempt.fingerprint,
          behaviour: fault?.params ?? null,
        },
      });
      store.raw.setIngestDispatch.run(now(), 'sent', null, attempt.id);
      addEvent(attempt.batchId, attempt.id, 'dispatched_ingestion', '格式校验通过，文件已转交业务入库', {
        detail: { posted: response.body?.posted ?? null },
      });
      return { ok: true };
    } catch (error) {
      // A transport error cannot distinguish "request lost" from "ledger
      // committed, reply lost". The ingest receipt (or a reconciliation
      // against the ledger) is the only authority; never fail the stage here.
      store.raw.setIngestDispatch.run(now(), 'unknown', error.message, attempt.id);
      addEvent(attempt.batchId, attempt.id, 'dispatch_unknown', `转交入库的响应未到达：${error.message}`, {
        level: 'warn',
        detail: { code: error.code, status: error.status },
      });
      return { ok: false, error: error.message };
    }
  }

  async function advanceAttempt(attemptId) {
    const attempt = store.getAttempt(attemptId);
    if (!attempt || attempt.status !== 'active') return;
    if (attempt.formatState === 'pending' && !attempt.formatDispatchedAt) {
      await dispatchValidation(attempt);
      return;
    }
    if (attempt.formatState === 'passed' && attempt.ingestState === 'pending') {
      await dispatchIngestion(attempt);
    }
  }

  /**
   * After a format receipt arrives, the file is immediately movable to
   * ingestion. done by the caller after ingestReceipt.
   */
  async function continueAfterFormat(attemptId) {
    const attempt = store.getAttempt(attemptId);
    if (!attempt || attempt.status !== 'active') return;
    if (attempt.formatState === 'passed' && attempt.ingestState === 'pending') {
      await dispatchIngestion(attempt);
    }
  }

  // ------------------------------------------------------ receipt intake

  function adjudicate({ kind, receipt }) {
    if (!receipt || typeof receipt !== 'object') {
      return { disposition: 'rejected', reason: 'MALFORMED', detail: '回执缺失或不是对象' };
    }
    if (kind && receipt.kind !== kind) {
      return { disposition: 'rejected', reason: 'KIND_MISMATCH', detail: `期望 ${kind} 回执，收到 ${receipt.kind}` };
    }
    if (!STAGE_OF_RECEIPT.has(receipt.kind)) {
      return { disposition: 'rejected', reason: 'UNKNOWN_KIND', detail: `未知回执类型 ${receipt.kind}` };
    }
    const expectedIssuer =
      receipt.kind === 'received'
        ? RECEIPT_ISSUERS.EXCHANGE
        : receipt.kind === 'format'
          ? RECEIPT_ISSUERS.VALIDATION
          : RECEIPT_ISSUERS.INGESTION;
    if (receipt.issuer !== expectedIssuer) {
      return {
        disposition: 'rejected',
        reason: 'WRONG_ISSUER',
        detail: `${receipt.kind} 回执只能由 ${expectedIssuer} 签发，收到 ${receipt.issuer}`,
      };
    }
    if (typeof receipt.signature !== 'string' || !verifyReceipt(secretOf(receipt.issuer), receipt)) {
      // The envelope's references are not trustworthy, but if the attempt id
      // names a real attempt we still attribute the anomaly to its batch so
      // operators see the forged receipt where it was aimed. Referencing an
      // attempt never changes state; only the signature can do that.
      const hinted = receipt.attemptId ? store.getAttempt(receipt.attemptId) : null;
      return {
        disposition: 'rejected',
        reason: 'BAD_SIGNATURE',
        detail: '签名不匹配：回执被篡改或来自非信任签发方',
        attempt: hinted ?? undefined,
        batchId: hinted?.batchId ?? undefined,
      };
    }
    const attempt = receipt.attemptId ? store.getAttempt(receipt.attemptId) : null;
    if (!attempt) {
      const batch = receipt.batchId ? store.getBatch(receipt.batchId) : null;
      return {
        disposition: 'orphan',
        reason: 'UNKNOWN_ATTEMPT',
        detail: '回执引用了交换服务不认识的尝试，无法归属',
        batchId: batch?.id ?? null,
      };
    }
    if (receipt.batchId !== attempt.batchId) {
      return {
        disposition: 'rejected',
        reason: 'BATCH_ATTEMPT_MISMATCH',
        detail: `回执声明批次 ${receipt.batchId}，但该尝试属于批次 ${attempt.batchId}`,
        attempt,
      };
    }
    if (receipt.token !== attempt.token) {
      return {
        disposition: 'rejected',
        reason: 'TOKEN_MISMATCH',
        detail: '阶段 token 不匹配：回执来自其他尝试或其他批次',
        attempt,
      };
    }
    const batch = store.getBatch(attempt.batchId);
    if (batch.status === 'cancelled') {
      return {
        disposition: 'stale',
        reason: 'BATCH_CANCELLED',
        detail: '批次已撤销，迟到的回执只归档，不推进任何阶段',
        attempt,
        batch,
      };
    }
    if (batch.status === 'voided') {
      return {
        disposition: 'stale',
        reason: 'BATCH_VOIDED',
        detail: '批次已作废（已入库部分已被撤销），迟到的回执不能再把它当成成功',
        attempt,
        batch,
      };
    }
    if (batch.status === 'superseded') {
      return {
        disposition: 'stale',
        reason: 'BATCH_SUPERSEDED',
        detail: `批次已被替代批次 ${batch.supersededBy} 取代，旧回执只归档、不改变状态`,
        attempt,
        batch,
      };
    }
    if (attempt.status !== 'active') {
      const alreadyFinal =
        (receipt.kind === 'received' && attempt.receivedState !== 'pending') ||
        (receipt.kind === 'format' && attempt.formatState !== 'pending') ||
        (receipt.kind === 'ingest' && attempt.ingestState !== 'pending');
      return {
        disposition: alreadyFinal ? 'duplicate' : 'stale',
        reason: alreadyFinal ? 'STAGE_ALREADY_FINAL' : 'ATTEMPT_NOT_ACTIVE',
        detail: alreadyFinal ? '该阶段已有终态，重复回执仅归档' : `尝试已结束（${attempt.status}），回执只归档`,
        attempt,
        batch,
      };
    }
    return { disposition: 'apply', attempt, batch };
  }

  function applyReceipt(receipt, attempt) {
    const stage = receipt.kind;
    const alreadyFinal =
      (stage === 'received' && attempt.receivedState !== 'pending') ||
      (stage === 'format' && attempt.formatState !== 'pending') ||
      (stage === 'ingest' && attempt.ingestState !== 'pending');
    if (alreadyFinal) {
      const previous =
        stage === 'received' ? attempt.receivedState : stage === 'format' ? attempt.formatState : attempt.ingestState;
      const expected =
        stage === 'received' ? 'passed' : stage === 'format' ? receipt.outcome : receipt.outcome === 'delivered' ? 'delivered' : 'failed';
      if (previous === expected) return { disposition: 'duplicate', reason: 'STAGE_ALREADY_FINAL' };
      return {
        disposition: 'conflict',
        reason: 'CONFLICTING_OUTCOME',
        detail: `该阶段已记录为 ${previous}，新回执声称 ${expected}；状态保持不变`,
      };
    }

    // Out-of-order handling. A downstream receipt is itself evidence that the
    // upstream stage happened, so a missing local "received" record can be
    // derived; a format receipt cannot be derived, so an early ingest receipt
    // is parked until the format stage has a final state.
    if (stage === 'format' && attempt.receivedState === 'pending') {
      store.raw.setReceived.run(receipt.emittedAt, attempt.id);
      addEvent(attempt.batchId, attempt.id, 'stage_received_inferred', '格式回执先于收件回执到达；校验服务已拿到文件，收件阶段据此补记', {
        level: 'warn',
        detail: { inferredFrom: 'format receipt', emittedAt: receipt.emittedAt },
      });
    }
    if (stage === 'ingest' && attempt.formatState === 'failed') {
      return { disposition: 'conflict', reason: 'FORMAT_FAILED', detail: '格式校验已判定不通过，入库回执不成立；状态保持不变' };
    }
    if (stage === 'ingest' && attempt.formatState !== 'passed') {
      return { disposition: 'parked', reason: 'PREREQUISITE_PENDING', detail: '入库回执先于格式结果到达，暂存待格式阶段落定' };
    }
    if (stage === 'ingest' && attempt.receivedState === 'pending') {
      // Cannot be derived from an ingest receipt alone; parked as well.
      return { disposition: 'parked', reason: 'PREREQUISITE_PENDING', detail: '收件阶段尚未落定，入库回执暂存' };
    }

    if (stage === 'received') {
      store.raw.setReceived.run(receipt.emittedAt, attempt.id);
      addEvent(attempt.batchId, attempt.id, 'stage_received', '收件回执到达：交换服务确认收到文件', {
        detail: { receiptOutcome: receipt.outcome },
      });
      return { disposition: 'applied', stage, state: 'received' };
    }

    if (stage === 'format') {
      const passed = receipt.outcome === 'passed';
      store.raw.setFormat.run(
        passed ? 'passed' : 'failed',
        receipt.emittedAt,
        JSON.stringify(receipt.details?.errors ?? []),
        receipt.details?.summary ?? (passed ? '格式校验通过' : '格式校验未通过'),
        attempt.id,
      );
      if (!passed) {
        store.setBatchStatus(attempt.batchId, 'failed', { closedReason: 'format_failed' });
        // Anything parked behind a passing format result can never apply now.
        for (const row of store.parkedForAttempt(attempt.id)) {
          store.deleteReceipt(row.receipt_key);
          const payload = JSON.parse(row.payload_json);
          store.recordReceiptRecord(payload, {
            receiptKey: row.receipt_key,
            application: 'stale',
            details: { reason: 'FORMAT_FAILED', detail: '格式校验未通过，暂存的入库回执作废' },
          });
          store.recordAnomaly({ reason: 'FORMAT_FAILED', detail: '格式校验未通过，暂存的入库回执作废', payload });
        }
      }
      addEvent(
        attempt.batchId,
        attempt.id,
        passed ? 'stage_format_passed' : 'stage_format_failed',
        passed
          ? `格式校验回执：通过（${receipt.details?.recordsOk ?? 0} 条记录）`
          : `格式校验回执：未通过，${receipt.details?.errorCount ?? '?'} 处问题`,
        { level: passed ? 'info' : 'warn', detail: receipt.details ?? null },
      );
      // A passing format result clears the batch-level failure so the batch
      // can proceed to ingestion.
      if (passed && store.getBatch(attempt.batchId).status === 'failed') {
        store.setBatchStatus(attempt.batchId, 'submitted', { closedReason: null });
      }
      return { disposition: 'applied', stage, state: passed ? 'passed' : 'failed' };
    }

    const delivered = receipt.outcome === 'delivered';
    store.raw.setIngest.run(
      delivered ? 'delivered' : 'failed',
      receipt.emittedAt,
      receipt.details?.summary ?? (delivered ? '入库成功' : '入库失败'),
      attempt.id,
    );
    if (delivered) {
      store.raw.setAttemptStatus.run('completed', null, attempt.id);
      store.setBatchStatus(attempt.batchId, 'accepted', { acceptedAt: receipt.emittedAt });
      addEvent(
        attempt.batchId,
        attempt.id,
        'batch_accepted',
        `业务入库回执到达：${receipt.details?.posted ?? '?'} 条入账，批次接收完成`,
        { detail: receipt.details ?? null },
      );
    } else {
      store.raw.setAttemptStatus.run('failed', receipt.emittedAt, attempt.id);
      store.setBatchStatus(attempt.batchId, 'partially_accepted', { closedReason: 'ingest_failed' });
      addEvent(attempt.batchId, attempt.id, 'stage_ingest_failed', `业务入库回执：失败（${receipt.details?.summary ?? receipt.outcome}）`, {
        level: 'error',
        detail: receipt.details ?? null,
      });
    }
    return { disposition: 'applied', stage, state: delivered ? 'delivered' : 'failed' };
  }

  /** Single entry point for every receipt: peer HTTP post or locally produced. */
  function ingestReceipt({ kind, receipt }, { source = 'peer' } = {}) {
    const verdict = adjudicate({ kind, receipt });
    const key = receipt && typeof receipt === 'object' && receipt.kind ? receiptKey(receipt) : null;

    if (verdict.disposition === 'rejected' || verdict.disposition === 'orphan') {
      store.recordAnomaly({
        reason: verdict.reason,
        detail: verdict.detail,
        payload: receipt,
        batchId: verdict.attempt?.batchId ?? verdict.batchId ?? undefined,
        attemptId: verdict.attempt?.id,
      });
      addEvent(
        verdict.attempt?.batchId ?? verdict.batchId ?? null,
        verdict.attempt?.id ?? null,
        'receipt_anomaly',
        `回执被拒绝（${verdict.reason}）：${verdict.detail}`,
        { level: 'error', detail: { kind: receipt?.kind, issuer: receipt?.issuer, seq: receipt?.seq } },
      );
      return { ...verdict, recorded: false };
    }

    // Exact-byte duplicates only short-circuit when the receipt would otherwise
    // still apply (or is itself already final). A receipt whose batch has since
    // been superseded, or whose prerequisite failed, must keep reporting
    // "stale"/"conflict" even though the same bytes were archived earlier —
    // otherwise replaying an old receipt could look like a harmless duplicate
    // and hide the fact that it no longer belongs to a live batch.
    const alreadyArchived = Boolean(key && store.receiptExists(key));
    if (alreadyArchived && (verdict.disposition === 'apply' || verdict.disposition === 'duplicate')) {
      store.recordAnomaly({
        reason: 'EXACT_DUPLICATE',
        detail: `${receipt.kind} 回执与已归档记录完全一致，按重复处理`,
        payload: receipt,
        batchId: verdict.attempt?.batchId ?? verdict.batchId ?? undefined,
        attemptId: verdict.attempt?.id,
      });
      return {
        disposition: 'duplicate',
        reason: 'EXACT_DUPLICATE',
        attempt: verdict.attempt,
        batchId: verdict.attempt?.batchId ?? null,
        recorded: true,
      };
    }

    const result = transaction(store.db, () => {
      const outcome = verdict.disposition === 'apply'
        ? { ...verdict, ...applyReceipt(receipt, verdict.attempt) }
        : verdict;
      // Record the receipt under the disposition it actually received, so the
      // archive reads "parked" / "conflict" rather than a misleading "applied".
      // Bytes already in the archive are not re-inserted (the key is unique);
      // the fresh disposition still goes to anomalies/events below.
      if (!alreadyArchived) {
        store.recordReceiptRecord(receipt, {
          receiptKey: key,
          application: outcome.disposition,
          details: outcome.reason ? { reason: outcome.reason, detail: outcome.detail } : null,
        });
      }
      // If the bytes were already archived, the archive keeps the disposition
      // from their first arrival; the fresh verdict is still surfaced through
      // the returned result, an anomaly and an event below.
      return outcome;
    });

    if (result.disposition === 'duplicate') {
      addEvent(verdict.attempt.batchId, verdict.attempt.id, 'receipt_duplicate', `${receipt.kind} 回执晚于阶段终态到达，仅归档`, {
        level: 'warn',
        detail: { reason: result.reason },
      });
      store.recordAnomaly({ reason: result.reason, detail: result.detail, payload: receipt });
    }
    if (result.disposition === 'stale') {
      addEvent(verdict.attempt.batchId, verdict.attempt.id, 'receipt_stale', `${receipt.kind} 回执不再有效：${verdict.detail}`, {
        level: 'warn',
        detail: { reason: verdict.reason },
      });
      store.recordAnomaly({ reason: verdict.reason, detail: verdict.detail, payload: receipt });
    }
    if (result.disposition === 'parked') {
      addEvent(verdict.attempt.batchId, verdict.attempt.id, 'receipt_parked', `${receipt.kind} 回执乱序到达，暂存：${result.detail}`, {
        level: 'warn',
        detail: { reason: result.reason },
      });
      store.recordAnomaly({ reason: result.reason, detail: result.detail, payload: receipt });
    }
    if (result.disposition === 'conflict') {
      addEvent(verdict.attempt.batchId, verdict.attempt.id, 'receipt_conflict', `${receipt.kind} 回执与既有终态矛盾：${result.detail}`, {
        level: 'error',
        detail: { reason: result.reason },
      });
      store.recordAnomaly({ reason: result.reason, detail: result.detail, payload: receipt });
    }
    if (result.disposition === 'applied' && receipt.kind === 'format') {
      replayParked(verdict.attempt.id);
    }
    return result;
  }

  /**
   * Receipts that arrived before their prerequisite now get a second chance.
   * A parked ingest receipt only survives if the format stage actually passed.
   */
  function replayParked(attemptId) {
    const parked = store.parkedForAttempt(attemptId);
    for (const row of parked) {
      store.deleteReceipt(row.receipt_key);
      const payload = JSON.parse(row.payload_json);
      const replay = ingestReceipt({ kind: payload.kind, receipt: payload });
      addEvent(
        payload.batchId,
        attemptId,
        'receipt_replayed',
        `乱序暂存的 ${payload.kind} 回执在格式阶段落定后重放：${replay.disposition}`,
        { level: 'warn', detail: { reason: replay.reason ?? null } },
      );
    }
  }

  // ------------------------------------------------------------ endpoints

  const app = createApp('exchange');

  app.get('/health', (req, res) => res.json({ ok: true, service: 'exchange', time: now() }));

  app.get('/internal/batches', (req, res) => {
    res.json({ batches: store.listBatches().map(batchView), anomalies: store.recentAnomalies(50) });
  });

  /** The stored file of an attempt, for replay and for the UI's diff view. */
  app.get('/internal/batches/:id/file/:attemptId', (req, res, next) => {
    const batch = store.getBatch(req.params.id);
    if (!batch) return next(new HttpError(404, 'BATCH_NOT_FOUND', '批次不存在'));
    const attempt = store.getAttempt(req.params.attemptId);
    if (!attempt || attempt.batchId !== batch.id) return next(new HttpError(404, 'ATTEMPT_NOT_FOUND', '尝试不属于该批次'));
    return res.json({
      attemptId: attempt.id,
      batchId: batch.id,
      filename: attempt.filename,
      fingerprint: attempt.fingerprint,
      contentBase64: attempt.contentBase64,
      sizeBytes: attempt.sizeBytes,
    });
  });

  app.get('/internal/anomalies', (req, res) => {
    res.json({ anomalies: store.recentAnomalies(200), events: store.recentEvents(100) });
  });

  app.get('/internal/batches/:id', (req, res, next) => {
    const batch = store.getBatch(req.params.id);
    if (!batch) return next(new HttpError(404, 'BATCH_NOT_FOUND', '批次不存在'));
    return res.json({ batch: batchView(batch) });
  });

  /** Sender hands over a new file. */
  app.post('/internal/batches', route(async (req, res) => {
    const upload = readUpload(req.body);
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : null;
    const created = store.createBatch({ ...upload, note, idempotencyKey });
    if (!created.created) {
      return res.status(200).json({
        deduplicated: true,
        message: '相同幂等键的批次已存在，未重复登记',
        batch: batchView(created.batch),
      });
    }
    const attempt = store.getAttempt(created.attempt.id);
    const received = emitReceivedReceipt(attempt);
    if (received) ingestReceipt({ kind: 'received', receipt: received }, { source: 'self' });
    // Downstream stages are dispatched asynchronously: a 201 here means the
    // exchange accepted the file, never that validation or ingestion passed.
    const response = res.status(201).json({ deduplicated: false, batch: batchView(store.getBatch(created.batch.id)) });
    setImmediate(() => {
      advanceAttempt(attempt.id).catch((error) => console.error('advanceAttempt', error));
    });
    return response;
  }));

  /** Same batch, corrected file. */
  app.post('/internal/batches/:id/revisions', route(async (req, res) => {
    const batch = store.getBatch(req.params.id);
    if (!batch) throw new HttpError(404, 'BATCH_NOT_FOUND', '批次不存在');
    if (batch.status === 'superseded') {
      throw new HttpError(409, 'BATCH_SUPERSEDED', `该批次已被 ${batch.supersededBy} 替代，请到替代批次补交`);
    }
    if (batch.status === 'accepted') {
      throw new HttpError(409, 'BATCH_ALREADY_ACCEPTED', '批次已完成接收；要变更请创建替代批次');
    }
    if (batch.status === 'cancelled') throw new HttpError(409, 'BATCH_CANCELLED', '批次已撤销，不能补交');
    const upload = readUpload(req.body);
    const { attempt, previousAttemptId } = store.addRevision(batch, upload);
    const fresh = store.getAttempt(attempt.id);
    const received = emitReceivedReceipt(fresh);
    if (received) ingestReceipt({ kind: 'received', receipt: received }, { source: 'self' });
    setImmediate(() => {
      advanceAttempt(attempt.id).catch((error) => console.error('advanceAttempt', error));
    });
    return res.status(201).json({
      batch: batchView(store.getBatch(batch.id)),
      newAttemptId: attempt.id,
      previousAttemptId,
      traceability: 'same_batch',
    });
  }));

  /** New batch that explicitly supersedes this one. */
  app.post('/internal/batches/:id/replacement', route(async (req, res) => {
    const old = store.getBatch(req.params.id);
    if (!old) throw new HttpError(404, 'BATCH_NOT_FOUND', '批次不存在');
    if (old.status === 'superseded') throw new HttpError(409, 'BATCH_SUPERSEDED', '该批次已被替代，不能再次替代');
    // A replacement is a new business object: it must not duplicate rows that
    // are already live for the old batch. Roll those back first, deliberately.
    const live = await askPeer(`${config.urls.ingestion}/internal/batches/${old.id}/live`);
    if (live.status === 200 && (live.body?.rows ?? 0) > 0) {
      throw new HttpError(
        409,
        'LEDGER_HAS_LIVE_ROWS',
        `原批次已有 ${live.body.rows} 条记录在库；请先撤销已入库部分，再创建替代批次，避免同一批数据重复入账`,
        { rows: live.body.rows, amount: live.body.amount },
      );
    }
    const upload = readUpload(req.body);
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
    const created = store.createReplacement(old, { ...upload, note });
    const attempt = store.getAttempt(created.attempt.id);
    const received = emitReceivedReceipt(attempt);
    if (received) ingestReceipt({ kind: 'received', receipt: received }, { source: 'self' });
    setImmediate(() => {
      advanceAttempt(attempt.id).catch((error) => console.error('advanceAttempt', error));
    });
    return res.status(201).json({
      batch: batchView(store.getBatch(created.batch.id)),
      superseded: batchView(store.getBatch(old.id)),
      traceability: 'new_batch',
    });
  }));

  /** Receipt inbox: peers post here; the console's simulator posts here too. */
  app.post('/internal/receipts', route(async (req, res) => {
    const { kind, receipt } = req.body ?? {};
    if (!receipt) throw new HttpError(400, 'INVALID_BODY', 'body.receipt is required');
    // Ingest receipts can unblock the pipeline, so continue asynchronously
    // after acknowledging: the caller is the peer, not the console.
    const result = ingestReceipt({ kind, receipt });
    if (result.disposition === 'applied' && result.stage === 'format') {
      res.on('finish', () => {
        continueAfterFormat(receipt.attemptId).catch((error) => console.error('continueAfterFormat', error));
      });
    }
    const status = result.disposition === 'rejected' ? 422 : 200;
    return res.status(status).json({
      disposition: result.disposition,
      reason: result.reason ?? null,
      detail: result.detail ?? null,
      batch: result.attempt ? batchView(store.getBatch(result.attempt.batchId)) : null,
    });
  }));

  /** Drop work that has not been ingested. Ledger cross-check lives here. */
  app.post('/internal/batches/:id/cancel', route(async (req, res) => {
    const batch = store.getBatch(req.params.id);
    if (!batch) throw new HttpError(404, 'BATCH_NOT_FOUND', '批次不存在');
    if (batch.status === 'superseded') throw new HttpError(409, 'BATCH_SUPERSEDED', '批次已被替代，无需撤销');
    if (batch.status === 'voided') throw new HttpError(409, 'BATCH_VOIDED', '批次已作废');
    if (batch.status === 'accepted') throw new HttpError(409, 'BATCH_ALREADY_ACCEPTED', '批次已完成入库，不能撤销');
    const attempt = store.getAttempt(batch.currentAttemptId);
    if (!attempt) throw new HttpError(409, 'NO_ACTIVE_ATTEMPT', '没有可撤销的尝试');
    if (attempt.ingestState === 'delivered') {
      throw new HttpError(409, 'ALREADY_INGESTED', '业务入库已完成，不能撤销');
    }

    // Ask the ledger whether anything is actually posted. This catches a
    // commit whose reply (and receipt) never made it back to us.
    const peer = await askPeer(`${config.urls.ingestion}/internal/ingest/${attempt.id}`);
    if (peer.status === 200 && peer.body?.state === 'posted') {
      throw new HttpError(409, 'LEDGER_ALREADY_HAS_DATA', '入库库中已有该批次数据（部分或全部），不能撤销未入库部分；请先处理已入账数据');
    }

    transaction(store.db, () => {
      store.raw.setAttemptStatus.run('cancelled', now(), attempt.id);
      store.setBatchStatus(batch.id, 'cancelled', { closedReason: req.body?.reason || 'operator_cancelled' });
      addEvent(batch.id, attempt.id, 'batch_cancelled', `批次被撤销，未入库部分不再推进（原因：${req.body?.reason || '操作员撤销'}）`, {
        level: 'warn',
      });
    });
    return res.json({ batch: batchView(store.getBatch(batch.id)) });
  }));

  /**
   * Reconciliation for a stage whose receipt never arrived: ask the peer what
   * it has, replay its stored receipt, or re-dispatch when it has no job.
   * This is what makes a lost ingest response safe — the ledger is truth.
   */
  app.post('/internal/batches/:id/reconcile', route(async (req, res) => {
    const batch = store.getBatch(req.params.id);
    if (!batch) throw new HttpError(404, 'BATCH_NOT_FOUND', '批次不存在');
    if (batch.status === 'superseded') {
      throw new HttpError(409, 'BATCH_SUPERSEDED', '替代批次不接受针对旧批次的推进操作');
    }
    const attemptId = req.body?.attemptId ?? batch.currentAttemptId;
    const attempt = store.getAttempt(attemptId);
    if (!attempt || attempt.batchId !== batch.id) throw new HttpError(404, 'ATTEMPT_NOT_FOUND', '尝试不属于该批次');

    const notes = [];

    let current = attempt;
    if (current.status === 'active' && current.receivedState === 'pending') {
      const payload = emitReceivedReceipt(current);
      if (payload) {
        ingestReceipt({ kind: 'received', receipt: payload }, { source: 'self' });
        notes.push('重新生成收件回执');
      } else {
        notes.push('收件回执再次被模拟故障丢弃，请先清除故障');
      }
    }

    current = store.getAttempt(attemptId);
    if (current.formatState === 'failed' && current.ingestState === 'pending') {
      notes.push('格式校验已失败，需补交修正文件后才能继续；未对入库服务发起任何操作');
    }
    if (current.status === 'active' && current.receivedState === 'passed' && current.formatState === 'pending') {
      const peer = await askPeer(`${config.urls.validation}/internal/jobs/${attemptId}`);
      if (peer.status === 200 && peer.body?.job) {
        if (peer.body.receipt) {
          const result = ingestReceipt({ kind: 'format', receipt: peer.body.receipt });
          notes.push(`校验服务已有该任务，回放格式回执：${describe(result)}`);
        } else {
          notes.push(`校验服务任务状态 ${peer.body.job.status}，回执尚未产出，稍后再对账`);
        }
      } else if (peer.status === 404) {
        if (current.formatDispatchedAt) {
          // It was dispatched once already; do not loop forever. Mark the
          // dispatch as retryable so an explicit retry can resend.
          store.raw.setFormatDispatched.run(null, current.formatDispatchError, current.id);
        }
        const again = await dispatchValidation(store.getAttempt(attemptId));
        notes.push(again.ok ? '校验服务无此任务，已重新转交' : `重新转交校验服务失败：${again.error}`);
      } else {
        notes.push(`无法查询校验服务：${peer.error ?? `HTTP ${peer.status}`}`);
      }
    }

    current = store.getAttempt(attemptId);
    if (current.status === 'active' && current.formatState === 'passed' && current.ingestState === 'pending') {
      const peer = await askPeer(`${config.urls.ingestion}/internal/ingest/${attemptId}`);
      if (peer.status === 200 && peer.body?.state) {
        if (peer.body.receipt) {
          const result = ingestReceipt({ kind: 'ingest', receipt: peer.body.receipt });
          notes.push(`入库服务已有该批次，回放入库回执：${describe(result)}`);
        } else if (peer.body.state === 'posted' && peer.body.pendingStatus !== 'pending') {
          notes.push('入库库中已有数据但入库服务缺失回执，请人工核查（不自动判定成功）');
        } else if (peer.body.state === 'posted') {
          // Partial commit: rows are live but the attempt never finished. The
          // ingestion service is idempotent on (batch, record), so re-dispatch
          // completes the remainder and produces the missing receipt.
          const again = await dispatchIngestion(current);
          notes.push(
            again.ok
              ? `入库为部分提交（已有 ${peer.body.live ?? 0} 条在账但无回执），已重新转交以补齐剩余记录`
              : `重新转交入库失败：${again.error}`,
          );
        } else {
          const again = await dispatchIngestion(current);
          notes.push(again.ok ? `入库服务无此任务，已重新转交（原状态 ${peer.body.state}）` : `重新转交入库失败：${again.error}`);
        }
      } else if (peer.status === 404) {
        const again = await dispatchIngestion(current);
        notes.push(again.ok ? '入库服务无此任务，已重新转交' : `重新转交入库失败：${again.error}`);
      } else {
        notes.push(`无法查询入库服务：${peer.error ?? `HTTP ${peer.status}`}`);
      }
    }

    addEvent(batch.id, attemptId, 'reconcile', `人工对账：${notes.join('；') || '没有可补发的事项'}`, { level: 'warn' });
    return res.json({ batch: batchView(store.getBatch(batch.id)), notes });
  }));

  /**
   * Mark a batch as voided after its ingested rows were rolled back. This is
   * distinct from cancel: cancel is pre-ingest, void is post-ingest.
   */
  app.post('/internal/batches/:id/void', route(async (req, res) => {
    const batch = store.getBatch(req.params.id);
    if (!batch) throw new HttpError(404, 'BATCH_NOT_FOUND', '批次不存在');
    if (batch.status === 'superseded') throw new HttpError(409, 'BATCH_SUPERSEDED', '已被替代的批次无需作废');
    const attempt = store.getAttempt(batch.currentAttemptId);
    transaction(store.db, () => {
      if (attempt) store.raw.setAttemptStatus.run('voided', now(), attempt.id);
      store.raw.setIngest.run('rolled_back', now(), '已入库数据被撤销', attempt?.id ?? batch.currentAttemptId);
      store.setBatchStatus(batch.id, 'voided', { closedReason: req.body?.reason || 'ingested_rows_rolled_back' });
      addEvent(batch.id, attempt?.id ?? null, 'batch_voided', `批次作废：${req.body?.reason || '已入库数据被撤销'}`, { level: 'warn' });
    });
    res.json({ batch: batchView(store.getBatch(batch.id)) });
  }));

  /** Retry dispatch for a stage that never reached its peer. */
  app.post('/internal/batches/:id/retry', route(async (req, res) => {
    const batch = store.getBatch(req.params.id);
    if (!batch) throw new HttpError(404, 'BATCH_NOT_FOUND', '批次不存在');
    if (batch.status === 'superseded') throw new HttpError(409, 'BATCH_SUPERSEDED', '旧批次不再推进');
    const attempt = store.getAttempt(req.body?.attemptId ?? batch.currentAttemptId);
    if (!attempt || attempt.batchId !== batch.id) throw new HttpError(404, 'ATTEMPT_NOT_FOUND', '尝试不属于该批次');
    if (attempt.status !== 'active') throw new HttpError(409, 'ATTEMPT_NOT_ACTIVE', '该尝试已结束，不能重试');
    const stage = req.body?.stage;
    if (stage === 'format') {
      if (attempt.formatState !== 'pending') throw new HttpError(409, 'STAGE_FINAL', '格式阶段已有终态');
      if (attempt.formatDispatchedAt && !attempt.formatDispatchError) {
        throw new HttpError(409, 'ALREADY_AWAITING_RECEIPT', '请求可能已送达，请先对账而不是重复转交');
      }
      store.raw.setFormatDispatched.run(null, null, attempt.id);
      const result = await dispatchValidation(store.getAttempt(attempt.id));
      return res.status(result.ok ? 200 : 502).json({ batch: batchView(store.getBatch(batch.id)), notes: [result.ok ? '已重新转交校验服务' : result.error] });
    }
    if (stage === 'ingest') {
      if (attempt.formatState !== 'passed') throw new HttpError(409, 'FORMAT_NOT_PASSED', '格式校验未通过，不能转交入库');
      if (attempt.ingestState !== 'pending') throw new HttpError(409, 'STAGE_FINAL', '入库阶段已有终态');
      if (attempt.ingestDispatchState === 'sent' || attempt.ingestDispatchState === 'in_flight' || attempt.ingestDispatchState === 'unknown') {
        throw new HttpError(409, 'ALREADY_DISPATCHED', '已转交过入库（结果未知），请先对账以确认结果');
      }
      store.raw.setIngestDispatch.run(null, 'none', null, attempt.id);
      const result = await dispatchIngestion(store.getAttempt(attempt.id));
      return res.status(result.ok ? 200 : 502).json({ batch: batchView(store.getBatch(batch.id)), notes: [result.ok ? '已重新转交入库' : result.error] });
    }
    throw new HttpError(400, 'INVALID_STAGE', 'stage 必须是 format 或 ingest');
  }));

  async function askPeer(url) {
    try {
      const response = await requestJson(url, { token: config.internalToken, timeoutMs: config.reconcileTimeoutMs });
      return { status: 200, body: response.body };
    } catch (error) {
      return { status: error.status || 0, error: error.message };
    }
  }

  function describe(result) {
    return result.disposition === 'applied' ? '已应用' : `${result.disposition}${result.reason ? `（${result.reason}）` : ''}`;
  }

  // Operators (and tests) can append routes before the catch-all handlers.
  deps.registerExtraRoutes?.({ app, store, ingestReceipt, config });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, store, ingestReceipt };
}
