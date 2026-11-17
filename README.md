# 批次交付接收台

三段确认、各自独立运行的批次交付接收演示：**收件 → 格式校验 → 业务入库**。
只有入库服务真正写库并签发回执，批次才算“接收完成”。上传成功、格式通过都不会让页面提前显示成功。

所有数据都是虚构的；所有动作都走真实的 HTTP 往返，服务之间也是如此。

## 运行

```bash
npm install
npm start -- --fresh        # 起 4 个进程，清空 data/
# 打开 http://127.0.0.1:4180/
```

- `npm test` — 33 个集成/视图测试（`test/`），全部在进程内起三个服务与控制台，用临时数据库。
- `npm run demo` — 对已启动的集群跑一遍脚本化走查（合规、格式错误、补交、回执丢失、替代、重复回执）。
- `npm start -- --fresh` 清库重启；不加参数则沿用 `data/`。
- 单独启动各服务：`npm run start:exchange|validation|ingestion|console`。

环境变量（`src/common/config.js`）：`DATA_DIR`、`EXCHANGE_PORT`/`VALIDATION_PORT`/`INGESTION_PORT`/`CONSOLE_PORT`、
`EXCHANGE_URL`/`VALIDATION_URL`/`INGESTION_URL`、`INTERNAL_TOKEN`、`RECEIPT_SECRET_{EXCHANGE,VALIDATION,INGESTION}`、
`AWAITING_RECEIPT_MS`（页面“超时”阈值）、`VALIDATION_DELAY_MS`。

## 拓扑

```
                  POST 文件                        POST 任务                      POST 入库
   浏览器/演示 ─────────▶ 交换服务 ───────────▶ 校验服务 ──────┐          ┌──────▶ 入库服务
      │              :4101  │  ▲                    :4102      │          │         :4103
      │  ← 状态/对账 ────────┘  │  ▲                              │          │            │
      │                       │  └──────── 格式回执 ─────────────┘          │            │
      │                       └──────────── 入库回执 ◀──────────────────────┴────────────┘
      ▼
   控制台 :4180  （只是代理 + 场景驱动，不持有任何接收状态）
```

- 交换服务：登记批次/尝试、保存文件、签发收件回执、判定所有回执、发起对账。
- 校验服务：独立任务表；按行校验并签发格式回执。
- 入库服务：独立账本，主键 `(batch_id, record_id)`，保证补交/重发不重复入账。
- 每个服务一个 SQLite 文件（`data/<service>/<service>.db`，WAL）。
- 服务之间用一个内部 token 认证；回执另有签发方各自的 HMAC-SHA256 密钥。

## 回执

每份回执是一个签名信封：

```
issuer / kind / batchId / attemptId / token / seq / outcome / details / emittedAt / signature
```

- `kind`：`received`（交换服务签）、`format`（校验服务签）、`ingest`（入库服务签）。
- `token` 是每个**尝试**独有的，回执必须同时对上 `batchId`、`attemptId`、`token` 和签名。
- 签名覆盖除 `signature` 外的规范化 JSON；任一字段被改都会失败。
- 文件指纹只按内容算（不含文件名），页面用指纹说明“这是不是同一份文件”。

交换服务对每份回执给出的判定（`disposition`）：

| 判定 | 含义 |
| --- | --- |
| `applied` | 推进了对应阶段 |
| `rejected` | 签名/签发方/类型/批次与尝试/token 不符；HTTP 422，只记异常 |
| `orphan` | 引用了不认识的尝试，无法归属 |
| `stale` | 批次已撤销/作废/被替代，或旧尝试的迟到回执；只归档 |
| `duplicate` | 同一阶段已有相同终态（含逐字节相同的重复回执） |
| `parked` | 乱序：入库回执早于格式结果，暂存，格式通过后自动重放 |
| `conflict` | 与既有终态矛盾（如格式已失败却收到入库成功） |

## 补交的两种追溯边界

| | 同批次补交（revision） | 替代批次（replacement） |
| --- | --- | --- |
| 批次号 | 不变 | 新批次号 |
| 旧尝试 | `superseded_attempt`，关闭 | 随旧批次一起关闭 |
| 追溯字段 | `attempts[].attemptNo`/`mode: 'revise'` | `supersedes` / `supersededBy`，`kind: 'replacement'` |
| 旧回执 | 旧尝试的 `token` 不再匹配当前尝试 → `stale`/`duplicate` | 旧批次整体 `superseded` → 一律 `stale`（`BATCH_SUPERSEDED`） |
| 前提 | 批次尚未接收完成 | 旧批次在入库账本里没有存活记录，否则 409 `LEDGER_HAS_LIVE_ROWS` |

替代批次创建后，旧批次状态为 `superseded`，任何引用它的回执都不会推进新批次；延迟到达的旧回执也不会把替代批次误判为成功。
已于入库后反悔的路径是：先在入库服务 `rollback` 已入账记录，再 `/void` 作废批次；作废后迟到回执为 `stale`（`BATCH_VOIDED`）。

## 撤销与“不知道”语义

- **撤销未入库部分**（cancel）：仅当入库账本没有该尝试的数据时允许。即使回执没回来，也会先查账本；有数据则 409 `LEDGER_ALREADY_HAS_DATA`。
- **撤销已入库部分**（rollback + void）：真的回滚账本行，再作废批次；页面明确显示“已撤销入库”。
- **回执丢失**：阶段显示“等待回执 / 已超时”，页面提示对账。`对账` 会向校验服务问任务、向入库服务问账本：
  - 有回执 → 原样回放（重复会被识别）；
  - 入库账本有数据但无回执 → 对部分提交重新转交，依靠账本幂等补齐；
  - 对端没有该任务 → 重新转交；
  - 绝不凭“没收到回执”判定失败，也绝不凭“上传成功”判定成功。
- **提交成功但响应断开**：回执其实已到交换服务；入库服务显示 `response_lost`，重投即为 `duplicate`。

## 页面能力

- 逐阶段显示状态、原因与原始回执：格式错误逐行列出（行号/字段/错误码），入库等待区分“已转交/结果未知/超时”。
- 每个批次多个尝试可切换查看；同批次补交、创建替代批次、对账、补发转交、撤销未入库、撤销已入库。
- 顶部横幅的判定永不乐观：批次状态与尝试终态必须同时成立才显示“接收完成”。
- 故障演练（真实故障注入，全部改变真实服务状态）：

| 按钮 | 注入点 | 观察点 |
| --- | --- | --- |
| 丢格式回执 / 丢入库回执 | 对端 `delivery=drop` | 停在等待；对账回放 |
| 入库后断连 | 入库 `crash_after_commit` | 账本有数据、无回执；对账后完成 |
| 响应断开 | 对端 `disconnect_after_send` | 交换服务已应用，重投为 duplicate |
| 乱序到达 | 先直接入库，再补投格式回执 | `parked` → 格式通过后重放 |
| 重复回执 | 重投同一份已存回执 | `duplicate`，账本不变 |
| 错批次引用 / 错 token | 用合法密钥签错引用 | `rejected` + 异常记录 |
| 篡改回执 | 改字段不改签名 | `rejected`（`BAD_SIGNATURE`） |
| 替代后旧回执 | 建替代批次后投旧回执 | `stale`（`BATCH_SUPERSEDED`） |

## 目录

```
src/common/          配置、HTTP、数据库、CSV、字段校验、回执签名/验签、故障存储
src/services/exchange/   批次/尝试/回执判定/对账/撤销/替代
src/services/validation/ 校验任务与格式回执
src/services/ingestion/  幂等账本、入库回执、回滚
src/console/app.js       静态页面 + 代理 + 场景驱动
public/                  页面（无构建步骤）
fixtures/                虚构 CSV 与 manifest
test/                    集成测试 + 视图函数测试
scripts/start-all.js     四进程监督器
scripts/demo.js          端到端走查
```
