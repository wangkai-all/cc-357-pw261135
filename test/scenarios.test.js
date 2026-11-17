import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { api, base64, csv, getBatch, startCluster, uploadBatch, waitFor } from './helpers.js';
import { parseCsv } from '../src/common/csv.js';
import { validateCsvPayload } from '../src/common/records.js';

const ROW = ['REC-1', 'ACC-1', '10.00', 'USD', '2026-11-10T09:00:00Z'];

function fixture(name) {
  return readFileSync(resolve(process.cwd(), 'fixtures', name));
}

async function accepted(cluster, batchId) {
  return waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: `batch ${batchId} accepted` });
}

// ------------------------------------------------------------- lost receipts

test('a lost format receipt is recovered by reconciliation, not guessed', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  await api(`${cluster.urls.validation}/internal/faults`, {
    method: 'POST',
    body: { kind: 'delivery', stage: 'format', remaining: 1, params: { mode: 'drop' } },
  });
  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;

  const waiting = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    const format = body.current.stages.format;
    return format.state === 'pending' && format.overdue ? body : null;
  }, { label: 'format stage overdue' });
  assert.equal(waiting.status, 'submitted', 'an overdue receipt is still not acceptance');

  // The validation service has the receipt on file; reconciliation replays it.
  const reconciled = await api(`${cluster.urls.exchange}/internal/batches/${batchId}/reconcile`, {
    method: 'POST',
    body: {},
  });
  assert.equal(reconciled.status, 200);
  assert.ok(reconciled.body.notes.some((n) => n.includes('回放格式回执')));

  const settled = await accepted(cluster, batchId);
  assert.equal(settled.current.stages.format.state, 'passed');
  assert.equal(settled.anomalies.filter((a) => a.reason === 'EXACT_DUPLICATE').length, 0);
});

test('a lost ingest receipt after a real commit is settled against the ledger', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  await api(`${cluster.urls.ingestion}/internal/faults`, {
    method: 'POST',
    body: { kind: 'crash_after_commit', stage: 'ingest', remaining: 1 },
  });
  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;

  const stuck = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    const ingest = body.current.stages.ingest;
    return ingest.state === 'pending' && ingest.dispatchState === 'sent' ? body : null;
  }, { label: 'ingest awaiting receipt after commit' });
  assert.notEqual(stuck.status, 'accepted', 'rows may be posted and the page must still not claim success');

  // The rows really are in the ledger while the exchange knows nothing.
  const ledger = await api(`${cluster.urls.ingestion}/internal/ingest/${stuck.current.id}`);
  assert.equal(ledger.body.state, 'posted');
  assert.equal(ledger.body.live, 1);

  const reconciled = await api(`${cluster.urls.exchange}/internal/batches/${batchId}/reconcile`, {
    method: 'POST',
    body: {},
  });
  assert.equal(reconciled.status, 200);
  assert.ok(reconciled.body.notes.some((n) => n.includes('回放入库回执')));

  const settled = await accepted(cluster, batchId);
  assert.equal(settled.current.stages.ingest.state, 'delivered');
  assert.equal((await api(`${cluster.urls.ingestion}/internal/ingest/${stuck.current.id}`)).body.live, 1);
});

test('a response lost after the exchange accepted the receipt resolves as a duplicate', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  await api(`${cluster.urls.ingestion}/internal/faults`, {
    method: 'POST',
    body: { kind: 'delivery', stage: 'ingest', remaining: 1, params: { mode: 'disconnect_after_send' } },
  });
  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;
  const settled = await accepted(cluster, batchId);

  // The peer believes delivery failed; the exchange already applied it.
  const peer = await api(`${cluster.urls.ingestion}/internal/ingest/${settled.current.id}`);
  assert.equal(peer.body.deliveryState, 'response_lost');

  const redelivered = await api(`${cluster.urls.ingestion}/internal/ingest/${settled.current.id}/redeliver`, {
    method: 'POST',
    body: {},
  });
  assert.equal(redelivered.status, 200);
  assert.equal(redelivered.body.delivery.mode, 'ok');

  const after = (await getBatch(cluster, batchId)).body.batch;
  assert.equal(after.status, 'accepted');
  assert.equal(
    (await api(`${cluster.urls.ingestion}/internal/ingest/${settled.current.id}`)).body.live,
    1,
    'redelivery must be a duplicate, not a second posting',
  );
  assert.ok(after.anomalies.some((a) => a.reason === 'EXACT_DUPLICATE'));
});

// ------------------------------------------------------------ undo / cancel

test('cancel is allowed before ingest and refused once rows are posted', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  await api(`${cluster.urls.validation}/internal/faults`, {
    method: 'POST',
    body: { kind: 'delivery', stage: 'format', remaining: 1, params: { mode: 'drop' } },
  });
  const waiting = await uploadBatch(cluster, { content: csv([ROW]) });
  const waitingId = waiting.body.batch.id;
  await waitFor(async () => {
    const body = (await getBatch(cluster, waitingId)).body.batch;
    return body.current.stages.format.state === 'pending' ? body : null;
  }, { label: 'format pending' });

  const cancelled = await api(`${cluster.urls.exchange}/internal/batches/${waitingId}/cancel`, {
    method: 'POST',
    body: { reason: 'test cancel' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.batch.status, 'cancelled');

  // A receipt that arrives after cancellation is archived as stale.
  const stored = await api(`${cluster.urls.validation}/internal/jobs/${waiting.body.batch.current.id}`);
  if (stored.body?.receipt) {
    const late = await api(`${cluster.urls.exchange}/internal/receipts`, {
      method: 'POST',
      body: { kind: 'format', receipt: stored.body.receipt },
    });
    assert.equal(late.status, 200);
    assert.equal(late.body.disposition, 'stale');
    assert.equal(late.body.reason, 'BATCH_CANCELLED');
  }

  // Accepted batches cannot be cancelled at all.
  const done = await uploadBatch(cluster, { content: csv([['REC-2', 'ACC-2', '3.00', 'USD', '2026-11-10T09:00:00Z']]) });
  await accepted(cluster, done.body.batch.id);
  const refused = await api(`${cluster.urls.exchange}/internal/batches/${done.body.batch.id}/cancel`, {
    method: 'POST',
    body: {},
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'BATCH_ALREADY_ACCEPTED');
});

test('a commit whose reply was lost blocks cancel; rollback + void is the way out', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  await api(`${cluster.urls.ingestion}/internal/faults`, {
    method: 'POST',
    body: { kind: 'crash_after_commit', stage: 'ingest', remaining: 1 },
  });
  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;
  const stuck = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.current.stages.ingest.dispatchState === 'sent' ? body : null;
  }, { label: 'unknown ingest dispatch' });

  const cancel = await api(`${cluster.urls.exchange}/internal/batches/${batchId}/cancel`, {
    method: 'POST',
    body: {},
  });
  assert.equal(cancel.status, 409);
  assert.equal(cancel.body.error.code, 'LEDGER_ALREADY_HAS_DATA');

  // Rolling back the rows and voiding the batch is the supported escape.
  const rolled = await api(`${cluster.urls.ingestion}/internal/ingest/${stuck.current.id}/rollback`, {
    method: 'POST',
    body: { reason: 'test rollback' },
  });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.body.rolledBack, 1);
  assert.equal(rolled.body.state.state, 'rolled_back');

  const voided = await api(`${cluster.urls.exchange}/internal/batches/${batchId}/void`, {
    method: 'POST',
    body: { reason: 'rolled back 1 row' },
  });
  assert.equal(voided.status, 200);
  assert.equal(voided.body.batch.status, 'voided');
  assert.equal(voided.body.batch.current.stages.ingest.state, 'rolled_back');

  // The crash-then-late ingest receipt cannot resurrect acceptance.
  const lateReceipt = (await api(`${cluster.urls.ingestion}/internal/ingest/${stuck.current.id}`)).body.receipt;
  assert.ok(lateReceipt);
  const late = await api(`${cluster.urls.exchange}/internal/receipts`, {
    method: 'POST',
    body: { kind: 'ingest', receipt: lateReceipt },
  });
  assert.equal(late.status, 200);
  assert.equal(late.body.disposition, 'stale');
  assert.equal(late.body.reason, 'BATCH_VOIDED');
  assert.equal((await getBatch(cluster, batchId)).body.batch.status, 'voided');
});

// -------------------------------------------------------------- resubmission

test('a revision after acceptance is refused: that would bypass the ledger', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;
  await accepted(cluster, batchId);

  const refused = await api(`${cluster.urls.exchange}/internal/batches/${batchId}/revisions`, {
    method: 'POST',
    body: { filename: 'more.csv', contentBase64: base64(csv([['REC-2', 'ACC-2', '1.00', 'USD', '2026-11-10T09:00:00Z']])) },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'BATCH_ALREADY_ACCEPTED');
});

test('a correction that repeats ingested rows does not double-post them', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  // First attempt is valid except for a blocked account, so it never reaches
  // ingestion: the revision is the one that posts.
  const first = csv([
    ['REC-1', 'ACC-1', '10.00', 'USD', '2026-11-10T09:00:00Z'],
    ['REC-2', 'BLOCKED-9', '5.00', 'USD', '2026-11-10T09:00:00Z'],
  ]);
  const created = await uploadBatch(cluster, { content: first });
  const batchId = created.body.batch.id;
  await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.current.stages.format.state === 'failed' ? body : null;
  }, { label: 'format failed' });

  // Corrected file repeats REC-1 and adds REC-3. REC-1 was never ingested, so
  // two rows should post; the ledger key is (batch, record).
  const fixed = csv([
    ['REC-1', 'ACC-1', '10.00', 'USD', '2026-11-10T09:00:00Z'],
    ['REC-3', 'ACC-3', '7.50', 'USD', '2026-11-11T09:00:00Z'],
  ]);
  const revision = await api(`${cluster.urls.exchange}/internal/batches/${batchId}/revisions`, {
    method: 'POST',
    body: { filename: 'fixed.csv', contentBase64: base64(fixed) },
  });
  assert.equal(revision.status, 201);

  const settled = await accepted(cluster, batchId);
  const ledger = await api(`${cluster.urls.ingestion}/internal/ingest/${settled.current.id}`);
  assert.equal(ledger.body.state, 'posted');
  assert.equal(ledger.body.batchLiveRows, 2);
  assert.deepEqual(ledger.body.rows.map((r) => r.recordId).sort(), ['REC-1', 'REC-3']);
});

test('uploading twice with the same idempotency key yields one batch', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const first = await uploadBatch(cluster, { content: csv([ROW]), idempotencyKey: 'demo-key-1' });
  const second = await uploadBatch(cluster, { content: csv([ROW]), idempotencyKey: 'demo-key-1' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.deduplicated, true);
  assert.equal(second.body.batch.id, first.body.batch.id);
  assert.equal(second.body.batch.attempts.length, 1);
});

// -------------------------------------------------------------------- faults

test('a dropped ingest dispatch stays unknown until somebody reconciles', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  await api(`${cluster.urls.exchange}/internal/faults`, {
    method: 'POST',
    body: { kind: 'drop_dispatch', stage: 'ingest', remaining: 1 },
  });
  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;

  const lost = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.current.stages.ingest.dispatchState === 'unknown' ? body : null;
  }, { label: 'ingest dispatch lost' });
  assert.equal(lost.current.stages.ingest.state, 'pending');

  // Retry is refused while the dispatch state is unknown: it might have
  // landed. Reconcile first, which finds the ingestion service never saw it.
  const retry = await api(`${cluster.urls.exchange}/internal/batches/${batchId}/retry`, {
    method: 'POST',
    body: { stage: 'ingest' },
  });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error.code, 'ALREADY_DISPATCHED');

  const reconciled = await api(`${cluster.urls.exchange}/internal/batches/${batchId}/reconcile`, {
    method: 'POST',
    body: {},
  });
  assert.ok(reconciled.body.notes.some((n) => n.includes('重新转交')) || reconciled.body.notes.some((n) => n.includes('回放入库回执')));
  await accepted(cluster, batchId);
});

test('a partial commit leaves real rows and never claims acceptance', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const threeRows = csv([
    ['REC-1', 'ACC-1', '10.00', 'USD', '2026-11-10T09:00:00Z'],
    ['REC-2', 'ACC-2', '20.00', 'USD', '2026-11-10T09:00:00Z'],
    ['REC-3', 'ACC-3', '30.00', 'USD', '2026-11-10T09:00:00Z'],
  ]);
  await api(`${cluster.urls.ingestion}/internal/faults`, {
    method: 'POST',
    body: { kind: 'ingest_commit', stage: 'ingest', remaining: 1, params: { commitFirst: 2 } },
  });
  const created = await uploadBatch(cluster, { content: threeRows });
  const batchId = created.body.batch.id;

  const stuck = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.current.stages.ingest.dispatchState === 'unknown' &&
      (await api(`${cluster.urls.ingestion}/internal/ingest/${body.current.id}`)).status === 200
      ? body
      : null;
  }, { label: 'partial commit' });
  assert.notEqual(stuck.status, 'accepted');

  const ledger = await api(`${cluster.urls.ingestion}/internal/ingest/${stuck.current.id}`);
  assert.equal(ledger.body.live, 2, 'two rows really were committed before the interruption');

  // Reconcile replays the successful portion; it must not post 5 rows. The
  // partial commit left pending.status='pending', so the ingestion service
  // finishes the remaining rows rather than reporting a complete receipt.
  await api(`${cluster.urls.exchange}/internal/batches/${batchId}/reconcile`, { method: 'POST', body: {} });
  const settled = await accepted(cluster, batchId);
  const final = await api(`${cluster.urls.ingestion}/internal/ingest/${settled.current.id}`);
  assert.equal(final.body.live, 3, 'exactly three distinct records are live');
  assert.equal(final.body.batchLiveRows, 3, 'the batch has exactly three distinct records');
  assert.equal(final.body.receipt.details.posted, 1, 'only the missing row was posted on the retry');
  assert.equal(final.body.receipt.details.skipped, 2, 'the two committed rows were skipped, not duplicated');
});

// ------------------------------------------------------------- csv/fixtures

test('csv parser rejects blanks, unterminated quotes and ragged rows with line numbers', () => {
  assert.equal(parseCsv('a,b\n1,2\n').ok, true);
  const blank = parseCsv('a,b\n1,2\n\n3,4\n');
  assert.equal(blank.ok, false);
  assert.equal(blank.line, 3);
  const quotes = parseCsv('a,b\n"unterminated,2\n');
  assert.equal(quotes.ok, false);
  assert.match(quotes.message, /引号未闭合/);
  const midQuote = parseCsv('a,b\n1,x"y\n');
  assert.equal(midQuote.ok, false);
  // Escaped quotes and CRLF survive.
  const quoted = parseCsv('a,b\r\n"say ""hi""",2\r\n');
  assert.equal(quoted.ok, true);
  assert.deepEqual(quoted.rows[1].cells, ['say "hi"', '2']);
});

test('fixtures behave exactly as their manifest claims', () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'fixtures', 'manifest.json'), 'utf8'));
  const outcomes = { format_passed: 'passed', format_failed: 'failed' };
  for (const entry of manifest) {
    const result = validateCsvPayload(fixture(entry.name));
    assert.equal(result.outcome, outcomes[entry.expected], `${entry.name} should be ${entry.expected}: ${result.summary}`);
    if (outcomes[entry.expected] === 'failed') assert.ok(result.errorCount >= 1, `${entry.name} should report errors`);
  }
});
