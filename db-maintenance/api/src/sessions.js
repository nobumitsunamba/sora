import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';

// 接続セッション管理。
// 画面で入力された DB名/DBユーザー/パスワード はサーバ側に永続保存せず、
// セッション中の pg.Pool の接続にのみ使用する(ログにも出力しない)。
const sessions = new Map(); // sessionId -> { pool, database, dbUser, lastUsed }

export function createSession({ database, user, password }) {
  const pool = new pg.Pool({
    host: config.dbHost,
    port: config.dbPort,
    database,
    user,
    password,
    ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
    max: 4,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: config.queryTimeoutMs,
  });
  pool.on('error', () => {}); // アイドル接続切断でプロセスを落とさない
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { pool, database, dbUser: user, lastUsed: Date.now() });
  return sessionId;
}

export function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.lastUsed = Date.now();
  return s;
}

export async function destroySession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  await s.pool.end().catch(() => {});
}

// 無操作セッションの自動破棄
setInterval(() => {
  const ttl = config.sessionTtlMinutes * 60_000;
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > ttl) destroySession(id);
  }
}, 60_000).unref();

// pgの接続エラーを利用者向けの日本語メッセージへ変換する
export function connectErrorMessage(err) {
  const code = err && err.code;
  if (code === '28P01' || code === '28000') {
    return 'DBユーザー名またはパスワードが正しくありません。';
  }
  if (code === '3D000') {
    return '指定されたデータベースが存在しません。DB名を確認してください。';
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
    return 'データベースサーバーに到達できません。ネットワーク設定または環境変数(DB_HOST/DB_PORT)を確認してください。';
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(err?.message ?? '')) {
    return 'データベースサーバーへの接続がタイムアウトしました。サーバーの稼働状況を確認してください。';
  }
  return `データベースに接続できませんでした: ${err?.message ?? '不明なエラー'}`;
}
