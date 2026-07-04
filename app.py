"""赤ちゃんの表情から機嫌を推定する Flask アプリ。

アップロードされた顔写真を Claude の画像認識に渡し、観察点にもとづいて
機嫌を推定した JSON を返します。あくまで遊び・参考目的の推定です。
"""

import base64
import json
import os

import anthropic
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

client = anthropic.Anthropic()

MODEL = "claude-opus-4-8"

# 許可する画像形式（拡張子 -> media_type）
SUPPORTED_MEDIA_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}

# 8MB 程度までを受け付ける（Claude の画像入力上限にも収まる範囲）
MAX_IMAGE_BYTES = 8 * 1024 * 1024

SYSTEM_PROMPT = """あなたは赤ちゃんの表情から機嫌を推定するアシスタントです。
アップロードされた顔写真を観察し、以下の観察点をもとに機嫌を判定してください。

【観察点】
- 口角の向き（上がっている／水平／下がっている）
- 口の開き方（閉じている／軽く開く／大きく開く＝泣き・笑い）
- 目の開き具合（見開いている／半目／閉じかけ）
- 眉のしわ・寄せ具合
- 頬の緊張やふくらみ
- 全体の顔の力み具合

【判定カテゴリ】以下の5つから選ぶ
- ごきげん（笑顔・リラックス）
- ふつう（無表情・落ち着いている）
- むずかり（不快・ぐずり始め）
- 泣いている
- 眠そう

【出力形式】以下のJSONのみを返す。前置きやMarkdownのコードフェンスは一切付けない。
{
  "mood": "最も可能性の高いカテゴリ",
  "confidence": 最も高いカテゴリの確信度（0〜100の整数）,
  "candidates": [
    { "label": "カテゴリ名", "score": 確信度（整数） }
  ],
  "observed_features": ["そう判断した根拠を日本語で2〜4点"]
}

【注意】
- candidates は score の高い順に並べ、上位2〜3件を含める。
- 顔がはっきり写っていない、横向き、暗すぎる等で判断が難しい場合は
  mood を "判定不能" とし、observed_features にその理由を書く。
- これは遊び・参考目的の推定であり、体調や苦痛の医学的判断ではないことを前提に、
  断定しすぎない表現で根拠を述べる。"""

# 出力を確実に JSON として受け取るためのスキーマ（構造化出力）
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "mood": {"type": "string"},
        "confidence": {"type": "integer"},
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "score": {"type": "integer"},
                },
                "required": ["label", "score"],
                "additionalProperties": False,
            },
        },
        "observed_features": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": ["mood", "observed_features"],
    "additionalProperties": False,
}


def estimate_mood(image_bytes: bytes, media_type: str) -> dict:
    """画像を Claude に渡して機嫌推定 JSON を得る。"""
    image_data = base64.standard_b64encode(image_bytes).decode("utf-8")

    response = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        output_config={
            "format": {
                "type": "json_schema",
                "schema": OUTPUT_SCHEMA,
            }
        },
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": "この赤ちゃんの顔写真から機嫌を推定してください。",
                    },
                ],
            }
        ],
    )

    text = next((b.text for b in response.content if b.type == "text"), "")
    return json.loads(text)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/estimate", methods=["POST"])
def api_estimate():
    if "image" not in request.files:
        return jsonify({"error": "画像ファイルが送信されていません。"}), 400

    file = request.files["image"]
    if not file.filename:
        return jsonify({"error": "画像ファイルが選択されていません。"}), 400

    media_type = file.mimetype
    if media_type not in SUPPORTED_MEDIA_TYPES:
        return (
            jsonify(
                {
                    "error": "対応していない画像形式です。"
                    "JPEG / PNG / GIF / WebP を使用してください。"
                }
            ),
            400,
        )

    image_bytes = file.read()
    if not image_bytes:
        return jsonify({"error": "画像ファイルが空です。"}), 400
    if len(image_bytes) > MAX_IMAGE_BYTES:
        return jsonify({"error": "画像サイズが大きすぎます（上限 8MB）。"}), 400

    try:
        result = estimate_mood(image_bytes, media_type)
    except anthropic.APIError as exc:
        app.logger.exception("Claude API error")
        return jsonify({"error": f"推定中にエラーが発生しました: {exc}"}), 502
    except (json.JSONDecodeError, ValueError):
        app.logger.exception("Failed to parse model output")
        return jsonify({"error": "推定結果の解析に失敗しました。"}), 502

    return jsonify(result)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
