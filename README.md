# 24-7liveyt

Automated YouTube livestream project for the KAXMOK music stream.

## Planned features

- Continuous MP3 playlist playback through FFmpeg
- Normal video background and birthday image switching
- YouTube Live Chat command reader
- `!birthday` and `!normal` background commands
- Analytics/leaderboard forwarding to the existing KAXMOK Analytics Worker
- GitHub Actions runner for the livestream

## Repository layout

- `songs/` — upload the MP3 files here
- `assets/backgrounds/` — upload the normal background video and `birthday.png`
- `chat_reader.js` — YouTube Live Chat reader
- `analytics.py` — command handling and analytics forwarding
- `stream.py` — FFmpeg stream process and playlist
- `config.example.json` — non-secret configuration template
- `.github/workflows/stream.yml` — livestream workflow (to be added after the Worker contract and stream settings are verified)

## Required GitHub Actions secrets

Add these in **Settings → Secrets and variables → Actions**:

- `YT_STREAM_KEY` — YouTube stream key
- `ANALYTICS_INGEST_TOKEN` — must match the existing Analytics Worker ingest token

Never put either secret in a committed file or share it in chat.

## Existing Analytics Worker

Base URL: https://kaxmok-analytics.kaxxmok.workers.dev/

The Worker and its stored leaderboard data must remain unchanged. The exact ingest route and JSON payload will be confirmed against the existing Worker before enabling forwarding.

## Media upload locations

Upload MP3s to `songs/`.

Upload the normal background video and birthday image to `assets/backgrounds/`. The configured filenames must match the files you upload.

## Safety before starting a stream

The workflow will not be enabled until the FFmpeg inputs, YouTube video ID, Worker ingest contract, and command switching have been checked. Starting a new workflow run may interrupt an already-running stream.
