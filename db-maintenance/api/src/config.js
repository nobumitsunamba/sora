// 接続先ホスト・ポート・SSLは環境変数からのみ取得する(ハードコード禁止)。
// Container Apps ではシークレット / Key Vault 参照として設定する。
// 環境変数名は基盤の既存アプリの流儀に合わせて変更可能なよう、ここに集約している。

function envInt(name, def) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

function envBool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  port: envInt('PORT', 3000),

  // DB接続(ホスト・ポート・SSLのみ環境変数。DB名/ユーザー/パスワードは画面入力)
  dbHost: process.env.DB_HOST ?? '',
  dbPort: envInt('DB_PORT', 5432),
  dbSsl: envBool('DB_SSL', true),

  // 安全機構
  maxBatchRows: envInt('MAX_BATCH_ROWS', 1000), // 一括操作の行数上限
  queryTimeoutMs: envInt('QUERY_TIMEOUT_MS', 30000), // statement_timeout
  sessionTtlMinutes: envInt('SESSION_TTL_MINUTES', 60), // 無操作セッションの破棄

  // 操作者(Entra ID導入までの暫定。導入後はトークンのユーザー情報に差し替える)
  operatorName: process.env.OPERATOR_NAME ?? '',
};
