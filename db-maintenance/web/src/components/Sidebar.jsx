import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// スキーマ一覧 → テーブル一覧のナビゲーション
export default function Sidebar({ selected, onSelect, onSessionLost }) {
  const [schemas, setSchemas] = useState([]);
  const [openSchema, setOpenSchema] = useState(null);
  const [tables, setTables] = useState({}); // schema -> [{name,type}]
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .schemas()
      .then((r) => {
        setSchemas(r.schemas);
        // publicスキーマがあれば自動で開く
        if (r.schemas.includes('public')) openTables('public');
      })
      .catch((err) => handleError(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleError = (err) => {
    if (err.status === 401) onSessionLost();
    else setError(err.message);
  };

  const openTables = async (schema) => {
    setOpenSchema((cur) => (cur === schema ? null : schema));
    if (!tables[schema]) {
      try {
        const r = await api.tables(schema);
        setTables((t) => ({ ...t, [schema]: r.tables }));
      } catch (err) {
        handleError(err);
      }
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-title">スキーマ / テーブル</div>
      {error && <div className="error-box">{error}</div>}
      <ul className="schema-list">
        {schemas.map((s) => (
          <li key={s}>
            <button className="schema-item" onClick={() => openTables(s)}>
              {openSchema === s ? '▼' : '▶'} {s}
            </button>
            {openSchema === s && (
              <ul className="table-list">
                {(tables[s] ?? []).map((t) => (
                  <li key={t.name}>
                    <button
                      className={
                        'table-item' +
                        (selected && selected.schema === s && selected.table === t.name ? ' active' : '')
                      }
                      onClick={() => onSelect({ schema: s, table: t.name })}
                      title={t.type === 'view' ? 'ビュー(読み取り専用)' : 'テーブル'}
                    >
                      {t.type === 'view' ? '👁' : '📋'} {t.name}
                    </button>
                  </li>
                ))}
                {tables[s] && tables[s].length === 0 && <li className="empty-note">(テーブルなし)</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
