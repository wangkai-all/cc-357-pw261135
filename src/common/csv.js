/**
 * Minimal, strict CSV reader for the upload fixtures. Handles quoted fields,
 * escaped quotes, CRLF and a UTF-8 BOM. The last row may omit a trailing
 * newline; blank lines are rejected so a truncated file is noticed rather
 * than silently pad the record count.
 */
export function parseCsv(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let line = 1;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field !== '') {
        return { ok: false, code: 'FORMAT_PARSE_ERROR', message: `第 ${line} 行引号出现在字段中间`, line };
      }
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length === 1 && row[0].trim() === '') {
        return { ok: false, code: 'FORMAT_PARSE_ERROR', message: `第 ${line} 行为空行`, line };
      }
      rows.push({ line, cells: row });
      row = [];
      line += 1;
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    return { ok: false, code: 'FORMAT_PARSE_ERROR', message: `引号未闭合（第 ${line} 行）`, line };
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length === 1 && row[0].trim() === '') {
      return { ok: false, code: 'FORMAT_PARSE_ERROR', message: `第 ${line} 行为空行`, line };
    }
    rows.push({ line, cells: row });
  }
  return { ok: true, rows };
}
