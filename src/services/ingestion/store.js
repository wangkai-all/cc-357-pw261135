import { nowIso, transaction } from '../../common/db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending (
  attempt_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  token TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expected_records INTEGER NOT NULL,
  records_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  posted_by_attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Rows are keyed by (batch, record), not by attempt: a resubmitted file that
-- repeats an already-ingested record must never double-post it.
CREATE TABLE IF NOT EXISTS ledger (
  batch_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  account_no TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  line INTEGER,
  posted_at TEXT NOT NULL,
  rolled_back_at TEXT,
  rollback_reason TEXT,
  PRIMARY KEY (batch_id, record_id)
);
CREATE INDEX IF NOT EXISTS ledger_by_attempt ON ledger(attempt_id);

CREATE TABLE IF NOT EXISTS receipt_state (
  attempt_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending',
  delivery_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  attempt_id TEXT,
  batch_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT
);
`;

function rowToPending(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id,
    batchId: row.batch_id,
    token: row.token,
    fingerprint: row.fingerprint,
    expectedRecords: row.expected_records,
    records: JSON.parse(row.records_json),
    status: row.status,
    postedByAttempt: row.posted_by_attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReceiptState(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id,
    batchId: row.batch_id,
    receipt: JSON.parse(row.payload_json),
    receiptKey: row.receipt_key,
    outcome: row.outcome,
    deliveryState: row.delivery_state,
    deliveryError: row.delivery_error,
    updatedAt: row.updated_at,
  };
}

export function createIngestionStore(db) {
  db.exec(SCHEMA);
  const q = {
    insertPending: db.prepare(`INSERT INTO pending
      (attempt_id, batch_id, token, fingerprint, expected_records, records_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    getPending: db.prepare('SELECT * FROM pending WHERE attempt_id = ?'),
    markPending: db.prepare('UPDATE pending SET status = ?, updated_at = ? WHERE attempt_id = ?'),
    setPostedByAttempt: db.prepare('UPDATE pending SET posted_by_attempt = posted_by_attempt + ?, updated_at = ? WHERE attempt_id = ?'),
    insertLedger: db.prepare(`INSERT OR IGNORE INTO ledger
      (batch_id, record_id, attempt_id, account_no, amount_cents, currency, occurred_at, line, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    liveRow: db.prepare('SELECT * FROM ledger WHERE batch_id = ? AND record_id = ? AND rolled_back_at IS NULL'),
    liveRowsForAttempt: db.prepare('SELECT * FROM ledger WHERE attempt_id = ? AND rolled_back_at IS NULL ORDER BY line ASC'),
    countLiveForAttempt: db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE attempt_id = ? AND rolled_back_at IS NULL'),
    countAllForAttempt: db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE attempt_id = ?'),
    rollbackAttempt: db.prepare('UPDATE ledger SET rolled_back_at = ?, rollback_reason = ? WHERE attempt_id = ? AND rolled_back_at IS NULL'),
    rollbackBatch: db.prepare('UPDATE ledger SET rolled_back_at = ?, rollback_reason = ? WHERE batch_id = ? AND rolled_back_at IS NULL'),
    batchLive: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
      FROM ledger WHERE batch_id = ? AND rolled_back_at IS NULL`),
    batchLiveByRecord: db.prepare('SELECT record_id FROM ledger WHERE batch_id = ? AND rolled_back_at IS NULL'),
    putReceipt: db.prepare(`INSERT INTO receipt_state
      (attempt_id, batch_id, payload_json, receipt_key, outcome, delivery_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(attempt_id) DO NOTHING`),
    getReceipt: db.prepare('SELECT * FROM receipt_state WHERE attempt_id = ?'),
    setDelivery: db.prepare('UPDATE receipt_state SET delivery_state = ?, delivery_error = ?, updated_at = ? WHERE attempt_id = ?'),
    insertEvent: db.prepare('INSERT INTO events (at, attempt_id, batch_id, type, message, detail_json) VALUES (?, ?, ?, ?, ?, ?)'),
    recentEvents: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
    stats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM ledger WHERE rolled_back_at IS NULL) AS live_rows,
      (SELECT COUNT(*) FROM ledger) AS total_rows,
      (SELECT COUNT(DISTINCT batch_id) FROM ledger WHERE rolled_back_at IS NULL) AS live_batches`),
  };

  const store = {
    db,

    event({ attemptId = null, batchId = null, type, message, detail = null }) {
      q.insertEvent.run(nowIso(), attemptId, batchId, type, message, detail ? JSON.stringify(detail) : null);
    },

    getPending(attemptId) {
      return rowToPending(q.getPending.get(attemptId));
    },

    insertPending({ attemptId, batchId, token, fingerprint, records }) {
      q.insertPending.run(attemptId, batchId, token, fingerprint, records.length, JSON.stringify(records), nowIso(), nowIso());
      return store.getPending(attemptId);
    },

    markPending(attemptId, status) {
      q.markPending.run(status, nowIso(), attemptId);
    },

    /**
     * Post rows idempotently. Records already live for the batch (from an
     * earlier attempt of the same batch) are skipped, never duplicated.
     *
     * `commitLimit` is used only to simulate a commit that succeeds for a
     * prefix and then fails; it is a fault-injection knob, not business logic.
     */
    postRecords({ attemptId, batchId, records, commitLimit = null }) {
      const slice = commitLimit === null ? records : records.slice(0, commitLimit);
      return transaction(db, () => {
        const at = nowIso();
        let posted = 0;
        let skipped = 0;
        for (const record of slice) {
          const existing = q.liveRow.get(batchId, record.recordId);
          if (existing) {
            skipped += 1;
            continue;
          }
          const result = q.insertLedger.run(
            batchId, record.recordId, attemptId, record.accountNo,
            Math.round(Number(record.amount) * 100), record.currency, record.occurredAt,
            record.line ?? null, at,
          );
          if (result.changes > 0) posted += 1;
          else skipped += 1;
        }
        if (posted > 0) q.setPostedByAttempt.run(posted, nowIso(), attemptId);
        const live = q.batchLive.get(batchId);
        return { posted, skipped, batchLiveRows: live.n, batchAmountCents: live.cents };
      });
    },

    liveRecordIds(batchId) {
      return new Set(q.batchLiveByRecord.all(batchId).map((row) => row.record_id));
    },

    /** Roll back the rows a single attempt posted (not rows from earlier attempts). */
    rollbackAttempt({ attemptId, reason }) {
      return transaction(db, () => {
        const live = q.liveRowsForAttempt.all(attemptId);
        if (live.length === 0) return { rolledBack: 0, batchId: null };
        q.rollbackAttempt.run(nowIso(), reason, attemptId);
        return { rolledBack: live.length, batchId: live[0].batch_id };
      });
    },

    rollbackBatch({ batchId, reason }) {
      return transaction(db, () => {
        const live = q.batchLive.get(batchId);
        if (live.n === 0) return { rolledBack: 0 };
        q.rollbackBatch.run(nowIso(), reason, batchId);
        return { rolledBack: live.n };
      });
    },

    stateOf(attemptId) {
      const pending = store.getPending(attemptId);
      const receipt = store.getReceipt(attemptId);
      if (!pending && !receipt) return { state: 'unknown', live: 0, all: 0 };
      const live = q.countLiveForAttempt.get(attemptId).n;
      const all = q.countAllForAttempt.get(attemptId).n;
      const batch = pending ? q.batchLive.get(pending.batchId) : { n: 0, cents: 0 };
      const state = all > 0 && live === 0
        ? 'rolled_back'
        : live > 0
          ? 'posted'
          : pending
            ? pending.status
            : 'unknown';
      return {
        state,
        live,
        all,
        batchLiveRows: batch.n,
        batchAmountCents: batch.cents,
        pending: pending ? { ...pending, liveRows: live } : null,
        receiptState: receipt,
      };
    },

    liveRows(attemptId) {
      return q.liveRowsForAttempt.all(attemptId).map((row) => ({
        batchId: row.batch_id,
        recordId: row.record_id,
        accountNo: row.account_no,
        amount: row.amount_cents / 100,
        currency: row.currency,
        occurredAt: row.occurred_at,
      }));
    },

    batchLive(batchId) {
      const live = q.batchLive.get(batchId);
      return { rows: live.n, amount: live.cents / 100 };
    },

    saveReceipt({ attemptId, batchId, receipt, receiptKey, outcome }) {
      q.putReceipt.run(attemptId, batchId, JSON.stringify(receipt), receiptKey, outcome, nowIso(), nowIso());
      return rowToReceiptState(q.getReceipt.get(attemptId));
    },

    getReceipt(attemptId) {
      return rowToReceiptState(q.getReceipt.get(attemptId));
    },

    setDelivery(attemptId, state, error = null) {
      q.setDelivery.run(state, error, nowIso(), attemptId);
    },

    recentEvents(limit = 50) {
      return q.recentEvents.all(limit).map((row) => ({
        at: row.at,
        attemptId: row.attempt_id,
        batchId: row.batch_id,
        type: row.type,
        message: row.message,
        detail: row.detail_json ? JSON.parse(row.detail_json) : null,
      }));
    },

    stats() {
      return q.stats.get();
    },
  };

  return store;
}
