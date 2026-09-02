import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, "..", "storage"));
const TEMP_DIR = path.resolve(process.env.TEMP_DIR || path.join(os.tmpdir(), "frameforge-temp"));
const MAX_UPLOAD_GB = Number(process.env.MAX_UPLOAD_GB || 4);
const FILE_TTL_HOURS = Number(process.env.FILE_TTL_HOURS || 24);

await fsp.mkdir(STORAGE_DIR, { recursive: true });
await fsp.mkdir(TEMP_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function safeName(name = "video.mp4") {
  return path.basename(name).replace(/[^\w.\-() ]+/g, "_").slice(0, 160);
}

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: MAX_UPLOAD_GB * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(mp4|mov|m4v|mkv|webm)$/i.test(file.originalname)) return cb(null, true);
    const allowed = [
      "video/mp4",
      "video/quicktime",
      "video/x-m4v",
      "video/x-matroska",
      "video/webm",
      "application/octet-stream"
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Unsupported file type. Use MP4, MOV, M4V, MKV, or WebM."));
  }
});

function run(cmd, args, { onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      onStderr?.(chunk);
    });

    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}\n${stderr.slice(-8000)}`));
    });
  });
}

function fpsToNumber(value) {
  if (!value || value === "0/0") return 0;
  if (!String(value).includes("/")) return Number(value) || 0;
  const [a, b] = String(value).split("/").map(Number);
  return b ? a / b : 0;
}

async function probe(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath
  ]);

  const raw = JSON.parse(stdout);
  const v = raw.streams?.find(s => s.codec_type === "video") || {};
  const a = raw.streams?.find(s => s.codec_type === "audio") || {};
  const fpsText = v.avg_frame_rate || v.r_frame_rate || "0/0";

  return {
    duration: Number(raw.format?.duration || 0),
    size: Number(raw.format?.size || 0),
    bitrate: Number(raw.format?.bit_rate || 0),
    format: raw.format?.format_long_name || raw.format?.format_name || "unknown",
    video: {
      codec: v.codec_name || "unknown",
      profile: v.profile || null,
      width: Number(v.width || 0),
      height: Number(v.height || 0),
      fpsText,
      fps: fpsToNumber(fpsText),
      pixFmt: v.pix_fmt || "unknown",
      bitDepth: v.bits_per_raw_sample ? Number(v.bits_per_raw_sample) : null,
      colorRange: v.color_range || null,
      colorSpace: v.color_space || null,
      colorTransfer: v.color_transfer || null,
      colorPrimaries: v.color_primaries || null
    },
    audio: {
      codec: a.codec_name || null,
      sampleRate: a.sample_rate ? Number(a.sample_rate) : null,
      channels: a.channels || null
    }
  };
}

async function hashWholeFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function hashEncodedVideoStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const child = spawn("ffmpeg", [
      "-v", "error",
      "-i", filePath,
      "-map", "0:v:0",
      "-c:v", "copy",
      "-f", "data",
      "pipe:1"
    ], { windowsHide: true });

    let stderr = "";
    child.stdout.on("data", chunk => hash.update(chunk));
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(hash.digest("hex"));
      else reject(new Error(`Video stream hashing failed.\n${stderr.slice(-4000)}`));
    });
  });
}

async function writeMeta(dir, meta) {
  await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

async function readMeta(id) {
  if (!/^[a-f0-9-]{20,50}$/i.test(id)) return null;
  try {
    const raw = await fsp.readFile(path.join(STORAGE_DIR, id, "meta.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function remuxLosslessly(input, output) {
  await run("ffmpeg", [
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-c", "copy",
    "-movflags", "+faststart+use_metadata_tags",
    output
  ]);
}

async function interpolateTo120(input, output) {
  // Motion-compensated frame interpolation creates synthetic in-between frames.
  // This necessarily re-encodes the video, so it is NOT bit-for-bit lossless.
  await run("ffmpeg", [
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-vf", "minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1",
    "-c:v", "libx264",
    "-preset", process.env.X264_PRESET || "slow",
    "-crf", process.env.X264_CRF || "10",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "320k",
    "-ar", "48000",
    "-movflags", "+faststart",
    output
  ]);
}

function publicBase(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

app.get("/api/health", async (_req, res) => {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
    res.json({ ok: true, ffmpeg: true, maxUploadGB: MAX_UPLOAD_GB, ttlHours: FILE_TTL_HOURS });
  } catch (error) {
    res.status(500).json({ ok: false, ffmpeg: false, error: error.message });
  }
});

app.post("/api/process", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video uploaded." });

  const mode = req.body.mode === "interpolate120" ? "interpolate120" : "preserve";
  const id = crypto.randomUUID();
  const jobDir = path.join(STORAGE_DIR, id);
  const input = req.file.path;
  const originalName = safeName(req.file.originalname);
  const outputName = mode === "preserve"
    ? `preserved-${originalName.replace(/\.(mov|m4v|mkv|webm)$/i, ".mp4")}`
    : `120fps-${originalName.replace(/\.(mov|m4v|mkv|webm)$/i, ".mp4")}`;
  const output = path.join(jobDir, outputName);

  try {
    await fsp.mkdir(jobDir, { recursive: true });

    const before = await probe(input);
    const beforeVideoHash = await hashEncodedVideoStream(input);

    if (mode === "interpolate120" && before.video.fps <= 0) {
      throw new Error("Could not detect the source frame rate.");
    }

    if (mode === "preserve") {
      await remuxLosslessly(input, output);
    } else {
      await interpolateTo120(input, output);
    }

    const after = await probe(output);
    const afterVideoHash = await hashEncodedVideoStream(output);
    const outputFileHash = await hashWholeFile(output);

    const exactVideoStreamPreserved = mode === "preserve" && beforeVideoHash === afterVideoHash;
    if (mode === "preserve" && !exactVideoStreamPreserved) {
      throw new Error("Safety verification failed: encoded video stream changed.");
    }

    const createdAt = new Date();
    const expiresAt = FILE_TTL_HOURS > 0
      ? new Date(createdAt.getTime() + FILE_TTL_HOURS * 3600_000)
      : null;

    const meta = {
      id,
      mode,
      originalName,
      outputName,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt?.toISOString() || null,
      before,
      after,
      verification: {
        beforeVideoStreamSha256: beforeVideoHash,
        afterVideoStreamSha256: afterVideoHash,
        exactVideoStreamPreserved,
        storedFileSha256: outputFileHash,
        delivery: "The /media endpoint serves this stored file directly with byte-range support. FrameForge does not re-compress it while streaming."
      }
    };
    await writeMeta(jobDir, meta);

    const base = publicBase(req);
    res.json({
      ok: true,
      ...meta,
      watchUrl: `${base}/watch/${id}`,
      mediaUrl: `${base}/media/${id}`,
      downloadUrl: `${base}/download/${id}`,
      note: mode === "preserve"
        ? "The encoded video stream was verified byte-for-byte identical before and after the remux."
        : "120 FPS mode creates synthetic intermediate frames and re-encodes the video. It is not genuine camera-captured 120 FPS and cannot be bit-for-bit identical to the source."
    });
  } catch (error) {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    console.error(error);
    res.status(500).json({ error: "Processing failed.", detail: String(error.message || error) });
  } finally {
    await fsp.unlink(input).catch(() => {});
  }
});

app.get("/api/item/:id", async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: "Video not found or expired." });
  res.json(meta);
});

app.get("/watch/:id", async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).send("Video not found or expired.");
  res.sendFile(path.join(__dirname, "..", "public", "watch.html"));
});

app.get("/media/:id", async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).send("Video not found or expired.");

  const filePath = path.join(STORAGE_DIR, meta.id, meta.outputName);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return res.status(404).send("Stored video is missing.");
  }

  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("X-FrameForge-SHA256", meta.verification.storedFileSha256);

  if (!range) {
    res.setHeader("Content-Length", stat.size);
    return fs.createReadStream(filePath).pipe(res);
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) return res.status(416).end();

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start > end || end >= stat.size) return res.status(416).end();

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

app.get("/download/:id", async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).send("Video not found or expired.");
  const filePath = path.join(STORAGE_DIR, meta.id, meta.outputName);
  res.download(filePath, meta.outputName);
});

app.get("/api/verify/:id", async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: "Video not found or expired." });

  const filePath = path.join(STORAGE_DIR, meta.id, meta.outputName);
  try {
    const current = await hashWholeFile(filePath);
    res.json({
      ok: current === meta.verification.storedFileSha256,
      expectedSha256: meta.verification.storedFileSha256,
      currentSha256: current
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function cleanupExpired() {
  if (FILE_TTL_HOURS <= 0) return;
  const entries = await fsp.readdir(STORAGE_DIR, { withFileTypes: true }).catch(() => []);
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readMeta(entry.name);
    if (!meta?.expiresAt) continue;
    if (new Date(meta.expiresAt).getTime() <= now) {
      await fsp.rm(path.join(STORAGE_DIR, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

setInterval(cleanupExpired, 60 * 60 * 1000).unref();
cleanupExpired().catch(console.error);

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large. Current limit is ${MAX_UPLOAD_GB} GB.` });
  }
  res.status(400).json({ error: err?.message || "Request failed." });
});

app.listen(PORT, () => {
  console.log(`FrameForge running on http://localhost:${PORT}`);
  console.log(`Storage: ${STORAGE_DIR}`);
});
