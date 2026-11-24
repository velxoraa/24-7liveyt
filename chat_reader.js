import { Innertube, YTNodes } from "youtubei.js";
import { spawn } from "node:child_process";
import { writeFile, rename } from "node:fs/promises";

const VIDEO_ID = process.env.YT_VIDEO_ID || "FhD_vXt8MEM";
const ANALYTICS_URL = process.env.ANALYTICS_URL || "https://kaxmok-analytics.kaxxmok.workers.dev";
const PYTHON = process.env.PYTHON || "python";
const BG_COMMAND_FILE = "bg_command.txt";

let receivedMessages = 0;
let stopping = false;
let liveChat = null;

function avatarUrl(author) {
  const thumbs = author?.thumbnails || [];
  return thumbs.length ? (thumbs[thumbs.length - 1].url || "") : "";
}

async function main() {
  console.log(`Starting unauthenticated YouTube chat reader for video ${VIDEO_ID}.`);

  if (!process.env.ANALYTICS_INGEST_TOKEN) {
    throw new Error("Missing ANALYTICS_INGEST_TOKEN GitHub Actions secret.");
  }

  const python = spawn(PYTHON, ["-u", "analytics.py"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ANALYTICS_URL }
  });

  python.on("error", error => {
    console.error("Could not start analytics.py:", error.message);
    process.exitCode = 1;
  });
  python.stdin.on("error", error => {
    console.error("Analytics bridge input error:", error.message);
  });

  let output = "";
  python.stdout.setEncoding("utf8");
  python.stdout.on("data", chunk => {
    output += chunk;
    const lines = output.split("\n");
    output = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "reply") {
          console.log(`Worker reply for ${event.author || "viewer"}: ${event.text || ""}`);
          console.warn("Worker requested a chat reply, but unauthenticated mode cannot post messages to YouTube.");
        } else if (event.type === "error") {
          console.error("Analytics bridge:", event.error);
        }
      } catch {
        console.error("Unrecognized analytics bridge output:", line);
      }
    }
  });

  python.on("exit", code => {
    console.error("analytics.py exited with code", code);
    if (code !== 0 && !stopping) console.error("Analytics forwarding has stopped; the video stream can continue.");
  });

  console.log("Connecting to YouTube using the public TV_EMBEDDED client...");
  const innertube = await Innertube.create();
  // TV_EMBEDDED avoids the bot-check response seen on the default WEB client.
  // Basic info avoids the extra watch-next request made by getInfo().
  const info = await innertube.getBasicInfo(VIDEO_ID, { client: "TV_EMBEDDED" });
  const ownerChannelId = info.basic_info?.channel_id || "";
  liveChat = info.getLiveChat();

  liveChat.on("chat-update", action => {
    try {
      if (!action.is(YTNodes.AddChatItemAction)) return;
      const item = action.as(YTNodes.AddChatItemAction).item;
      if (!item || item.type !== "LiveChatTextMessage") return;

      const author = item.author;
      const authorId = author?.id || "";
      if (!authorId) return;

      const message = item.message?.toString?.() || "";
      if (!message) return;

      // Background commands are handled locally and never depend on Cloudflare.
      const bgMatch = message.trim().match(/^!bg\s+(\d+)$/i);
      if (bgMatch) {
        const tempPath = BG_COMMAND_FILE + ".tmp";
        void writeFile(tempPath, bgMatch[1] + "\n", "utf8")
          .then(() => rename(tempPath, BG_COMMAND_FILE))
          .then(() => console.log(`Background change requested: !bg ${bgMatch[1]} by ${author.name?.toString?.() || authorId}`))
          .catch(error => console.error("Could not send background command to stream:", error.message));
      }

      // Owner commands can control the stream, but owner messages stay out of analytics.
      if (authorId === ownerChannelId) return;

      const event = {
        author_id: authorId,
        author: author?.name?.toString?.() || "Viewer",
        avatar_url: avatarUrl(author),
        is_moderator: Boolean(author?.is_moderator || author?.is_owner),
        text: message
      };

      if (!python.stdin.write(JSON.stringify(event) + "\n")) {
        console.warn("Analytics bridge is backpressured; waiting for it to catch up.");
      }
      receivedMessages += 1;
      if (receivedMessages === 1 || receivedMessages % 10 === 0) {
        console.log(`Received ${receivedMessages} viewer chat message(s); forwarding to analytics bridge.`);
      }
    } catch (error) {
      console.error("Chat event handling error:", error.message);
    }
  });

  liveChat.on("error", error => console.error("YouTube live chat error:", error?.message || error));
  liveChat.start();
  console.log(`Reading public live chat for video ${VIDEO_ID}; no OAuth secrets required.`);

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping YouTube chat reader...");
    try { liveChat?.stop(); } catch {}
    python.stdin.end();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(error => {
  console.error("CHAT READER ERROR:", error);
  process.exit(1);
});
