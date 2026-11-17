const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  fixtures: [],
  fixture: null,
  batches: [],
  selectedBatchId: null,
  selectedAttemptId: null,
  batch: null,
  health: null,
  simNotes: [],
  busy: false,
  timer: null,
  lastSeenEventId: 0,
};

// --------------------------------------------------------------- utilities

const STAGE_LABELS = {
  received: '收件',
  format: '格式校验',
  ingest: '业务入库',
};

const STAGE_ORDER = ['received', 'format', 'ingest'];

const TERMINAL_LABELS = {
  accepted: { text: '接收完成', tone: 'ok' },
  failed: { text: '未接收（失败）', tone: 'bad' },
  cancelled: { text: '已撤销（未入库）', tone: 'warn' },
  voided: { text: '已作废', tone: 'warn' },
  superseded: { text: '已被替代', tone: 'warn' },
  replaced_by_attempt: { text: '已被新一次补交取代', tone: 'warn' },
  in_progress: { text: '进行中', tone: 'info' },
};

const BATCH_STATUS_LABELS = {
  submitted: { text: '已交付 / 推进中', tone: 'info' },
  failed: { text: '未通过', tone: 'bad' },
  partially_accepted: { text: '部分接收', tone: 'warn' },
  accepted: { text: '接收完成', tone: 'ok' },
  cancelled: { text: '已撤销', tone: 'warn' },
  voided: { text: '已作废', tone: 'warn' },
  superseded: { text: '已被替代', tone: 'warn' },
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shortId(id) {
  if (!id) return '—';
  const [prefix, ...rest] = String(id).split('_');
  const body = rest.join('_');
  return body ? `${prefix}_${body.slice(0, 8)}…` : id;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(fromIso) {
  if (!fromIso) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(fromIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(parsed?.error?.message || `HTTP ${response.status}`);
    error.code = parsed?.error?.code;
    error.status = response.status;
    error.details = parsed?.error?.details;
    throw error;
  }
  return parsed;
}

function toast(title, message = '', tone = 'info', ttl = 6000) {
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.innerHTML = `<strong>${esc(title)}</strong>${message ? esc(message) : ''}`;
  $('#toasts').append(node);
  setTimeout(() => node.remove(), ttl);
}

function stageTone(stage) {
  if (!stage) return 'pending';
  if (stage.state === 'passed' || stage.state === 'delivered' || stage.state === 'received') return 'ok';
  if (stage.state === 'failed' || stage.state === 'rejected') return 'bad';
  if (stage.state === 'rolled_back') return 'warn';
  if (stage.overdue) return 'warn';
  return 'pending';
}

function stageStateLabel(stage) {
  if (!stage) return '未知';
  // The received stage is stored as 'passed' when the exchange's own receipt
  // was recorded; for the operator that means "已收件", not "校验通过".
  if (stage.kind === 'received' && stage.state === 'passed') return '已收件';
  switch (stage.state) {
    case 'pending': return stage.overdue ? '等待回执（已超时）' : '等待回执';
    case 'passed': return '通过';
    case 'failed': return '未通过';
    case 'rejected': return '被拒';
    case 'received': return '已收件';
    case 'delivered': return '已入库';
    case 'rolled_back': return '已撤销入库';
    default: return stage.state;
  }
}

/** What is actually true for a batch right now, stated without optimism. */
function batchVerdict(batch) {
  if (!batch) return { tone: 'pending', title: '未选择批次', detail: '' };
  const attempts = batch.attempts ?? [];
  const accepted = attempts.find((a) => a.stages.ingest.state === 'delivered' && a.terminal === 'accepted');
  if (batch.status === 'accepted' && accepted) {
    return {
      tone: 'ok',
      title: '接收完成：三段回执齐全，业务入库成功',
      detail: `${batch.filename} 的入库回执确认 ${accepted.filename ?? '文件'} 已入账。只有这一步成功才判定接收完成。`,
    };
  }
  if (batch.status === 'voided') {
    return { tone: 'warn', title: '批次已作废：已入库数据被撤销', detail: '作废不等于删除历史；账本中保留撤销原因，可查。' };
  }
  if (batch.status === 'superseded') {
    return {
      tone: 'warn',
      title: `已被替代批次 ${shortId(batch.supersededBy)} 取代`,
      detail: '旧批次此后不再推进；它的回执只会归档，不会把替代批次判为成功。',
    };
  }
  if (batch.status === 'cancelled') {
    return { tone: 'warn', title: '批次已撤销，未入库部分停止推进', detail: `原因：${batch.closedReason ?? '操作员撤销'}` };
  }
  if (batch.status === 'partially_accepted') {
    return { tone: 'bad', title: '部分接收：入库阶段失败', detail: '已提交的入库数据需人工核对；本页不会把它算作完成。' };
  }
  const current = batch.current;
  if (!current) return { tone: 'pending', title: '尚无尝试记录', detail: '' };
  const stages = current.stages;
  const waiting = STAGE_ORDER.find((name) => stages[name].state === 'pending');
  if (stages.format.state === 'failed') {
    return {
      tone: 'bad',
      title: '格式校验未通过，需要补交修正文件',
      detail: '补交可以沿用原批次（生成新尝试），也可以创建替代批次。未通过之前不会转交入库。',
    };
  }
  if (waiting) {
    const overdue = stages[waiting].overdue;
    return {
      tone: overdue ? 'warn' : 'info',
      title: `等待${STAGE_LABELS[waiting]}回执${overdue ? '（已超过预期时间）' : ''}`,
      detail: overdue
        ? '回执可能丢失。请使用“对账”向对应服务核对实际状态；在拿到回执前不判定成功。'
        : '请求已发出，回执尚未到达。回执可能乱序或重复，交换服务会按签发方与 token 校验。',
    };
  }
  return { tone: 'info', title: '推进中', detail: '' };
}

// ---------------------------------------------------------------- renders

function renderHealth() {
  const el = $('#health');
  if (!state.health) {
    el.innerHTML = '<span class="health-pill"><span class="dot"></span>检查中…</span>';
    return;
  }
  const rows = ['exchange', 'validation', 'ingestion'].map((name) => {
    const svc = state.health.services?.[name];
    const ok = svc?.ok;
    const label = { exchange: '交换', validation: '校验', ingestion: '入库' }[name];
    return `<span class="health-pill" title="${esc(svc?.url ?? '')}"><span class="dot ${ok ? 'ok' : 'bad'}"></span>${label} ${ok ? '在线' : '离线'}</span>`;
  });
  el.innerHTML = rows.join('');
}

function miniStages(attempt) {
  return STAGE_ORDER.map((name) => {
    const stage = attempt.stages[name];
    let cls = '';
    if (stage.state === 'passed' || stage.state === 'received') cls = 'passed';
    else if (stage.state === 'delivered') cls = 'delivered';
    else if (stage.state === 'failed') cls = 'failed';
    else if (stage.overdue) cls = 'awaiting';
    return `<span class="mini-stage ${cls}" title="${esc(STAGE_LABELS[name])}：${esc(stageStateLabel(stage))}"></span>`;
  }).join('');
}

function renderBatchList() {
  const el = $('#batch-list');
  if (!state.batches.length) {
    el.innerHTML = '<p class="list-empty">还没有批次。用左上角的样例文件交付第一批。</p>';
    return;
  }
  el.innerHTML = state.batches
    .map((batch) => {
      const label = BATCH_STATUS_LABELS[batch.status] ?? { text: batch.status, tone: 'info' };
      const current = batch.current;
      return `
        <button class="batch-item" data-batch="${esc(batch.id)}" aria-current="${batch.id === state.selectedBatchId}">
          <div class="row">
            <span class="fname">${esc(batch.filename)}</span>
            <span class="badge ${label.tone}">${esc(label.text)}</span>
          </div>
          <div class="row">
            <span class="bid">${esc(shortId(batch.id))}${batch.kind === 'replacement' ? ' · 替代' : ''}</span>
            <span class="bid">${esc(fmtTime(batch.createdAt))}</span>
          </div>
          ${current ? `<div class="mini-stages">${miniStages(current)}</div>` : ''}
        </button>`;
    })
    .join('');
}

function renderFixturePreview() {
  const el = $('#fixture-preview');
  const fixture = state.fixtures.find((f) => f.name === $('#fixture-select').value);
  state.fixture = fixture ?? null;
  if (!fixture) {
    el.textContent = '选择一个样例文件以查看内容。';
    return;
  }
  const preview = (fixture.preview ?? '').slice(0, 600);
  el.textContent = `${fixture.label}\n${fixture.note}\n\n${preview || '（空文件）'}`;
}

function renderSimTarget() {
  const el = $('#sim-target');
  if (!state.batch) {
    el.textContent = '先在右侧选中一个批次';
    return;
  }
  el.textContent = `当前批次：${state.batch.filename}（${shortId(state.batch.id)}）`;
}

function renderSimNotes() {
  const el = $('#sim-notes');
  if (!state.simNotes.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = state.simNotes
    .slice(0, 6)
    .map((note) => `<div class="sim-note ${note.tone ?? ''}"><strong>${esc(note.title)}</strong><br />${esc(note.body)}</div>`)
    .join('');
}

function renderStage(stageName, attempt, index, actions) {
  const stage = attempt.stages[stageName];
  const tone = stageTone(stage);
  const receipt = stage.receipt;
  const parts = [];

  if (stageName === 'received') {
    if (stage.state === 'passed') {
      parts.push(`<p class="reason"><strong>交换服务已收件</strong>，回执时间 ${esc(fmtTime(stage.at))}。</p>`);
    } else {
      parts.push(`<p class="reason">文件已进入交换服务，等待收件回执落账。${stage.overdue ? '已超时，可对账重建。' : ''}</p>`);
    }
  }

  if (stageName === 'format') {
    if (stage.dispatchError) {
      parts.push(`<p class="reason"><strong>转交校验失败：</strong>${esc(stage.dispatchError)}</p>`);
    }
    if (stage.summary) parts.push(`<p class="reason">${esc(stage.summary)}</p>`);
    if (Array.isArray(stage.errors) && stage.errors.length) {
      parts.push(`<ul class="error-list">${stage.errors
        .slice(0, 12)
        .map(
          (e) =>
            `<li><span class="line">行 ${esc(e.line ?? '—')}</span><span class="code">${esc(e.code ?? '')}</span><span>${esc(e.message ?? '')}</span></li>`,
        )
        .join('')}</ul>`);
    }
    if (stage.state === 'pending' && !stage.dispatchError) {
      parts.push(`<p class="reason">${
        stage.overdue
          ? '格式回执迟迟未到，可能是回执在路上丢失。用“对账”向校验服务查询它是否已经处理过这个文件。'
          : '已转交校验服务，等待格式回执。'
      }</p>`);
    }
  }

  if (stageName === 'ingest') {
    if (stage.dispatchError) {
      parts.push(`<p class="reason"><strong>转交入库结果未知：</strong>${esc(stage.dispatchError)}</p>`);
    }
    if (stage.summary) parts.push(`<p class="reason">${esc(stage.summary)}</p>`);
    if (stage.state === 'pending') {
      const waiting =
        stage.dispatchState === 'sent' || stage.dispatchState === 'unknown' || stage.dispatchState === 'in_flight';
      parts.push(`<p class="reason">${
        waiting
          ? stage.overdue
            ? '入库回执未到达。数据可能已经写库，也可能没有——页面对账会直接问入库服务的账本，不会凭猜测判定。'
            : '已转交入库，等待入库回执。'
          : '尚未达到入库阶段。'
      }</p>`);
    }
    if (stage.state === 'delivered') {
      parts.push('<p class="reason"><strong>业务入库已确认</strong>。这是唯一能让批次判定“接收完成”的一步。</p>');
    }
    if (stage.state === 'rolled_back') {
      parts.push('<p class="reason">该尝试的入账记录已被撤销，批次不应再显示为成功。</p>');
    }
  }

  const receiptBlock = receipt
    ? `<details class="disclosure">
         <summary><span>回执详情 · ${esc(receipt.issuer)} / ${esc(receipt.outcome)} · ${esc(fmtTime(receipt.receivedAt ?? receipt.emittedAt))}</span><span class="badge ${receipt.application === 'applied' ? 'ok' : receipt.application === 'rejected' ? 'bad' : 'warn'}">${esc(receipt.application ?? '')}</span></summary>
         <div class="disclosure-body">
           <dl class="kv">
             <dt>签发方</dt><dd>${esc(receipt.issuer)}</dd>
             <dt>结果</dt><dd>${esc(receipt.outcome)}</dd>
             <dt>序号</dt><dd>${esc(receipt.seq ?? '—')}</dd>
             <dt>签发时间</dt><dd class="mono">${esc(fmtTime(receipt.emittedAt))}</dd>
             <dt>到达时间</dt><dd class="mono">${esc(fmtTime(receipt.receivedAt))}</dd>
             ${receipt.details?.summary ? `<dt>说明</dt><dd>${esc(receipt.details.summary)}</dd>` : ''}
             ${receipt.details?.posted !== undefined ? `<dt>入账条数</dt><dd>${esc(receipt.details.posted)}</dd>` : ''}
             ${receipt.details?.errorCount !== undefined ? `<dt>问题数</dt><dd>${esc(receipt.details.errorCount)}</dd>` : ''}
           </dl>
         </div>
       </details>`
    : '';

  return `
    <div class="stage">
      <div class="stage-rail">
        <span class="stage-num ${tone}">${index + 1}</span>
        <span class="stage-line"></span>
      </div>
      <div class="stage-main">
        <div class="stage-head">
          <div class="title"><strong>${esc(STAGE_LABELS[stageName])}</strong><span>${esc(stageStateLabel(stage))}</span></div>
          <span class="badge ${tone}">${esc(stageStateLabel(stage))}</span>
        </div>
        ${parts.length ? `<div class="stage-detail">${parts.join('')}</div>` : ''}
        ${actions ? `<div class="stage-actions">${actions}</div>` : ''}
        ${receiptBlock}
      </div>
    </div>`;
}

function renderAttemptActions(attempt, batch) {
  const groups = {};
  const alive = attempt.terminal === 'in_progress';
  const stages = attempt.stages;

  if (alive) {
    if (stages.format.state === 'pending' && (stages.format.overdue || stages.format.dispatchError)) {
      groups.format = `
        ${stages.format.dispatchError ? `<button class="btn small" data-action="retry" data-stage="format" data-attempt="${esc(attempt.id)}">补发转交校验</button>` : ''}
        <button class="btn small" data-action="reconcile" data-attempt="${esc(attempt.id)}">对账（查校验服务）</button>`;
    }
    if (stages.ingest.state === 'pending' && (stages.ingest.overdue || ['unknown', 'none'].includes(stages.ingest.dispatchState))) {
      groups.ingest = `
        <button class="btn small" data-action="reconcile" data-attempt="${esc(attempt.id)}">对账（查入库账本）</button>
        ${['unknown', 'none'].includes(stages.ingest.dispatchState) ? `<button class="btn small" data-action="retry" data-stage="ingest" data-attempt="${esc(attempt.id)}">重新转交入库</button>` : ''}`;
    }
  }

  if (stages.format.state === 'failed' || stages.ingest.state === 'failed' || stages.format.dispatchError) {
    groups.format = `${groups.format ?? ''}<button class="btn small primary" data-action="revise" data-attempt="${esc(attempt.id)}">补交修正文件（同批次）</button>
      <button class="btn small" data-action="replace" data-attempt="${esc(attempt.id)}" title="新建批次并在追溯链上指向原批次；原批次及其旧回执不再推进">创建替代批次</button>`;
  }
  if (stages.ingest.state === 'delivered') {
    groups.ingest = `${groups.ingest ?? ''}<button class="btn small danger" data-action="rollback" data-attempt="${esc(attempt.id)}">撤销已入库数据</button>`;
  }
  if (alive && stages.ingest.state !== 'delivered') {
    groups.received = `<button class="btn small danger" data-action="cancel" data-attempt="${esc(attempt.id)}">撤销未入库部分</button>`;
  }
  return groups;
}

function renderChain(batch) {
  if (batch.kind !== 'replacement' && !batch.supersededBy) return '';
  const links = [];
  if (batch.supersedes) {
    links.push(`<button class="chain-link" data-jump="${esc(batch.supersedes)}">原批次 ${esc(shortId(batch.supersedes))}</button>`);
    links.push('<span class="chain-arrow">→</span>');
    links.push(`<span class="chain-link current">本批次 ${esc(shortId(batch.id))}</span>`);
  } else if (batch.supersededBy) {
    links.push(`<span class="chain-link current">本批次 ${esc(shortId(batch.id))}</span>`);
    links.push('<span class="chain-arrow">→</span>');
    links.push(`<button class="chain-link" data-jump="${esc(batch.supersededBy)}">替代批次 ${esc(shortId(batch.supersededBy))}</button>`);
  }
  return `<div class="chain">${links.join('')}</div>`;
}

function renderDetail() {
  const el = $('#detail');
  const batch = state.batch;
  if (!batch) {
    el.innerHTML = `
      <div class="empty-state">
        <h2>还没有选中批次</h2>
        <p>这里不会用“上传成功”冒充“接收成功”。每个批次要依次拿到三份回执：</p>
        <ol>
          <li><strong>收件回执</strong> —— 交换服务确认拿到了文件。</li>
          <li><strong>格式校验回执</strong> —— 校验服务给出的通过/不通过及逐行原因。</li>
          <li><strong>业务入库回执</strong> —— 入库服务真正写库后签发的成功回执。</li>
        </ol>
        <p style="margin-top:14px">第三步没到，本页就一直显示等待。</p>
      </div>`;
    return;
  }

  const verdict = batchVerdict(batch);
  const attempts = batch.attempts ?? [];
  const selected =
    attempts.find((a) => a.id === state.selectedAttemptId) ?? batch.current ?? attempts[0] ?? null;
  const status = BATCH_STATUS_LABELS[batch.status] ?? { text: batch.status, tone: 'info' };

  const attemptTabs = attempts
    .map((attempt) => {
      const tone =
        attempt.terminal === 'accepted' ? 'ok' : attempt.terminal === 'failed' ? 'bad' : attempt.terminal === 'in_progress' ? 'warn' : 'pending';
      return `<button class="attempt-tab" data-attempt-tab="${esc(attempt.id)}" aria-pressed="${selected?.id === attempt.id}">
        <span class="status-dot ${tone}"></span>尝试 #${attempt.attemptNo}${attempt.mode === 'revise' ? ' · 补交' : ''}
      </button>`;
    })
    .join('');

  const stageActions = selected ? renderAttemptActions(selected, batch) : {};
  const attemptsBlock = attempts.length
    ? `<div class="attempts-block">
        <div class="attempt-tabs">${attemptTabs}</div>
        ${
          selected
            ? `<div class="stages" style="margin-top:14px">
                 ${STAGE_ORDER.map((name, i) => renderStage(name, selected, i, stageActions[name])).join('')}
               </div>`
            : ''
        }
      </div>`
    : '<p class="micro">没有尝试记录。</p>';

  const events = batch.events ?? [];
  const anomalies = batch.anomalies ?? [];

  el.innerHTML = `
    <section class="card">
      <div class="card-head">
        <div>
          <h3>${esc(batch.filename)}</h3>
          <p class="sub">批次 ${esc(batch.id)}${batch.note ? ` · ${esc(batch.note)}` : ''}</p>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="badge ${status.tone}">${esc(status.text)}</span>
          ${batch.kind === 'replacement' ? '<span class="badge info">替代批次</span>' : ''}
        </div>
      </div>
      <div class="card-body">
        <div class="banner ${verdict.tone}">
          <div>
            <div class="b-title">${esc(verdict.title)}</div>
            ${verdict.detail ? `<p>${esc(verdict.detail)}</p>` : ''}
          </div>
        </div>
        ${renderChain(batch)}
        <div class="meta-grid">
          <div class="meta"><span class="k">文件指纹</span><span class="v mono">${esc(batch.fingerprint)}</span></div>
          <div class="meta"><span class="k">创建时间</span><span class="v">${esc(fmtTime(batch.createdAt))}</span></div>
          <div class="meta"><span class="k">尝试次数</span><span class="v">${attempts.length}</span></div>
          <div class="meta"><span class="k">当前尝试</span><span class="v mono">${esc(shortId(batch.current?.id))}</span></div>
        </div>
        ${attemptsBlock}
      </div>
    </section>

    <div class="two-col">
      <section class="card">
        <div class="card-head">
          <h3>异常与拒绝回执</h3>
          <span class="badge ${anomalies.length ? 'warn' : 'pending'}">${anomalies.length} 条</span>
        </div>
        <div class="card-body">
          ${
            anomalies.length
              ? `<div class="anomaly-list">${anomalies
                  .map(
                    (a) => `
                <div class="anomaly ${['BAD_SIGNATURE', 'BATCH_ATTEMPT_MISMATCH', 'TOKEN_MISMATCH', 'CONFLICTING_OUTCOME'].includes(a.reason) ? 'bad' : ''}">
                  <div class="a-head"><span class="a-reason">${esc(a.reason)}</span><span class="a-time">${esc(fmtTime(a.receivedAt))}</span></div>
                  <div class="a-detail">${esc(a.detail ?? '')}</div>
                </div>`,
                  )
                  .join('')}</div>`
              : '<p class="micro">没有异常。重复、乱序、错引用、签名不符的回执都会出现在这里。</p>'
          }
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h3>时间线</h3>
          <span class="hint" style="font-size:11px;color:var(--text-faint)">最近 ${Math.min(events.length, 40)} 条</span>
        </div>
        <div class="card-body">
          ${
            events.length
              ? `<div class="timeline">${events
                  .slice(0, 25)
                  .map(
                    (e) => `
                <div class="tl-item ${esc(e.level)}">
                  <span class="tl-dot"></span>
                  <div class="tl-body">
                    <div class="tl-msg">${esc(e.message)}</div>
                    <div class="tl-meta">${esc(fmtTime(e.at))} · ${esc(e.type)}${e.attemptId ? ` · ${esc(shortId(e.attemptId))}` : ''}</div>
                  </div>
                </div>`,
                  )
                  .join('')}</div>`
              : '<p class="micro">暂无事件。</p>'
          }
        </div>
      </section>
    </div>
  `;
}

function renderAll() {
  renderHealth();
  renderBatchList();
  renderSimTarget();
  renderSimNotes();
  renderDetail();
}

// ------------------------------------------------------------------ loading

async function loadFixtures() {
  const data = await api('/api/fixtures');
  state.fixtures = data.fixtures ?? [];
  const select = $('#fixture-select');
  select.innerHTML = state.fixtures
    .map((f) => `<option value="${esc(f.name)}">${esc(f.label)} · ${f.sizeBytes} B</option>`)
    .join('');
  renderFixturePreview();
}

async function loadHealth() {
  try {
    state.health = await api('/api/health');
  } catch {
    state.health = { services: {} };
  }
  renderHealth();
}

async function loadBatches() {
  const data = await api('/api/batches');
  state.batches = data.batches ?? [];
  const exists = state.batches.some((b) => b.id === state.selectedBatchId);
  if (!exists) state.selectedBatchId = state.batches[0]?.id ?? null;
  renderBatchList();
}

async function loadBatch(batchId = state.selectedBatchId) {
  if (!batchId) {
    state.batch = null;
    state.selectedAttemptId = null;
    renderSimTarget();
    renderDetail();
    return;
  }
  const data = await api(`/api/batches/${encodeURIComponent(batchId)}`);
  state.batch = data.batch;
  const attempts = state.batch.attempts ?? [];
  if (!attempts.some((a) => a.id === state.selectedAttemptId)) {
    state.selectedAttemptId = state.batch.current?.id ?? attempts[0]?.id ?? null;
  }
  renderSimTarget();
  renderDetail();
}

async function refresh({ keepDetail = true } = {}) {
  try {
    await loadBatches();
    if (keepDetail) await loadBatch();
  } catch (error) {
    toast('刷新失败', error.message, 'bad');
  }
}

function selectBatch(batchId) {
  state.selectedBatchId = batchId;
  state.selectedAttemptId = null;
  renderBatchList();
  loadBatch(batchId).catch((error) => toast('加载批次失败', error.message, 'bad'));
}

// ------------------------------------------------------------------ actions

function setBusy(busy) {
  state.busy = busy;
  $$('button[data-action], #upload-btn').forEach((btn) => {
    if (btn.id === 'upload-btn') btn.disabled = busy;
  });
}

async function uploadSelected() {
  const fixture = state.fixtures.find((f) => f.name === $('#fixture-select').value);
  if (!fixture) return;
  const detail = await api(`/api/fixtures/${encodeURIComponent(fixture.name)}`);
  $('#upload-btn').disabled = true;
  try {
    const result = await api('/api/batches', {
      method: 'POST',
      body: {
        filename: fixture.name,
        contentBase64: detail.contentBase64,
        note: $('#upload-note').value.trim() || undefined,
      },
    });
    state.selectedBatchId = result.batch.id;
    state.selectedAttemptId = null;
    toast('文件已交给交换服务', '接下来等待格式校验与业务入库回执；在此之前不会显示接收完成。', 'ok');
    await refresh();
  } catch (error) {
    toast('交付失败', error.message, 'bad');
  } finally {
    $('#upload-btn').disabled = false;
  }
}

async function reviseAttempt(attemptId) {
  const fixture = state.fixtures.find((f) => f.name === $('#fixture-select').value);
  if (!fixture) {
    toast('请选择修正文件', '在左侧“样例文件”里选择用作补交内容的文件。', 'warn');
    return;
  }
  const detail = await api(`/api/fixtures/${encodeURIComponent(fixture.name)}`);
  try {
    const result = await api(`/api/batches/${encodeURIComponent(state.batch.id)}/revisions`, {
      method: 'POST',
      body: { filename: `revised-${fixture.name}`, contentBase64: detail.contentBase64 },
    });
    toast('已补交到同一批次', `新尝试 ${shortId(result.newAttemptId)}；旧尝试已关闭，其回执不再推进批次。`, 'ok');
    state.selectedAttemptId = result.newAttemptId;
    await refresh();
  } catch (error) {
    toast('补交失败', error.message, 'bad');
  }
}

async function replaceBatch(attemptId) {
  const fixture = state.fixtures.find((f) => f.name === $('#fixture-select').value);
  if (!fixture) {
    toast('请选择替代文件', '在左侧“样例文件”里选择用作替代批次内容的文件。', 'warn');
    return;
  }
  if (
    !window.confirm(
      '创建替代批次？这会新开一个批次号并明确指向原批次；原批次及其旧回执从此只归档，不能再推进或判成功。若原批次已有入账数据，需先撤销。',
    )
  ) {
    return;
  }
  const detail = await api(`/api/fixtures/${encodeURIComponent(fixture.name)}`);
  try {
    const result = await api(`/api/batches/${encodeURIComponent(state.batch.id)}/replacement`, {
      method: 'POST',
      body: { filename: `replacement-${fixture.name}`, contentBase64: detail.contentBase64 },
    });
    toast(
      '已创建替代批次',
      `新批次 ${shortId(result.batch.id)}；原批次 ${shortId(result.superseded.id)} 已关闭，旧回执只会归档。`,
      'warn',
      9000,
    );
    state.selectedBatchId = result.batch.id;
    state.selectedAttemptId = null;
    await refresh();
  } catch (error) {
    toast('创建替代批次失败', error.message, 'bad', 9000);
  }
}

async function reconcile(attemptId) {
  try {
    const result = await api(`/api/batches/${encodeURIComponent(state.batch.id)}/reconcile`, {
      method: 'POST',
      body: { attemptId },
    });
    const notes = result.notes ?? [];
    toast('对账完成', notes.join('；') || '没有可补发的事项', notes.some((n) => n.includes('失败') || n.includes('无法')) ? 'warn' : 'ok', 9000);
    state.simNotes.unshift({ title: '人工对账', body: notes.join('；') || '没有可补发的事项', tone: 'warn' });
    await refresh();
  } catch (error) {
    toast('对账失败', error.message, 'bad');
  }
}

async function retryStage(attemptId, stage) {
  try {
    const result = await api(`/api/batches/${encodeURIComponent(state.batch.id)}/retry`, {
      method: 'POST',
      body: { attemptId, stage },
    });
    toast('已补发', (result.notes ?? []).join('；'), 'ok');
    await refresh();
  } catch (error) {
    toast('补发失败', error.message, 'bad');
  }
}

async function cancelBatch(attemptId) {
  if (!window.confirm('撤销这个批次尚未入库的部分？已入库的数据不会被撤销，需要使用“撤销已入库数据”。')) return;
  try {
    await api(`/api/batches/${encodeURIComponent(state.batch.id)}/cancel`, {
      method: 'POST',
      body: { attemptId, reason: '操作员在页面上撤销未入库部分' },
    });
    toast('已撤销', '批次不再推进；迟到的回执只会归档。', 'warn');
    await refresh();
  } catch (error) {
    toast('撤销失败', error.message, 'bad');
  }
}

async function rollbackIngested(attemptId) {
  if (!window.confirm('撤销该尝试已经入账的记录？这会直接改写入库服务的账本，并把批次标记为作废。')) return;
  try {
    const result = await api(`/api/batches/${encodeURIComponent(state.batch.id)}/rollback-ingested`, {
      method: 'POST',
      body: { attemptId, reason: '操作员在页面上撤销已入库数据' },
    });
    toast('已撤销入库', `回滚 ${result.rollback.rolledBack} 条记录；批次状态：${result.voided.status}`, 'warn');
    await refresh();
  } catch (error) {
    toast('撤销失败', error.message, 'bad');
  }
}

async function runScenario(button) {
  const scenario = button.dataset.sim;
  const stage = button.dataset.stage ?? 'format';
  try {
    const result = await api('/api/simulate', {
      method: 'POST',
      body: {
        scenario,
        stage,
        batchId: state.batch?.id,
        attemptId: state.selectedAttemptId,
      },
    });
    const body = [result.note, summarizeScenario(result)].filter(Boolean).join(' ');
    state.simNotes.unshift({ title: `演练：${scenario}`, body, tone: scenario.includes('lose') ? 'warn' : '' });
    toast('演练已触发', body, 'warn', 9000);
    await refresh();
  } catch (error) {
    toast('演练失败', error.message, 'bad');
  }
}

function summarizeScenario(result) {
  const bits = [];
  const disposition = result.result?.disposition ?? result.stale?.disposition ?? result.replay?.disposition;
  if (disposition) bits.push(`交换服务判定：${disposition}${result.result?.reason ? `（${result.result.reason}）` : ''}`);
  if (result.error) bits.push(`错误：${result.error.message ?? JSON.stringify(result.error)}`);
  return bits.join('；');
}

async function clearFaults() {
  try {
    await api('/api/faults', { method: 'DELETE' });
    toast('故障已清除', '三个服务的故障队列都已清空。', 'ok');
    await refresh();
  } catch (error) {
    toast('清除失败', error.message, 'bad');
  }
}

// --------------------------------------------------------------------- init

function bindEvents() {
  $('#fixture-select').addEventListener('change', renderFixturePreview);
  $('#upload-btn').addEventListener('click', uploadSelected);
  $('#refresh-btn').addEventListener('click', () => refresh());
  $('#clear-faults-btn').addEventListener('click', clearFaults);

  $('#batch-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-batch]');
    if (item) selectBatch(item.dataset.batch);
  });

  $('#detail').addEventListener('click', (event) => {
    const jump = event.target.closest('[data-jump]');
    if (jump) {
      selectBatch(jump.dataset.jump);
      return;
    }
    const tab = event.target.closest('[data-attempt-tab]');
    if (tab) {
      state.selectedAttemptId = tab.dataset.attemptTab;
      renderDetail();
      return;
    }
    const actionBtn = event.target.closest('[data-action]');
    if (!actionBtn) return;
    const { action, attempt, stage } = actionBtn.dataset;
    if (action === 'revise') reviseAttempt(attempt);
    if (action === 'replace') replaceBatch(attempt);
    if (action === 'reconcile') reconcile(attempt);
    if (action === 'retry') retryStage(attempt, stage);
    if (action === 'cancel') cancelBatch(attempt);
    if (action === 'rollback') rollbackIngested(attempt);
  });

  $$('[data-sim]').forEach((button) => {
    button.addEventListener('click', () => runScenario(button));
  });
}

async function boot() {
  bindEvents();
  try {
    await loadFixtures();
  } catch (error) {
    toast('样例加载失败', error.message, 'bad');
  }
  await loadHealth();
  await refresh({ keepDetail: false });
  await loadBatch();
  // Poll: stages can settle asynchronously; overdue labels depend on time.
  state.timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      await loadBatches();
      await loadBatch();
    } catch {
      /* keep the last good view */
    }
  }, 3000);
  setInterval(loadHealth, 10000);
}

// The script runs in a browser and in the DOM-shim tests, which import this
// module without a real page. Only boot when there is a document to boot into.
if (typeof document !== 'undefined' && document.getElementById('detail')) boot();

export { batchVerdict, renderStage, renderAttemptActions, stageStateLabel };
