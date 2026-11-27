import { Innertube, YTNodes } from "youtubei.js";
import { spawn } from "node:child_process";
import { google } from "googleapis";
import { writeFile, rename, appendFile } from "node:fs/promises";

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
let wordVoteQueue = Promise.resolve();
let youtubeApi = null;
let liveChatId = null;
let ownerChannelId = "";
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
  const broadcastItem = broadcast.data.items?.[0];
  liveChatId = broadcastItem?.snippet?.liveChatId || null;
  ownerChannelId = broadcastItem?.snippet?.channelId || "";
  if (liveChatId) console.log("Authenticated YouTube Live Chat API is ready.");
  else console.warn("No active liveChatId found; authenticated chat polling is unavailable.");
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

function handleIncomingMessage({ authorId, authorName, avatar, isModerator, text: message }) {
  if (!authorId || !message) return;
  const bgMatch = message.trim().match(/^!bg\s+(\d+)$/i);
  if (bgMatch) queueBackgroundChange(bgMatch[1], authorName || authorId);
  const directWord = message.trim().match(/^([A-Za-z]{3,8})$/);
  if (directWord) {
    const vote = { id: authorId, name: authorName || authorId, word: directWord[1].toUpperCase(), at: Date.now() };
    wordVoteQueue = wordVoteQueue.then(() => appendFile("word_messages.jsonl", JSON.stringify(vote) + "\n", "utf8"))
      .catch(error => console.error("Could not record direct word answer:", error.message));
  }
  if (ownerChannelId && authorId === ownerChannelId) return;
  const event = { author_id: authorId, author: authorName || authorId, avatar_url: avatar || "", is_moderator: Boolean(isModerator), text: message };
  if (!python.stdin.write(JSON.stringify(event) + "\n")) console.warn("Analytics bridge is backpressured; Node is buffering chat events.");
  receivedMessages += 1;
  if (receivedMessages === 1 || receivedMessages % 10 === 0) console.log("Received " + receivedMessages + " viewer chat message(s); forwarding to Analytics Worker.");
}

async function pollAuthenticatedLiveChat() {
  let pageToken;
  console.log("AUTHENTICATED CHAT READER CONNECTED: polling liveChatId for " + VIDEO_ID + ".");
  while (!stopping) {
    const response = await youtubeApi.liveChatMessages.list({ liveChatId, part: ["snippet", "authorDetails"], pageToken });
    pageToken = response.data.nextPageToken || pageToken;
    for (const item of response.data.items || []) {
      const snippet = item.snippet || {};
      if (snippet.type !== "textMessageEvent") continue;
      const author = item.authorDetails || {};
      handleIncomingMessage({ authorId: author.channelId, authorName: author.displayName, avatar: author.profileImageUrl, isModerator: author.isChatModerator || author.isChatOwner, text: snippet.textMessageDetails?.messageText || "" });
    }
    const waitMs = Math.max(1000, Number(response.data.pollingIntervalMillis) || 5000);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
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

  // Prefer the official authenticated Live Chat API when OAuth credentials are configured.
  await initializeYouTubeSender().catch(error => console.error("Authenticated chat setup failed; trying public fallback:", error.message));
  if (youtubeApi && liveChatId) {
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      console.log("Stopping YouTube chat reader...");
      try { python?.stdin.end(); } catch {}
      try { python?.kill("SIGTERM"); } catch {}
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await pollAuthenticatedLiveChat();
    return;
  }

  // Use the same public InnerTube flow that was present in run #10.
  // Do not call applyFilter(): youtubei.js 13.4.0 throws before initial chat info exists.
  const innertube = await Innertube.create();
  const info = await innertube.getInfo(VIDEO_ID);
  ownerChannelId = info.basic_info?.channel_id || ownerChannelId;
  liveChat = info.getLiveChat();
  if (!liveChat) {
    throw new Error("No live-chat continuation returned. Confirm the stream is live and chat is enabled.");
  }
  console.log("Loaded video info and live-chat continuation using the public InnerTube session.");

  liveChat.on("chat-update", action => {
    try {
      if (!action.is(YTNodes.AddChatItemAction)) return;
      const item = action.as(YTNodes.AddChatItemAction).item;
      if (!item || item.type !== "LiveChatTextMessage") return;

      const author = item.author;
      handleIncomingMessage({
        authorId: author?.id || "",
        authorName: author?.name?.toString?.() || "",
        avatar: avatarUrl(author),
        isModerator: Boolean(author?.is_moderator || author?.is_owner),
        text: item.message?.toString?.() || ""
      });
    } catch (error) {
      console.error("Chat event handling error:", error.message);
    }
  });

  liveChat.on("error", error => {
    console.error("YouTube live chat polling error:", error?.message || error);
    // Exit so the workflow supervisor restarts the reader instead of leaving
    // a dead chat connection running forever beside the livestream.
    setTimeout(() => process.exit(1), 1000);
  });
  liveChat.on("end", () => {
    if (!stopping) {
      console.error("YouTube live chat connection ended; exiting for supervisor restart.");
      process.exit(1);
    }
  });
  await liveChat.start();
  console.log(`PUBLIC CHAT READER CONNECTED: forwarding messages to ${ANALYTICS_URL}/api/ingest.`);

  // OAuth sender was initialized above when credentials were available.

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
