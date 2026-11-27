# KAXMOK Quiz Arena Overlay

Premium transparent HTML quiz overlay for OBS/browser capture.

## Open in OBS
1. Download `quiz-overlay.html` from this folder to your streaming PC.
2. In OBS, add **Browser** source and select **Local file**.
3. Choose the HTML file; set width `1920`, height `1080` (or match your canvas).
4. Enable transparent background if your OBS version exposes that setting.
5. To show the operator buttons, add `?control=1` to the local file URL, for example `file:///C:/KAXMOK/quiz-overlay.html?control=1`.

## Controls
- Click an answer card or press A/B/C/D to answer.
- Space or **Next round** advances.
- **Reset scores** clears the browser's local quiz scores.
- **Demo score +** is only for preview/testing.
- Scores are stored in that browser's localStorage.

## Important current limitation
This is an HTML overlay preview with a local browser leaderboard. It is **not yet wired to YouTube chat or the Cloudflare Analytics Worker**, and the current GitHub Actions FFmpeg stream does not capture browser sources. Therefore adding this file to the repository alone will not make it appear in the existing livestream. A live-stream integration requires a browser-render/capture step in `stream.py` (or OBS on a streaming PC) plus a Worker endpoint for shared quiz answers and persistent quiz leaderboard. The existing music and `!bg` pipeline remains unchanged.
