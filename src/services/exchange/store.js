import { nowIso, transaction, newId } from '../../common/db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('original','replacement')),
  supersedes TEXT,
  superseded_by TEXT,
  filename TEXT NOT NULL,
  note TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  current_attempt_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT,
  closed_reason TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  attempt_no INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('initial','revise')),
  token TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_b64 TEXT NOT NULL,
  status TEXT NOT NULL,
  received_state TEXT NOT NULL DEFAULT 'pending',
  format_state TEXT NOT NULL DEFAULT 'pending',
  ingest_state TEXT NOT NULL DEFAULT 'pending',
  received_at TEXT,
  format_at TEXT,
  ingest_at TEXT,
  format_errors_json TEXT,
  format_summary TEXT,
  ingest_summary TEXT,
  format_dispatched_at TEXT,
  format_dispatch_error TEXT,
  ingest_dispatched_at TEXT,
  ingest_dispatch_state TEXT NOT NULL DEFAULT 'none',
  ingest_dispatch_error TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (batch_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_key TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  kind TEXT NOT NULL,
  batch_id TEXT,
  attempt_id TEXT,
  token TEXT,
  seq INTEGER,
  outcome TEXT,
  emitted_at TEXT,
  received_at TEXT NOT NULL,
  application TEXT NOT NULL,
  details_json TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_by_attempt ON receipts(attempt_id, kind);

CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  issuer TEXT,
  kind TEXT,
  batch_id TEXT,
  attempt_id TEXT,
  token TEXT,
  receipt_key TEXT,
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  batch_id TEXT,
  attempt_id TEXT,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS emitted_receipts (
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'inbox',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, kind)
);

`;

export function rowToBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    filename: row.filename,
    note: row.note,
    fingerprint: row.fingerprint,
    status: row.status,
    currentAttemptId: row.current_attempt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    closedReason: row.closed_reason,
  };
}

function rowToAttempt(row) {
  if (!row) return null;
  const attempt = {
    id: row.id,
    batchId: row.batch_id,
    attemptNo: row.attempt_no,
    mode: row.mode,
    token: row.token,
    filename: row.filename,
    fingerprint: row.fingerprint,
    sizeBytes: row.size_bytes,
    contentBase64: row.content_b64,
    status: row.status,
    receivedState: row.received_state,
    formatState: row.format_state,
    ingestState: row.ingest_state,
    receivedAt: row.received_at,
    formatAt: row.format_at,
    ingestAt: row.ingest_at,
    formatErrors: row.format_errors_json ? JSON.parse(row.format_errors_json) : null,
    formatSummary: row.format_summary,
    ingestSummary: row.ingest_summary,
    formatDispatchedAt: row.format_dispatched_at,
    formatDispatchError: row.format_dispatch_error,
    ingestDispatchedAt: row.ingest_dispatched_at,
    ingestDispatchState: row.ingest_dispatch_state,
    ingestDispatchError: row.ingest_dispatch_error,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
  return attempt;
}

function rowToReceipt(row) {
  if (!row) return null;
  const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  return {
    receiptKey: row.receipt_key,
    issuer: row.issuer,
    kind: row.kind,
    batchId: row.batch_id,
    attemptId: row.attempt_id,
    token: row.token,
    seq: row.seq,
    outcome: row.outcome,
    emittedAt: row.emitted_at,
    receivedAt: row.received_at,
    application: row.application,
    // Business details come from the signed payload; `applicationDetails`
    // holds the exchange's own adjudication notes.
    details: payload?.details ?? null,
    applicationDetails: row.details_json ? JSON.parse(row.details_json) : null,
  };
}

function rowToEvent(row) {
  return {
    id: row.id,
    at: row.at,
    batchId: row.batch_id,
    attemptId: row.attempt_id,
    type: row.type,
    level: row.level,
    message: row.message,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
  };
}

function rowToAnomaly(row) {
  return {
    id: row.id,
    receivedAt: row.received_at,
    reason: row.reason,
    detail: row.detail,
    issuer: row.issuer,
    kind: row.kind,
    batchId: row.batch_id,
    attemptId: row.attempt_id,
    token: row.token,
    receiptKey: row.receipt_key,
  };
}

export function createExchangeStore(db) {
  db.exec(SCHEMA);

  const q = {
    insertBatch: db.prepare(`INSERT INTO batches
      (id, kind, supersedes, superseded_by, filename, note, fingerprint, status, current_attempt_id, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertAttempt: db.prepare(`INSERT INTO attempts
      (id, batch_id, attempt_no, mode, token, filename, fingerprint, size_bytes, content_b64, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getBatch: db.prepare('SELECT * FROM batches WHERE id = ?'),
    getBatchByIdempotency: db.prepare('SELECT * FROM batches WHERE idempotency_key = ?'),
    listBatches: db.prepare('SELECT * FROM batches ORDER BY created_at DESC, rowid DESC'),
    getAttempt: db.prepare('SELECT * FROM attempts WHERE id = ?'),
    listAttempts: db.prepare('SELECT * FROM attempts WHERE batch_id = ? ORDER BY attempt_no ASC'),
    activeAttemptRows: db.prepare("SELECT * FROM attempts WHERE batch_id = ? AND status = 'active' ORDER BY attempt_no DESC"),
    lastAttempt: db.prepare('SELECT * FROM attempts WHERE batch_id = ? ORDER BY attempt_no DESC LIMIT 1'),
    setBatchStatus: db.prepare(`UPDATE batches SET status = ?, updated_at = ?,
      accepted_at = COALESCE(?, accepted_at), closed_reason = COALESCE(?, closed_reason) WHERE id = ?`),
    setBatchCurrentAttempt: db.prepare('UPDATE batches SET current_attempt_id = ?, updated_at = ? WHERE id = ?'),
    markSuperseded: db.prepare('UPDATE batches SET status = ?, superseded_by = ?, updated_at = ?, closed_reason = ? WHERE id = ?'),
    setAttemptStatus: db.prepare('UPDATE attempts SET status = ?, closed_at = COALESCE(?, closed_at) WHERE id = ?'),
    setReceived: db.prepare("UPDATE attempts SET received_state = 'passed', received_at = ? WHERE id = ?"),
    setFormat: db.prepare('UPDATE attempts SET format_state = ?, format_at = ?, format_errors_json = ?, format_summary = ? WHERE id = ?'),
    setIngest: db.prepare('UPDATE attempts SET ingest_state = ?, ingest_at = ?, ingest_summary = ? WHERE id = ?'),
    setFormatDispatched: db.prepare('UPDATE attempts SET format_dispatched_at = ?, format_dispatch_error = ? WHERE id = ?'),
    setIngestDispatch: db.prepare('UPDATE attempts SET ingest_dispatched_at = ?, ingest_dispatch_state = ?, ingest_dispatch_error = ? WHERE id = ?'),
    insertReceipt: db.prepare(`INSERT INTO receipts
      (receipt_key, issuer, kind, batch_id, attempt_id, token, seq, outcome, emitted_at, received_at, application, details_json, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getReceipt: db.prepare('SELECT * FROM receipts WHERE receipt_key = ?'),
    receiptsForAttempt: db.prepare('SELECT * FROM receipts WHERE attempt_id = ? ORDER BY received_at ASC, rowid ASC'),
    parkedForAttempt: db.prepare("SELECT * FROM receipts WHERE attempt_id = ? AND application = 'parked' ORDER BY received_at ASC, rowid ASC"),
    deleteReceipt: db.prepare('DELETE FROM receipts WHERE receipt_key = ?'),
    insertAnomaly: db.prepare(`INSERT INTO anomalies
      (received_at, reason, detail, issuer, kind, batch_id, attempt_id, token, receipt_key, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    listAnomalies: db.prepare('SELECT * FROM anomalies ORDER BY id DESC LIMIT ?'),
    anomaliesForBatch: db.prepare('SELECT * FROM anomalies WHERE batch_id = ? ORDER BY id DESC LIMIT ?'),
    insertEvent: db.prepare('INSERT INTO events (at, batch_id, attempt_id, type, level, message, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    eventsForBatch: db.prepare('SELECT * FROM events WHERE batch_id = ? ORDER BY id DESC LIMIT ?'),
    recentEvents: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
    upsertEmitted: db.prepare(`INSERT INTO emitted_receipts
      (attempt_id, kind, receipt_key, payload_json, emitted_at, delivery_state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id, kind) DO UPDATE SET
        receipt_key = excluded.receipt_key,
        payload_json = excluded.payload_json,
        emitted_at = excluded.emitted_at,
        delivery_state = excluded.delivery_state,
        updated_at = excluded.updated_at`),
    emittedForAttempt: db.prepare('SELECT * FROM emitted_receipts WHERE attempt_id = ?'),
  };

  const store = {
    db,

    event({ batchId = null, attemptId = null, type, level = 'info', message, detail = null }) {
      q.insertEvent.run(nowIso(), batchId, attemptId, type, level, message, detail ? JSON.stringify(detail) : null);
    },

    getBatch(id) {
      return rowToBatch(q.getBatch.get(id));
    },

    listBatches() {
      return q.listBatches.all().map(rowToBatch);
    },

    getAttempt(id) {
      return rowToAttempt(q.getAttempt.get(id));
    },

    listAttempts(batchId) {
      return q.listAttempts.all(batchId).map(rowToAttempt);
    },

    activeAttempt(batchId) {
      const rows = q.activeAttemptRows.all(batchId);
      if (rows.length > 0) return rowToAttempt(rows[0]);
      return rowToAttempt(q.lastAttempt.get(batchId));
    },

    setBatchStatus(batchId, status, { acceptedAt = null, closedReason = null } = {}) {
      q.setBatchStatus.run(status, nowIso(), acceptedAt, closedReason, batchId);
    },

    createBatch({ filename, note, contentBase64, fingerprint, sizeBytes, idempotencyKey = null }) {
      return transaction(db, () => {
        if (idempotencyKey) {
          const existing = rowToBatch(q.getBatchByIdempotency.get(idempotencyKey));
          if (existing) return { batch: existing, attempt: store.activeAttempt(existing.id), created: false };
        }
        const now = nowIso();
        const batchId = newId('bat');
        const attemptId = newId('att');
        q.insertBatch.run(
          batchId, 'original', null, null, filename, note, fingerprint, 'submitted',
          attemptId, idempotencyKey, now, now,
        );
        q.insertAttempt.run(attemptId, batchId, 1, 'initial', newId('tok'), filename, fingerprint, sizeBytes, contentBase64, 'active', now);
        store.event({
          batchId,
          attemptId,
          type: 'batch_created',
          message: `批次已登记：${filename}（${sizeBytes} 字节），文件保存在交换服务`,
          detail: { fingerprint },
        });
        return { batch: store.getBatch(batchId), attempt: store.getAttempt(attemptId), created: true };
      });
    },

    /** Same-batch correction. Only the newest attempt may advance. */
    addRevision(batch, { filename, contentBase64, fingerprint, sizeBytes }) {
      return transaction(db, () => {
        const previous = store.activeAttempt(batch.id);
        if (!previous || previous.status !== 'active') throw new Error('batch has no active attempt');
        const now = nowIso();
        const attemptId = newId('att');
        q.setAttemptStatus.run('superseded_attempt', now, previous.id);
        q.insertAttempt.run(attemptId, batch.id, previous.attemptNo + 1, 'revise', newId('tok'), filename, fingerprint, sizeBytes, contentBase64, 'active', now);
        q.setBatchCurrentAttempt.run(attemptId, now, batch.id);
        q.setBatchStatus.run('submitted', now, null, null, batch.id);
        store.event({
          batchId: batch.id,
          attemptId,
          type: 'attempt_revised',
          message: `补交为同一批次的第 ${previous.attemptNo + 1} 次尝试（${filename}），旧尝试 ${previous.id} 关闭`,
          detail: { previousAttemptId: previous.id, previousFilename: previous.filename, fingerprint },
        });
        return { attempt: store.getAttempt(attemptId), previousAttemptId: previous.id };
      });
    },

    /** Successor batch. The old batch is closed and its receipts can no longer apply. */
    createReplacement(oldBatch, { filename, note, contentBase64, fingerprint, sizeBytes }) {
      return transaction(db, () => {
        const now = nowIso();
        const batchId = newId('bat');
        const attemptId = newId('att');
        q.insertBatch.run(batchId, 'replacement', oldBatch.id, null, filename, note, fingerprint, 'submitted', attemptId, null, now, now);
        q.insertAttempt.run(attemptId, batchId, 1, 'initial', newId('tok'), filename, fingerprint, sizeBytes, contentBase64, 'active', now);
        q.markSuperseded.run('superseded', batchId, now, `被替代批次 ${batchId} 取代`, oldBatch.id);
        const openAttempt = store.activeAttempt(oldBatch.id);
        if (openAttempt) q.setAttemptStatus.run('superseded_batch', now, openAttempt.id);
        store.event({
          batchId: oldBatch.id,
          attemptId: openAttempt?.id ?? null,
          type: 'batch_superseded',
          level: 'warn',
          message: `批次被替代批次 ${batchId} 取代；旧批次的回执此后只归档、不推进任何阶段`,
          detail: { replacementBatchId: batchId },
        });
        store.event({
          batchId,
          attemptId,
          type: 'replacement_created',
          message: `替代批次已创建（${filename}），追溯原批次 ${oldBatch.id}`,
          detail: { supersedes: oldBatch.id },
        });
        return { batch: store.getBatch(batchId), attempt: store.getAttempt(attemptId) };
      });
    },

    receiptExists(receiptKey) {
      return Boolean(q.getReceipt.get(receiptKey));
    },

    recordReceiptRecord(payload, { receiptKey, application, details = null }) {
      q.insertReceipt.run(
        receiptKey, payload.issuer, payload.kind, payload.batchId ?? null, payload.attemptId ?? null,
        payload.token ?? null, payload.seq ?? null, payload.outcome ?? null, payload.emittedAt ?? null,
        nowIso(), application, details ? JSON.stringify(details) : null, JSON.stringify(payload),
      );
      return receiptKey;
    },

    recordAnomaly({ reason, detail, payload = null, batchId, attemptId }) {
      q.insertAnomaly.run(
        nowIso(), reason, detail ?? null, payload?.issuer ?? null, payload?.kind ?? null,
        // Prefer the batch the exchange knows this receipt belongs to; the
        // receipt's own (possibly wrong) reference is kept in the payload.
        batchId ?? payload?.batchId ?? null,
        attemptId ?? payload?.attemptId ?? null,
        payload?.token ?? null,
        payload ? payloadKey(payload) : null, payload ? JSON.stringify(payload) : null,
      );
    },

    receiptsForAttempt(attemptId) {
      return q.receiptsForAttempt.all(attemptId).map(rowToReceipt);
    },

    /** Receipts that arrived before their prerequisite stage settled. */
    parkedForAttempt(attemptId) {
      return q.parkedForAttempt.all(attemptId);
    },

    deleteReceipt(receiptKey) {
      q.deleteReceipt.run(receiptKey);
    },

    anomaliesForBatch(batchId, limit = 50) {
      return q.anomaliesForBatch.all(batchId, limit).map(rowToAnomaly);
    },

    recentAnomalies(limit = 50) {
      return q.listAnomalies.all(limit).map(rowToAnomaly);
    },

    eventsForBatch(batchId, limit = 50) {
      return q.eventsForBatch.all(batchId, limit).map(rowToEvent);
    },

    recentEvents(limit = 50) {
      return q.recentEvents.all(limit).map(rowToEvent);
    },

    rememberEmitted(attemptId, payload, deliveryState = 'inbox') {
      const key = payloadKey(payload);
      q.upsertEmitted.run(attemptId, payload.kind, key, JSON.stringify(payload), payload.emittedAt, deliveryState, nowIso());
      return key;
    },

    emittedForAttempt(attemptId) {
      return q.emittedForAttempt.all(attemptId).map((row) => ({
        kind: row.kind,
        receiptKey: row.receipt_key,
        payload: JSON.parse(row.payload_json),
        emittedAt: row.emitted_at,
        deliveryState: row.delivery_state,
      }));
    },

    raw: q,
  };

  return store;
}

export function payloadKey(payload) {
  return [
    payload?.issuer ?? '?',
    payload?.kind ?? '?',
    payload?.batchId ?? '?',
    payload?.attemptId ?? '?',
    payload?.seq ?? '?',
    payload?.signature ?? '?',
  ].join(':');
}
