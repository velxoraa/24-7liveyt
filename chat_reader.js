import { Innertube, YTNodes } from "youtubei.js";
import { spawn } from "node:child_process";
import { google } from "googleapis";
import { writeFile, rename } from "node:fs/promises";

const VIDEO_ID = process.env.YT_VIDEO_ID || "FhD_vXt8MEM";
const ANALYTICS_URL = (process.env.ANALYTICS_URL || "https://kaxmok-analytics.kaxxmok.workers.dev").replace(/\/$/, "");
const PYTHON = process.env.PYTHON || "python";
const BG_COMMAND_FILE = "bg_command.txt";

let liveChat = null;
let python = null;
let stopping = false;
let receivedMessages = 0;
let workerAccepted = 0;
let bgWriteQueue = Promise.resolve();
let youtubeApi = null;
let liveChatId = null;
let sendQueue = Promise.resolve();
let lastSendAt = 0;

function avatarUrl(author) {
  const thumbs = author?.thumbnails || [];
  return thumbs.length ? (thumbs[thumbs.length - 1].url || "") : "";
}

function parseJsonSecret(name) {
  const value = process.env[name];
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    console.warn(`${name} is not valid JSON; optional YouTube reply sending is disabled.`);
    return null;
  }
}

// Optional reply sender. It never blocks public incoming-chat reading.
async function initializeYouTubeSender() {
  const token = parseJsonSecret("YT_TOKEN_JSON");
  const client = parseJsonSecret("YT_CLIENT_SECRET_JSON");
  if (!token || !client) {
    console.log("Optional YouTube reply sender disabled; incoming chat and Worker commands remain enabled.");
    return;
  }

  const credentials = client.installed || client.web || client;
  if (!credentials.client_id || !credentials.client_secret) {
    console.warn("OAuth client JSON is missing client_id/client_secret; reply sender disabled.");
    return;
  }

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
  if (liveChatId) console.log("Optional YouTube reply sender is ready.");
  else console.warn("No active liveChatId found; Worker replies will be logged but not posted.");
}

function sendReply(message) {
  if (!youtubeApi || !liveChatId || !message || stopping) return;
  sendQueue = sendQueue.then(async () => {
    const wait = Math.max(0, 1500 - (Date.now() - lastSendAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    await youtubeApi.liveChatMessages.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          liveChatId,
          type: "textMessageEvent",
          textMessageDetails: { messageText: String(message).slice(0, 200) }
        }
      }
    });
    lastSendAt = Date.now();
    console.log("Posted Worker reply to YouTube live chat.");
  }).catch(error => console.error("Could not post Worker reply:", error.message));
  return sendQueue;
}

function queueBackgroundChange(number, author) {
  const tempPath = `${BG_COMMAND_FILE}.${process.pid}.tmp`;
  bgWriteQueue = bgWriteQueue
    .then(() => writeFile(tempPath, String(number) + "\n", "utf8"))
    .then(() => rename(tempPath, BG_COMMAND_FILE))
    .then(() => console.log(`Background change requested: !bg ${number} by ${author}`))
    .catch(error => console.error("Could not send background command to stream:", error.message));
}

async function main() {
  console.log(`Starting public YouTube chat reader for video ${VIDEO_ID}.`);

  if (!process.env.ANALYTICS_INGEST_TOKEN) {
    throw new Error("Missing ANALYTICS_INGEST_TOKEN GitHub Actions secret.");
  }

  python = spawn(PYTHON, ["-u", "analytics.py"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ANALYTICS_URL }
  });
  python.on("error", error => console.error("Could not start analytics.py:", error.message));
  python.stdin.on("error", error => {
    if (!stopping) console.error("Analytics bridge input error:", error.message);
  });
  python.on("exit", code => {
    if (!stopping) console.error("analytics.py exited unexpectedly with code", code);
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
        } else if (event.type === "ingested") {
          workerAccepted += 1;
          if (workerAccepted === 1 || workerAccepted % 10 === 0) {
            console.log(`Analytics Worker accepted ${workerAccepted} chat message(s).`);
          }
        } else if (event.type === "error") {
          console.error("Analytics bridge:", event.error);
        }
      } catch {
        console.error("Unrecognized analytics bridge output:", line);
      }
    }
  });

  const innertube = await Innertube.create();
  let info = null;
  let lastError = null;

  // Use the normal watch client first. Basic info avoids the extra /next request
  // that caused earlier 403s. Android is a fallback; TV_EMBEDDED rejects this
  // broadcast because YouTube reports that it is not embeddable.
  for (const client of ["WEB", "TVHTML5", "ANDROID"]) {
    try {
      console.log(`Connecting to public live chat with YouTube ${client} client...`);
      // youtubei.js 15+ requires client selection inside an options object.
      const candidate = await innertube.getBasicInfo(VIDEO_ID, { client });
      const candidateChat = candidate.getLiveChat();
      if (!candidateChat) throw new Error("YouTube returned no live-chat continuation.");
      info = candidate;
      liveChat = candidateChat;
      console.log(`Loaded video info and live-chat continuation using ${client}.`);
      break;
    } catch (error) {
      lastError = error;
      console.error(`YouTube ${client} client failed:`, error?.message || error);
    }
  }

  if (!info || !liveChat) {
    throw new Error(`Could not load public live chat using WEB, TVHTML5 or ANDROID: ${lastError?.message || "No live-chat continuation returned"}`);
  }

  const ownerChannelId = info.basic_info?.channel_id || "";
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

      // Owner commands are intentionally allowed, but owner messages are not
      // forwarded to the Worker leaderboard/analytics.
      const authorName = author?.name?.toString?.() || authorId;
      const bgMatch = message.trim().match(/^!bg\s+(\d+)$/i);
      if (bgMatch) queueBackgroundChange(bgMatch[1], authorName);

      if (authorId === ownerChannelId) return;

      const event = {
        author_id: authorId,
        author: authorName,
        avatar_url: avatarUrl(author),
        is_moderator: Boolean(author?.is_moderator || author?.is_owner),
        text: message
      };

      if (!python.stdin.write(JSON.stringify(event) + "\n")) {
        console.warn("Analytics bridge is backpressured; Node is buffering chat events.");
      }
      receivedMessages += 1;
      if (receivedMessages === 1 || receivedMessages % 10 === 0) {
        console.log(`Received ${receivedMessages} viewer chat message(s); forwarding to Analytics Worker.`);
      }
    } catch (error) {
      console.error("Chat event handling error:", error.message);
    }
  });

  liveChat.on("error", error => console.error("YouTube live chat polling error:", error?.message || error));
  await liveChat.start();
  console.log(`PUBLIC CHAT READER CONNECTED: forwarding messages to ${ANALYTICS_URL}/api/ingest.`);

  // Replies are optional. Incoming chat remains active if OAuth is absent or invalid.
  void initializeYouTubeSender().catch(error => {
    console.error("Optional YouTube reply sender unavailable; incoming chat continues:", error.message);
  });

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping YouTube chat reader...");
    try { liveChat?.stop(); } catch {}
    try { python?.stdin.end(); } catch {}
    try { python?.kill("SIGTERM"); } catch {}
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(error => {
  console.error("CHAT READER ERROR:", error);
  try { liveChat?.stop(); } catch {}
  try { python?.stdin.end(); } catch {}
  try { python?.kill("SIGTERM"); } catch {}
  process.exit(1);
});
