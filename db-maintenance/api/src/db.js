// メタデータ取得・識別子の安全な取り扱い・型検証・SQL組み立て。
// 値は必ずパラメータ化クエリ($1, $2, ...)で渡す。
// 識別子(スキーマ/テーブル/カラム名)はカタログに実在することを検証したうえで
// 二重引用符でクォートする。

export function quoteIdent(name) {
  return '"' + String(name).replaceAll('"', '""') + '"';
}

export async function listSchemas(pool) {
  const { rows } = await pool.query(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
       AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%'
     ORDER BY schema_name`
  );
  return rows.map((r) => r.schema_name);
}

export async function listTables(pool, schema) {
  const { rows } = await pool.query(
    `SELECT table_name, table_type FROM information_schema.tables
     WHERE table_schema = $1 ORDER BY table_name`,
    [schema]
  );
  return rows.map((r) => ({ name: r.table_name, type: r.table_type === 'VIEW' ? 'view' : 'table' }));
}

// テーブル構造(カラム名・型・PK・NOT NULL・デフォルト値)を取得。
// テーブルの実在確認を兼ねる(存在しなければ null を返す)。
export async function getTableMeta(pool, schema, table) {
  const colRes = await pool.query(
    `SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
            c.ordinal_position, c.character_maximum_length, c.is_identity, c.is_generated
     FROM information_schema.columns c
     WHERE c.table_schema = $1 AND c.table_name = $2
     ORDER BY c.ordinal_position`,
    [schema, table]
  );
  if (colRes.rows.length === 0) return null;

  const pkRes = await pool.query(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
     WHERE i.indisprimary AND n.nspname = $1 AND t.relname = $2
     ORDER BY array_position(i.indkey, a.attnum)`,
    [schema, table]
  );
  const pkColumns = pkRes.rows.map((r) => r.column_name);

  const columns = colRes.rows.map((r) => ({
    name: r.column_name,
    dataType: r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type,
    udtName: r.udt_name,
    notNull: r.is_nullable === 'NO',
    default: r.column_default,
    maxLength: r.character_maximum_length,
    isPk: pkColumns.includes(r.column_name),
    isIdentity: r.is_identity === 'YES',
    isGenerated: r.is_generated === 'ALWAYS',
  }));

  return { schema, table, columns, pkColumns, readOnly: pkColumns.length === 0 };
}

// ---- 型検証 --------------------------------------------------------------
// 貼り付け/入力値(文字列 or null)をカラム型に応じて検証し、DBへ渡す値に変換する。
// 戻り値: { ok: true, value } | { ok: false, error }
export function validateValue(raw, col) {
  if (raw === null || raw === undefined) {
    if (col.notNull && col.default === null && !col.isIdentity) {
      return { ok: false, error: `「${col.name}」はNOT NULL制約のためNULLにできません` };
    }
    return { ok: true, value: null };
  }
  const s = String(raw);
  const t = col.udtName ?? col.dataType;

  if (/^(int2|int4|int8|smallint|integer|bigint)$/.test(t)) {
    if (!/^[+-]?\d+$/.test(s.trim())) {
      return { ok: false, error: `「${col.name}」は整数で入力してください: 「${s}」` };
    }
    return { ok: true, value: s.trim() };
  }
  if (/^(numeric|decimal|float4|float8|real|double precision|money)$/.test(t)) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim())) {
      return { ok: false, error: `「${col.name}」は数値で入力してください: 「${s}」` };
    }
    return { ok: true, value: s.trim() };
  }
  if (/^bool(ean)?$/.test(t)) {
    const v = s.trim().toLowerCase();
    if (['true', 't', '1', 'yes', 'on'].includes(v)) return { ok: true, value: true };
    if (['false', 'f', '0', 'no', 'off'].includes(v)) return { ok: true, value: false };
    return { ok: false, error: `「${col.name}」は真偽値(true/false)で入力してください: 「${s}」` };
  }
  if (/^(date)$/.test(t)) {
    if (Number.isNaN(Date.parse(s.trim()))) {
      return { ok: false, error: `「${col.name}」は日付(例: 2026-01-31)で入力してください: 「${s}」` };
    }
    return { ok: true, value: s.trim() };
  }
  if (/^(timestamp|timestamptz)/.test(t)) {
    if (Number.isNaN(Date.parse(s.trim()))) {
      return { ok: false, error: `「${col.name}」は日時(例: 2026-01-31 12:00:00)で入力してください: 「${s}」` };
    }
    return { ok: true, value: s.trim() };
  }
  if (/^(json|jsonb)$/.test(t)) {
    try {
      JSON.parse(s);
    } catch {
      return { ok: false, error: `「${col.name}」は正しいJSONで入力してください` };
    }
    return { ok: true, value: s };
  }
  if (/^uuid$/.test(t)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())) {
      return { ok: false, error: `「${col.name}」はUUID形式で入力してください: 「${s}」` };
    }
    return { ok: true, value: s.trim() };
  }
  // 文字列・その他の型はそのまま渡す(最終的な整合性はDB側の制約で担保)
  if (col.maxLength != null && s.length > col.maxLength) {
    return { ok: false, error: `「${col.name}」は最大${col.maxLength}文字です(${s.length}文字が入力されました)` };
  }
  return { ok: true, value: s };
}

// ---- SELECT --------------------------------------------------------------
export function buildSelect({ schema, table, meta, limit, offset, sortCol, sortDir, filters, search }) {
  const params = [];
  const where = [];
  const colNames = meta.columns.map((c) => c.name);

  // ORDER BY が text 化した出力列名ではなく元のカラムを参照するよう、テーブル別名 t で修飾する
  for (const [col, value] of Object.entries(filters ?? {})) {
    if (!colNames.includes(col) || value === '') continue;
    params.push(`%${escapeLike(value)}%`);
    where.push(`CAST(t.${quoteIdent(col)} AS text) ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    const p = `$${params.length}`;
    where.push(
      '(' + colNames.map((c) => `CAST(t.${quoteIdent(c)} AS text) ILIKE ${p} ESCAPE '\\'`).join(' OR ') + ')'
    );
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  let orderSql = '';
  if (sortCol && colNames.includes(sortCol)) {
    orderSql = ` ORDER BY t.${quoteIdent(sortCol)} ${sortDir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  } else if (meta.pkColumns.length > 0) {
    orderSql = ` ORDER BY ${meta.pkColumns.map((c) => 't.' + quoteIdent(c)).join(', ')}`;
  }

  const from = `${quoteIdent(schema)}.${quoteIdent(table)} AS t`;
  const countSql = `SELECT count(*)::bigint AS total FROM ${from}${whereSql}`;
  const selectCols = colNames.map((c) => `CAST(t.${quoteIdent(c)} AS text) AS ${quoteIdent(c)}`).join(', ');
  const dataSql = `SELECT ${selectCols} FROM ${from}${whereSql}${orderSql} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
  return { countSql, dataSql, params };
}

function escapeLike(s) {
  return String(s).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

// ---- INSERT / UPDATE / DELETE -------------------------------------------
// rows: [{col: value|null}] 。検証エラーがあれば errors に行番号付きで返す。
export function buildInserts({ schema, table, meta, rows }) {
  const statements = [];
  const errors = [];
  const colByName = Object.fromEntries(meta.columns.map((c) => [c.name, c]));
  const from = `${quoteIdent(schema)}.${quoteIdent(table)}`;

  rows.forEach((row, i) => {
    const cols = Object.keys(row).filter((c) => colByName[c]);
    if (cols.length === 0) {
      errors.push({ row: i + 1, error: '有効なカラムがありません' });
      return;
    }
    const values = [];
    for (const c of cols) {
      const r = validateValue(row[c], colByName[c]);
      if (!r.ok) {
        errors.push({ row: i + 1, error: r.error });
        return;
      }
      values.push(r.value);
    }
    const placeholders = cols.map((_, j) => `$${j + 1}`).join(', ');
    statements.push({
      sql: `INSERT INTO ${from} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`,
      params: values,
    });
  });
  return { statements, errors };
}

// updates: [{ key: {pkCol: value}, changes: {col: value|null} }]
export function buildUpdates({ schema, table, meta, updates }) {
  const statements = [];
  const errors = [];
  const colByName = Object.fromEntries(meta.columns.map((c) => [c.name, c]));
  const from = `${quoteIdent(schema)}.${quoteIdent(table)}`;

  updates.forEach((u, i) => {
    const changeCols = Object.keys(u.changes ?? {}).filter((c) => colByName[c]);
    if (changeCols.length === 0) {
      errors.push({ row: i + 1, error: '変更対象のカラムがありません' });
      return;
    }
    const params = [];
    const sets = [];
    for (const c of changeCols) {
      const r = validateValue(u.changes[c], colByName[c]);
      if (!r.ok) {
        errors.push({ row: i + 1, error: r.error });
        return;
      }
      params.push(r.value);
      sets.push(`${quoteIdent(c)} = $${params.length}`);
    }
    const whereRes = buildPkWhere(meta, u.key, params);
    if (!whereRes.ok) {
      errors.push({ row: i + 1, error: whereRes.error });
      return;
    }
    statements.push({
      sql: `UPDATE ${from} SET ${sets.join(', ')} WHERE ${whereRes.where}`,
      params,
    });
  });
  return { statements, errors };
}

// keys: [{pkCol: value}]
export function buildDeletes({ schema, table, meta, keys }) {
  const statements = [];
  const errors = [];
  const from = `${quoteIdent(schema)}.${quoteIdent(table)}`;

  keys.forEach((key, i) => {
    const params = [];
    const whereRes = buildPkWhere(meta, key, params);
    if (!whereRes.ok) {
      errors.push({ row: i + 1, error: whereRes.error });
      return;
    }
    statements.push({ sql: `DELETE FROM ${from} WHERE ${whereRes.where}`, params });
  });
  return { statements, errors };
}

// 更新・削除のWHERE条件は必ず主キー全カラムで特定する
function buildPkWhere(meta, key, params) {
  if (meta.pkColumns.length === 0) {
    return { ok: false, error: '主キーが無いテーブルのため更新・削除できません' };
  }
  const conds = [];
  for (const pk of meta.pkColumns) {
    const v = key?.[pk];
    if (v === undefined || v === null) {
      return { ok: false, error: `主キー「${pk}」の値が指定されていません` };
    }
    params.push(String(v));
    conds.push(`${quoteIdent(pk)} = $${params.length}`);
  }
  return { ok: true, where: conds.join(' AND ') };
}

// 各文の影響行数が1件であることを保証しつつトランザクション内で実行。
// 一部失敗時は全体ロールバック。
export async function executeInTransaction(pool, statements, { expectOneRow = false } = {}) {
  const client = await pool.connect();
  let affected = 0;
  try {
    await client.query('BEGIN');
    for (const st of statements) {
      const res = await client.query(st.sql, st.params);
      if (expectOneRow && res.rowCount !== 1) {
        throw Object.assign(
          new Error(`対象行が特定できませんでした(影響行数: ${res.rowCount})。他のユーザーによって変更・削除された可能性があります。`),
          { code: 'ROW_MISMATCH' }
        );
      }
      affected += res.rowCount ?? 0;
    }
    await client.query('COMMIT');
    return affected;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 実行時のDBエラーを日本語メッセージへ変換
export function execErrorMessage(err) {
  const code = err?.code;
  const detail = err?.detail ? `(${err.detail})` : '';
  switch (code) {
    case '23505':
      return `一意制約(重複)エラーです${detail}。既に同じキーの行が存在します。`;
    case '23503':
      return `外部キー制約エラーです${detail}。参照先/参照元のデータを確認してください。`;
    case '23502':
      return `NOT NULL制約エラーです${detail}。必須カラムに値を設定してください。`;
    case '23514':
      return `チェック制約エラーです${detail}。値の条件を確認してください。`;
    case '22P02':
    case '22007':
    case '22008':
      return `値の形式がカラムの型と一致しません${detail ? detail : `(${err.message})`}。`;
    case '42501':
      return '権限がありません。DBユーザーに対象テーブルへの権限が付与されているか確認してください。';
    case '57014':
      return 'クエリがタイムアウトしました。件数を絞って再実行してください。';
    case 'ROW_MISMATCH':
      return err.message;
    default:
      return `データベースエラー: ${err?.message ?? '不明なエラー'}`;
  }
}
