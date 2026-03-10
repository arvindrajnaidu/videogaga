#!/usr/bin/env node

const { chromium } = require("playwright");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { URL } = require("url");

const reelUrl = process.argv[2];
const outputName = process.argv[3];

if (!reelUrl || !reelUrl.includes("instagram.com")) {
  console.error("Usage: node ig-download.js <instagram-reel-url> [output-filename]");
  console.error("Example: node ig-download.js https://www.instagram.com/reel/DVoTfSFEthj/");
  process.exit(1);
}

// Derive default output name from reel ID in URL
function getDefaultOutputName(url) {
  const match = url.match(/\/reel\/([^/?]+)/);
  if (match) return `reel_${match[1]}.mp4`;
  return `reel_${Date.now()}.mp4`;
}

const finalOutput = outputName || getDefaultOutputName(reelUrl);

// Parse the efg query param (base64-encoded JSON) to get bitrate and stream type
function parseEfg(efgParam) {
  try {
    const json = JSON.parse(Buffer.from(efgParam, "base64").toString("utf-8"));
    const vencTag = json.venc_tag || json.vencode_tag || "";
    // Audio detection: check venc_tag, or if there's no video codec info but audio codec present
    const isAudio =
      vencTag.toLowerCase().includes("audio") ||
      vencTag.toLowerCase().includes("dash_audio") ||
      (json.video_codec === "audio" || false);
    return {
      bitrate: json.bitrate || 0,
      vencTag,
      isAudio,
    };
  } catch {
    return { bitrate: 0, vencTag: "", isAudio: false };
  }
}

// Strip byte-range params to get the canonical base URL for deduplication
function getBaseUrl(urlStr) {
  const u = new URL(urlStr);
  u.searchParams.delete("bytestart");
  u.searchParams.delete("byteend");
  return u.toString();
}

// Download a URL to a file
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    mod
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          downloadFile(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function main() {
  console.log(`Fetching reel: ${reelUrl}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Collect .mp4 CDN URLs from network responses
  const capturedUrls = new Map(); // baseUrl -> { url, bitrate, isAudio, vencTag }

  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes(".mp4") || !url.includes("cdninstagram.com")) return;

    const u = new URL(url);
    const efg = u.searchParams.get("efg");
    if (!efg) return;

    const parsed = parseEfg(efg);
    const base = getBaseUrl(url);

    // Keep the entry (deduplicate by base URL, prefer higher bitrate)
    // IMPORTANT: use the base URL (no byte-range params) for downloading
    const existing = capturedUrls.get(base);
    if (!existing || parsed.bitrate > existing.bitrate) {
      capturedUrls.set(base, { url: base, ...parsed });
    }
  });

  // Navigate to the reel
  await page.goto(reelUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Dismiss login dialog if it appears
  try {
    const closeBtn = page.locator('svg[aria-label="Close"]').first();
    await closeBtn.click({ timeout: 5000 });
    console.log("Dismissed login dialog");
  } catch {
    // No dialog, that's fine
  }

  // Wait for video streams to load
  console.log("Waiting for video streams to load...");
  await page.waitForTimeout(8000);

  await browser.close();

  // Process captured URLs
  const entries = Array.from(capturedUrls.values());
  console.log(`Captured ${entries.length} unique stream URLs`);

  if (entries.length === 0) {
    console.error("No video streams captured. The reel may be private or the page structure changed.");
    process.exit(1);
  }

  const audioStreams = entries.filter((e) => e.isAudio);
  const videoStreams = entries.filter((e) => !e.isAudio);

  console.log(`  Video streams: ${videoStreams.length}`);
  console.log(`  Audio streams: ${audioStreams.length}`);

  if (videoStreams.length === 0) {
    console.error("No video streams found.");
    process.exit(1);
  }

  // Pick highest bitrate video
  videoStreams.sort((a, b) => b.bitrate - a.bitrate);
  const bestVideo = videoStreams[0];
  console.log(`Selected video: bitrate=${bestVideo.bitrate}, venc=${bestVideo.vencTag}`);

  const tmpVideo = path.join(process.cwd(), `_tmp_video_${Date.now()}.mp4`);
  const tmpAudio = path.join(process.cwd(), `_tmp_audio_${Date.now()}.mp4`);
  const outputPath = path.join(process.cwd(), finalOutput);

  // Download video
  console.log("Downloading video stream...");
  await downloadFile(bestVideo.url, tmpVideo);

  if (audioStreams.length > 0) {
    // Pick highest bitrate audio
    audioStreams.sort((a, b) => b.bitrate - a.bitrate);
    const bestAudio = audioStreams[0];
    console.log(`Selected audio: bitrate=${bestAudio.bitrate}, venc=${bestAudio.vencTag}`);

    console.log("Downloading audio stream...");
    await downloadFile(bestAudio.url, tmpAudio);

    // Merge with ffmpeg
    console.log("Merging video + audio with ffmpeg...");
    try {
      execSync(
        `ffmpeg -y -i "${tmpVideo}" -i "${tmpAudio}" -c:v libx264 -c:a copy "${outputPath}"`,
        { stdio: "pipe" }
      );
    } catch (err) {
      console.error("ffmpeg merge failed:", err.stderr?.toString() || err.message);
      process.exit(1);
    }

    // Clean up temp files
    fs.unlinkSync(tmpVideo);
    fs.unlinkSync(tmpAudio);
  } else {
    // No separate audio - just re-encode the video
    console.log("No separate audio stream found. Re-encoding video...");
    try {
      execSync(`ffmpeg -y -i "${tmpVideo}" -c:v libx264 -c:a copy "${outputPath}"`, {
        stdio: "pipe",
      });
    } catch (err) {
      console.error("ffmpeg failed:", err.stderr?.toString() || err.message);
      process.exit(1);
    }
    fs.unlinkSync(tmpVideo);
  }

  console.log(`Done! Saved to ${finalOutput}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
