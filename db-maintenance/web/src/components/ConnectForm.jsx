import React, { useState } from 'react';
import { api } from '../api.js';

// 接続画面: DB名・DBユーザー・パスワードのみ入力する。
// ホスト・ポート・SSLはサーバ側の環境変数で設定済み。
export default function ConnectForm({ onConnected }) {
  const [database, setDatabase] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const info = await api.connect(database.trim(), user.trim(), password);
      onConnected(info);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect-page">
      <form className="connect-card" onSubmit={submit}>
        <h1>DBメンテナンス</h1>
        <p className="connect-desc">
          対象アプリ専用のDBユーザーで接続してください。<br />
          入力した資格情報はサーバーに保存されません。
        </p>
        <label>
          DB名
          <input
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            autoFocus
            required
            placeholder="例: myapp_db"
          />
        </label>
        <label>
          DBユーザー
          <input value={user} onChange={(e) => setUser(e.target.value)} required placeholder="例: myapp_user" />
        </label>
        <label>
          パスワード
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="error-box">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? '接続中…' : '接続'}
        </button>
      </form>
    </div>
  );
}
