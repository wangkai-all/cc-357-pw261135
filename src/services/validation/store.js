import { nowIso } from '../../common/db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  attempt_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  token TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_b64 TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  errors_json TEXT,
  records_json TEXT,
  receipt_payload_json TEXT,
  receipt_key TEXT,
  delivery_state TEXT NOT NULL DEFAULT 'none',
  delivery_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
`;

function rowToJob(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id,
    batchId: row.batch_id,
    token: row.token,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    status: row.status,
    outcome: row.outcome,
    errorCount: row.error_count,
    summary: row.summary,
    result: row.records_json
      ? { errors: row.errors_json ? JSON.parse(row.errors_json) : [], records: JSON.parse(row.records_json) }
      : null,
    receipt: row.receipt_payload_json ? JSON.parse(row.receipt_payload_json) : null,
    receiptKey: row.receipt_key,
    deliveryState: row.delivery_state,
    deliveryError: row.delivery_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export function createValidationStore(db) {
  db.exec(SCHEMA);
  const q = {
    get: db.prepare('SELECT * FROM jobs WHERE attempt_id = ?'),
    insert: db.prepare(`INSERT INTO jobs
      (attempt_id, batch_id, token, filename, size_bytes, content_b64, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`),
    setStatus: db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE attempt_id = ?'),
    complete: db.prepare(`UPDATE jobs SET status = 'completed', outcome = ?, error_count = ?, summary = ?,
      errors_json = ?, records_json = ?, finished_at = ?, updated_at = ? WHERE attempt_id = ?`),
    saveReceipt: db.prepare('UPDATE jobs SET receipt_payload_json = ?, receipt_key = ?, updated_at = ? WHERE attempt_id = ?'),
    setDelivery: db.prepare('UPDATE jobs SET delivery_state = ?, delivery_error = ?, updated_at = ? WHERE attempt_id = ?'),
    list: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?'),
    stats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM jobs) AS total,
      (SELECT COUNT(*) FROM jobs WHERE status = 'completed') AS completed,
      (SELECT COUNT(*) FROM jobs WHERE outcome = 'failed') AS rejected,
      (SELECT COUNT(*) FROM jobs WHERE delivery_state = 'dropped') AS receipts_dropped`),
  };

  return {
    db,
    get(attemptId) {
      return rowToJob(q.get.get(attemptId));
    },
    /** Raw file bytes; never exposed over HTTP. */
    contentOf(attemptId) {
      const row = q.get.get(attemptId);
      return row ? row.content_b64 : null;
    },
    create({ attemptId, batchId, token, filename, contentBase64 }) {
      q.insert.run(attemptId, batchId, token, filename, Buffer.from(contentBase64, 'base64').length, contentBase64, nowIso(), nowIso());
      return this.get(attemptId);
    },
    setStatus(attemptId, status) {
      q.setStatus.run(status, nowIso(), attemptId);
    },
    complete(attemptId, { outcome, errorCount, summary, result }) {
      q.complete.run(
        outcome, errorCount, summary,
        JSON.stringify(result.errors ?? []), JSON.stringify(result.records ?? []),
        nowIso(), nowIso(), attemptId,
      );
      return this.get(attemptId);
    },
    saveReceipt(attemptId, receipt, receiptKey) {
      q.saveReceipt.run(JSON.stringify(receipt), receiptKey, nowIso(), attemptId);
    },
    setDelivery(attemptId, state, error = null) {
      q.setDelivery.run(state, error, nowIso(), attemptId);
    },
    list(limit = 40) {
      return q.list.all(limit).map(rowToJob);
    },
    stats() {
      return q.stats.get();
    },
  };
}
