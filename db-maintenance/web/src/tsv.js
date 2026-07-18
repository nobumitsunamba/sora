// TSV/CSV のパースとシリアライズ。
// TSV: Excelのコピー形式(タブ区切り・行は改行区切り)を想定。
// CSV: RFC4180風(ダブルクォート対応)。

export function parseTsv(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  // 末尾の空行(コピー時に付く)を除去
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => line.split('\t'));
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

// グリッドの選択範囲をTSV文字列へ(Excelへそのまま貼り付け可能)
export function toTsv(rows2d) {
  return rows2d
    .map((row) =>
      row
        .map((v) => (v === null || v === undefined ? '' : String(v).replaceAll('\t', ' ').replaceAll('\n', ' ')))
        .join('\t')
    )
    .join('\r\n');
}
