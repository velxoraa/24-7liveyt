#!/usr/bin/env python3
"""Stream continuous audio with a hot-swappable video/image background."""
from __future__ import annotations

import os
import subprocess
import sys
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
SONG_COMMAND_FILE = ROOT / "song_command.txt"
YT_STREAM_KEY = os.environ.get("YT_STREAM_KEY", "").strip()
RTMP_URL = os.environ.get("YOUTUBE_RTMP_URL", "rtmp://a.rtmp.youtube.com/live2").rstrip("/")
WIDTH, HEIGHT, FPS = 854, 480, 30
FRAME_BYTES = WIDTH * HEIGHT * 3
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def ffconcat_quote(path: Path) -> str:
    return str(path.resolve()).replace("'", "'\\''")



def list_songs() -> list[Path]:
    return sorted(
        (p for p in SONGS_DIR.iterdir() if p.is_file() and p.suffix.lower() in {".mp3", ".mpeg", ".mp2"}),
        key=lambda p: p.name.casefold()
    )


def start_song_decoder(path: Path) -> subprocess.Popen:
    return subprocess.Popen([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-i", str(path),
        "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", "pipe:1"
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)



def take_song_command(songs: list[Path]) -> int | None:
    try:
        value = SONG_COMMAND_FILE.read_text(encoding="utf-8").strip().lower()
        SONG_COMMAND_FILE.unlink(missing_ok=True)
    except FileNotFoundError:
        return None
    if value == "next":
        return -1
    if value.isdigit() and 1 <= int(value) <= len(songs):
        return int(value) - 1
    print(f"Invalid song command: {value!r}; choose 1-{len(songs)}.", flush=True)
    return None


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
        input_args = ["-loop", "1", "-framerate", str(FPS), "-i", str(path)]
    elif path.suffix.lower() in VIDEO_EXTS:
        input_args = ["-stream_loop", "-1", "-i", str(path)]
    else:
        raise RuntimeError(f"Unsupported background format: {path.suffix}")

    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        *input_args, "-an", "-vf", common_filter,
        "-thread_queue_size", "512", "-probesize", "32", "-analyzeduration", "0",
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

    songs = list_songs()
    song_index = 0
    destination = f"{RTMP_URL}/{YT_STREAM_KEY}"
    encoder_command = [
        "ffmpeg", "-hide_banner", "-loglevel", "info",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "pipe:0",
        "-thread_queue_size", "512", "-probesize", "32", "-analyzeduration", "0",
        "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:3",
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0", "-pix_fmt", "yuv420p",
        "-b:v", "1500k", "-maxrate", "1500k", "-bufsize", "3000k",
        "-g", "60", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "96k", "-ar", "44100",
        "-flvflags", "no_duration_filesize", "-flush_packets", "1",
        "-f", "flv", destination,
    ]

    encoder = None
    decoder = None
    song_decoder = None
    audio_read_fd = audio_write_fd = None
    game_renderer = None
    try:
        game_renderer = subprocess.Popen(["node", "html_game_renderer.js"], stdout=subprocess.PIPE, stderr=None, bufsize=0)
        print(f"Loaded {len(songs)} songs; audio can be changed without restarting the stream encoder.", flush=True)
        print("Starting FFmpeg livestream; audio encoder stays running during background changes.", flush=True)
        audio_read_fd, audio_write_fd = os.pipe()
        encoder_command[encoder_command.index("pipe:3")] = f"pipe:{audio_read_fd}"
        encoder = subprocess.Popen(encoder_command, stdin=subprocess.PIPE, pass_fds=(audio_read_fd,))
        os.close(audio_read_fd)
        audio_read_fd = None
        decoder = start_background_decoder(current)
        song_decoder = start_song_decoder(songs[song_index])
        print("Song controls ready; alphabetical song list:", flush=True)
        for number, song in enumerate(songs, 1):
            print(f"  !song {number} -> {song.name}", flush=True)

        audio_bytes_per_frame = 44100 * 2 * 2 // FPS
        while encoder.poll() is None:
            requested_song = take_song_command(songs)
            if requested_song is not None:
                song_index = (song_index + 1) % len(songs) if requested_song == -1 else requested_song
                if song_decoder and song_decoder.poll() is None:
                    song_decoder.terminate()
                    try:
                        song_decoder.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        song_decoder.kill()
                        song_decoder.wait()
                song_decoder = start_song_decoder(songs[song_index])
                print(f"Song changed to !song {song_index + 1}: {songs[song_index].name}", flush=True)
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
                audio_chunk = read_exact(song_decoder.stdout, audio_bytes_per_frame)
                if not audio_chunk:
                    song_index = (song_index + 1) % len(songs)
                    if song_decoder and song_decoder.poll() is None:
                        song_decoder.terminate()
                        song_decoder.wait()
                    song_decoder = start_song_decoder(songs[song_index])
                    audio_chunk = read_exact(song_decoder.stdout, audio_bytes_per_frame)
                    print(f"Auto-advanced to !song {song_index + 1}: {songs[song_index].name}", flush=True)
                view = memoryview(audio_chunk)
                while view:
                    written = os.write(audio_write_fd, view)
                    view = view[written:]
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
        for process in (decoder, song_decoder, encoder, game_renderer):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        if audio_write_fd is not None:
            try:
                os.close(audio_write_fd)
            except OSError:
                pass
        if audio_read_fd is not None:
            try:
                os.close(audio_read_fd)
            except OSError:
                pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"STREAM ERROR: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
