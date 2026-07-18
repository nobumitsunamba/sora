import React, { useState, useCallback } from 'react';
import { api, setSessionId } from './api.js';
import ConnectForm from './components/ConnectForm.jsx';
import Sidebar from './components/Sidebar.jsx';
import GridView from './components/GridView.jsx';

export default function App() {
  const [conn, setConn] = useState(null); // { database, user }
  const [selected, setSelected] = useState(null); // { schema, table }

  const handleConnected = useCallback((info) => {
    setSessionId(info.sessionId);
    setConn({ database: info.database, user: info.user });
  }, []);

  const handleDisconnect = useCallback(async () => {
    try {
      await api.disconnect();
    } catch {
      /* 切断エラーは無視 */
    }
    setSessionId(null);
    setConn(null);
    setSelected(null);
  }, []);

  // セッション切れ(401)時は接続画面へ戻す
  const handleSessionLost = useCallback(() => {
    setSessionId(null);
    setConn(null);
    setSelected(null);
  }, []);

  if (!conn) {
    return <ConnectForm onConnected={handleConnected} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">DBメンテナンス</span>
        <span className="conn-info" title="接続中のデータベース">
          🗄 DB: <strong>{conn.database}</strong>(ユーザー: {conn.user})
        </span>
        {selected && (
          <span className="conn-info table-info" title="表示中のテーブル">
            📋 テーブル: <strong>{selected.schema}.{selected.table}</strong>
          </span>
        )}
        <span className="spacer" />
        <button className="btn" onClick={handleDisconnect}>切断</button>
      </header>
      <div className="app-body">
        <Sidebar selected={selected} onSelect={setSelected} onSessionLost={handleSessionLost} />
        <main className="main-area">
          {selected ? (
            <GridView
              key={`${selected.schema}.${selected.table}`}
              schema={selected.schema}
              table={selected.table}
              onSessionLost={handleSessionLost}
            />
          ) : (
            <div className="placeholder">左のリストからテーブルを選択してください</div>
          )}
        </main>
      </div>
    </div>
  );
}
