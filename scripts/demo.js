/**
 * End-to-end walkthrough against a running console (npm start).
 *
 *   npm start            # terminal 1, fresh data dir
 *   npm run demo         # terminal 2
 *
 * Every step goes through the console's HTTP API, which in turn calls the
 * real exchange / validation / ingestion services. Nothing is stubbed.
 */
const base = (process.env.CONSOLE_URL || 'http://127.0.0.1:4180').replace(/\/$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;

function log(title, detail = '') {
  console.log(`\n\x1b[1m${title}\x1b[0m${detail ? `\n  ${detail}` : ''}`);
}

function ok(message) {
  console.log(`  \x1b[32m✔\x1b[0m ${message}`);
}

function bad(message) {
  failures += 1;
  console.log(`  \x1b[31m✖\x1b[0m ${message}`);
}

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(body?.error?.message || `HTTP ${response.status}`);
    error.code = body?.error?.code;
    error.body = body;
    throw error;
  }
  return body;
}

async function fixture(name) {
  return api(`/api/fixtures/${encodeURIComponent(name)}`);
}

async function upload(name, note) {
  const detail = await fixture(name);
  return api('/api/batches', {
    method: 'POST',
    body: { filename: name, contentBase64: detail.contentBase64, note },
  });
}

async function getBatch(id) {
  return (await api(`/api/batches/${encodeURIComponent(id)}`)).batch;
}

async function waitForBatch(id, predicate, { timeoutMs = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getBatch(id);
    if (predicate(last)) return last;
    await sleep(120);
  }
  throw new Error(`timeout waiting for ${label}; status=${last?.status}`);
}

function describe(batch) {
  const s = batch.current?.stages;
  if (!s) return batch.status;
  return `status=${batch.status} received=${s.received.state} format=${s.format.state} ingest=${s.ingest.state}`;
}

async function main() {
  log('0. 服务健康检查');
  const health = await api('/api/health');
  for (const name of ['exchange', 'validation', 'ingestion']) {
    if (health.services?.[name]?.ok) ok(`${name} 在线`);
    else bad(`${name} 不在线：${health.services?.[name]?.error ?? '未知'}`);
  }
  if (failures > 0) throw new Error('服务未全部启动，请先运行 npm start');

  log('1. 合规文件走完三段回执');
  const clean = await upload('clean-batch.csv', 'demo: happy path');
  ok(`上传返回 201，批次 ${clean.batch.id}，此刻状态 ${clean.batch.status}（还不是接收完成）`);
  const accepted = await waitForBatch(clean.batch.id, (b) => b.status === 'accepted', { label: 'accepted' });
  ok(`${describe(accepted)}`);
  const ingestReceipt = accepted.current.stages.ingest.receipt;
  if (ingestReceipt?.application === 'applied') ok('入库回执已应用：这是唯一让批次判定“接收完成”的一步');
  else bad('入库回执未应用');
  const ledger = await api(`/api/batches/${encodeURIComponent(clean.batch.id)}`); // console proxy sanity
  if (ledger.batch.current.stages.ingest.state === 'delivered') ok('入库服务账本确认已写库');

  log('2. 格式错误文件：逐行原因，不会进入入库');
  const badBatch = await upload('bad-format.csv', 'demo: format errors');
  const failed = await waitForBatch(badBatch.batch.id, (b) => b.status === 'failed', { label: 'format failed' });
  const errors = failed.current.stages.format.errors ?? [];
  ok(`${describe(failed)}，共 ${errors.length} 处问题`);
  for (const error of errors.slice(0, 4)) console.log(`    行 ${error.line} ${error.code}: ${error.message}`);
  if (failed.current.stages.ingest.state === 'pending') ok('入库阶段保持 pending：没有把失败偷偷当成完成');

  log('3. 同批次补交修正文件');
  const revised = await api(`/api/batches/${encodeURIComponent(failed.id)}/revisions`, {
    method: 'POST',
    body: { filename: 'fixed.csv', contentBase64: (await fixture('clean-batch-revised.csv')).contentBase64 },
  });
  ok(`批次号不变（${revised.batch.id === failed.id}），新尝试 ${revised.newAttemptId}，旧尝试已关闭`);
  const revisedAccepted = await waitForBatch(failed.id, (b) => b.status === 'accepted', { label: 'accepted after revision' });
  ok(`${describe(revisedAccepted)}`);

  log('4. 入库回执丢失（数据已提交）→ 对账而不是猜');
  await api('/api/faults', {
    method: 'POST',
    body: { service: 'ingestion', kind: 'crash_after_commit', stage: 'ingest', remaining: 1 },
  });
  const lost = await upload('clean-batch.csv', 'demo: crash after commit');
  const waiting = await waitForBatch(lost.batch.id, (b) => b.current?.stages.ingest.dispatchState === 'sent', {
    label: 'ingest dispatch sent',
  });
  ok(`${describe(waiting)}（收到的回执被模拟故障丢弃，页面显示等待）`);
  if (waiting.status !== 'accepted') ok('页面没有因为“上传成功”或“没收到回执”而判定成功');
  const reconciled = await api(`/api/batches/${encodeURIComponent(lost.batch.id)}/reconcile`, {
    method: 'POST',
    body: {},
  });
  for (const note of reconciled.notes ?? []) console.log(`    · ${note}`);
  const recovered = await waitForBatch(lost.batch.id, (b) => b.status === 'accepted', { label: 'recovered via ledger' });
  ok(`${describe(recovered)}（对账读了入库账本并回放回执）`);

  log('5. 替代批次与旧回执的追溯边界');
  // Hold back the format receipt so the batch is still undecided when the
  // operator decides to replace it instead of revising it.
  await api('/api/faults', {
    method: 'POST',
    body: { service: 'validation', kind: 'delivery', stage: 'format', remaining: 1, params: { mode: 'drop' } },
  });
  const original = await upload('clean-batch.csv', 'demo: replacement source');
  await waitForBatch(original.batch.id, (b) => b.current?.stages.format.state === 'pending', {
    label: 'format pending before replacement',
  });
  const scenario = await api('/api/simulate', {
    method: 'POST',
    body: { scenario: 'replace_then_old_receipt', stage: 'format', batchId: original.batch.id },
  });
  const replacementId = scenario.replacement?.id;
  const oldReceipt = scenario.stale;
  ok(`替代批次 ${replacementId}；原批次 ${original.batch.id} 已关闭`);
  const old = await getBatch(original.batch.id);
  ok(`原批次状态 ${old.status}，supersededBy=${old.supersededBy}；追溯链指向新批次`);
  if (oldReceipt?.disposition === 'stale' && oldReceipt?.reason === 'BATCH_SUPERSEDED') {
    ok('旧批次签发的回执判定 stale（BATCH_SUPERSEDED），替代批次不受影响');
  } else {
    bad(`旧回执应判定 stale，实际 ${JSON.stringify(oldReceipt)}`);
  }
  const replaced = await waitForBatch(replacementId, (b) => b.status === 'accepted', { label: 'replacement accepted' });
  ok(`替代批次 ${describe(replaced)}`);

  log('6. 重复回执不重复入账');
  const duplicate = await api('/api/simulate', {
    method: 'POST',
    body: { scenario: 'duplicate_receipt', stage: 'ingest', batchId: accepted.id },
  });
  if (duplicate.result?.disposition === 'duplicate') ok('交换服务判定 duplicate，账本未新增');
  else bad(`预期 duplicate，实际 ${JSON.stringify(duplicate.result)}`);

  console.log(
    failures === 0
      ? '\n\x1b[32m全部演示步骤通过。页面打开后可在“故障演练”里重复这些场景。\x1b[0m'
      : `\n\x1b[31m${failures} 个检查未通过。\x1b[0m`,
  );
  console.log(`控制台：${base}/`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\n演示中断：', error.message);
  if (error.body) console.error(JSON.stringify(error.body, null, 2));
  process.exitCode = 1;
});
