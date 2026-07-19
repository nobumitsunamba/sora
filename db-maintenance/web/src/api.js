// APIクライアント。セッションIDをヘッダーで送る。
let sessionId = null;

export function setSessionId(id) {
  sessionId = id;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (sessionId) headers['X-Session-Id'] = sessionId;
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('サーバーに接続できません。ネットワークを確認してください。', 0, null);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 空レスポンス */
  }
  if (!res.ok) {
    throw new ApiError(body?.error ?? `サーバーエラー (HTTP ${res.status})`, res.status, body);
  }
  return body;
}

export const api = {
  connect: (database, user, password) =>
    request('/api/connect', { method: 'POST', body: { database, user, password } }),
  disconnect: () => request('/api/disconnect', { method: 'POST' }),
  schemas: () => request('/api/schemas'),
  tables: (schema) => request(`/api/tables?schema=${encodeURIComponent(schema)}`),
  tableMeta: (schema, table) =>
    request(`/api/table-meta?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`),
  rows: (params) => request(`/api/rows?${new URLSearchParams(params)}`),
  insert: (body) => request('/api/insert', { method: 'POST', body }),
  update: (body) => request('/api/update', { method: 'POST', body }),
  delete: (body) => request('/api/delete', { method: 'POST', body }),
  exportUrl: null, // エクスポートは fetch + blob ダウンロード(下記)で行う
  async exportFile(params) {
    const res = await fetch(`/api/export?${new URLSearchParams(params)}`, {
      headers: sessionId ? { 'X-Session-Id': sessionId } : {},
    });
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      throw new ApiError(body?.error ?? 'エクスポートに失敗しました。', res.status, body);
    }
    return res.blob();
  },
};
