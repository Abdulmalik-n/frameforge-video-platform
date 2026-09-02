# FrameForge V2

FrameForge has two deliberately separate video modes.

## 1. Preserve Master

This is the only mode that can truthfully claim exact preservation of the **encoded video stream**.

It uses FFmpeg stream copy:

```bash
ffmpeg -i input.mp4 \
  -map 0:v:0 -map 0:a? \
  -map_metadata -1 -map_chapters -1 \
  -c copy \
  -movflags +faststart+use_metadata_tags \
  output.mp4
```

The server hashes the encoded video stream before and after. If the hashes differ, it rejects the output.

It then stores that MP4 and serves it directly through `/media/:id` using HTTP byte-range responses. FrameForge itself does not create a lower-resolution streaming rendition.

### What “100%” can mean

When somebody watches a preserved file **on your own FrameForge site**, the server delivers the stored file rather than transcoding it.

That does **not** mean every display will look pixel-for-pixel identical: browsers, operating systems, HDR pipelines, display panels and color management can render the same encoded file differently.

It also does **not** guarantee TikTok, Instagram, YouTube, X, Discord, etc. will keep the file untouched. Those platforms own their upload/transcoding pipelines.

No external website can force TikTok to skip server-side transcoding.

## 2. 120 FPS Creator

This mode converts a lower-frame-rate source to a 120 FPS timeline with FFmpeg's motion-compensated `minterpolate` filter:

```text
minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1
```

It creates synthetic in-between frames.

Important:

- 60 → 120 FPS is possible.
- The extra 60 frames each second are **generated**, not camera-captured.
- Motion interpolation can create artifacts around fast motion, occlusion, particles, text, hands, wheels, etc.
- The video must be re-encoded, so this mode can never be bit-for-bit identical to the source.
- The default H.264 settings are CRF 10 + `slow`, which prioritizes visual quality over file size and speed.
- 4K 120 FPS interpolation is extremely CPU-heavy.

For better interpolation quality at scale, the next upgrade would be a GPU/AI interpolation worker such as RIFE running in a separate processing service.

## Local run

Requirements:

- Node.js 20+
- FFmpeg / ffprobe

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Docker

```bash
docker compose up --build
```

Open `http://localhost:3000`.

## Environment settings

Copy `.env.example` values into your hosting environment.

Key values:

```text
MAX_UPLOAD_GB=4
FILE_TTL_HOURS=24
X264_PRESET=slow
X264_CRF=10
```

Set `FILE_TTL_HOURS=0` if you do not want automatic deletion.

## Production warning: large videos

Do not rely on a tiny free web host for multi-GB 4K video.

A production version should use:

- an object store such as S3 or Cloudflare R2,
- multipart/direct-to-object-storage uploads,
- a background FFmpeg worker,
- a queue,
- persistent metadata/database,
- CDN delivery,
- authentication and abuse controls.

The included project is a functional self-hosted starter and is suitable for a VPS or a Docker server with enough disk/CPU.

## GitHub

Create a blank repository, extract this project, open a terminal inside it and run:

```bash
git init
git add .
git commit -m "Build FrameForge V2"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

This chat does not currently have an authenticated GitHub connector, so it cannot push into your account directly.

## Safety / honest product claims

Good claims:

- "No video re-encoding in Preserve mode."
- "Encoded video stream verified with SHA-256."
- "FrameForge serves the stored file directly without making a lower-quality rendition."
- "Create a motion-interpolated 120 FPS version."

Claims to avoid:

- "TikTok will show the exact original file."
- "60 FPS becomes genuine camera-captured 120 FPS."
- "100% quality is guaranteed on every third-party platform."
