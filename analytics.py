#!/usr/bin/env python3
"""Forward YouTube Live Chat events to the existing KAXMOK Analytics Worker.

The Worker owns the persistent leaderboard and command state. This bridge does
not access or modify Cloudflare KV directly.
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

import requests

ANALYTICS_URL = os.environ.get(
    "ANALYTICS_URL", "https://kaxmok-analytics.kaxxmok.workers.dev"
).rstrip("/")
INGEST_TOKEN = os.environ.get("ANALYTICS_INGEST_TOKEN", "")
HTTP_TIMEOUT = float(os.environ.get("ANALYTICS_HTTP_TIMEOUT", "12"))
session = requests.Session()


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
    message = raw.get("text")
    if isinstance(message, str):
        item["text"] = message[:300]
    return item


def ingest(raw: dict[str, Any]) -> None:
    if not INGEST_TOKEN:
        raise RuntimeError("Missing ANALYTICS_INGEST_TOKEN GitHub Actions secret")

    item = normalize_message(raw)
    if not item:
        return

    last_error: Exception | None = None
    payload: dict[str, Any] | None = None
    for attempt in range(1, 4):
        try:
            response = session.post(
                f"{ANALYTICS_URL}/api/ingest",
                headers={
                    "Authorization": f"Bearer {INGEST_TOKEN}",
                    "Content-Type": "application/json",
                },
                json={"messages": [item]},
                timeout=HTTP_TIMEOUT,
            )
            response.raise_for_status()
            candidate = response.json()
            if not isinstance(candidate, dict) or not candidate.get("ok"):
                raise RuntimeError(f"Analytics Worker rejected message: {candidate}")
            payload = candidate
            break
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                time.sleep(0.5 * (2 ** (attempt - 1)))

    if payload is None:
        raise RuntimeError(f"Analytics Worker ingest failed after 3 attempts: {last_error}")

    # Node reads stdout as JSONL, so this is a reliable delivery confirmation.
    print(json.dumps({"type": "ingested"}, ensure_ascii=False), flush=True)

    for reply in payload.get("replies", []):
        if isinstance(reply, dict):
            print(json.dumps({"type": "reply", **reply}, ensure_ascii=False), flush=True)


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
            if isinstance(raw, dict):
                ingest(raw)
        except Exception as exc:
            print(json.dumps({"type": "error", "error": str(exc)}), file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
