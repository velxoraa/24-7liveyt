#!/usr/bin/env python3
"""Stream continuous audio with a hot-swappable video/image background."""
from __future__ import annotations

import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
SONGS_DIR = ROOT / "songs"
BACKGROUND_DIR = ROOT / "assets" / "backgrounds"
BACKGROUND = ROOT / os.environ.get(
    "NORMAL_BACKGROUND",
    "assets/backgrounds/WhatsApp Video 2026-11-14 at 4.16.22 PM.mp4",
)
BG_COMMAND_FILE = ROOT / "bg_command.txt"
YT_STREAM_KEY = os.environ.get("YT_STREAM_KEY", "").strip()
RTMP_URL = os.environ.get("YOUTUBE_RTMP_URL", "rtmp://a.rtmp.youtube.com/live2").rstrip("/")
REPEATS = max(20, int(os.environ.get("PLAYLIST_ROUNDS", "250")))
WIDTH, HEIGHT, FPS = 854, 480, 30
FRAME_BYTES = WIDTH * HEIGHT * 3
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def ffconcat_quote(path: Path) -> str:
    return str(path.resolve()).replace("'", "'\\''")


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


def list_backgrounds() -> list[Path]:
    if not BACKGROUND_DIR.is_dir():
        raise RuntimeError(f"Background folder not found: {BACKGROUND_DIR}")
    return sorted(
        (p for p in BACKGROUND_DIR.iterdir()
         if p.is_file() and p.suffix.lower() in VIDEO_EXTS | IMAGE_EXTS),
        key=lambda p: p.name.casefold()
    )


def read_exact(pipe, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = pipe.read(size - len(chunks))
        if not chunk:
            return b""
        chunks.extend(chunk)
    return bytes(chunks)


def start_background_decoder(path: Path) -> subprocess.Popen:
    common_filter = (
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,"
        f"fps={FPS},format=rgb24"
    )
    if path.suffix.lower() in IMAGE_EXTS:
        input_args = ["-loop", "1", "-framerate", str(FPS), "-re", "-i", str(path)]
    elif path.suffix.lower() in VIDEO_EXTS:
        input_args = ["-stream_loop", "-1", "-re", "-i", str(path)]
    else:
        raise RuntimeError(f"Unsupported background format: {path.suffix}")

    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        *input_args, "-an", "-vf", common_filter,
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"
    ]
    return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)


def take_background_command(backgrounds: list[Path]) -> Path | None:
    try:
        if not BG_COMMAND_FILE.exists():
            return None
        raw = BG_COMMAND_FILE.read_text(encoding="utf-8").strip()
        BG_COMMAND_FILE.unlink(missing_ok=True)
        if not raw.isdigit():
            print(f"Ignoring invalid background command: {raw!r}", flush=True)
            return None
        index = int(raw)
        if index < 1 or index > len(backgrounds):
            print(f"Invalid !bg {index}; available backgrounds are 1-{len(backgrounds)}.", flush=True)
            return None
        return backgrounds[index - 1]
    except FileNotFoundError:
        return None


def main() -> int:
    if not YT_STREAM_KEY:
        raise RuntimeError("Missing YT_STREAM_KEY GitHub Actions secret")
    if not BACKGROUND.is_file():
        raise RuntimeError(f"Normal background video not found: {BACKGROUND}")

    backgrounds = list_backgrounds()
    if not backgrounds:
        raise RuntimeError(f"No JPG/PNG/MP4 backgrounds found in {BACKGROUND_DIR}")

    print("Available backgrounds (the !bg number follows this alphabetical order):", flush=True)
    for number, path in enumerate(backgrounds, 1):
        print(f"  !bg {number} -> {path.name}", flush=True)

    current = BACKGROUND
    if current not in backgrounds:
        print(f"Normal background is not in numbered list: {current.name}", flush=True)
    else:
        print(f"Starting with background: {current.name}", flush=True)

    playlist = build_playlist()
    destination = f"{RTMP_URL}/{YT_STREAM_KEY}"
    encoder_command = [
        "ffmpeg", "-hide_banner", "-loglevel", "info",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "pipe:0",
        "-re", "-stream_loop", "-1", "-f", "concat", "-safe", "0", "-i", str(playlist),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0",
        "-b:v", "1500k", "-maxrate", "1500k", "-bufsize", "3000k",
        "-g", "60", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "96k", "-ar", "44100",
        "-flvflags", "no_duration_filesize", "-flush_packets", "1",
        "-f", "flv", destination,
    ]

    encoder = None
    decoder = None
    game_renderer = None
    try:
        game_renderer = subprocess.Popen(["node", "html_game_renderer.js"], stdout=subprocess.PIPE, stderr=None, bufsize=0)
        print(f"Loaded {len(list(SONGS_DIR.glob('*')))} directory entries; playlist has {REPEATS} shuffled rounds.", flush=True)
        print("Starting FFmpeg livestream; audio encoder stays running during background changes.", flush=True)
        encoder = subprocess.Popen(encoder_command, stdin=subprocess.PIPE)
        decoder = start_background_decoder(current)

        while encoder.poll() is None:
            requested = take_background_command(backgrounds)
            if requested is not None and requested != current:
                if decoder and decoder.poll() is None:
                    decoder.terminate()
                    try:
                        decoder.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        decoder.kill()
                        decoder.wait()
                current = requested
                decoder = start_background_decoder(current)
                print(f"Switched background immediately to: {current.name}", flush=True)

            if decoder.poll() is not None:
                print(f"Background decoder stopped; restarting: {current.name}", flush=True)
                decoder = start_background_decoder(current)

            frame = read_exact(decoder.stdout, FRAME_BYTES)
            if not frame:
                if decoder.poll() is not None:
                    decoder = start_background_decoder(current)
                    continue
                raise RuntimeError(f"Could not read video frame from background: {current.name}")

            try:
                overlay_bytes = read_exact(game_renderer.stdout, WIDTH * HEIGHT * 4)
                if not overlay_bytes:
                    raise RuntimeError("HTML game renderer stopped unexpectedly")
                # Composite directly onto RGB to avoid RGB->RGBA and RGBA->RGB
                # conversions on every 1280x720 frame.
                base = Image.frombytes("RGB", (WIDTH, HEIGHT), frame)
                overlay = Image.frombytes("RGBA", (WIDTH, HEIGHT), overlay_bytes)
                base.paste(overlay, (0, 0), overlay)
                encoder.stdin.write(base.tobytes())
            except BrokenPipeError:
                break

        return encoder.returncode if encoder.returncode is not None else 1
    finally:
        for process in (decoder, encoder, game_renderer):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        playlist.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"STREAM ERROR: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
