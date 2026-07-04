"""Vercel Python サーバーレス関数: /api/estimate

フロントエンドから JSON `{ "image": "<base64>", "media_type": "image/jpeg" }`
を受け取り、Claude の画像認識で赤ちゃんの機嫌を推定した JSON を返します。
あくまで遊び・参考目的の推定です。
"""

from http.server import BaseHTTPRequestHandler
import base64
import json
import os

import anthropic

MODEL = "claude-opus-4-8"

SUPPORTED_MEDIA_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

# base64 デコード後のバイト数の上限（フロント側で縮小するので十分な余裕）
MAX_IMAGE_BYTES = 6 * 1024 * 1024

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


def estimate_mood(image_b64: str, media_type: str) -> dict:
    """base64 画像を Claude に渡して機嫌推定 JSON を得る。"""
    client = anthropic.Anthropic()
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
                            "data": image_b64,
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


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler naming)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            data = json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._send_json(400, {"error": "リクエストの形式が不正です。"})

        image_b64 = data.get("image")
        media_type = data.get("media_type")

        if not image_b64:
            return self._send_json(400, {"error": "画像が送信されていません。"})
        if media_type not in SUPPORTED_MEDIA_TYPES:
            return self._send_json(
                400,
                {"error": "対応していない画像形式です。JPEG / PNG / GIF / WebP を使用してください。"},
            )

        try:
            raw_image = base64.b64decode(image_b64, validate=True)
        except (ValueError, base64.binascii.Error):
            return self._send_json(400, {"error": "画像データを読み取れませんでした。"})

        if not raw_image:
            return self._send_json(400, {"error": "画像データが空です。"})
        if len(raw_image) > MAX_IMAGE_BYTES:
            return self._send_json(400, {"error": "画像サイズが大きすぎます。"})

        if not (
            os.environ.get("ANTHROPIC_API_KEY")
            or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        ):
            return self._send_json(
                500,
                {
                    "error": "サーバーに ANTHROPIC_API_KEY が設定されていません。"
                    "Vercel の環境変数を設定してから再デプロイしてください。"
                },
            )

        try:
            result = estimate_mood(image_b64, media_type)
        except anthropic.APIError as exc:
            return self._send_json(502, {"error": f"推定中に API エラーが発生しました: {exc}"})
        except (json.JSONDecodeError, ValueError):
            return self._send_json(502, {"error": "推定結果の解析に失敗しました。"})
        except Exception as exc:  # noqa: BLE001 — 常に JSON を返すための保険
            return self._send_json(500, {"error": f"サーバーエラー: {exc}"})

        return self._send_json(200, result)
