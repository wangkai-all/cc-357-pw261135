import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, base64, csv, getBatch, startCluster, uploadBatch, waitFor } from './helpers.js';

const ROW = ['REC-1', 'ACC-1', '10.00', 'USD', '2026-11-10T09:00:00Z'];

test('happy path: three receipts, only ingestion commits acceptance', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  assert.equal(created.status, 201);
  const batchId = created.body.batch.id;

  // The upload response itself must not claim acceptance, and neither may the
  // batch view at that moment: validation and ingestion have not reported yet.
  assert.notEqual(created.body.batch.status, 'accepted');
  assert.notEqual(created.body.batch.current.stages.ingest.state, 'delivered');

  const settled = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: 'batch accepted' });

  const attempt = settled.current;
  assert.equal(attempt.stages.received.state, 'passed');
  assert.equal(attempt.stages.format.state, 'passed');
  assert.equal(attempt.stages.ingest.state, 'delivered');
  assert.equal(attempt.terminal, 'accepted');
  assert.ok(settled.acceptedAt);

  // Every receipt was signed by the expected issuer and applied once.
  const receipts = (await api(`${cluster.urls.exchange}/internal/receipts/${attempt.id}`)).body.receipts;
  assert.deepEqual(
    receipts.map((r) => `${r.kind}:${r.issuer}:${r.application}`).sort(),
    ['format:validation:applied', 'ingest:ingestion:applied', 'received:exchange:applied'],
  );

  // The ledger really holds the rows.
  const ledger = await api(`${cluster.urls.ingestion}/internal/ingest/${attempt.id}`);
  assert.equal(ledger.body.state, 'posted');
  assert.equal(ledger.body.live, 1);
  assert.equal(firstRow(ledger.body.rows).recordId, 'REC-1');
});

function firstRow(rows) {
  return rows[0];
}

test('upload alone never yields accepted: format-stage failure stays failed', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const bad = csv([
    ['REC-1', 'ACC-1', '10.00', 'USD', '2026-11-10T09:00:00Z'],
    ['REC-2', '', '5.00', 'USD', '2026-11-10T09:00:00Z'],
  ]);
  const created = await uploadBatch(cluster, { content: bad });
  const settled = await waitFor(async () => {
    const body = (await getBatch(cluster, created.body.batch.id)).body.batch;
    return body.status === 'failed' ? body : null;
  }, { label: 'format failure' });

  assert.equal(settled.current.stages.format.state, 'failed');
  assert.equal(settled.current.stages.ingest.state, 'pending');
  assert.ok(settled.current.stages.format.errors.length >= 1);
  assert.match(settled.current.stages.format.errors[0].message, /account_no/);
  // No ingest receipt exists, so the batch can never be accepted.
  const receipts = settled.current.receipts.map((r) => r.kind);
  assert.ok(!receipts.includes('ingest'));
});

test('duplicate receipt is archived and cannot re-apply', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batch = await waitFor(async () => {
    const body = (await getBatch(cluster, created.body.batch.id)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: 'accepted' });

  const ingestReceipt = (await api(`${cluster.urls.ingestion}/internal/ingest/${batch.current.id}`)).body.receipt;
  assert.ok(ingestReceipt);

  const duplicate = await api(`${cluster.urls.exchange}/internal/receipts`, {
    method: 'POST',
    body: { kind: 'ingest', receipt: ingestReceipt },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.disposition, 'duplicate');

  const ledger = await api(`${cluster.urls.ingestion}/internal/ingest/${batch.current.id}`);
  assert.equal(ledger.body.live, 1, 'duplicate receipt must not post again');

  const after = (await getBatch(cluster, batch.id)).body.batch;
  assert.equal(after.status, 'accepted');
  assert.equal(after.anomalies.filter((a) => a.reason === 'EXACT_DUPLICATE').length, 1);
});

test('format receipt arriving before the received receipt is handled out of order', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  // Two faults, one per direction: the exchange drops its own received
  // receipt, and the validation service keeps its format receipt so it can be
  // delivered by hand while the received stage is still unrecorded.
  await api(`${cluster.urls.exchange}/internal/faults`, {
    method: 'POST',
    body: { kind: 'drop_receipt', stage: 'received', remaining: 1 },
  });
  await api(`${cluster.urls.validation}/internal/faults`, {
    method: 'POST',
    body: { kind: 'delivery', stage: 'format', remaining: 1, params: { mode: 'drop' } },
  });
  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;

  const pending = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.current.stages.received.state === 'pending' && body.current.stages.format.state === 'pending'
      ? body
      : null;
  }, { label: 'received pending, format still undecided' });

  // Wait until validation has produced its receipt, then deliver it while the
  // received stage is still unrecorded.
  const job = await waitFor(async () => {
    const response = await api(`${cluster.urls.validation}/internal/jobs/${pending.current.id}`);
    return response.status === 200 && response.body.receipt && response.body.job.deliveryState === 'dropped'
      ? response.body
      : null;
  }, { label: 'validation receipt produced but not delivered' });

  // Ensure the exchange never saw its own received receipt (fault did that).
  const before = (await getBatch(cluster, batchId)).body.batch;
  assert.equal(before.current.stages.received.state, 'pending');

  const outOfOrder = await api(`${cluster.urls.exchange}/internal/receipts`, {
    method: 'POST',
    body: { kind: 'format', receipt: job.receipt },
  });
  assert.equal(outOfOrder.status, 200);
  assert.equal(outOfOrder.body.disposition, 'applied');

  const after = (await getBatch(cluster, batchId)).body.batch;
  assert.equal(after.current.stages.received.state, 'passed', 'received state is inferred from the format receipt');
  assert.equal(after.current.stages.format.state, 'passed');
  assert.ok(after.events.some((e) => e.type === 'stage_received_inferred'));
});

test('early ingest receipt is parked, then replayed when format passes', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  // Make the validation service drop its receipt so the ingest stage is the
  // only thing that reports back first.
  await api(`${cluster.urls.validation}/internal/faults`, {
    method: 'POST',
    body: { kind: 'delivery', stage: 'format', remaining: 1, params: { mode: 'drop' } },
  });
  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;
  await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.current.stages.ingest.state === 'pending' && body.current.stages.format.state === 'pending' ? body : null;
  }, { label: 'format pending, ingest pending' });

  const attempt = (await getBatch(cluster, batchId)).body.batch.current;

  // Post rows directly at the ingestion service; its receipt names the
  // attempt while format is still undecided, so the exchange parks it.
  const stored = (await api(`${cluster.urls.exchange}/internal/batches/${batchId}/file/${attempt.id}`)).body;
  const ingest = await api(`${cluster.urls.ingestion}/internal/ingest`, {
    method: 'POST',
    body: {
      attemptId: attempt.id,
      batchId,
      token: attempt.token,
      filename: attempt.filename,
      contentBase64: stored.contentBase64,
      fingerprint: attempt.fingerprint,
    },
  });
  assert.equal(ingest.status, 201);

  const parkedView = (await getBatch(cluster, batchId)).body.batch;
  assert.equal(parkedView.current.stages.ingest.state, 'pending', 'parked receipt must not advance the stage');
  assert.ok(parkedView.anomalies.some((a) => a.reason === 'PREREQUISITE_PENDING'));

  // Now let the format receipt through (redeliver from validation).
  const job = await api(`${cluster.urls.validation}/internal/jobs/${attempt.id}`);
  const delivered = await api(`${cluster.urls.exchange}/internal/receipts`, {
    method: 'POST',
    body: { kind: 'format', receipt: job.body.receipt },
  });
  assert.equal(delivered.status, 200);

  const settled = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: 'accepted after replay' });
  assert.equal(settled.current.stages.ingest.state, 'delivered');
  assert.ok(settled.events.some((e) => e.type === 'receipt_replayed'));
});

test('revision keeps the batch id and closes the previous attempt', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const bad = csv([['REC-1', '', '10.00', 'USD', '2026-11-10T09:00:00Z']]);
  const created = await uploadBatch(cluster, { content: bad });
  const batchId = created.body.batch.id;
  await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.current.stages.format.state === 'failed' ? body : null;
  }, { label: 'format failed' });

  const revision = await api(`${cluster.urls.exchange}/internal/batches/${batchId}/revisions`, {
    method: 'POST',
    body: { filename: 'fixed.csv', contentBase64: base64(csv([ROW])) },
  });
  assert.equal(revision.status, 201);
  assert.equal(revision.body.traceability, 'same_batch');
  assert.equal(revision.body.batch.id, batchId, 'revision must not mint a new batch id');
  assert.equal(revision.body.batch.attempts.length, 2);

  const settled = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: 'accepted after revision' });

  const [latest, first] = settled.attempts;
  assert.equal(latest.attemptNo, 2);
  assert.equal(latest.mode, 'revise');
  assert.equal(latest.terminal, 'accepted');
  assert.equal(first.status, 'superseded_attempt');
  assert.equal(first.terminal, 'replaced_by_attempt');
});

test('replacement mints a new batch and old receipts stay stale', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const oldId = created.body.batch.id;
  const settledOld = await waitFor(async () => {
    const body = (await getBatch(cluster, oldId)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: 'old accepted' });
  const oldReceipt = (await api(`${cluster.urls.ingestion}/internal/ingest/${settledOld.current.id}`)).body.receipt;

  // Roll back the ingested rows so a replacement is allowed.
  const rollback = await api(`${cluster.urls.ingestion}/internal/ingest/${settledOld.current.id}/rollback`, {
    method: 'POST',
    body: { reason: 'prepare replacement' },
  });
  assert.equal(rollback.body.rolledBack, 1);
  await api(`${cluster.urls.exchange}/internal/batches/${oldId}/void`, { method: 'POST', body: { reason: 'rolled back' } });

  const replacement = await api(`${cluster.urls.exchange}/internal/batches/${oldId}/replacement`, {
    method: 'POST',
    body: { filename: 'replacement.csv', contentBase64: base64(csv([ROW])) },
  });
  assert.equal(replacement.status, 201);
  const newId = replacement.body.batch.id;
  assert.notEqual(newId, oldId);
  assert.equal(replacement.body.batch.supersedes, oldId);
  assert.equal(replacement.body.superseded.status, 'superseded');
  assert.equal(replacement.body.superseded.supersededBy, newId);

  // The replacement reaches acceptance on its own.
  await waitFor(async () => {
    const body = (await getBatch(cluster, newId)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: 'replacement accepted' });

  // Replaying the old batch's signed ingest receipt must not do anything.
  const stale = await api(`${cluster.urls.exchange}/internal/receipts`, {
    method: 'POST',
    body: { kind: 'ingest', receipt: oldReceipt },
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.disposition, 'stale');
  assert.equal(stale.body.reason, 'BATCH_SUPERSEDED');

  const oldAfter = (await getBatch(cluster, oldId)).body.batch;
  const newAfter = (await getBatch(cluster, newId)).body.batch;
  assert.equal(oldAfter.status, 'superseded');
  assert.equal(newAfter.status, 'accepted');
  assert.equal(newAfter.current.id === oldAfter.current.id, false);
});

test('replacement is refused while old rows are live in the ledger', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const oldId = created.body.batch.id;
  await waitFor(async () => {
    const body = (await getBatch(cluster, oldId)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: 'accepted' });

  const attempt = await api(`${cluster.urls.exchange}/internal/batches/${oldId}/replacement`, {
    method: 'POST',
    body: { filename: 'replacement.csv', contentBase64: base64(csv([ROW])) },
  });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.body.error.code, 'LEDGER_HAS_LIVE_ROWS');
});

test('tampered receipts are rejected by signature and state is untouched', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;
  const batch = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: 'accepted' });
  const attempt = batch.current;
  const receipt = (await api(`${cluster.urls.ingestion}/internal/ingest/${attempt.id}`)).body.receipt;

  const cases = [
    ['changed batch reference', { batchId: 'bat_ffffffffffffffffffffffff' }],
    ['changed token', { token: 'tok_000000000000000000000000' }],
    ['changed outcome', { outcome: 'failed' }],
    ['changed signature', { signature: 'a'.repeat(64) }],
    ['changed amount detail', { details: { ...receipt.details, posted: 999 } }],
  ];
  for (const [label, patch] of cases) {
    const response = await api(`${cluster.urls.exchange}/internal/receipts`, {
      method: 'POST',
      body: { kind: 'ingest', receipt: { ...receipt, ...patch } },
    });
    assert.equal(response.status, 422, `${label} must be rejected`);
    assert.equal(response.body.disposition, 'rejected', label);
    assert.equal(response.body.reason, 'BAD_SIGNATURE', label);
  }

  const after = (await getBatch(cluster, batchId)).body.batch;
  assert.equal(after.status, 'accepted', 'rejections must not change state');
  assert.ok(after.anomalies.filter((a) => a.reason === 'BAD_SIGNATURE').length >= cases.length);
});

test('correctly signed receipt naming the wrong batch or token is rejected', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const { makeReceipt } = await import('../src/common/receipts.js');
  const first = await uploadBatch(cluster, { content: csv([ROW]) });
  const second = await uploadBatch(cluster, {
    content: csv([['REC-2', 'ACC-2', '20.00', 'USD', '2026-11-10T09:00:00Z']]),
  });
  const batchA = (await getBatch(cluster, first.body.batch.id)).body.batch;
  const batchB = (await getBatch(cluster, second.body.batch.id)).body.batch;

  // A peer bug: it signs over attempt A's id but puts batch B's id in the
  // envelope. The signature is valid, so only the reference check can catch it.
  const crossBatch = makeReceipt(cluster.config.secrets.validation, {
    issuer: 'validation',
    kind: 'format',
    batchId: batchB.id,
    attemptId: batchA.current.id,
    token: batchA.current.token,
    seq: 2,
    outcome: 'passed',
    details: { summary: '格式通过' },
    emittedAt: new Date().toISOString(),
  });
  const crossResponse = await api(`${cluster.urls.exchange}/internal/receipts`, {
    method: 'POST',
    body: { kind: 'format', receipt: crossBatch },
  });
  assert.equal(crossResponse.status, 422);
  assert.equal(crossResponse.body.reason, 'BATCH_ATTEMPT_MISMATCH');

  // Same batch, signed, but carrying another attempt's token.
  const wrongToken = makeReceipt(cluster.config.secrets.validation, {
    issuer: 'validation',
    kind: 'format',
    batchId: batchA.id,
    attemptId: batchA.current.id,
    token: batchB.current.token,
    seq: 2,
    outcome: 'passed',
    details: { summary: '格式通过' },
    emittedAt: new Date().toISOString(),
  });
  const tokenResponse = await api(`${cluster.urls.exchange}/internal/receipts`, {
    method: 'POST',
    body: { kind: 'format', receipt: wrongToken },
  });
  assert.equal(tokenResponse.status, 422);
  assert.equal(tokenResponse.body.reason, 'TOKEN_MISMATCH');
});

test('a receipt signed with the wrong issuer secret is rejected', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const created = await uploadBatch(cluster, { content: csv([ROW]) });
  const batchId = created.body.batch.id;
  const batch = (await getBatch(cluster, batchId)).body.batch;
  const attempt = batch.current;

  const { makeReceipt } = await import('../src/common/receipts.js');
  const forged = makeReceipt(cluster.config.secrets.exchange, {
    issuer: 'ingestion',
    kind: 'ingest',
    batchId,
    attemptId: attempt.id,
    token: attempt.token,
    seq: 3,
    outcome: 'delivered',
    details: { posted: 99 },
    emittedAt: new Date().toISOString(),
  });
  const response = await api(`${cluster.urls.exchange}/internal/receipts`, {
    method: 'POST',
    body: { kind: 'ingest', receipt: forged },
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.disposition, 'rejected');
  assert.equal(response.body.reason, 'BAD_SIGNATURE');
});

test('ingest receipt arriving after the format stage failed is not applied', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const bad = csv([['REC-9', 'BLOCKED-0001', '10.00', 'USD', '2026-11-10T09:00:00Z']]);
  const created = await uploadBatch(cluster, { content: bad });
  const batchId = created.body.batch.id;
  const failed = await waitFor(async () => {
    const body = (await getBatch(cluster, batchId)).body.batch;
    return body.current.stages.format.state === 'failed' ? body : null;
  }, { label: 'format failed' });

  const { makeReceipt } = await import('../src/common/receipts.js');
  const attempt = failed.current;
  const bogus = makeReceipt(cluster.config.secrets.ingestion, {
    issuer: 'ingestion',
    kind: 'ingest',
    batchId,
    attemptId: attempt.id,
    token: attempt.token,
    seq: 3,
    outcome: 'delivered',
    details: { posted: 1, summary: '伪造的成功' },
    emittedAt: new Date().toISOString(),
  });
  const response = await api(`${cluster.urls.exchange}/internal/receipts`, {
    method: 'POST',
    body: { kind: 'ingest', receipt: bogus },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.disposition, 'conflict');
  assert.equal(response.body.reason, 'FORMAT_FAILED');

  const after = (await getBatch(cluster, batchId)).body.batch;
  assert.notEqual(after.status, 'accepted');
  assert.equal(after.current.stages.ingest.state, 'pending');
});
