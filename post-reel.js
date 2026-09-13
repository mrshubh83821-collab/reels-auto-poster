// post-reel.js
// Picks ONE not-yet-posted video from a Google Drive folder,
// generates a caption + hashtags with Gemini, and publishes it
// as a Facebook Reel on the Page. Meant to be run repeatedly
// (e.g. by GitHub Actions cron) — each run posts exactly one reel.

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const TRACKING_FILE = path.join(__dirname, "posted.json");

// ---------- ENV VARS (set these as GitHub Secrets) ----------
const {
  GDRIVE_FOLDER_ID,
  GDRIVE_SERVICE_ACCOUNT_JSON, // base64-encoded service account JSON
  FB_PAGE_ID,
  FB_PAGE_TOKEN,
  GEMINI_API_KEY,
} = process.env;

function requireEnv() {
  const missing = [
    "GDRIVE_FOLDER_ID",
    "GDRIVE_SERVICE_ACCOUNT_JSON",
    "FB_PAGE_ID",
    "FB_PAGE_TOKEN",
    "GEMINI_API_KEY",
  ].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error("Missing required env vars: " + missing.join(", "));
  }
}

function loadTracking() {
  if (!fs.existsSync(TRACKING_FILE)) return { posted: [] };
  return JSON.parse(fs.readFileSync(TRACKING_FILE, "utf8"));
}

function saveTracking(data) {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
}

async function getDriveClient() {
  const keyJson = JSON.parse(
    Buffer.from(GDRIVE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8")
  );
  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

async function listDriveVideos(drive) {
  const res = await drive.files.list({
    q: `'${GDRIVE_FOLDER_ID}' in parents and mimeType contains 'video/' and trashed = false`,
    fields: "files(id, name, createdTime)",
    orderBy: "createdTime",
    pageSize: 1000,
  });
  return res.data.files || [];
}

async function downloadDriveFile(drive, fileId, destPath) {
  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );
  await new Promise((resolve, reject) => {
    res.data.pipe(dest).on("finish", resolve).on("error", reject);
  });

  const stats = fs.statSync(destPath);
  if (!stats.size) {
    throw new Error(`Downloaded file ${destPath} is empty (0 bytes)`);
  }
}

async function generateCaption(fileName) {
  const prompt = `You are writing a short, punchy Instagram/Facebook Reels caption
for an AI-generated video. The source filename is "${fileName}" (may contain hints
about the content, ignore if not useful). Write:
1. A catchy 1-2 line caption (with 1-2 relevant emojis, no more)
2. 8-12 relevant trending hashtags for AI videos / reels / viral content

Respond ONLY as JSON: {"caption": "...", "hashtags": "#tag1 #tag2 ..."}
No markdown, no extra text.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  const data = await res.json();
  let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  text = text.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(text);
    return `${parsed.caption}\n\n${parsed.hashtags}`;
  } catch {
    // Fallback if Gemini output isn't clean JSON
    return "Watch till the end! 🔥\n\n#AIvideo #Reels #Viral #Trending #AIart #ForYou #Explore #MustWatch";
  }
}

async function uploadReelToFacebook(videoPath, description) {
  // Step 1: Start upload session
  const startRes = await fetch(
    `https://graph.facebook.com/v20.0/${FB_PAGE_ID}/video_reels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "start",
        access_token: FB_PAGE_TOKEN,
      }),
    }
  ).then((r) => r.json());

  if (!startRes.video_id || !startRes.upload_url) {
    throw new Error("Failed to start upload session: " + JSON.stringify(startRes));
  }

  const { video_id, upload_url } = startRes;

  // Step 2: Upload the actual video bytes
  const fileBuffer = fs.readFileSync(videoPath);
  const fileSize = fileBuffer.length;
  console.log(`Uploading ${videoPath} (${fileSize} bytes)`);

  const uploadRes = await fetch(upload_url, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${FB_PAGE_TOKEN}`,
      offset: "0",
      file_size: String(fileSize),
      "Content-Length": String(fileSize),
      "Content-Type": "application/octet-stream",
    },
    body: fileBuffer,
    duplex: "half",
  }).then((r) => r.json());

  if (uploadRes.success !== true) {
    throw new Error("Video upload failed: " + JSON.stringify(uploadRes));
  }

  // Step 3: Finish / publish
  const finishRes = await fetch(
    `https://graph.facebook.com/v20.0/${FB_PAGE_ID}/video_reels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "finish",
        video_id,
        description,
        video_state: "PUBLISHED",
        access_token: FB_PAGE_TOKEN,
      }),
    }
  ).then((r) => r.json());

  if (finishRes.success !== true) {
    throw new Error("Publish failed: " + JSON.stringify(finishRes));
  }

  return video_id;
}

async function main() {
  requireEnv();

  const tracking = loadTracking();
  const postedIds = new Set(tracking.posted.map((p) => p.id));

  const drive = await getDriveClient();
  const files = await listDriveVideos(drive);

  const next = files.find((f) => !postedIds.has(f.id));
  if (!next) {
    console.log("No new videos to post. All caught up!");
    return;
  }

  console.log(`Posting: ${next.name} (${next.id})`);

  const tmpPath = path.join("/tmp", next.name.replace(/[^a-zA-Z0-9._-]/g, "_"));
  await downloadDriveFile(drive, next.id, tmpPath);
  console.log("Downloaded to", tmpPath);

  const caption = await generateCaption(next.name);
  console.log("Generated caption:\n", caption);

  const videoId = await uploadReelToFacebook(tmpPath, caption);
  console.log("Posted! Facebook video_id:", videoId);

  tracking.posted.push({
    id: next.id,
    name: next.name,
    fb_video_id: videoId,
    postedAt: new Date().toISOString(),
  });
  saveTracking(tracking);

  fs.unlinkSync(tmpPath);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
