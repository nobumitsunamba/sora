import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { parseTsv, parseCsv, toTsv } from '../tsv.js';
import ConfirmDialog from './ConfirmDialog.jsx';
import StructureView from './StructureView.jsx';

const PAGE_SIZES = [50, 100, 500];

export default function GridView({ schema, table, onSessionLost }) {
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [sortCol, setSortCol] = useState('');
  const [sortDir, setSortDir] = useState('asc');
  const [filters, setFilters] = useState({});
  const [filterDraft, setFilterDraft] = useState({});
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // 選択状態
  const [sel, setSel] = useState(null); // {anchor:{r,c}, focus:{r,c}}
  const [selectedRows, setSelectedRows] = useState(new Set());
  const lastCheckedRef = useRef(null);
  const draggingRef = useRef(false);

  // 編集状態
  const [pendingEdits, setPendingEdits] = useState({}); // {rowIdx: {col: value|null}}
  const [newRows, setNewRows] = useState([]); // [{col: string}]
  const [editing, setEditing] = useState(null); // {r, c, value}

  // ダイアログ
  const [confirm, setConfirm] = useState(null); // {action, preview, payload, detail}
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [structureOpen, setStructureOpen] = useState(false);

  const gridRef = useRef(null);
  const fileRef = useRef(null);

  const cols = meta ? meta.columns.map((c) => c.name) : [];
  const editCount = Object.values(pendingEdits).reduce((n, m) => n + Object.keys(m).length, 0);
  const dirty = editCount > 0 || newRows.length > 0;

  const handleError = useCallback(
    (err) => {
      if (err.status === 401) onSessionLost();
      else setError(err.message);
    },
    [onSessionLost]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const m = await api.tableMeta(schema, table);
      const params = {
        schema,
        table,
        limit: pageSize,
        offset: page * pageSize,
        sortCol,
        sortDir,
        filters: JSON.stringify(filters),
        search,
      };
      const r = await api.rows(params);
      setMeta(m);
      setRows(r.rows);
      setTotal(r.total);
      setSel(null);
      setSelectedRows(new Set());
      setPendingEdits({});
      setEditing(null);
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [schema, table, page, pageSize, sortCol, sortDir, filters, search, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const confirmDiscard = () => {
    if (!dirty) return true;
    return window.confirm('未確定の変更があります。破棄して続行しますか?');
  };

  const guarded = (fn) => (...args) => {
    if (!confirmDiscard()) return;
    setNewRows([]);
    fn(...args);
  };

  // ---- 表示値 ----
  const cellValue = (r, col) => {
    const e = pendingEdits[r];
    if (e && col in e) return e[col];
    return rows[r]?.[col] ?? null;
  };

  const isEdited = (r, col) => pendingEdits[r] && col in pendingEdits[r];

  // ---- 選択 ----
  const normSel = useMemo(() => {
    if (!sel) return null;
    return {
      r0: Math.min(sel.anchor.r, sel.focus.r),
      r1: Math.max(sel.anchor.r, sel.focus.r),
      c0: Math.min(sel.anchor.c, sel.focus.c),
      c1: Math.max(sel.anchor.c, sel.focus.c),
    };
  }, [sel]);

  const inSel = (r, c) =>
    normSel && r >= normSel.r0 && r <= normSel.r1 && c >= normSel.c0 && c <= normSel.c1;

  const onCellMouseDown = (r, c, e) => {
    if (e.button !== 0) return;
    if (editing) commitEdit();
    if (e.shiftKey && sel) {
      setSel({ anchor: sel.anchor, focus: { r, c } });
    } else {
      setSel({ anchor: { r, c }, focus: { r, c } });
      draggingRef.current = true;
    }
    gridRef.current?.focus();
    e.preventDefault();
  };

  const onCellMouseEnter = (r, c) => {
    if (draggingRef.current) {
      setSel((s) => (s ? { anchor: s.anchor, focus: { r, c } } : s));
    }
  };

  useEffect(() => {
    const up = () => (draggingRef.current = false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const toggleRow = (r, e) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastCheckedRef.current !== null) {
        const [a, b] = [Math.min(lastCheckedRef.current, r), Math.max(lastCheckedRef.current, r)];
        for (let i = a; i <= b; i++) next.add(i);
      } else if (next.has(r)) {
        next.delete(r);
      } else {
        next.add(r);
      }
      lastCheckedRef.current = r;
      return next;
    });
  };

  const toggleAllRows = () => {
    setSelectedRows((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((_, i) => i))));
  };

  // ---- コピー(選択範囲 → TSV) ----
  const onCopy = (e) => {
    if (editing || isFormElement(document.activeElement)) return;
    let block = null;
    if (normSel) {
      block = [];
      for (let r = normSel.r0; r <= normSel.r1; r++) {
        const row = [];
        for (let c = normSel.c0; c <= normSel.c1; c++) row.push(cellValue(r, cols[c]));
        block.push(row);
      }
    } else if (selectedRows.size > 0) {
      block = [...selectedRows].sort((a, b) => a - b).map((r) => cols.map((col) => cellValue(r, col)));
    }
    if (block) {
      e.clipboardData.setData('text/plain', toTsv(block));
      e.preventDefault();
      setNotice(`${block.length}行 × ${block[0].length}列をコピーしました`);
    }
  };

  // ---- 貼り付け(TSV → 選択範囲の一括更新) ----
  const onPaste = (e) => {
    if (editing || isFormElement(document.activeElement)) return;
    if (!normSel || !meta || meta.readOnly) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const data = parseTsv(text);
    if (data.length === 0) return;

    const startR = normSel.r0;
    const startC = normSel.c0;
    // 選択が1セルなら貼り付けデータの大きさ分、複数セルなら選択範囲に限定
    const singleCell = normSel.r0 === normSel.r1 && normSel.c0 === normSel.c1;
    const endR = singleCell ? startR + data.length - 1 : normSel.r1;
    const endC = singleCell ? startC + (data[0]?.length ?? 1) - 1 : normSel.c1;

    if (endR >= rows.length || endC >= cols.length) {
      if (
        !window.confirm(
          '貼り付けデータが表の範囲を超えています。範囲内のセルのみ更新して続行しますか?\n(新規行として挿入する場合は、下部の「新規行の追加」領域に貼り付けてください)'
        )
      ) {
        return;
      }
    }

    setPendingEdits((prev) => {
      const next = { ...prev };
      let applied = 0;
      for (let r = startR; r <= Math.min(endR, rows.length - 1); r++) {
        for (let c = startC; c <= Math.min(endC, cols.length - 1); c++) {
          const v = data[(r - startR) % data.length]?.[(c - startC) % data[0].length];
          if (v === undefined) continue;
          const col = cols[c];
          const newVal = v === '' ? null : v;
          if ((rows[r]?.[col] ?? null) === newVal) {
            if (next[r]) delete next[r][col];
            continue;
          }
          next[r] = { ...(next[r] ?? {}), [col]: newVal };
          applied++;
        }
      }
      setNotice(`${applied}セルに貼り付けました(「変更を確定」で反映されます)`);
      return next;
    });
    setSel({ anchor: { r: startR, c: startC }, focus: { r: Math.min(endR, rows.length - 1), c: Math.min(endC, cols.length - 1) } });
  };

  // ---- インライン編集 ----
  const startEdit = (r, c) => {
    if (!meta || meta.readOnly) return;
    const v = cellValue(r, cols[c]);
    setEditing({ r, c, value: v ?? '' });
  };

  const commitEdit = () => {
    if (!editing) return;
    const { r, c, value } = editing;
    const col = cols[c];
    const newVal = value === '' ? null : value;
    setPendingEdits((prev) => {
      const next = { ...prev };
      if ((rows[r]?.[col] ?? null) === newVal) {
        if (next[r]) {
          delete next[r][col];
          if (Object.keys(next[r]).length === 0) delete next[r];
        }
      } else {
        next[r] = { ...(next[r] ?? {}), [col]: newVal };
      }
      return next;
    });
    setEditing(null);
  };

  // ---- 新規行(挿入)領域 ----
  const addNewRow = () => setNewRows((n) => [...n, {}]);

  const setNewCell = (ir, col, value) => {
    setNewRows((n) => n.map((row, i) => (i === ir ? { ...row, [col]: value } : row)));
  };

  const removeNewRow = (ir) => setNewRows((n) => n.filter((_, i) => i !== ir));

  // 新規行領域へのTSV複数行貼り付け
  const onNewCellPaste = (ir, ci, e) => {
    const text = e.clipboardData.getData('text/plain');
    const data = parseTsv(text);
    if (data.length <= 1 && (data[0]?.length ?? 0) <= 1) return; // 単一セルは通常貼り付け
    e.preventDefault();
    const pasteCols = Math.max(...data.map((r) => r.length));
    if (ci + pasteCols > cols.length) {
      if (
        !window.confirm(
          `貼り付けデータの列数(${pasteCols})が貼り付け位置からの残り列数(${cols.length - ci})を超えています。\n超過分の列は無視して続行しますか?`
        )
      ) {
        return;
      }
    }
    setNewRows((prev) => {
      const next = prev.map((r) => ({ ...r }));
      data.forEach((dRow, di) => {
        const target = ir + di;
        while (next.length <= target) next.push({});
        dRow.forEach((v, dc) => {
          const c = ci + dc;
          if (c < cols.length) next[target][cols[c]] = v;
        });
      });
      return next;
    });
    setNotice(`${data.length}行を新規行領域に貼り付けました(「挿入を確定」で反映されます)`);
  };

  // ---- 確認 → 実行フロー ----
  const openConfirm = async (action, payload, detail) => {
    setError('');
    try {
      const preview = await callMutation(action, { ...payload, preview: true });
      setConfirm({ action, payload, preview, detail });
    } catch (err) {
      handleError(err);
    }
  };

  const callMutation = (action, body) => {
    if (action === 'insert') return api.insert(body);
    if (action === 'update') return api.update(body);
    return api.delete(body);
  };

  const executeConfirm = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      const res = await callMutation(confirm.action, { ...confirm.payload, preview: false });
      const label = { insert: '挿入', update: '更新', delete: '削除' }[confirm.action];
      setNotice(`${label}が完了しました(${res.affected}件)`);
      setConfirm(null);
      if (confirm.action === 'insert') setNewRows([]);
      setPendingEdits({});
      await load();
    } catch (err) {
      if (err.status === 401) onSessionLost();
      else {
        setConfirm(null);
        setError(err.message);
      }
    } finally {
      setConfirmBusy(false);
    }
  };

  const submitUpdates = () => {
    const updates = Object.entries(pendingEdits).map(([r, changes]) => ({
      key: pkKey(rows[r]),
      changes,
    }));
    const detail = (
      <table className="diff-table">
        <thead>
          <tr><th>主キー</th><th>カラム</th><th>変更前</th><th></th><th>変更後</th></tr>
        </thead>
        <tbody>
          {Object.entries(pendingEdits).flatMap(([r, changes]) =>
            Object.entries(changes).map(([col, v]) => (
              <tr key={`${r}-${col}`}>
                <td>{fmtKey(pkKey(rows[r]))}</td>
                <td>{col}</td>
                <td className="cell-old">{fmtVal(rows[r]?.[col])}</td>
                <td>→</td>
                <td className="cell-new">{fmtVal(v)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    );
    openConfirm('update', { schema, table, updates }, detail);
  };

  const submitInserts = () => {
    // 空欄のセルはINSERT対象から除外し、DBのデフォルト値に任せる
    const rowsToInsert = newRows
      .map((row) => {
        const out = {};
        for (const [col, v] of Object.entries(row)) {
          if (v !== undefined && v !== '') out[col] = v;
        }
        return out;
      })
      .filter((row) => Object.keys(row).length > 0);
    if (rowsToInsert.length === 0) {
      setError('挿入する行がありません。新規行領域に値を入力してください。');
      return;
    }
    const shownCols = cols.filter((c) => rowsToInsert.some((r) => c in r));
    const detail = (
      <table className="diff-table">
        <thead>
          <tr>{shownCols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rowsToInsert.map((row, i) => (
            <tr key={i}>
              {shownCols.map((c) => (
                <td key={c} className={c in row ? 'cell-new' : ''}>
                  {c in row ? fmtVal(row[c]) : <span className="null-val">(デフォルト)</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
    openConfirm('insert', { schema, table, rows: rowsToInsert }, detail);
  };

  const submitDeletes = () => {
    const rowIdxs = [...selectedRows].sort((a, b) => a - b);
    const keys = rowIdxs.map((r) => pkKey(rows[r]));
    const detail = (
      <table className="diff-table">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rowIdxs.map((r) => (
            <tr key={r}>
              {cols.map((c) => <td key={c} className="cell-old">{fmtVal(rows[r]?.[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    );
    openConfirm('delete', { schema, table, keys }, detail);
  };

  const pkKey = (row) => {
    const key = {};
    for (const pk of meta?.pkColumns ?? []) key[pk] = row?.[pk];
    return key;
  };

  // ---- エクスポート / インポート ----
  const doExport = async (format, scope) => {
    setError('');
    try {
      const blob = await api.exportFile({
        schema, table, format, scope,
        limit: pageSize, offset: page * pageSize,
        sortCol, sortDir,
        filters: JSON.stringify(filters), search,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${table}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      handleError(err);
    }
  };

  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const isCsv = /\.csv$/i.test(file.name);
    const data = isCsv ? parseCsv(text) : parseTsv(text);
    if (data.length === 0) {
      setError('ファイルにデータがありません。');
      return;
    }
    // 1行目がカラム名と一致する場合はヘッダーとして扱い、名前でマッピングする
    const headerCandidates = data[0].map((h) => h.trim());
    const matched = headerCandidates.filter((h) => cols.includes(h));
    let mapping; // インデックス -> カラム名
    let body;
    if (matched.length > 0 && window.confirm(`1行目をヘッダー(カラム名)として扱いますか?\n一致したカラム: ${matched.join(', ')}`)) {
      mapping = headerCandidates.map((h) => (cols.includes(h) ? h : null));
      body = data.slice(1);
    } else {
      mapping = cols.slice(0, data[0].length);
      body = data;
      if (data[0].length !== cols.length) {
        if (!window.confirm(`ファイルの列数(${data[0].length})がテーブルの列数(${cols.length})と一致しません。先頭から順にマッピングして続行しますか?`)) {
          return;
        }
      }
    }
    const imported = body.map((line) => {
      const row = {};
      line.forEach((v, i) => {
        const col = mapping[i];
        if (col) row[col] = v;
      });
      return row;
    });
    setNewRows((prev) => [...prev, ...imported]);
    setNotice(`${imported.length}行をファイルから読み込みました(内容を確認して「挿入を確定」してください)`);
  };

  // ---- フィルタ・検索 ----
  const applyFilter = (col) => {
    setPage(0);
    setFilters((f) => {
      const next = { ...f };
      const v = filterDraft[col] ?? '';
      if (v === '') delete next[col];
      else next[col] = v;
      return next;
    });
  };

  const toggleSort = (col) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  // ---- レンダリング ----
  if (!meta && loading) return <div className="placeholder">読み込み中…</div>;
  if (!meta) return <div className="main-scroll">{error && <div className="error-box">{error}</div>}</div>;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const colMeta = Object.fromEntries(meta.columns.map((c) => [c.name, c]));

  return (
    <div className="grid-view">
      {/* ツールバー */}
      <div className="toolbar">
        <button className="btn" onClick={guarded(load)} disabled={loading} title="再読込">🔄 再読込</button>
        <button className="btn" onClick={() => setStructureOpen(true)}>構造</button>
        <span className="toolbar-sep" />
        <input
          className="search-box"
          placeholder="全体検索…"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && confirmDiscard()) {
              setNewRows([]);
              setPage(0);
              setSearch(searchDraft);
            }
          }}
        />
        <span className="toolbar-sep" />
        <div className="dropdown">
          <button className="btn">エクスポート ▾</button>
          <div className="dropdown-menu">
            <button onClick={() => doExport('csv', 'page')}>表示中をCSV</button>
            <button onClick={() => doExport('tsv', 'page')}>表示中をTSV</button>
            <button onClick={() => doExport('csv', 'all')}>全件をCSV</button>
            <button onClick={() => doExport('tsv', 'all')}>全件をTSV</button>
          </div>
        </div>
        {!meta.readOnly && (
          <button className="btn" onClick={() => fileRef.current?.click()}>インポート</button>
        )}
        <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" hidden onChange={onImportFile} />
        <span className="spacer" />
        {editCount > 0 && (
          <>
            <button className="btn btn-primary" onClick={submitUpdates}>変更を確定 ({editCount}セル)</button>
            <button className="btn" onClick={() => setPendingEdits({})}>変更を破棄</button>
          </>
        )}
        {selectedRows.size > 0 && !meta.readOnly && (
          <button className="btn btn-danger" onClick={submitDeletes}>選択行を削除 ({selectedRows.size}行)</button>
        )}
      </div>

      {meta.readOnly && (
        <div className="warn-box">
          このテーブルには主キーがないため<strong>読み取り専用</strong>です(更新・削除・挿入はできません)。
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="notice-box">{notice}</div>}

      {/* グリッド */}
      <div
        className="grid-scroll"
        ref={gridRef}
        tabIndex={0}
        onCopy={onCopy}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setSel(null);
            setEditing(null);
          }
        }}
      >
        <table className="grid-table">
          <thead>
            <tr>
              <th className="row-head">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selectedRows.size === rows.length}
                  onChange={toggleAllRows}
                  title="全行選択/解除"
                />
              </th>
              {cols.map((col) => {
                const c = colMeta[col];
                return (
                  <th
                    key={col}
                    className="col-head"
                    title={`型: ${c.dataType}${c.notNull ? ' NOT NULL' : ''}${c.isPk ? ' [主キー]' : ''}${c.default ? `\nデフォルト: ${c.default}` : ''}`}
                    onClick={() => guarded(() => { setPage(0); toggleSort(col); })()}
                  >
                    {c.isPk && <span className="pk-mark" title="主キー">🔑</span>}
                    {col}
                    {sortCol === col && <span className="sort-mark">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                );
              })}
            </tr>
            <tr className="filter-row">
              <th className="row-head" title="列フィルタ">🔍</th>
              {cols.map((col) => (
                <th key={col}>
                  <input
                    className="filter-input"
                    placeholder="フィルタ"
                    value={filterDraft[col] ?? ''}
                    onChange={(e) => setFilterDraft((f) => ({ ...f, [col]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && confirmDiscard()) {
                        setNewRows([]);
                        applyFilter(col);
                      }
                    }}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className={selectedRows.has(r) ? 'row-selected' : ''}>
                <td className="row-head">
                  <input
                    type="checkbox"
                    checked={selectedRows.has(r)}
                    onClick={(e) => toggleRow(r, e)}
                    onChange={() => {}}
                  />
                </td>
                {cols.map((col, c) =>
                  editing && editing.r === r && editing.c === c ? (
                    <td key={col} className="cell editing">
                      <input
                        autoFocus
                        className="cell-editor"
                        value={editing.value}
                        placeholder="(空欄=NULL)"
                        onChange={(e) => setEditing((ed) => ({ ...ed, value: e.target.value }))}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit();
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                    </td>
                  ) : (
                    <td
                      key={col}
                      className={
                        'cell' +
                        (inSel(r, c) ? ' selected' : '') +
                        (isEdited(r, col) ? ' edited' : '')
                      }
                      onMouseDown={(e) => onCellMouseDown(r, c, e)}
                      onMouseEnter={() => onCellMouseEnter(r, c)}
                      onDoubleClick={() => startEdit(r, c)}
                    >
                      {fmtVal(cellValue(r, col))}
                    </td>
                  )
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="empty-note" colSpan={cols.length + 1}>データがありません</td>
              </tr>
            )}
          </tbody>
          {/* 新規行(挿入)領域 */}
          {!meta.readOnly && newRows.length > 0 && (
            <tbody className="insert-zone">
              <tr className="insert-zone-head">
                <td colSpan={cols.length + 1}>
                  ↓ 新規行(挿入待ち)— 空欄はDBのデフォルト値になります。TSVの複数行貼り付けが可能です
                </td>
              </tr>
              {newRows.map((row, ir) => (
                <tr key={ir}>
                  <td className="row-head">
                    <button className="mini-btn" onClick={() => removeNewRow(ir)} title="この行を取り消す">✕</button>
                  </td>
                  {cols.map((col, ci) => (
                    <td key={col} className="cell new-cell">
                      <input
                        className="cell-editor"
                        value={row[col] ?? ''}
                        placeholder={colMeta[col].isIdentity || colMeta[col].isGenerated ? '(自動)' : ''}
                        onChange={(e) => setNewCell(ir, col, e.target.value)}
                        onPaste={(e) => onNewCellPaste(ir, ci, e)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>

      {/* フッター(ページング・挿入操作) */}
      <div className="grid-footer">
        {!meta.readOnly && (
          <>
            <button className="btn" onClick={addNewRow}>+ 行を追加</button>
            {newRows.length > 0 && (
              <>
                <button className="btn btn-primary" onClick={submitInserts}>挿入を確定 ({newRows.length}行)</button>
                <button className="btn" onClick={() => setNewRows([])}>挿入を取消</button>
              </>
            )}
          </>
        )}
        <span className="spacer" />
        <span className="total-info">
          総 {total.toLocaleString()} 行
          {Object.keys(filters).length > 0 || search ? '(フィルタ適用中)' : ''}
        </span>
        <select
          value={pageSize}
          onChange={(e) => guarded(() => { setPage(0); setPageSize(Number(e.target.value)); })()}
        >
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}件</option>)}
        </select>
        <button className="btn" disabled={page === 0} onClick={guarded(() => setPage((p) => p - 1))}>前へ</button>
        <span>{page + 1} / {totalPages} ページ</span>
        <button className="btn" disabled={page >= totalPages - 1} onClick={guarded(() => setPage((p) => p + 1))}>次へ</button>
      </div>

      {confirm && (
        <ConfirmDialog
          action={confirm.action}
          preview={confirm.preview}
          detail={confirm.detail}
          busy={confirmBusy}
          onOk={executeConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
      {structureOpen && <StructureView meta={meta} onClose={() => setStructureOpen(false)} />}
    </div>
  );
}

function fmtVal(v) {
  if (v === null || v === undefined) return <span className="null-val">NULL</span>;
  return String(v);
}

function fmtKey(key) {
  return Object.entries(key)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

function isFormElement(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}
