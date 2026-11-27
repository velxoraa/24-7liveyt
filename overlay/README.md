# KAXMOK Words On Stream – HTML Anagram Game

The live overlay is built in `overlay/anagram-game.html` using HTML, CSS and JavaScript. A headless Chromium renderer captures the transparent overlay and the existing FFmpeg stream composites it over the selected background.

## Viewer play

Viewers type a word directly in YouTube chat, e.g. `planet` — no command prefix.

- More than 100 curated letter racks / rounds
- Words must be in the current rack's accepted word list and respect the available letter counts
- Each discovered word can only be claimed once per round
- 10 points per letter, plus a 50-point bonus for using every rack letter
- 55-second rounds, word-length groups, 60-word goal, level display and top-five leaderboard

The existing FFmpeg audio playlist, YouTube public chat reader, and `!bg N` background switching remain in place.

The in-game leaderboard is session-local and does not yet persist to the Analytics Worker.
