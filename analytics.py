#!/usr/bin/env python3
"""Bridge YouTube Live Chat events into the existing KAXMOK Analytics Worker.

Input: one JSON object per stdin line:
{
  "author_id": "...",
  "author": "...",
  "avatar_url": "https://...",
  "is_moderator": false,
  "text": "!join NOVA"
}

Output: one JSON object per stdout line for each Worker reply:
{"type":"reply","author_id":"...","author":"...","text":"..."}

The Worker owns the persistent leaderboard state. This script never writes to
Cloudflare KV directly and must not be pointed at a replacement/reset Worker.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

import requests

ANALYTICS_URL = os.environ.get(
    "ANALYTICS_URL", "https://kaxmok-analytics.kaxxmok.workers.dev"
).rstrip("/")
INGEST_TOKEN = os.environ.get("ANALYTICS_INGEST_TOKEN", "")
ZMQ_ENDPOINT = os.environ.get("FFMPEG_ZMQ_ENDPOINT", "tcp://127.0.0.1:5555")
HTTP_TIMEOUT = float(os.environ.get("ANALYTICS_HTTP_TIMEOUT", "12"))

session = requests.Session()


def switch_background(command: str) -> None:
    """Switch only the FFmpeg video stream; audio is not addressed by this command."""
    try:
        import zmq

        ctx = zmq.Context.instance()
        sock = ctx.socket(zmq.REQ)
        sock.setsockopt(zmq.LINGER, 0)
        sock.setsockopt(zmq.RCVTIMEO, 2500)
        sock.setsockopt(zmq.SNDTIMEO, 2500)
        sock.connect(ZMQ_ENDPOINT)
        sock.send_string(command)
        response = sock.recv_string()
        print(
            json.dumps({"type": "background", "command": command, "response": response}),
            flush=True,
        )
        sock.close(0)
    except Exception as exc:
        print(
            json.dumps({"type": "warning", "component": "background", "error": str(exc)}),
            file=sys.stderr,
            flush=True,
        )


def normalize_message(raw: dict[str, Any]) -> dict[str, Any] | None:
    author_id = str(raw.get("author_id") or "").strip()
    if not author_id:
        return None
    item: dict[str, Any] = {
        "author_id": author_id[:200],
        "author": str(raw.get("author") or "Viewer").strip()[:100] or "Viewer",
        "avatar_url": str(raw.get("avatar_url") or "")[:1000],
        "is_moderator": bool(raw.get("is_moderator", False)),
    }
    # Worker uses this optional field to parse chat commands and produce replies.
    text = raw.get("text")
    if isinstance(text, str):
        item["text"] = text[:300]
    return item


def ingest_batch(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not INGEST_TOKEN:
        raise RuntimeError("Missing ANALYTICS_INGEST_TOKEN GitHub Actions secret")
    if not messages:
        return []
    response = session.post(
        f"{ANALYTICS_URL}/api/ingest",
        headers={
            "Authorization": f"Bearer {INGEST_TOKEN}",
            "Content-Type": "application/json",
        },
        json={"messages": messages[:100]},
        timeout=HTTP_TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()
    if not payload.get("ok"):
        raise RuntimeError(f"Analytics Worker rejected batch: {payload}")
    replies = payload.get("replies", [])
    return replies if isinstance(replies, list) else []


def handle(raw: dict[str, Any]) -> None:
    text = raw.get("text")
    if isinstance(text, str):
        command = text.strip().lower()
        if command == "!birthday":
            switch_background("streamselect@birthday_bg map 1")
        elif command == "!normal":
            switch_background("streamselect@birthday_bg map 0")

    item = normalize_message(raw)
    if not item:
        return
    # One event per request keeps command replies immediate and avoids retrying a
    # batch that might already have incremented counters in KV.
    for reply in ingest_batch([item]):
        print(json.dumps({"type": "reply", **reply}, ensure_ascii=False), flush=True)


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
            if isinstance(raw, dict):
                handle(raw)
        except Exception as exc:
            print(
                json.dumps({"type": "error", "error": str(exc)}),
                file=sys.stderr,
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
