import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { auditLog } from './audit.js';
import { createSession, getSession, destroySession, connectErrorMessage } from './sessions.js';
import {
  listSchemas, listTables, getTableMeta, buildSelect,
  buildInserts, buildUpdates, buildDeletes,
  executeInTransaction, execErrorMessage,
} from './db.js';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(authMiddleware);

// ヘルスチェック(基盤のヘルスゲートが /api/health をポーリングする)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---- 接続管理 ------------------------------------------------------------
app.post('/api/connect', async (req, res) => {
  const { database, user, password } = req.body ?? {};
  if (!database || !user || !password) {
    return res.status(400).json({ error: 'DB名・DBユーザー・パスワードをすべて入力してください。' });
  }
  if (!config.dbHost) {
    return res.status(500).json({ error: 'サーバーの環境変数 DB_HOST が設定されていません。管理者に連絡してください。' });
  }
  const sessionId = createSession({ database, user, password });
  try {
    const session = getSession(sessionId);
    await session.pool.query('SELECT 1');
    res.json({ sessionId, database, user });
  } catch (err) {
    await destroySession(sessionId);
    res.status(400).json({ error: connectErrorMessage(err) });
  }
});

// 以降のAPIはセッション必須
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/connect') return next();
  const sessionId = req.get('x-session-id');
  const session = sessionId && getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'セッションが無効です。再度接続してください。', code: 'NO_SESSION' });
  }
  req.dbSession = session;
  req.sessionId = sessionId;
  next();
});

app.post('/api/disconnect', async (req, res) => {
  await destroySession(req.sessionId);
  res.json({ ok: true });
});

// ---- メタデータ ----------------------------------------------------------
app.get('/api/schemas', wrap(async (req, res) => {
  res.json({ schemas: await listSchemas(req.dbSession.pool) });
}));

app.get('/api/tables', wrap(async (req, res) => {
  const schema = String(req.query.schema ?? '');
  if (!schema) return res.status(400).json({ error: 'スキーマ名を指定してください。' });
  res.json({ tables: await listTables(req.dbSession.pool, schema) });
}));

app.get('/api/table-meta', wrap(async (req, res) => {
  const meta = await requireMeta(req, res);
  if (!meta) return;
  res.json(meta);
}));

// ---- データ参照 ----------------------------------------------------------
app.get('/api/rows', wrap(async (req, res) => {
  const meta = await requireMeta(req, res);
  if (!meta) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const filters = parseJson(req.query.filters) ?? {};
  const { countSql, dataSql, params } = buildSelect({
    schema: meta.schema, table: meta.table, meta,
    limit, offset,
    sortCol: req.query.sortCol, sortDir: req.query.sortDir,
    filters, search: req.query.search,
  });
  const pool = req.dbSession.pool;
  const [countRes, dataRes] = await Promise.all([
    pool.query(countSql, params),
    pool.query(dataSql, params),
  ]);
  res.json({
    total: Number(countRes.rows[0].total),
    rows: dataRes.rows,
    readOnly: meta.readOnly,
    pkColumns: meta.pkColumns,
  });
}));

// ---- エクスポート(CSV/TSV) ---------------------------------------------
app.get('/api/export', wrap(async (req, res) => {
  const meta = await requireMeta(req, res);
  if (!meta) return;
  const format = req.query.format === 'csv' ? 'csv' : 'tsv';
  const all = req.query.scope === 'all';
  const limit = all ? 1000000 : Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = all ? 0 : Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const filters = parseJson(req.query.filters) ?? {};
  const { dataSql, params } = buildSelect({
    schema: meta.schema, table: meta.table, meta,
    limit, offset,
    sortCol: req.query.sortCol, sortDir: req.query.sortDir,
    filters, search: req.query.search,
  });
  const { rows } = await req.dbSession.pool.query(dataSql, params);
  const cols = meta.columns.map((c) => c.name);
  const sep = format === 'csv' ? ',' : '\t';
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (format === 'csv') {
      return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
    }
    return s.replaceAll('\t', ' ').replaceAll('\n', ' ').replaceAll('\r', '');
  };
  const lines = [cols.join(sep), ...rows.map((r) => cols.map((c) => esc(r[c])).join(sep))];
  const body = lines.join('\r\n') + '\r\n';
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'text/tab-separated-values; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(`${meta.table}.${format}`)}`
  );
  // ExcelでのUTF-8認識のためBOMを付与
  res.send('\uFEFF' + body);
}));

// ---- 更新系(挿入/更新/削除) --------------------------------------------
// preview=true の場合は実行せず、検証結果とSQLプレビュー(パラメータ化形式)を返す。
// preview=false は確認画面でOKされた後の実行。トランザクション内で実行し一部失敗は全体ロールバック。
app.post('/api/insert', wrap(async (req, res) => {
  await mutate(req, res, {
    action: 'insert',
    build: (meta) => {
      const rows = req.body.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        return { badRequest: '挿入する行がありません。' };
      }
      if (rows.length > config.maxBatchRows) {
        return { badRequest: `一括操作の上限は${config.maxBatchRows}行です(${rows.length}行が指定されました)。` };
      }
      return buildInserts({ schema: meta.schema, table: meta.table, meta, rows });
    },
    expectOneRow: false,
  });
}));

app.post('/api/update', wrap(async (req, res) => {
  await mutate(req, res, {
    action: 'update',
    requirePk: true,
    build: (meta) => {
      const updates = req.body.updates;
      if (!Array.isArray(updates) || updates.length === 0) {
        return { badRequest: '更新する内容がありません。' };
      }
      if (updates.length > config.maxBatchRows) {
        return { badRequest: `一括操作の上限は${config.maxBatchRows}行です(${updates.length}行が指定されました)。` };
      }
      return buildUpdates({ schema: meta.schema, table: meta.table, meta, updates });
    },
    expectOneRow: true,
  });
}));

app.post('/api/delete', wrap(async (req, res) => {
  await mutate(req, res, {
    action: 'delete',
    requirePk: true,
    build: (meta) => {
      const keys = req.body.keys;
      if (!Array.isArray(keys) || keys.length === 0) {
        return { badRequest: '削除する行がありません。' };
      }
      if (keys.length > config.maxBatchRows) {
        return { badRequest: `一括操作の上限は${config.maxBatchRows}行です(${keys.length}行が指定されました)。` };
      }
      return buildDeletes({ schema: meta.schema, table: meta.table, meta, keys });
    },
    expectOneRow: true,
  });
}));

async function mutate(req, res, { action, build, requirePk, expectOneRow }) {
  const meta = await requireMeta(req, res, { fromBody: true });
  if (!meta) return;
  if (requirePk && meta.readOnly) {
    return res.status(400).json({ error: '主キーが無いテーブルのため、このテーブルは読み取り専用です。' });
  }
  const built = build(meta);
  if (built.badRequest) return res.status(400).json({ error: built.badRequest });
  const { statements, errors } = built;

  if (req.body.preview) {
    return res.json({
      preview: true,
      valid: errors.length === 0,
      errors,
      count: statements.length,
      statements: statements.slice(0, 50).map((s) => ({ sql: s.sql, params: s.params })),
      statementsTruncated: statements.length > 50,
    });
  }
  if (errors.length > 0) {
    return res.status(400).json({ error: '検証エラーがあるため実行できません。', errors });
  }
  try {
    const affected = await executeInTransaction(req.dbSession.pool, statements, { expectOneRow });
    auditLog({
      operator: req.operator,
      database: req.dbSession.database,
      dbUser: req.dbSession.dbUser,
      schema: meta.schema,
      table: meta.table,
      action,
      rowCount: affected,
      sessionId: req.sessionId,
    });
    res.json({ ok: true, affected });
  } catch (err) {
    res.status(400).json({ error: `実行に失敗したため、すべての変更をロールバックしました。${execErrorMessage(err)}` });
  }
}

// ---- 共通ヘルパー --------------------------------------------------------
async function requireMeta(req, res, { fromBody = false } = {}) {
  const src = fromBody ? (req.body ?? {}) : req.query;
  const schema = String(src.schema ?? '');
  const table = String(src.table ?? '');
  if (!schema || !table) {
    res.status(400).json({ error: 'スキーマ名とテーブル名を指定してください。' });
    return null;
  }
  const meta = await getTableMeta(req.dbSession.pool, schema, table);
  if (!meta) {
    res.status(404).json({ error: `テーブル ${schema}.${table} が見つかりません。` });
    return null;
  }
  return meta;
}

function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function wrap(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      console.error(JSON.stringify({ logType: 'error', timestamp: new Date().toISOString(), message: err.message }));
      if (!res.headersSent) {
        res.status(500).json({ error: execErrorMessage(err) });
      }
    });
  };
}

// ---- フロントエンド静的配信(本番: web/dist を同梱する構成にも対応) ------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../public');
app.use(express.static(webDist));
app.get(/^\/(?!api\/).*/, (_req, res, next) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => err && next());
});

app.listen(config.port, () => {
  console.log(JSON.stringify({ logType: 'app', timestamp: new Date().toISOString(), message: `db-maintenance api listening on port ${config.port}` }));
});
