// 操作監査ログ。
// 本アプリはログ記録用DBを持たない方針のため、構造化JSON(1操作=1行)を標準出力へ出力し、
// Container Apps の標準ログ収集(Log Analytics: ContainerAppConsoleLogs_CL)で検索する。
// 例: ContainerAppConsoleLogs_CL | where Log_s has '"logType":"audit"'
// 資格情報(パスワード)は絶対に出力しないこと。
export function auditLog({ operator, database, dbUser, schema, table, action, rowCount, sessionId }) {
  const entry = {
    logType: 'audit',
    timestamp: new Date().toISOString(),
    operator,
    database,
    dbUser,
    schema,
    table,
    action, // 'insert' | 'update' | 'delete'
    rowCount,
    sessionId,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}
