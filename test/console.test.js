import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, csv, startCluster, uploadBatch, waitFor } from './helpers.js';
import { createConsoleService } from '../src/console/app.js';
import { createConfig } from '../src/common/config.js';

/**
 * The console is only a proxy plus a scenario driver: these tests assert it
 * relays real service verdicts and never invents state of its own.
 */
async function startConsole(cluster) {
  const config = createConfig({ dataRoot: cluster.config.dataRoot, urls: cluster.urls });
  const { app } = createConsoleService(config);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

function consoleApi(console_, path, options = {}) {
  return api(`${console_.base}${path}`, { token: null, ...options });
}

async function acceptedBatch(cluster, console_) {
  const created = await uploadBatch(cluster, { content: csv([['REC-1', 'ACC-1', '10.00', 'USD', '2026-11-10T09:00:00Z']]) });
  const batchId = created.body.batch.id;
  const batch = await waitFor(async () => {
    const body = (await consoleApi(console_, `/api/batches/${batchId}`)).body.batch;
    return body.status === 'accepted' ? body : null;
  }, { label: 'accepted via console' });
  return batch;
}

test('console serves the app, the fixtures and the proxied batch view', async (t) => {
  const cluster = await startCluster();
  const console_ = await startConsole(cluster);
  t.after(async () => {
    await console_.stop();
    await cluster.stop();
  });

  const page = await fetch(`${console_.base}/app/index.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /三段回执/);

  const traverse = await fetch(`${console_.base}/app/../package.json`);
  assert.equal(traverse.status === 200, false, 'path traversal must not leak files');

  const fixtures = await consoleApi(console_, '/api/fixtures');
  assert.ok(fixtures.body.fixtures.length >= 5);
  const fixture = await consoleApi(console_, '/api/fixtures/clean-batch.csv');
  assert.ok(fixture.body.contentBase64);

  const health = await consoleApi(console_, '/api/health');
  assert.equal(health.body.services.exchange.ok, true);
  assert.equal(health.body.services.validation.ok, true);
  assert.equal(health.body.services.ingestion.ok, true);

  const batch = await acceptedBatch(cluster, console_);
  const proxied = await consoleApi(console_, `/api/batches/${batch.id}`);
  assert.equal(proxied.body.batch.status, 'accepted');
  assert.equal(proxied.body.batch.current.stages.ingest.state, 'delivered');
});

test('scenario driver relays the exchange verdict instead of masking it', async (t) => {
  const cluster = await startCluster();
  const console_ = await startConsole(cluster);
  t.after(async () => {
    await console_.stop();
    await cluster.stop();
  });

  const batch = await acceptedBatch(cluster, console_);
  const attemptId = batch.current.id;

  const duplicate = await consoleApi(console_, '/api/simulate', {
    method: 'POST',
    body: { scenario: 'duplicate_receipt', stage: 'ingest', batchId: batch.id, attemptId },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.result.disposition, 'duplicate');

  const wrongToken = await consoleApi(console_, '/api/simulate', {
    method: 'POST',
    body: { scenario: 'wrong_token', stage: 'ingest', batchId: batch.id, attemptId },
  });
  // The driver reports a refused receipt as an outcome, not a transport error;
  // the exchange's own reason must survive the round trip.
  assert.equal(wrongToken.status, 200);
  assert.equal(wrongToken.body.result.error.status, 422);
  assert.equal(wrongToken.body.result.error.code, 'TOKEN_MISMATCH');

  const tampered = await consoleApi(console_, '/api/simulate', {
    method: 'POST',
    body: { scenario: 'tampered_receipt', stage: 'ingest', batchId: batch.id, attemptId },
  });
  assert.equal(tampered.status, 200);
  assert.equal(tampered.body.result.error.status, 422);
  assert.equal(tampered.body.result.error.code, 'BAD_SIGNATURE');

  // Nothing the simulator did changed the state.
  const after = await consoleApi(console_, `/api/batches/${batch.id}`);
  assert.equal(after.body.batch.status, 'accepted');
  assert.equal((await api(`${cluster.urls.ingestion}/internal/ingest/${attemptId}`)).body.live, 1);
});

test('rollback-ingested is a real ledger rollback followed by a void', async (t) => {
  const cluster = await startCluster();
  const console_ = await startConsole(cluster);
  t.after(async () => {
    await console_.stop();
    await cluster.stop();
  });

  const batch = await acceptedBatch(cluster, console_);
  const attemptId = batch.current.id;

  const rolled = await consoleApi(console_, `/api/batches/${batch.id}/rollback-ingested`, {
    method: 'POST',
    body: { attemptId, reason: 'console test' },
  });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.body.rollback.rolledBack, 1);
  assert.equal(rolled.body.voided.status, 'voided');

  const ledger = await api(`${cluster.urls.ingestion}/internal/ingest/${attemptId}`);
  assert.equal(ledger.body.live, 0);
  assert.equal(ledger.body.state, 'rolled_back');

  const view = await consoleApi(console_, `/api/batches/${batch.id}`);
  assert.equal(view.body.batch.status, 'voided');
  assert.equal(view.body.batch.current.stages.ingest.state, 'rolled_back');
  // The page must not offer to roll back again: there is nothing live.
  const again = await consoleApi(console_, `/api/batches/${batch.id}/rollback-ingested`, {
    method: 'POST',
    body: { attemptId },
  });
  assert.equal(again.status, 409);
});
