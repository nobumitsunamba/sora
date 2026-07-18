# PostgreSQL DBメンテナンスWebアプリ

社内「Container Apps セルフサービス基盤」上の各アプリのPostgreSQLデータベースを、GUI(Excelライクなグリッド)でメンテナンス(参照・挿入・更新・削除)するためのWebアプリです。利用者はIT部門の運用担当者を想定しています。

## 構成

| ディレクトリ | 役割 |
| --- | --- |
| `api/` | Node.js / Express API。PostgreSQL接続・メタデータ取得・データ操作・監査ログ出力・フロントエンド静的配信(`api/public`) |
| `web/` | React (Vite) フロントエンド。ビルド成果物は `api/public` に出力される |
| `Dockerfile` | マルチステージビルド(web build → api が静的配信)。`/api/health` でヘルスゲート対応 |
| `docker-compose.yml` | ローカル動作確認用(PostgreSQL 16 同梱) |

> **注**: 基盤のスキャフォールド(溶接検査アプリ等)が web / api の2コンテナ構成の場合は、`Dockerfile` のステージを分割してそれぞれのイメージにしてください。API は `/api/health` を公開済みなので既存のヘルスゲート(ポーリング)をそのまま踏襲できます。

## 主な機能

- **接続画面**: DB名・DBユーザー・パスワードの3項目で接続(パスワードはマスク表示)。資格情報はサーバ側に保存せず、セッション中の接続にのみ使用(ログにも出力しない)
- **グリッド表示**: ページング(50/100/500件)、列ソート、列フィルタ、全体検索、総行数表示、再読込
- **コピー**: 矩形範囲選択(ドラッグ / Shift+クリック)または行選択 → `Ctrl+C` でTSV形式コピー(Excelにそのまま貼り付け可能)
- **挿入**: グリッド末尾の新規行領域にExcelからのTSVを複数行一括貼り付け(列数不一致時は警告)。CSV/TSVファイルインポートも同じ確認フローを経由
- **更新**: 矩形範囲を選択して `Ctrl+V` でブロック一括更新、またはセルのダブルクリックでインライン編集
- **削除**: チェックボックス(Shiftで範囲選択)で複数行選択 → 一括削除
- **確認画面(必須)**: 挿入・更新・削除とも実行前に差分プレビュー(変更前→変更後)・件数・パラメータ化SQLのプレビューを表示し、OK時のみ実行。トランザクション内で実行し、一部失敗時は全体ロールバック
- **テーブル構造表示**: カラム名・型・PK・NOT NULL・デフォルト値
- **エクスポート**: 表示中 or 全件を CSV / TSV でダウンロード(UTF-8 BOM付き、Excel対応)
- UIはすべて日本語。エラーメッセージは原因・対処が分かる日本語で表示

## 安全機構

- **主キーの無いテーブル(およびビュー)は読み取り専用**(理由をバナー表示)
- 更新・削除のWHERE条件は必ず主キー全カラムで特定し、**影響行数が1件でなければロールバック**(他ユーザーによる変更・削除を検知)
- SQLはすべて**パラメータ化クエリ**。識別子(スキーマ/テーブル/カラム名)は information_schema で実在検証のうえ引用符付けし、文字列連結によるSQL組み立てをしない
- **型検証**: 貼り付け・入力値をカラム型(数値/boolean/日付/日時/JSON/UUID/文字数上限)とNOT NULL制約で検証し、エラーは確認画面に行番号付きで明示
- 一括操作の行数上限(既定1,000行、`MAX_BATCH_ROWS` で変更可)とクエリタイムアウト(`QUERY_TIMEOUT_MS`、statement_timeout)
- 接続はアプリ専用DBユーザーの権限のみで実行(サーバ管理者資格情報は不使用)。権限不足はDB側の権限エラーを日本語で表示

## 監査ログ

ログ記録用のDBは持たず、**構造化JSON(1操作=1行)を標準出力へ出力**します。Container Apps の標準ログ収集により Log Analytics(`ContainerAppConsoleLogs_CL`)で検索できます。

```json
{"logType":"audit","timestamp":"2026-07-18T13:46:33.600Z","operator":"テスト運用者","database":"myapp_db","dbUser":"myapp_user","schema":"public","table":"products","action":"update","rowCount":1,"sessionId":"..."}
```

Log Analytics クエリ例:

```kusto
ContainerAppConsoleLogs_CL
| where Log_s has '"logType":"audit"'
| extend a = parse_json(Log_s)
| project TimeGenerated, tostring(a.operator), tostring(a.database), tostring(a.table), tostring(a.action), toint(a.rowCount)
```

**代替案(Blob Storage 追記出力)との比較**: Blob出力は保持期間を独自に管理でき、Log Analytics の取り込みコストがかからない一方、追記の競合制御・接続情報の管理・出力失敗時のハンドリングを自前で持つ必要があります。基盤で既にコンソールログが Log Analytics に収集されているため、**追加インフラ不要・欠損しにくい標準出力方式を第一候補として実装**しました。Blob方式が必要になった場合は `api/src/audit.js` の出力先を差し替えるだけで対応できます。

## 認証(将来のEntra ID対応)

- 現時点では認証なし(IT部門内限定)。フロントにログイン画面は作りません
- `api/src/auth.js` がミドルウェア層として分離されており、Container Apps の Easy Auth 導入時は `X-MS-CLIENT-PRINCIPAL-NAME` ヘッダーから操作者を取得します(実装済み・Easy Auth を有効化するだけで操作ログの操作者が切り替わる)
- それまでは環境変数 `OPERATOR_NAME` の値、未設定なら「未認証」を監査ログに記録します

## 環境変数

接続先ホスト等はハードコードせず、Container Apps のシークレット / Key Vault 参照で設定します。

| 変数名 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `DB_HOST` | ✔ | — | PostgreSQLサーバーのホスト名(基盤の接続情報) |
| `DB_PORT` | | `5432` | ポート |
| `DB_SSL` | | `true` | SSL接続の有無(Azure Database for PostgreSQL は `true`) |
| `OPERATOR_NAME` | | (空=未認証) | 監査ログに記録する操作者名(Entra ID導入までの暫定) |
| `MAX_BATCH_ROWS` | | `1000` | 一括操作の行数上限 |
| `QUERY_TIMEOUT_MS` | | `30000` | クエリタイムアウト(statement_timeout) |
| `SESSION_TTL_MINUTES` | | `60` | 無操作接続セッションの自動破棄時間 |
| `PORT` | | `3000` | APIの待受ポート |

> **要確認**: 環境変数の具体的な名前は基盤の既存アプリ(溶接検査アプリ等)の流儀に合わせて `api/src/config.js` で変更してください(名前の対応はこのファイル1箇所に集約しています)。

## グリッド実装の選定について

要件(矩形範囲選択・TSVクリップボード連携・商用利用可能な無償ライセンス)に対し、候補を比較のうえ**外部グリッドライブラリを使わない自前実装**としました。

| 候補 | ライセンス | 範囲選択 | クリップボード | 備考 |
| --- | --- | --- | --- | --- |
| Glide Data Grid | MIT | ○ | ○ | 高機能だが依存が大きく、確認画面連動の編集モデルは自前実装が必要 |
| AG Grid Community | MIT | ×(範囲選択はEnterprise有償) | △ | 要件の中核が有償版限定 |
| Handsontable | 商用有償 | ○ | ○ | ライセンス要件を満たさない |
| **自前実装(採用)** | — | ○ | ○ | 依存ゼロでライセンス問題なし。確認フロー・編集ハイライトと密結合できる |

本アプリのグリッドは1ページ最大500行の表示で仮想スクロールが不要なため、自前実装でも性能上の問題はありません。Glide Data Grid への置き換えが望ましい場合はご相談ください。

## ローカルでの動作確認

```bash
# 1) docker compose(推奨)
cd db-maintenance
docker compose up --build
# → http://localhost:3000 を開き、DB名 postgres / ユーザー postgres / パスワード adminpass で接続

# 2) 手動起動(開発時)
cd db-maintenance/web && npm install && npm run build   # または npm run dev(HMR、/api は :3000 へプロキシ)
cd ../api && npm install
DB_HOST=127.0.0.1 DB_PORT=5432 DB_SSL=false npm start
```

## API一覧

| メソッド/パス | 説明 |
| --- | --- |
| `GET /api/health` | ヘルスチェック(基盤ヘルスゲート用) |
| `POST /api/connect` | 接続(DB名/ユーザー/パスワード)→ セッションID発行 |
| `POST /api/disconnect` | 切断 |
| `GET /api/schemas` | スキーマ一覧 |
| `GET /api/tables?schema=` | テーブル一覧 |
| `GET /api/table-meta?schema=&table=` | テーブル構造(カラム・型・PK・NOT NULL・デフォルト) |
| `GET /api/rows?...` | データ取得(ページング・ソート・フィルタ・検索) |
| `GET /api/export?format=csv\|tsv&scope=page\|all` | エクスポート |
| `POST /api/insert` / `update` / `delete` | データ操作。`preview: true` で検証+SQLプレビューのみ(確認画面用)、`preview` なしで実行 |

セッションIDは `X-Session-Id` ヘッダーで送信します。

## デプロイ(基盤標準フロー)

1. 基盤の申請専用リポジトリ(Run workflow)で雛形を生成
2. 本ディレクトリの `api/` / `web/` / `Dockerfile` を雛形の構成に合わせて配置
3. Container Apps のシークレット(または Key Vault 参照)として上記環境変数を設定
4. GitHub Actions + OIDC の既存標準フローでデプロイ(ヘルスゲートは `/api/health`)

### 実装前確認事項として挙げられていた点(現状の判断)

- **接続情報の環境変数名**: 基盤標準の名前が確認でき次第 `api/src/config.js` を合わせて変更(1箇所で完結)
- **スキャフォールドの構成**: 単一コンテナ(API が静的配信)で実装済み。2コンテナ構成が必要な場合は Dockerfile のステージ分割で対応
- **Log Analytics のログ収集設定**: 基盤の標準収集(コンソールログ)を前提。カスタムテーブル等が必要な場合は要調整
