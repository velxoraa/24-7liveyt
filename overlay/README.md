# KAXMOK Quiz Arena

The live quiz is rendered directly by the GitHub Actions FFmpeg stream using `quiz_game.py`. It is not an OBS/browser-source overlay.

## Play in YouTube chat
During the live stream, viewers answer the on-screen multiple-choice question by typing:
- `!quiz A`
- `!quiz B`
- `!quiz C`
- `!quiz D`

Also accepted: `!answer A` or `!q A`.

Each viewer's first answer in a round is counted. Correct answers earn 100 points. The in-stream Hall of Fame displays the current stream session's top scores. Quiz voting is handled by `chat_reader.js` and `quiz_votes.jsonl`; rendering is composited into the existing raw video frames by `stream.py`.

The HTML file `quiz-overlay.html` is a standalone style/demo preview only. It is not what GitHub Actions renders into YouTube.
