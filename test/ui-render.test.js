import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchVerdict, renderStage, stageStateLabel } from '../public/app.js';

/**
 * The console UI is a browser module. There is no headless browser in this
 * environment, so these tests exercise the pure view functions against the
 * same batch payloads the services produce. They pin the one rule the whole
 * page exists for: nothing may say "accepted" before the ingest receipt.
 */

function batch(overrides = {}) {
  return {
    id: 'bat_1',
    status: 'submitted',
    filename: 'batch.csv',
    attempts: [],
    events: [],
    anomalies: [],
    current: null,
    ...overrides,
  };
}

function stage(state, extra = {}) {
  return { kind: 'x', state, at: null, pendingSince: null, overdue: false, receipt: null, ...extra };
}

function attempt({ received = 'pending', format = 'pending', ingest = 'pending', terminal = 'in_progress', ingestExtra = {} } = {}) {
  return {
    id: 'att_1',
    attemptNo: 1,
    status: 'active',
    filename: 'batch.csv',
    terminal,
    stages: {
      received: stage(received),
      format: stage(format),
      ingest: stage(ingest, ingestExtra),
    },
    receipts: [],
  };
}

test('upload alone is never presented as acceptance', () => {
  const withCurrent = batch({ current: attempt(), attempts: [attempt()] });
  const verdict = batchVerdict(withCurrent);
  assert.equal(verdict.tone, 'info');
  assert.match(verdict.title, /等待收件回执/);
  assert.ok(!verdict.title.includes('接收完成'));

  const empty = batchVerdict(batch());
  assert.match(empty.title, /尚无尝试/);
});

test('accepted requires the ingest stage delivered and the attempt accepted', () => {
  const consistent = batch({
    status: 'accepted',
    current: attempt({ received: 'passed', format: 'passed', ingest: 'delivered', terminal: 'accepted' }),
  });
  consistent.attempts = [consistent.current];
  const ok = batchVerdict(consistent);
  assert.equal(ok.tone, 'ok');
  assert.match(ok.title, /接收完成/);

  // Contradictory state: batch says accepted but no attempt has an ingest
  // receipt. The UI must not repeat the optimistic status.
  const lying = batch({
    status: 'accepted',
    current: attempt({ received: 'passed', format: 'passed', ingest: 'pending', terminal: 'in_progress' }),
  });
  lying.attempts = [lying.current];
  const verdict = batchVerdict(lying);
  assert.notEqual(verdict.tone, 'ok');
  assert.ok(!verdict.title.includes('接收完成'));
  assert.match(verdict.title, /等待业务入库回执/);
});

test('a lost ingest receipt is described as unknown, not failed or accepted', () => {
  const lost = batch({
    current: attempt({
      received: 'passed',
      format: 'passed',
      ingest: 'pending',
      ingestExtra: { overdue: true, dispatchState: 'unknown', dispatchError: '响应未到达' },
    }),
  });
  lost.attempts = [lost.current];
  const verdict = batchVerdict(lost);
  assert.equal(verdict.tone, 'warn');
  assert.match(verdict.detail, /对账/);
  assert.match(verdict.detail, /不判定成功/);

  const html = renderStage('ingest', lost.current, 2, '');
  assert.match(html, /数据可能已经写库，也可能没有/);
  assert.match(html, /对账/);
  assert.ok(!html.includes('业务入库已确认'));
});

test('format failures expose per-line reasons and never claim ingest', () => {
  const failed = batch({
    status: 'failed',
    current: attempt({
      received: 'passed',
      format: 'failed',
    }),
  });
  failed.attempts = [failed.current];

  const verdict = batchVerdict(failed);
  assert.equal(verdict.tone, 'bad');
  assert.match(verdict.title, /格式校验未通过/);
  assert.match(verdict.detail, /补交/);

  const stageHtml = renderStage(
    'format',    {
      ...failed.current,
      stages: {
        ...failed.current.stages,
        format: stage('failed', {
          summary: '发现 2 处问题',
          errors: [{ line: 3, field: 'account_no', code: 'REQUIRED', message: 'account_no 不能为空' }],
        }),
      },
    },
    1,
    '',
  );
  assert.match(stageHtml, /行 3/);
  assert.match(stageHtml, /account_no/);
  assert.match(stageHtml, /发现 2 处问题/);
});

test('superseded, voided and cancelled batches read as stopped, never as success', () => {
  for (const [status, pattern] of [
    ['superseded', /已被替代/],
    ['voided', /已作废/],
    ['cancelled', /已撤销/],
    ['partially_accepted', /部分接收/],
  ]) {
    const verdict = batchVerdict(batch({ status, supersededBy: status === 'superseded' ? 'bat_2' : undefined }));
    assert.notEqual(verdict.tone, 'ok');
    assert.match(`${verdict.title} ${verdict.detail}`, pattern);
  }
});

test('stage labels distinguish waiting, overdue and rolled back', () => {
  assert.equal(stageStateLabel(stage('pending')), '等待回执');
  assert.equal(stageStateLabel(stage('pending', { overdue: true })), '等待回执（已超时）');
  assert.equal(stageStateLabel(stage('delivered')), '已入库');
  assert.equal(stageStateLabel(stage('rolled_back')), '已撤销入库');
  assert.equal(stageStateLabel({ kind: 'received', state: 'passed' }), '已收件');
  assert.equal(stageStateLabel({ kind: 'format', state: 'passed' }), '通过');
  assert.equal(stageStateLabel(null), '未知');
});
