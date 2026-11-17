import { newId, nowIso } from './db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS faults (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  stage TEXT,
  attempt_id TEXT,
  remaining INTEGER NOT NULL,
  params_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
`;

/**
 * Per-service fault queue. A fault is consumed by the code path that would
 * otherwise deliver a receipt or a dispatch, which makes "lose the next
 * format receipt" deterministic instead of dependent on timing.
 */
export function createFaultStore(db) {
  db.exec(SCHEMA);
  const q = {
    insert: db.prepare(`INSERT INTO faults
      (id, kind, stage, attempt_id, remaining, params_json, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    match: db.prepare(`SELECT * FROM faults
      WHERE kind = ? AND remaining > 0
        AND (stage IS NULL OR stage = ?)
        AND (attempt_id IS NULL OR attempt_id = ?)
      ORDER BY created_at ASC, rowid ASC LIMIT 1`),
    consume: db.prepare('UPDATE faults SET remaining = remaining - 1, consumed_at = ? WHERE id = ?'),
    list: db.prepare('SELECT * FROM faults ORDER BY created_at DESC, rowid DESC LIMIT 50'),
    clear: db.prepare('DELETE FROM faults'),
    active: db.prepare('SELECT COUNT(*) AS n FROM faults WHERE remaining > 0'),
  };

  return {
    add({ kind, stage = null, attemptId = null, remaining = 1, params = null, note = null }) {
      const id = newId('flt');
      q.insert.run(id, kind, stage, attemptId, remaining, params ? JSON.stringify(params) : null, note, nowIso());
      return { id, kind, stage, attemptId, remaining, params, note };
    },
    /** Stage-specific faults win; null attempt/stage act as wildcards. */
    take(kind, stage = null, attemptId = null) {
      const row = q.match.get(kind, stage, attemptId) ??
        q.match.get(kind, null, attemptId) ??
        q.match.get(kind, stage, null) ??
        q.match.get(kind, null, null);
      if (!row) return null;
      q.consume.run(nowIso(), row.id);
      return {
        id: row.id,
        kind: row.kind,
        stage: row.stage,
        attemptId: row.attempt_id,
        params: row.params_json ? JSON.parse(row.params_json) : null,
        note: row.note,
      };
    },
    list() {
      return q.list.all().map((row) => ({
        id: row.id,
        kind: row.kind,
        stage: row.stage,
        attemptId: row.attempt_id,
        remaining: row.remaining,
        params: row.params_json ? JSON.parse(row.params_json) : null,
        note: row.note,
        createdAt: row.created_at,
        consumedAt: row.consumed_at,
      }));
    },
    clear() {
      q.clear.run();
    },
    activeCount() {
      return q.active.get().n;
    },
  };
}
