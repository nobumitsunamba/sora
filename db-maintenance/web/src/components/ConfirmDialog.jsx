import React from 'react';

const ACTION_LABEL = { insert: '挿入', update: '更新', delete: '削除' };

// 実行前の確認画面(差分プレビュー + SQLプレビュー)。
// OKされた場合のみ onOk が呼ばれ、DBに反映される。
export default function ConfirmDialog({ action, preview, detail, busy, onOk, onCancel }) {
  const label = ACTION_LABEL[action] ?? action;
  const hasErrors = preview.errors && preview.errors.length > 0;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h2>{label}の確認</h2>
        <p className="confirm-count">
          対象件数: <strong>{preview.count}</strong> 件
          {hasErrors && (
            <span className="error-inline">(検証エラー {preview.errors.length} 件 — 実行できません)</span>
          )}
        </p>

        {hasErrors && (
          <div className="error-box">
            <div>以下のエラーを修正してください:</div>
            <ul>
              {preview.errors.map((e, i) => (
                <li key={i}>行{e.row}: {e.error}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="confirm-detail">{detail}</div>

        <details className="sql-preview">
          <summary>実行されるSQL(パラメータ化形式)を表示</summary>
          <div className="sql-list">
            {preview.statements.map((s, i) => (
              <div key={i} className="sql-item">
                <code>{s.sql}</code>
                <div className="sql-params">パラメータ: {JSON.stringify(s.params)}</div>
              </div>
            ))}
            {preview.statementsTruncated && <div className="sql-note">(先頭50件のみ表示)</div>}
          </div>
        </details>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>キャンセル</button>
          <button
            className={'btn ' + (action === 'delete' ? 'btn-danger' : 'btn-primary')}
            onClick={onOk}
            disabled={busy || hasErrors || preview.count === 0}
          >
            {busy ? '実行中…' : `${label}を実行 (${preview.count}件)`}
          </button>
        </div>
      </div>
    </div>
  );
}
