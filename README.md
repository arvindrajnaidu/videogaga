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
npm install
```

## Usage

### Single video

```bash
node reel-download.js <url> [output-filename]
```

### Multiple videos (combined with 3s black intermissions)

```bash
node reel-download.js <url1> <url2> <url3> [-o combined-output.mp4]
```

### Examples

```bash
# Download a YouTube Short
node reel-download.js https://youtube.com/shorts/abc123

# Download an Instagram Reel
node reel-download.js https://www.instagram.com/reel/abc123/

# Download a Facebook Reel
node reel-download.js https://www.facebook.com/reel/123456789

# Combine multiple videos
node reel-download.js \
  https://youtube.com/shorts/abc \
  https://www.instagram.com/reel/xyz/ \
  -o compilation.mp4
```

## How it works

1. Detects the platform from the URL
2. Tries **yt-dlp** first (best quality, H.264 + AAC)
3. Falls back to **Playwright** browser capture for Instagram/Facebook — intercepts CDN video/audio streams, downloads them, and merges with ffmpeg
4. When combining multiple videos, normalizes all clips to 1080x1920 @ 30fps and inserts black intermissions

## License

MIT
