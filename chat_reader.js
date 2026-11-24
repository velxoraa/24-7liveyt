import { Innertube, YTNodes } from "youtubei.js";
import { spawn } from "node:child_process";
import { writeFile, rename } from "node:fs/promises";
import { google } from "googleapis";

const VIDEO_ID = process.env.YT_VIDEO_ID || "FhD_vXt8MEM";
const ANALYTICS_URL = process.env.ANALYTICS_URL || "https://kaxmok-analytics.kaxxmok.workers.dev";
const PYTHON = process.env.PYTHON || "python";
const BG_COMMAND_FILE = "bg_command.txt";

let liveChatId = null;
let youtubeApi = null;
let sendQueue = Promise.resolve();
let lastSendAt = 0;
let receivedMessages = 0;

function parseJsonSecret(name) {
  const value = process.env[name];
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} is not valid JSON. Paste the complete JSON file contents into the GitHub secret.`);
  }
}

// Reply posting is optional. It must never prevent incoming chat from being read.
async function initializeYouTubeSender() {
  const token = parseJsonSecret("YT_TOKEN_JSON");
  const client = parseJsonSecret("YT_CLIENT_SECRET_JSON");
  if (!token || !client) {
    console.warn("YouTube reply sending is disabled: OAuth secrets are not configured.");
    return;
  }

  const credentials = client.installed || client.web || client;
  const oauth = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    (credentials.redirect_uris || ["http://localhost"])[0]
  );
  oauth.setCredentials(token);
  youtubeApi = google.youtube({ version: "v3", auth: oauth });

  const broadcast = await youtubeApi.liveBroadcasts.list({
    part: ["snippet"],
    id: [VIDEO_ID]
  });
  liveChatId = broadcast.data.items?.[0]?.snippet?.liveChatId || null;
  if (!liveChatId) {
    console.warn("No liveChatId found for reply posting. Incoming chat reading remains active.");
  } else {
    console.log("YouTube chat reply sender is ready.");
  }
}

async function sendReply(text) {
  if (!youtubeApi || !liveChatId || !text) return;
  sendQueue = sendQueue.then(async () => {
    const wait = Math.max(0, 1500 - (Date.now() - lastSendAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    await youtubeApi.liveChatMessages.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          liveChatId,
          type: "textMessageEvent",
          textMessageDetails: { messageText: String(text).slice(0, 200) }
        }
      }
    });
    lastSendAt = Date.now();
    console.log("Posted Worker reply to live chat.");
  }).catch(error => console.error("Could not post Worker reply:", error.message));
  return sendQueue;
}

function avatarUrl(author) {
  const thumbs = author?.thumbnails || [];
  return thumbs.length ? (thumbs[thumbs.length - 1].url || "") : "";
}

async function main() {
  console.log(`Starting YouTube chat reader for video ${VIDEO_ID}.`);

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
    process.exitCode = 1;
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
          void sendReply(event.text);
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
    if (code !== 0) process.exitCode = code || 1;
  });

  console.log("Connecting to YouTube live chat...");
  const innertube = await Innertube.create();
  const info = await innertube.getInfo(VIDEO_ID);
  const ownerChannelId = info.basic_info?.channel_id || "";
  const liveChat = info.getLiveChat();
  if (!liveChat) {
    throw new Error("No live chat is available for this video. Confirm the configured video is live and chat is enabled.");
  }

  // Do not apply a filter before LiveChat.start() retrieves its initial info.
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

      // Handle background commands locally so they never depend on the Worker.
      const bgMatch = message.trim().match(/^!bg\s+(\d+)$/i);
      if (bgMatch) {
        const tempPath = BG_COMMAND_FILE + ".tmp";
        void writeFile(tempPath, bgMatch[1] + "\n", "utf8")
          .then(() => rename(tempPath, BG_COMMAND_FILE))
          .then(() => console.log(`Background change requested: !bg ${bgMatch[1]}`))
          .catch(error => console.error("Could not send background command to stream:", error.message));
      }

      // Owner commands can control the stream, but owner messages stay out of the leaderboard.
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
  await liveChat.start();
  console.log(`Reading live chat for video ${VIDEO_ID} and forwarding messages to ${ANALYTICS_URL}.`);

  // Start optional OAuth reply support only after incoming chat is already running.
  void initializeYouTubeSender().catch(error => {
    console.error("YouTube reply sender unavailable (chat reading continues):", error.message);
  });

  const shutdown = () => {
    try { liveChat.stop(); } catch {}
    python.stdin.end();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(error => {
  console.error("CHAT READER ERROR:", error);
  process.exit(1);
});
