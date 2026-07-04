# 👶 赤ちゃん機嫌エスティメーター

アップロードされた赤ちゃんの顔写真を観察し、表情から機嫌を推定する Web アプリです。
Claude の画像認識を使い、口角・目・眉・頬などの観察点にもとづいて判定します。
**Vercel** にそのままデプロイできる構成です。

> ⚠️ これは **遊び・参考目的** の推定です。赤ちゃんの体調や苦痛を医学的に判断するものではありません。

## 判定カテゴリ

- ごきげん（笑顔・リラックス）
- ふつう（無表情・落ち着いている）
- むずかり（不快・ぐずり始め）
- 泣いている
- 眠そう

顔がはっきり写っていない・横向き・暗すぎる等で判断が難しい場合は「判定不能」を返します。

## 構成

| パス | 役割 |
| --- | --- |
| `public/index.html` | アップロード UI と結果表示（Vercel が `/` で静的配信） |
| `api/estimate.py` | Vercel Python サーバーレス関数（`/api/estimate`）。画像を Claude に渡し JSON を返す |
| `requirements.txt` | `anthropic` |

フロントは画像を最大 1024px の JPEG に縮小してから
`POST /api/estimate` に `{ "image": "<base64>", "media_type": "image/jpeg" }` を送ります。

## デプロイ（Vercel）

1. このリポジトリを Vercel プロジェクトに接続（追加設定は不要）。
2. **環境変数 `ANTHROPIC_API_KEY` を設定**する（Project → Settings → Environment Variables）。
   これが無いと推定は失敗します。
3. 再デプロイすると `https://<project>.vercel.app` で動作します。

## ローカル実行

Vercel CLI を使うと本番と同じ構成で動きます。

```bash
npm i -g vercel
export ANTHROPIC_API_KEY="sk-ant-..."
vercel dev
```

## API レスポンス形式

```json
{
  "mood": "ごきげん",
  "confidence": 82,
  "candidates": [
    { "label": "ごきげん", "score": 82 },
    { "label": "ふつう", "score": 12 }
  ],
  "observed_features": ["口角が上がっている", "頬がふっくらしている"]
}
```

推定には `claude-opus-4-8` の画像認識と構造化出力（JSON スキーマ）を使用しています。
