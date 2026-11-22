import { Innertube, YTNodes } from "youtubei.js";
import { spawn } from "node:child_process";
import { google } from "googleapis";

const VIDEO_ID = process.env.YT_VIDEO_ID || "XVF4AhsrUqM";
const ANALYTICS_URL = process.env.ANALYTICS_URL || "https://kaxmok-analytics.kaxxmok.workers.dev";
const PYTHON = process.env.PYTHON || "python";

let liveChatId = null;
let youtubeApi = null;
let sendQueue = Promise.resolve();
let lastSendAt = 0;

function parseJsonSecret(name) {
  const value = process.env[name];
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} is not valid JSON. Paste the complete JSON file contents into the GitHub secret.`);
  }
}

async function initializeYouTubeSender() {
  const token = parseJsonSecret("YT_TOKEN_JSON");
  const client = parseJsonSecret("YT_CLIENT_SECRET_JSON");
  if (!token || !client) {
    console.warn("YouTube reply sending is disabled: YT_TOKEN_JSON and/or YT_CLIENT_SECRET_JSON are not configured.");
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
    console.warn("No active liveChatId found for the configured YouTube video. Worker replies will be logged but not posted.");
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
  if (!process.env.ANALYTICS_INGEST_TOKEN) {
    throw new Error("Missing ANALYTICS_INGEST_TOKEN GitHub Actions secret.");
  }

  await initializeYouTubeSender();

  const python = spawn(PYTHON, ["-u", "analytics.py"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ANALYTICS_URL }
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
    process.exitCode = code || 1;
  });

  const innertube = await Innertube.create();
  const info = await innertube.getInfo(VIDEO_ID);
  const ownerChannelId = info.basic_info?.channel_id || "";
  const liveChat = info.getLiveChat();
  if (!liveChat) throw new Error("No live chat is available for this video. Confirm the stream is live and chat is enabled.");

  liveChat.applyFilter("LIVE_CHAT");
  liveChat.on("chat-update", action => {
    try {
      if (!action.is(YTNodes.AddChatItemAction)) return;
      const item = action.as(YTNodes.AddChatItemAction).item;
      if (!item || item.type !== "LiveChatTextMessage") return;

      const author = item.author;
      const authorId = author?.id || "";
      if (!authorId || authorId === ownerChannelId) return;

      const message = item.message?.toString?.() || "";
      if (!message) return;

      const event = {
        author_id: authorId,
        author: author?.name?.toString?.() || "Viewer",
        avatar_url: avatarUrl(author),
        is_moderator: Boolean(author?.is_moderator || author?.is_owner),
        text: message
      };
      python.stdin.write(JSON.stringify(event) + "\n");
    } catch (error) {
      console.error("Chat event handling error:", error.message);
    }
  });

  liveChat.on("error", error => console.error("YouTube live chat error:", error));
  liveChat.start();
  console.log(`Reading live chat for video ${VIDEO_ID} and forwarding messages to ${ANALYTICS_URL}.`);

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
