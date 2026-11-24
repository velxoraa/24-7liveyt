import { spawn } from "node:child_process";
import { writeFile, rename } from "node:fs/promises";
import { google } from "googleapis";

const VIDEO_ID = process.env.YT_VIDEO_ID || "FhD_vXt8MEM";
const ANALYTICS_URL = process.env.ANALYTICS_URL || "https://kaxmok-analytics.kaxxmok.workers.dev";
const PYTHON = process.env.PYTHON || "python";
const BG_COMMAND_FILE = "bg_command.txt";

let liveChatId = null;
let youtubeApi = null;
let ownerChannelId = "";
let sendQueue = Promise.resolve();
let lastSendAt = 0;
let receivedMessages = 0;
let stopping = false;

function parseJsonSecret(name) {
  const value = process.env[name];
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} is not valid JSON. Paste the complete JSON file contents into the GitHub secret.`);
  }
}

async function initializeYouTubeApi() {
  const token = parseJsonSecret("YT_TOKEN_JSON");
  const client = parseJsonSecret("YT_CLIENT_SECRET_JSON");
  if (!token || !client) {
    throw new Error("Incoming chat requires YT_TOKEN_JSON and YT_CLIENT_SECRET_JSON GitHub Actions secrets.");
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
  const item = broadcast.data.items?.[0];
  liveChatId = item?.snippet?.liveChatId || null;
  ownerChannelId = item?.snippet?.channelId || "";
  if (!liveChatId) {
    throw new Error(`YouTube Data API did not return a liveChatId for ${VIDEO_ID}. Confirm the OAuth account owns this live broadcast and live chat is enabled.`);
  }
  console.log(`YouTube Data API connected. Live chat ID found for ${VIDEO_ID}.`);
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

function handleChatMessage(item, python) {
  const author = item.authorDetails || {};
  const authorId = author.channelId || "";
  const message = item.snippet?.textMessageDetails?.messageText || "";
  if (!authorId || !message) return;

  // Handle background commands locally; they do not depend on Cloudflare.
  const bgMatch = message.trim().match(/^!bg\s+(\d+)$/i);
  if (bgMatch) {
    const tempPath = BG_COMMAND_FILE + ".tmp";
    void writeFile(tempPath, bgMatch[1] + "\n", "utf8")
      .then(() => rename(tempPath, BG_COMMAND_FILE))
      .then(() => console.log(`Background change requested: !bg ${bgMatch[1]} by ${author.displayName || authorId}`))
      .catch(error => console.error("Could not send background command to stream:", error.message));
  }

  // Owner commands still work, but owner messages are excluded from analytics.
  if (authorId === ownerChannelId || author.isChatOwner) return;

  const event = {
    author_id: authorId,
    author: author.displayName || "Viewer",
    avatar_url: author.profileImageUrl || "",
    is_moderator: Boolean(author.isChatModerator || author.isChatOwner),
    text: message
  };

  if (!python.stdin.write(JSON.stringify(event) + "\n")) {
    console.warn("Analytics bridge is backpressured; waiting for it to catch up.");
  }
  receivedMessages += 1;
  if (receivedMessages === 1 || receivedMessages % 10 === 0) {
    console.log(`Received ${receivedMessages} viewer chat message(s); forwarding to analytics bridge.`);
  }
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
    if (code !== 0 && !stopping) process.exitCode = code || 1;
  });

  await initializeYouTubeApi();

  let pageToken;
  let pollIntervalMs = 5000;
  console.log(`Reading live chat for video ${VIDEO_ID} using the official YouTube Data API.`);

  while (!stopping) {
    try {
      const response = await youtubeApi.liveChatMessages.list({
        liveChatId,
        part: ["snippet", "authorDetails"],
        ...(pageToken ? { pageToken } : {})
      });

      for (const item of response.data.items || []) {
        handleChatMessage(item, python);
      }

      pageToken = response.data.nextPageToken || pageToken;
      pollIntervalMs = Math.max(1000, Number(response.data.pollingIntervalMillis) || 5000);
    } catch (error) {
      const status = error.code || error.response?.status || "unknown";
      const reason = error.response?.data?.error?.errors?.[0]?.reason || "";
      console.error(`YouTube Data API chat poll failed (HTTP ${status}${reason ? `, ${reason}` : ""}): ${error.message}`);
      if (error.response?.data?.error?.message) {
        console.error("YouTube API detail:", error.response.data.error.message);
      }
      // Keep the livestream alive during temporary API/network errors.
      pollIntervalMs = 15000;
    }

    if (!stopping) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  python.stdin.end();
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("Stopping YouTube chat reader...");
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(error => {
  console.error("CHAT READER ERROR:", error);
  process.exit(1);
});
