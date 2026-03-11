# videogaga

Download and combine videos from Instagram, Facebook, and YouTube.

Uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) as the primary downloader with a Playwright browser fallback for Instagram and Facebook when yt-dlp fails.

## Prerequisites

- **Node.js** >= 18
- **yt-dlp** — `brew install yt-dlp`
- **ffmpeg** — `brew install ffmpeg`
- **Playwright browsers** — installed automatically, or run `npx playwright install chromium`

## Install

```bash
npm install videogaga
```

Or install globally for CLI usage:

```bash
npm install -g videogaga
```

## CLI Usage

```bash
# Download a single video
videogaga https://youtube.com/shorts/abc123

# Download with custom output name
videogaga https://www.instagram.com/reel/abc123/ my-reel.mp4

# Combine multiple videos (3s black intermissions between clips)
videogaga \
  https://youtube.com/shorts/abc \
  https://www.instagram.com/reel/xyz/ \
  -o compilation.mp4
```

## Library Usage

```js
// ESM
import { downloadVideo, combineVideos, detectPlatform, getVideoId, getDefaultOutputName } from "videogaga";

// CommonJS
const { downloadVideo, combineVideos, detectPlatform, getVideoId, getDefaultOutputName } = require("videogaga");

// Download a single video
await downloadVideo("https://youtube.com/shorts/abc123", "/path/to/output.mp4");

// Download and combine multiple videos
const files = ["/path/to/clip1.mp4", "/path/to/clip2.mp4"];
combineVideos(files, "/path/to/combined.mp4", 3); // 3s intermission

// Utility: detect platform from URL
detectPlatform("https://www.instagram.com/reel/abc/"); // "instagram"

// Utility: extract video ID
getVideoId("https://youtube.com/shorts/xyz", "youtube"); // { id: "xyz", type: "short" }

// Utility: generate default filename
getDefaultOutputName("youtube", { id: "xyz", type: "short" }); // "yt_short_xyz.mp4"
```

## API

### `downloadVideo(url, outputPath) → Promise<void>`

Downloads a video from a supported URL. Tries yt-dlp first, falls back to Playwright browser capture for Instagram/Facebook.

### `combineVideos(videoPaths, outputPath, intermissionSecs?) → void`

Combines multiple local video files into one. Normalizes all clips to 1080x1920 @ 30fps and inserts black intermissions between them. Default intermission is 3 seconds.

### `detectPlatform(url) → string | null`

Returns `"instagram"`, `"facebook"`, `"youtube"`, or `null`.

### `getVideoId(url, platform) → object | string | null`

Extracts the video/reel ID from a URL.

### `getDefaultOutputName(platform, videoId) → string`

Generates a default output filename based on platform and video ID.

## How it works

1. Detects the platform from the URL
2. Tries **yt-dlp** first (best quality, H.264 + AAC)
3. Falls back to **Playwright** browser capture for Instagram/Facebook — intercepts CDN video/audio streams, downloads them, and merges with ffmpeg
4. When combining multiple videos, normalizes all clips to 1080x1920 @ 30fps and inserts black intermissions

## License

MIT
