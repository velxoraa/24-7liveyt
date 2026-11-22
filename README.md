# KAXMOK 24/7 YouTube Livestream

This repository runs the KAXMOK music livestream with a continuous shuffled MP3 playlist, one normal looping background video, YouTube Live Chat reading, and the existing KAXMOK Analytics Worker.

## Media files

- Put audio files in `songs/` (`.mp3`, `.mpeg`, or `.mp2`).
- Normal background video: `assets/backgrounds/WhatsApp Video 2026-11-14 at 4.16.22 PM.mp4`.
- Birthday/background switching is not included in this version.

The playlist is shuffled for each round. The first track of a new round is adjusted when needed so it does not immediately repeat the last track of the previous round.

## Existing Analytics Worker

The project forwards each chat message to:

`https://kaxmok-analytics.kaxxmok.workers.dev/api/ingest`

The bridge sends the Worker's expected `{ "messages": [...] }` body and Bearer token. The Worker remains the owner of the leaderboard and its existing KV data. This repository does not create, reset, or write directly to KV.

## GitHub Actions secrets

Open **Settings → Secrets and variables → Actions** and add:

Required:
- `YT_STREAM_KEY` — YouTube stream key.
- `ANALYTICS_INGEST_TOKEN` — must match the existing Worker's `INGEST_TOKEN`.

Optional, for posting Worker-generated command replies back into YouTube chat:
- `YT_CLIENT_SECRET_JSON` — complete OAuth client-secret JSON file contents.
- `YT_TOKEN_JSON` — complete OAuth token JSON file contents for the channel that owns the livestream.

Do not paste secret values into chat or commit them to this repository. If the two optional OAuth secrets are absent, chat messages will still be read and forwarded to the Worker, but replies will only appear in the Actions log and will not be posted to YouTube chat.

## Starting the livestream

1. Confirm the YouTube broadcast is live or scheduled and the video ID in `.github/workflows/stream.yml` is correct.
2. Confirm the required GitHub secrets are configured.
3. Open **Actions → KAXMOK 24/7 Live Stream → Run workflow**.

The workflow runs for up to 350 minutes because of GitHub-hosted runner limits. It is manual; it does not start automatically on every push.

**Important:** starting a new run cancels the previous run in the same concurrency group and can interrupt the stream. Do not start a second run while one is already streaming.

## Notes

- FFmpeg uses the background video for video only; its audio is not mapped.
- The MP3 playlist supplies the stream audio continuously.
- The chat reader forwards viewer IDs, names, avatars, moderator status, and message text.
- YouTube's API may impose quota limits on posting bot replies.
- Only stream music and visuals that you have permission to broadcast.
