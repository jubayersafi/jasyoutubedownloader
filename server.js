import express from "express";
import path from "path";
import axios from "axios";
import { Innertube } from "youtubei.js";
import { spawn } from "child_process";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// Render কুকিজ ভ্যারিয়েবল থেকে টেম্পোরারি cookies.txt ফাইল তৈরি করা
let cookiePath = undefined;
if (process.env.YOUTUBE_COOKIES) {
  try {
    cookiePath = path.join(__dirname, "cookies.txt");
    fs.writeFileSync(cookiePath, process.env.YOUTUBE_COOKIES.trim());
    console.log("YouTube cookies successfully loaded into cookies.txt");
  } catch (e) {
    console.error("Failed to write cookies.txt:", e);
  }
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition,Content-Length");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "jas-web-backend" });
});

function extractYouTubeId(rawUrl) {
  try {
    const trimmed = String(rawUrl || "").trim();
    const urlMatch = trimmed.match(/https?:\/\/[^\s]+/);
    const cleanUrl = urlMatch ? urlMatch[0] : trimmed;
    const parsed = new URL(cleanUrl);

    if (parsed.hostname.includes("youtu.be")) {
      const id = parsed.pathname.replace(/^\//, "").split("/")[0];
      return id || null;
    }

    if (parsed.hostname.includes("youtube.com") || parsed.hostname.includes("youtube-nocookie.com")) {
      const vParam = parsed.searchParams.get("v");
      if (vParam) return vParam;

      const parts = parsed.pathname.split("/").filter(Boolean);
      if (["shorts", "embed", "live", "v"].includes(parts[0]) && parts[1]) {
        return parts[1];
      }
    }
  } catch {
    const regex = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/;
    const match = String(rawUrl || "").match(regex);
    if (match) return match[1];
  }
  return null;
}

function sanitizeFilename(name) {
  return (
    String(name || "jas_video")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "jas_video"
  );
}

function formatBytes(bytes) {
  const num = Number(bytes);
  if (!num || Number.isNaN(num) || num <= 0) return "";
  if (num >= 1024 * 1024 * 1024) return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(num / (1024 * 1024)))} MB`;
}

function getEffectiveHeight(f) {
  if (f.width && f.height) return Math.min(f.width, f.height);
  return f.height || 0;
}

async function resolveVideoStream(videoId, quality, cookie) {
  // youtubei.js-এর জন্য কুকিজ পাথ বা স্ট্রিং কনফিগারেশন ঠিক করা হয়েছে
  const ytCookie = cookiePath && fs.existsSync(cookiePath) ? cookiePath : (cookie || process.env.YOUTUBE_COOKIES || undefined);
  
  const yt = await Innertube.create({
    retrieve_player: true,
    cookie: ytCookie,
  });

  const clientsToTry = ["IOS", "VISIONOS", "ANDROID", "WEB"];
  let lastReason = "Could not retrieve video stream.";

  for (const client of clientsToTry) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });
      const status = info.playability_status?.status;
      if (status && status !== "OK") {
        lastReason = info.playability_status?.reason || status;
        continue;
      }

      const streaming = info.streaming_data;
      if (!streaming) continue;

      const title = sanitizeFilename(info.basic_info?.title || `youtube_${videoId}`);

      if (quality === "audio" || quality === "mp3" || quality === "m4a") {
        const audioFormat = info.chooseFormat({
          type: "audio",
          quality: "best",
        });
        const streamUrl = await audioFormat.decipher(yt.session.player);
        if (streamUrl) {
          return {
            title,
            streamUrl,
            audioUrl: null,
            mimeType: audioFormat.mime_type || "audio/mp4",
            ext: quality === "m4a" ? "m4a" : "mp3",
            isAudio: true,
          };
        }
      }

      const targetHeight = parseInt(String(quality), 10) || 1080;

      const adaptiveAll = streaming.adaptive_formats || [];
      const bestAac = adaptiveAll
        .filter((f) => f.has_audio && !f.has_video && f.mime_type?.includes("audio/mp4"))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const bestWebmAudio = adaptiveAll
        .filter((f) => f.has_audio && !f.has_video && f.mime_type?.includes("audio/webm"))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      const adaptiveVideos = adaptiveAll
        .filter((f) => f.has_video && !f.has_audio && (f.height || f.width))
        .sort((a, b) => {
          const hDiff = getEffectiveHeight(b) - getEffectiveHeight(a);
          if (hDiff !== 0) return hDiff;
          const aMp4 = a.mime_type?.includes("video/mp4") ? 1 : 0;
          const bMp4 = b.mime_type?.includes("video/mp4") ? 1 : 0;
          if (bMp4 !== aMp4) return bMp4 - aMp4;
          return (b.bitrate || 0) - (a.bitrate || 0);
        });

      const exactOrLower = adaptiveVideos.filter((f) => getEffectiveHeight(f) <= targetHeight);
      const pickedAdaptive = exactOrLower[0] || adaptiveVideos[0];

      if (pickedAdaptive) {
        const isWebm = pickedAdaptive.mime_type?.includes("video/webm");
        const audioPair = isWebm ? bestWebmAudio || bestAac : bestAac;
        if (audioPair && getEffectiveHeight(pickedAdaptive) > 360) {
          const videoUrl = await pickedAdaptive.decipher(yt.session.player);
          const audioUrl = await audioPair.decipher(yt.session.player);
          if (videoUrl && audioUrl) {
            return {
              title,
              streamUrl: videoUrl,
              audioUrl,
              mimeType: isWebm && bestWebmAudio ? "video/webm" : "video/mp4",
              ext: isWebm && bestWebmAudio ? "webm" : "mp4",
              isAudio: false,
            };
          }
        }
      }

      const combinedFormats = (streaming.formats || [])
        .filter((f) => f.has_audio && f.has_video)
        .sort((a, b) => getEffectiveHeight(b) - getEffectiveHeight(a));

      const selected =
        combinedFormats.find((f) => getEffectiveHeight(f) <= targetHeight) || combinedFormats[0];

      if (selected) {
        const streamUrl = await selected.decipher(yt.session.player);
        if (streamUrl) {
          return {
            title,
            streamUrl,
            audioUrl: null,
            mimeType: "video/mp4",
            ext: "mp4",
            isAudio: false,
          };
        }
      }
    } catch (err) {
      lastReason = err?.message || lastReason;
    }
  }

  const isBotCheck =
    lastReason.toLowerCase().includes("bot") ||
    lastReason.toLowerCase().includes("login_required") ||
    lastReason.toLowerCase().includes("sign in");

  const error = new Error(lastReason);
  error.code = isBotCheck ? "BOT_CHECK" : "EXTRACTION_FAILED";
  throw error;
}

app.post("/api/video-info", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }

  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return res.status(400).json({ error: "Please enter a valid YouTube video or Shorts URL." });
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
    const response = await axios.get(oembedUrl, { timeout: 10000 });

    res.json({
      videoId,
      title: response.data.title,
      author: response.data.author_name,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      provider: response.data.provider_name || "YouTube",
      url: canonicalUrl,
    });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch video metadata. Please check the URL." });
  }
});

app.post("/api/formats", async (req, res) => {
  const { url, videoId: bodyVideoId, cookie } = req.body || {};
  const videoId = bodyVideoId || (typeof url === "string" ? extractYouTubeId(url) : null);
  if (!videoId) return res.status(400).json({ error: "Valid videoId is required." });

  try {
    const ytCookie = cookiePath && fs.existsSync(cookiePath) ? cookiePath : (cookie || process.env.YOUTUBE_COOKIES || undefined);
    const yt = await Innertube.create({
      retrieve_player: true,
      cookie: ytCookie,
    });

    let info = null;
    let lastReason = "Could not load video qualities.";
    for (const client of ["IOS", "VISIONOS", "ANDROID"]) {
      try {
        const attempt = await yt.getBasicInfo(videoId, { client });
        if (attempt.playability_status?.status && attempt.playability_status.status !== "OK") {
          lastReason = attempt.playability_status.reason || attempt.playability_status.status;
          continue;
        }
        if (attempt.streaming_data?.adaptive_formats?.length) {
          info = attempt;
          break;
        }
      } catch (e) {
        lastReason = e?.message || lastReason;
      }
    }

    if (!info) {
      return res.status(403).json({ code: "BOT_CHECK", error: lastReason });
    }

    const adaptive = info.streaming_data?.adaptive_formats || [];
    const bestAac = adaptive
      .filter((f) => f.has_audio && !f.has_video && f.mime_type?.includes("audio/mp4"))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    const bestWebmAudio = adaptive
      .filter((f) => f.has_audio && !f.has_video && f.mime_type?.includes("audio/webm"))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    const map = new Map();
    for (const f of adaptive) {
      const h = getEffectiveHeight(f);
      if (!f.has_video || !h) continue;
      const isMp4 = f.mime_type?.includes("video/mp4");
      const isWebm = f.mime_type?.includes("video/webm");
      if (!isMp4 && !isWebm) continue;
      const existing = map.get(h);
      if (!existing || (isMp4 && existing.ext !== "mp4")) {
        const audioPair = isMp4 ? bestAac : bestWebmAudio || bestAac;
        map.set(h, {
          id: `${h}p`,
          height: h,
          label:
            h >= 2160
              ? `${h}p 4K`
              : h >= 1440
                ? `${h}p 2K`
                : h >= 1080
                  ? `${h}p Full HD`
                  : h >= 720
                    ? `${h}p HD`
                    : `${h}p`,
          ext: isMp4 ? "mp4" : "webm",
          sizeLabel: formatBytes((Number(f.content_length) || 0) + (Number(audioPair?.content_length) || 0)),
        });
      }
    }

    const formats = Array.from(map.values()).sort((a, b) => b.height - a.height);
    if (bestAac || bestWebmAudio) {
      const refAudio = bestAac || bestWebmAudio;
      formats.push({
        id: "audio",
        height: 0,
        label: "Audio Only (MP3)",
        ext: "mp3",
        sizeLabel: formatBytes(refAudio.content_length),
      });
    }

    res.json({ formats });
  } catch (err) {
    res.status(403).json({ code: "BOT_CHECK", error: err?.message || "Could not load formats" });
  }
});

app.post("/api/download", async (req, res) => {
  const { url, videoId: bodyVideoId, quality = "1080p", cookie } = req.body || {};
  const videoId = bodyVideoId || (typeof url === "string" ? extractYouTubeId(url) : null);

  if (!videoId) {
    return res.status(400).json({ error: "Valid YouTube video ID or URL is required." });
  }

  try {
    const { title, streamUrl, audioUrl, isAudio, ext } = await resolveVideoStream(
      videoId,
      quality,
      typeof cookie === "string" ? cookie : undefined
    );

    if (!isAudio && audioUrl) {
      const isWebm = ext === "webm";
      res.setHeader("Content-Type", isWebm ? "video/webm" : "video/mp4");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(`${title} (${quality}).${ext}`)}`
      );

      const ffArgs = [
        "-i",
        streamUrl,
        "-i",
        audioUrl,
        "-c",
        "copy",
        ...(isWebm ? ["-f", "webm"] : ["-movflags", "frag_keyframe+empty_moov", "-f", "mp4"]),
        "pipe:1",
      ];

      const ff = spawn("ffmpeg", ffArgs);
      ff.stdout.pipe(res);
      ff.on("error", () => {
        if (!res.headersSent) res.status(500).json({ error: "HD video muxing failed (ffmpeg required)." });
      });
      req.on("close", () => ff.kill("SIGKILL"));
      return;
    }

    const upstream = await fetch(streamUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `Upstream media stream failed (${upstream.status}).` });
    }

    const nodeStream = Readable.fromWeb(upstream.body);

    if (isAudio && ext === "mp3") {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(`${title}.mp3`)}`
      );

      const ff = spawn("ffmpeg", [
        "-i",
        "pipe:0",
        "-vn",
        "-acodec",
        "libmp3lame",
        "-ab",
        "192k",
        "-f",
        "mp3",
        "pipe:1",
      ]);

      nodeStream.pipe(ff.stdin);
      ff.stdout.pipe(res);
      ff.on("error", () => {
        if (!res.headersSent) res.status(500).json({ error: "Audio conversion failed (ffmpeg required)." });
      });
      req.on("close", () => {
        ff.kill("SIGKILL");
        nodeStream.destroy();
      });
      return;
    }

    const finalExt = isAudio ? "m4a" : "mp4";
    res.setHeader("Content-Type", isAudio ? "audio/mp4" : "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`${title} (${quality}).${finalExt}`)}`
    );
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    nodeStream.pipe(res);
    req.on("close", () => nodeStream.destroy());
  } catch (err) {
    const code = err?.code || "EXTRACTION_FAILED";
    const status = code === "BOT_CHECK" ? 403 : 500;
    res.status(status).json({
      code,
      error:
        code === "BOT_CHECK"
          ? "YouTube requested browser verification for this server IP. Add YouTube cookies in Session Settings or run from your own server/IP."
          : err?.message || "Failed to download video.",
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`JAS Web Version running on http://localhost:${PORT}`);
});
