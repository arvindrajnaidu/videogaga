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

// Detect platform
function detectPlatform(url) {
  if (!url) return null;
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("facebook.com") || url.includes("fb.watch")) return "facebook";
  return null;
}

const platform = detectPlatform(reelUrl);

if (!platform) {
  console.error("Usage: node reel-download.js <reel-url> [output-filename]");
  console.error("Supports Instagram and Facebook reels.");
  console.error("Examples:");
  console.error("  node reel-download.js https://www.instagram.com/reel/DVoTfSFEthj/");
  console.error("  node reel-download.js https://www.facebook.com/reel/1690521082387945/");
  process.exit(1);
}

// Extract reel ID from URL
function getReelId(url, platform) {
  const match = url.match(/\/reel\/([^/?]+)/);
  return match ? match[1] : null;
}

const reelId = getReelId(reelUrl, platform);

// Derive default output name
function getDefaultOutputName(platform, reelId) {
  const prefix = platform === "facebook" ? "fb_reel" : "ig_reel";
  if (reelId) return `${prefix}_${reelId}.mp4`;
  return `${prefix}_${Date.now()}.mp4`;
}

const finalOutput = outputName || getDefaultOutputName(platform, reelId);

// For Facebook, the reel ID in the URL is the numeric video_id.
// We use this to filter out preloaded adjacent reels.
const fbVideoId = platform === "facebook" && reelId ? Number(reelId) : null;

// Parse the efg query param (base64-encoded JSON) to get bitrate and stream type
function parseEfg(efgParam) {
  try {
    const json = JSON.parse(Buffer.from(efgParam, "base64").toString("utf-8"));
    const vencTag = json.venc_tag || json.vencode_tag || "";
    const isAudio =
      vencTag.toLowerCase().includes("audio") ||
      vencTag.toLowerCase().includes("dash_audio");
    return {
      bitrate: json.bitrate || 0,
      vencTag,
      isAudio,
      videoId: json.video_id || null,
    };
  } catch {
    return { bitrate: 0, vencTag: "", isAudio: false, videoId: null };
  }
}

// Strip byte-range params to get the canonical base URL for deduplication and full download
function getBaseUrl(urlStr) {
  const u = new URL(urlStr);
  u.searchParams.delete("bytestart");
  u.searchParams.delete("byteend");
  return u.toString();
}

// CDN host pattern for each platform
function isCdnUrl(url, platform) {
  if (!url.includes(".mp4")) return false;
  if (platform === "instagram") return url.includes("cdninstagram.com");
  if (platform === "facebook") return url.includes("fbcdn.net");
  return false;
}

// Download a URL to a file using the browser context (preserves cookies/session) or plain https
async function downloadFile(url, dest, apiRequestContext) {
  if (apiRequestContext) {
    const response = await apiRequestContext.get(url);
    if (response.status() !== 200) {
      throw new Error(`Download failed: HTTP ${response.status()}`);
    }
    const body = await response.body();
    fs.writeFileSync(dest, body);
    return;
  }
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    mod
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
  console.log(`[${platform}] Fetching reel: ${reelUrl}`);
  if (fbVideoId) console.log(`Target video_id: ${fbVideoId}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Collect .mp4 CDN URLs from network responses
  const capturedUrls = new Map(); // baseUrl -> { url, bitrate, isAudio, vencTag, videoId, source }

  function addCapturedUrl(url, source = "network") {
    const u = new URL(url);
    const efg = u.searchParams.get("efg");
    if (!efg) return;

    const parsed = parseEfg(efg);

    // For Facebook, filter to only the target video_id (FB preloads adjacent reels)
    if (fbVideoId && parsed.videoId && parsed.videoId !== fbVideoId) return;

    const base = getBaseUrl(url);

    // Deduplicate by base URL, prefer higher bitrate
    const existing = capturedUrls.get(base);
    if (!existing || parsed.bitrate > existing.bitrate) {
      capturedUrls.set(base, { url: base, ...parsed, source });
    }
  }

  // Capture CDN URLs from actual network requests
  page.on("response", (response) => {
    const url = response.url();
    if (!isCdnUrl(url, platform)) return;
    addCapturedUrl(url);
  });

  // Also intercept GraphQL / unified_cvc / HTML responses to extract all video URLs
  // Facebook embeds DASH representation URLs in page data and API responses
  if (platform === "facebook") {
    page.on("response", async (response) => {
      const url = response.url();
      const ct = response.headers()["content-type"] || "";
      if (
        url.includes("/api/graphql") ||
        url.includes("/unified_cvc") ||
        (url.includes("facebook.com/reel/") && ct.includes("html"))
      ) {
        try {
          const text = await response.text();
          // Extract all fbcdn .mp4 URLs from the response body
          // They appear in DASH XML as BaseURL elements, JSON-escaped, with HTML entities
          const urlPattern = /https?:[\\\/]+video[^"'<>\s]*?\.fbcdn\.net[^"'<>\s]*?\.mp4[^"'<>\s]*/g;
          const matches = text.match(urlPattern) || [];
          for (const raw of matches) {
            // Minimal decoding: only fix transport-level escapes, preserve URL encoding as-is
            // The oh= signature is computed over the URL with its original encoding
            const decoded = raw
              .replace(/\\\//g, "/")       // JSON escape: \/ → /
              .replace(/&amp;/g, "&")      // HTML entity: &amp; → &
              .replace(/\\u0025/g, "%");   // unicode escape of %: \u0025 → %
            try {
              addCapturedUrl(decoded, "html");
            } catch {}
          }
        } catch {}
      }
    });
  }

  // Navigate to the reel
  await page.goto(reelUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Dismiss login dialog
  try {
    if (platform === "instagram") {
      await page.locator('svg[aria-label="Close"]').first().click({ timeout: 5000 });
    } else {
      // Facebook login dialog has a "Close" button
      await page.locator('div[role="dialog"] >> text=Close').first().click({ timeout: 5000 });
    }
    console.log("Dismissed login dialog");
  } catch {
    // No dialog, that's fine
  }
  await page.waitForTimeout(1000);

  // Try to trigger higher quality by playing the video via JS and seeking
  console.log("Triggering video playback...");
  try {
    await page.evaluate(() => {
      const video = document.querySelector("video");
      if (video) {
        video.play();
        // Seeking can trigger adaptive bitrate to request higher quality
        video.currentTime = 0;
      }
    });
  } catch {
    // Best effort
  }

  // Wait for video streams to load (higher quality streams arrive after playback starts)
  console.log("Waiting for video streams to load...");
  await page.waitForTimeout(10000);

  // Process captured URLs (browser still open for downloading)
  const entries = Array.from(capturedUrls.values());
  console.log(`Captured ${entries.length} unique stream URLs`);

  if (entries.length === 0) {
    await browser.close();
    console.error("No video streams captured. The reel may be private or the page structure changed.");
    process.exit(1);
  }

  const audioStreams = entries.filter((e) => e.isAudio);
  const videoStreams = entries.filter((e) => !e.isAudio);

  console.log(`  Video streams: ${videoStreams.length}`);
  console.log(`  Audio streams: ${audioStreams.length}`);

  if (videoStreams.length === 0) {
    await browser.close();
    console.error("No video streams found.");
    process.exit(1);
  }

  // Pick highest bitrate video, preferring network sources (verified downloadable)
  // then fall back to html-extracted sources
  const networkVideos = videoStreams.filter((e) => e.source === "network");
  const htmlVideos = videoStreams.filter((e) => e.source === "html");
  networkVideos.sort((a, b) => b.bitrate - a.bitrate);
  htmlVideos.sort((a, b) => b.bitrate - a.bitrate);

  // We'll try network first, then html
  const videoCandidates = [...networkVideos, ...htmlVideos];
  const bestVideo = videoCandidates[0];
  console.log(`Selected video: bitrate=${bestVideo.bitrate}, venc=${bestVideo.vencTag}, source=${bestVideo.source}`);
  if (networkVideos.length > 0) {
    console.log(`  Best network quality: ${networkVideos[0].bitrate} | Best HTML quality: ${htmlVideos[0]?.bitrate || "N/A"}`);
  }

  const tmpVideo = path.join(process.cwd(), `_tmp_video_${Date.now()}.mp4`);
  const tmpAudio = path.join(process.cwd(), `_tmp_audio_${Date.now()}.mp4`);
  const outputPath = path.join(process.cwd(), finalOutput);

  const apiContext = context.request;

  // Download video — try candidates in order until one succeeds
  console.log("Downloading video stream...");
  let videoDownloaded = false;
  for (const candidate of videoCandidates) {
    try {
      await downloadFile(candidate.url, tmpVideo, apiContext);
      if (!videoDownloaded) {
        console.log(`  Downloaded: bitrate=${candidate.bitrate}, source=${candidate.source}`);
      }
      videoDownloaded = true;
      break;
    } catch (err) {
      console.log(`  Failed (${err.message}) for bitrate=${candidate.bitrate}, source=${candidate.source}, trying next...`);
    }
  }
  if (!videoDownloaded) {
    await browser.close();
    console.error("All video download attempts failed.");
    process.exit(1);
  }

  if (audioStreams.length > 0) {
    // Pick highest bitrate audio, preferring network sources
    const networkAudio = audioStreams.filter((e) => e.source === "network");
    const htmlAudio = audioStreams.filter((e) => e.source === "html");
    networkAudio.sort((a, b) => b.bitrate - a.bitrate);
    htmlAudio.sort((a, b) => b.bitrate - a.bitrate);
    const audioCandidates = [...networkAudio, ...htmlAudio];

    console.log(`Selected audio: bitrate=${audioCandidates[0].bitrate}, venc=${audioCandidates[0].vencTag}`);
    console.log("Downloading audio stream...");
    let audioDownloaded = false;
    for (const candidate of audioCandidates) {
      try {
        await downloadFile(candidate.url, tmpAudio, apiContext);
        audioDownloaded = true;
        break;
      } catch {
        // try next
      }
    }
    if (!audioDownloaded) {
      console.log("Warning: Could not download audio stream, proceeding without audio.");
    }

    await browser.close();

    if (audioDownloaded) {
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
      fs.unlinkSync(tmpVideo);
      fs.unlinkSync(tmpAudio);
    } else {
      // No audio — just re-encode video
      try {
        execSync(`ffmpeg -y -i "${tmpVideo}" -c:v libx264 "${outputPath}"`, { stdio: "pipe" });
      } catch (err) {
        console.error("ffmpeg failed:", err.stderr?.toString() || err.message);
        process.exit(1);
      }
      fs.unlinkSync(tmpVideo);
    }
  } else {
    await browser.close();

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
