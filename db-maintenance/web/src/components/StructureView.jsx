import React from 'react';

// テーブル構造表示(カラム名・型・PK・NOT NULL・デフォルト値)
export default function StructureView({ meta, onClose }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>テーブル構造: {meta.schema}.{meta.table}</h2>
        {meta.readOnly && (
          <div className="warn-box">主キーが無いため、このテーブルは読み取り専用です。</div>
        )}
        <div className="structure-table-wrap">
          <table className="structure-table">
            <thead>
              <tr>
                <th>カラム名</th>
                <th>型</th>
                <th>PK</th>
                <th>NOT NULL</th>
                <th>デフォルト値</th>
              </tr>
            </thead>
            <tbody>
              {meta.columns.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>
                    {c.dataType}
                    {c.maxLength != null ? `(${c.maxLength})` : ''}
                    {c.isIdentity ? '(IDENTITY)' : ''}
                    {c.isGenerated ? '(生成列)' : ''}
                  </td>
                  <td>{c.isPk ? '✔' : ''}</td>
                  <td>{c.notNull ? '✔' : ''}</td>
                  <td>{c.default ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
