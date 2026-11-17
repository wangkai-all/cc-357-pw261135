import { ALLOWED_CURRENCIES, BLOCKED_ACCOUNT_PREFIX, MAX_AMOUNT, MAX_RECORDS, REQUIRED_COLUMNS } from './config.js';
import { parseCsv } from './csv.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DECIMAL = /^\d+(?:\.\d{1,2})?$/;

function pushError(errors, entry) {
  if (errors.length < 200) errors.push(entry);
}

/**
 * Full format + field ruleset. Used by the validation service and re-run in a
 * slimmer form by ingestion so a trusted-looking upstream cannot smuggle an
 * invalid record into the ledger.
 */
export function validateCsvPayload(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return {
      outcome: 'failed',
      errorCount: 1,
      errors: [{ line: 0, field: 'file', code: 'NOT_UTF8', message: '文件不是合法的 UTF-8 文本' }],
      records: [],
      summary: '无法解码文件内容',
    };
  }
  if (text.trim().length === 0) {
    return {
      outcome: 'failed',
      errorCount: 1,
      errors: [{ line: 0, field: 'file', code: 'EMPTY_FILE', message: '文件为空' }],
      records: [],
      summary: '文件为空',
    };
  }
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    return {
      outcome: 'failed',
      errorCount: 1,
      errors: [{ line: parsed.line ?? 0, field: 'file', code: parsed.code, message: parsed.message }],
      records: [],
      summary: parsed.message,
    };
  }
  const { rows } = parsed;
  const errors = [];

  if (rows.length === 0) {
    return {
      outcome: 'failed',
      errorCount: 1,
      errors: [{ line: 0, field: 'file', code: 'NO_HEADER', message: '文件没有表头' }],
      records: [],
      summary: '文件没有表头',
    };
  }
  const header = rows[0].cells.map((cell) => cell.trim());
  const missing = REQUIRED_COLUMNS.filter((col) => !header.includes(col));
  if (missing.length > 0 || header.length !== REQUIRED_COLUMNS.length || header.some((c, i) => c !== REQUIRED_COLUMNS[i])) {
    return {
      outcome: 'failed',
      errorCount: 1,
      errors: [
        {
          line: rows[0].line,
          field: 'header',
          code: 'INVALID_HEADER',
          message: `表头必须依次为 ${REQUIRED_COLUMNS.join(',')}，收到 ${header.join(',')}`,
        },
      ],
      records: [],
      summary: '表头不符合约定',
    };
  }
  const columnIndex = Object.fromEntries(header.map((name, index) => [name, index]));
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    pushError(errors, { line: rows[0].line, field: 'file', code: 'NO_RECORDS', message: '文件只有表头，没有数据行' });
  }
  if (dataRows.length > MAX_RECORDS) {
    pushError(errors, {
      line: 0,
      field: 'file',
      code: 'TOO_MANY_RECORDS',
      message: `记录数 ${dataRows.length} 超出上限 ${MAX_RECORDS}`,
    });
  }

  const seen = new Map();
  const records = [];
  for (const row of dataRows) {
    if (row.cells.length !== header.length) {
      pushError(errors, {
        line: row.line,
        field: 'row',
        code: 'COLUMN_COUNT',
        message: `列数 ${row.cells.length} 与表头 ${header.length} 不一致`,
      });
      continue;
    }
    const raw = Object.fromEntries(header.map((name, index) => [name, row.cells[index].trim()]));
    const record = {
      recordId: raw.record_id,
      accountNo: raw.account_no,
      amount: raw.amount,
      currency: raw.currency,
      occurredAt: raw.occurred_at,
      line: row.line,
    };
    let ok = true;
    if (!record.recordId) {
      pushError(errors, { line: row.line, field: 'record_id', code: 'REQUIRED', message: 'record_id 不能为空' });
      ok = false;
    } else if (seen.has(record.recordId)) {
      pushError(errors, {
        line: row.line,
        field: 'record_id',
        code: 'DUPLICATE_IN_FILE',
        message: `record_id ${record.recordId} 与第 ${seen.get(record.recordId)} 行重复`,
      });
      ok = false;
    } else {
      seen.set(record.recordId, row.line);
    }
    if (!record.accountNo) {
      pushError(errors, { line: row.line, field: 'account_no', code: 'REQUIRED', message: 'account_no 不能为空' });
      ok = false;
    } else if (record.accountNo.startsWith(BLOCKED_ACCOUNT_PREFIX)) {
      pushError(errors, {
        line: row.line,
        field: 'account_no',
        code: 'ACCOUNT_BLOCKED',
        message: `账户 ${record.accountNo} 在业务黑名单中，拒绝入账`,
      });
      ok = false;
    }
    if (!DECIMAL.test(record.amount)) {
      pushError(errors, {
        line: row.line,
        field: 'amount',
        code: 'INVALID_AMOUNT',
        message: `amount 必须是正数且最多两位小数，收到 "${record.amount}"`,
      });
      ok = false;
    } else if (Number(record.amount) <= 0 || Number(record.amount) > MAX_AMOUNT) {
      pushError(errors, {
        line: row.line,
        field: 'amount',
        code: 'AMOUNT_OUT_OF_RANGE',
        message: `amount 必须大于 0 且不超过 ${MAX_AMOUNT}，收到 ${record.amount}`,
      });
      ok = false;
    }
    if (!ALLOWED_CURRENCIES.includes(record.currency)) {
      pushError(errors, {
        line: row.line,
        field: 'currency',
        code: 'INVALID_CURRENCY',
        message: `currency 必须是 ${ALLOWED_CURRENCIES.join('/')} 之一，收到 "${record.currency}"`,
      });
      ok = false;
    }
    if (!ISO_DATE.test(record.occurredAt) || Number.isNaN(Date.parse(record.occurredAt))) {
      pushError(errors, {
        line: row.line,
        field: 'occurred_at',
        code: 'INVALID_TIMESTAMP',
        message: `occurred_at 必须是 ISO 时间，收到 "${record.occurredAt}"`,
      });
      ok = false;
    }
    if (ok) {
      records.push({ ...record, amount: Number(record.amount), currency: record.currency });
    }
  }

  const errorCount = errors.length;
  const outcome = errorCount === 0 ? 'passed' : 'failed';
  const summary =
    outcome === 'passed'
      ? `${records.length} 条记录通过格式与字段校验`
      : `发现 ${errorCount} 处格式/字段问题${records.length ? `，${records.length} 条记录可继续` : ''}`;
  return { outcome, errorCount, errors, records, summary, header, totalRows: dataRows.length };
}
