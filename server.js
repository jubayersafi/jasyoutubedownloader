import express from "express";
import path from "path";
import axios from "axios";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const cookiePath = path.join(__dirname, "cookies.txt");
if (process.env.YOUTUBE_COOKIES) {
  try {
    fs.writeFileSync(cookiePath, process.env.YOUTUBE_COOKIES.trim());
    console.log("YouTube cookies successfully written to cookies.txt");
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
  res.json({ ok: true, service: "jas-web-backend-ytdlp" });
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
  const { url, videoId: bodyVideoId } = req.body || {};
  const videoId = bodyVideoId || (typeof url === "string" ? extractYouTubeId(url) : null);
  if (!videoId) return res.status(400).json({ error: "Valid videoId is required." });

  const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const args = ["--dump-json", "--no-playlist"];
  if (fs.existsSync(cookiePath)) {
    args.push("--cookies", cookiePath);
  }
  args.push(targetUrl);

  const ytDlp = spawn("yt-dlp", args);
  let dataString = "";

  ytDlp.stdout.on("data", (chunk) => {
    dataString += chunk;
  });

  ytDlp.on("close", (code) => {
    if (code !== 0) {
      return res.status(403).json({ code: "BOT_CHECK", error: "YouTube bot check or extraction failed." });
    }

    const standardHeights = [1080, 720, 480, 360];
    const formatsList = standardHeights.map((h) => ({
      id: `${h}p`,
      height: h,
      label: h === 1080 ? "1080p Full HD" : h === 720 ? "720p HD" : h === 480 ? "480p SD" : "360p Fast",
      ext: "mp4",
      sizeLabel: "",
    }));

    formatsList.push({
      id: "audio",
      height: 0,
      label: "Audio Only (MP3)",
      ext: "mp3",
      sizeLabel: "",
    });

    res.json({ formats: formatsList });
  });
});

app.post("/api/download", async (req, res) => {
  const { url, videoId: bodyVideoId, quality = "1080p" } = req.body || {};
  const videoId = bodyVideoId || (typeof url === "string" ? extractYouTubeId(url) : null);

  if (!videoId) {
    return res.status(400).json({ error: "Valid YouTube video ID or URL is required." });
  }

  const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const isAudio = quality === "audio" || quality === "mp3" || quality === "m4a";

  const args = ["--no-playlist"];
  if (fs.existsSync(cookiePath)) {
    args.push("--cookies", cookiePath);
  }

  if (isAudio) {
    args.push("-f", "bestaudio", "-x", "--audio-format", "mp3", "--audio-quality", "192k", "-o", "-");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="youtube_audio.mp3"`);
  } else {
    const heightNum = parseInt(quality, 10) || 720;
    args.push("-f", `bestvideo[height<=${heightNum}]+bestaudio/best[height<=${heightNum}]`, "--merge-output-format", "mp4", "-o", "-");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="youtube_video_${heightNum}p.mp4"`);
  }

  args.push(targetUrl);

  const ytDlp = spawn("yt-dlp", args);
  ytDlp.stdout.pipe(res);

  ytDlp.stderr.on("data", (err) => {
    console.error("yt-dlp log:", err.toString());
  });

  ytDlp.on("error", () => {
    if (!res.headersSent) res.status(500).json({ error: "Download process failed." });
  });

  req.on("close", () => {
    ytDlp.kill("SIGKILL");
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`JAS Web Version (yt-dlp) running on http://localhost:${PORT}`);
});
