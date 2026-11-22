#!/usr/bin/env python3
"""Build a shuffled, repeating MP3 playlist and stream it with one video loop."""
from __future__ import annotations

import os
import random
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SONGS_DIR = ROOT / "songs"
BACKGROUND = ROOT / os.environ.get(
    "NORMAL_BACKGROUND",
    "assets/backgrounds/WhatsApp Video 2026-11-14 at 4.16.22 PM.mp4",
)
YT_STREAM_KEY = os.environ.get("YT_STREAM_KEY", "").strip()
RTMP_URL = os.environ.get("YOUTUBE_RTMP_URL", "rtmp://a.rtmp.youtube.com/live2").rstrip("/")
REPEATS = max(20, int(os.environ.get("PLAYLIST_ROUNDS", "250")))


def ffconcat_quote(path: Path) -> str:
    value = str(path.resolve())
    return value.replace("'", "'\\''")


def build_playlist() -> Path:
    songs = sorted(
        p for p in SONGS_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in {".mp3", ".mpeg", ".mp2"}
    )
    if not songs:
        raise RuntimeError(f"No MP3 audio files found in {SONGS_DIR}")

    playlist: list[Path] = []
    previous: Path | None = None
    for _ in range(REPEATS):
        batch = songs[:]
        random.shuffle(batch)
        if previous is not None and len(batch) > 1 and batch[0] == previous:
            batch[0], batch[1] = batch[1], batch[0]
        playlist.extend(batch)
        previous = batch[-1]

    fd, filename = tempfile.mkstemp(prefix="kaxmok-playlist-", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        for song in playlist:
            file.write(f"file '{ffconcat_quote(song)}'\n")
    return Path(filename)


def main() -> int:
    if not YT_STREAM_KEY:
        raise RuntimeError("Missing YT_STREAM_KEY GitHub Actions secret")
    if not BACKGROUND.is_file():
        raise RuntimeError(f"Normal background video not found: {BACKGROUND}")

    playlist = build_playlist()
    destination = f"{RTMP_URL}/{YT_STREAM_KEY}"
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "info",
        "-stream_loop", "-1", "-re", "-i", str(BACKGROUND),
        "-re", "-stream_loop", "-1", "-f", "concat", "-safe", "0", "-i", str(playlist),
        "-map", "0:v:0", "-map", "1:a:0",
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,"
               "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast",
        "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
        "-g", "60", "-r", "30",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
        "-flvflags", "no_duration_filesize",
        "-f", "flv", destination,
    ]

    print(f"Loaded {len(list(SONGS_DIR.glob('*')))} directory entries; playlist has {REPEATS} shuffled rounds.", flush=True)
    print(f"Using normal background: {BACKGROUND.name}", flush=True)
    print("Starting FFmpeg livestream.", flush=True)
    try:
        return subprocess.run(command, check=False).returncode
    finally:
        playlist.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"STREAM ERROR: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
