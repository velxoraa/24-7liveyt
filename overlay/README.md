# KAXMOK Words On Stream – Anagram Game

The game is rendered directly into the livestream by `word_game.py`, composited over the existing background frames in `stream.py`, then encoded by the existing FFmpeg process. It is not an OBS/browser source.

## Viewer command

Type a word using the seven letters shown on screen:

`!world PLANET`

Rules:
- 3–7 letters.
- The word must be in the current round's curated answer list and use only the displayed letters.
- A discovered word can only be claimed once in that round.
- Points: 10 per letter, plus 50 bonus points for a seven-letter word.
- The overlay shows the shuffled letters, countdown, discovered-word slots, 60-word goal, level, and top three word hunters.

## Existing stream features

The anagram game does not replace the playlist, FFmpeg process, YouTube chat reader, or `!bg N` background-switching command.

The anagram leaderboard is currently local to the active GitHub Actions stream session. Persistent Analytics Worker score storage is not connected yet.
