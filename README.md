# 👶 赤ちゃん機嫌エスティメーター

アップロードされた赤ちゃんの顔写真を観察し、表情から機嫌を推定する Web アプリです。
Claude の画像認識を使い、口角・目・眉・頬などの観察点にもとづいて判定します。

> ⚠️ これは **遊び・参考目的** の推定です。赤ちゃんの体調や苦痛を医学的に判断するものではありません。

## 判定カテゴリ

- ごきげん（笑顔・リラックス）
- ふつう（無表情・落ち着いている）
- むずかり（不快・ぐずり始め）
- 泣いている
- 眠そう

顔がはっきり写っていない・横向き・暗すぎる等で判断が難しい場合は「判定不能」を返します。

## 出力形式

`POST /api/estimate`（`multipart/form-data`, フィールド名 `image`）に画像を送ると、
次の JSON を返します。

```json
{
  "mood": "最も可能性の高いカテゴリ",
  "confidence": 82,
  "candidates": [
    { "label": "ごきげん", "score": 82 },
    { "label": "ふつう", "score": 12 }
  ],
  "observed_features": ["口角が上がっている", "頬がふっくらしている"]
}
```

## セットアップ

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY="sk-ant-..."   # あるいは `ant auth login`
python app.py
```

ブラウザで <http://localhost:5000> を開き、写真をアップロードしてください。

## 構成

| ファイル | 役割 |
| --- | --- |
| `app.py` | Flask バックエンド。画像を Claude に渡し JSON を返す |
| `templates/index.html` | アップロード UI と結果表示（単一ページ） |

推定には `claude-opus-4-8` の画像認識と構造化出力（JSON スキーマ）を使用しています。
