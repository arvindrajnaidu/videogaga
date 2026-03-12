const { chromium } = require("playwright");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const { promisify } = require("util");
const { URL } = require("url");

const execAsync = promisify(exec);

function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${command} exited with code ${code}`));
      else resolve();
    });
    child.on("error", reject);
  });
}

function detectPlatform(url) {
  if (!url) return null;
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("facebook.com") || url.includes("fb.watch")) return "facebook";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  return null;
}

function getVideoId(url, platform) {
  if (platform === "youtube") {
    const shortsMatch = url.match(/\/shorts\/([^/?]+)/);
    if (shortsMatch) return { id: shortsMatch[1], type: "short" };
    const watchMatch = url.match(/[?&]v=([^&]+)/);
    if (watchMatch) return { id: watchMatch[1], type: "watch" };
    const shortUrlMatch = url.match(/youtu\.be\/([^/?]+)/);
    if (shortUrlMatch) return { id: shortUrlMatch[1], type: "watch" };
    return null;
  }
  // Match /reel/<id> (works for both Instagram and Facebook)
  const reelMatch = url.match(/\/reel\/([^/?]+)/);
  if (reelMatch) return reelMatch[1];
  // Facebook /watch/?v=<id>
  if (platform === "facebook") {
    const watchMatch = url.match(/[?&]v=(\d+)/);
    if (watchMatch) return watchMatch[1];
  }
  return null;
}

function getDefaultOutputName(platform, videoId) {
  if (platform === "youtube") {
    if (videoId && videoId.type === "short") return `yt_short_${videoId.id}.mp4`;
    if (videoId) return `yt_${videoId.id}.mp4`;
    return `yt_${Date.now()}.mp4`;
  }
  const prefix = platform === "facebook" ? "fb_reel" : "ig_reel";
  if (videoId) return `${prefix}_${videoId}.mp4`;
  return `${prefix}_${Date.now()}.mp4`;
}

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

function getBaseUrl(urlStr) {
  const u = new URL(urlStr);
  u.searchParams.delete("bytestart");
  u.searchParams.delete("byteend");
  return u.toString();
}

function isCdnUrl(url, platform) {
  if (!url.includes(".mp4")) return false;
  if (platform === "instagram") return url.includes("cdninstagram.com");
  if (platform === "facebook") return url.includes("fbcdn.net");
  return false;
}

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

async function downloadWithYtDlp(url, outputPath) {
  try {
    await execAsync("which yt-dlp");
  } catch {
    throw new Error("yt-dlp is not installed. Install it with: brew install yt-dlp");
  }
  console.log(`[yt-dlp] Downloading: ${url}`);
  console.log(`Output: ${outputPath}`);
  try {
    await spawnAsync("yt-dlp", [
      "-f", "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/best[vcodec^=avc1]",
      "--merge-output-format", "mp4",
      "-o", outputPath,
      url,
    ]);
  } catch (err) {
    throw new Error(`yt-dlp download failed: ${err.message}`);
  }
  console.log(`Done! Saved to ${path.basename(outputPath)}`);
}

async function downloadWithBrowser(reelUrl, platform, outputPath) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  const capturedUrls = new Map();
  // Track the target video ID — set after page loads and we resolve redirects
  let targetVideoId = null;
  // Lock to the first video_id we see in CDN streams, to avoid picking up recommended videos
  let lockedVideoId = null;

  function addCapturedUrl(url, source = "network") {
    const u = new URL(url);
    const efg = u.searchParams.get("efg");
    if (!efg) return;

    const parsed = parseEfg(efg);

    // If we have a known target video ID (from resolved URL), filter strictly
    if (targetVideoId && parsed.videoId && parsed.videoId !== targetVideoId) return;

    // If no target ID, lock onto the first video_id we encounter to avoid mixing videos
    if (!targetVideoId && parsed.videoId) {
      if (!lockedVideoId) {
        lockedVideoId = parsed.videoId;
        console.log(`  Locked onto video_id: ${lockedVideoId}`);
      } else if (parsed.videoId !== lockedVideoId) {
        return;
      }
    }

    const base = getBaseUrl(url);

    const existing = capturedUrls.get(base);
    if (!existing || parsed.bitrate > existing.bitrate) {
      capturedUrls.set(base, { url: base, ...parsed, source });
    }
  }

  page.on("response", (response) => {
    const url = response.url();
    if (!isCdnUrl(url, platform)) return;
    addCapturedUrl(url);
  });

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
          const urlPattern = /https?:[\\\/]+video[^"'<>\s]*?\.fbcdn\.net[^"'<>\s]*?\.mp4[^"'<>\s]*/g;
          const matches = text.match(urlPattern) || [];
          for (const raw of matches) {
            const decoded = raw
              .replace(/\\\//g, "/")
              .replace(/&amp;/g, "&")
              .replace(/\\u0025/g, "%");
            try {
              addCapturedUrl(decoded, "html");
            } catch {}
          }
        } catch {}
      }
    });
  }

  await page.goto(reelUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // After navigation, resolve the actual URL (handles /share/v/ → /reel/ redirects)
  const resolvedUrl = page.url();
  console.log(`Resolved URL: ${resolvedUrl}`);
  const resolvedVideoId = getVideoId(resolvedUrl, platform);
  if (platform === "facebook" && resolvedVideoId) {
    targetVideoId = Number(resolvedVideoId);
    console.log(`Target Facebook video ID: ${targetVideoId}`);
  } else if (platform === "instagram" && resolvedVideoId) {
    // Instagram reel IDs are strings, not used for efg filtering,
    // but we log it for debugging
    console.log(`Target Instagram reel ID: ${resolvedVideoId}`);
  }

  try {
    if (platform === "instagram") {
      await page.locator('svg[aria-label="Close"]').first().click({ timeout: 5000 });
    } else {
      await page.locator('div[role="dialog"] >> text=Close').first().click({ timeout: 5000 });
    }
    console.log("Dismissed login dialog");
  } catch {}
  await page.waitForTimeout(1000);

  console.log("Triggering video playback...");
  try {
    await page.evaluate(() => {
      const video = document.querySelector("video");
      if (video) {
        video.play();
        video.currentTime = 0;
      }
    });
  } catch {}

  console.log("Waiting for video streams to load...");
  await page.waitForTimeout(10000);

  const entries = Array.from(capturedUrls.values());
  console.log(`Captured ${entries.length} unique stream URLs`);

  if (entries.length === 0) {
    await browser.close();
    throw new Error("No video streams captured. The reel may be private or the page structure changed.");
  }

  const audioStreams = entries.filter((e) => e.isAudio);
  const videoStreams = entries.filter((e) => !e.isAudio);

  console.log(`  Video streams: ${videoStreams.length}`);
  console.log(`  Audio streams: ${audioStreams.length}`);

  if (videoStreams.length === 0) {
    await browser.close();
    throw new Error("No video streams found.");
  }

  const networkVideos = videoStreams.filter((e) => e.source === "network");
  const htmlVideos = videoStreams.filter((e) => e.source === "html");
  networkVideos.sort((a, b) => b.bitrate - a.bitrate);
  htmlVideos.sort((a, b) => b.bitrate - a.bitrate);

  const videoCandidates = [...networkVideos, ...htmlVideos];
  const bestVideo = videoCandidates[0];
  console.log(`Selected video: bitrate=${bestVideo.bitrate}, venc=${bestVideo.vencTag}, source=${bestVideo.source}`);
  if (networkVideos.length > 0) {
    console.log(`  Best network quality: ${networkVideos[0].bitrate} | Best HTML quality: ${htmlVideos[0]?.bitrate || "N/A"}`);
  }

  const tmpVideo = path.join(process.cwd(), `_tmp_video_${Date.now()}.mp4`);
  const tmpAudio = path.join(process.cwd(), `_tmp_audio_${Date.now()}.mp4`);

  const apiContext = context.request;

  console.log("Downloading video stream...");
  let videoDownloaded = false;
  for (const candidate of videoCandidates) {
    try {
      await downloadFile(candidate.url, tmpVideo, apiContext);
      console.log(`  Downloaded: bitrate=${candidate.bitrate}, source=${candidate.source}`);
      videoDownloaded = true;
      break;
    } catch (err) {
      console.log(`  Failed (${err.message}) for bitrate=${candidate.bitrate}, source=${candidate.source}, trying next...`);
    }
  }
  if (!videoDownloaded) {
    await browser.close();
    throw new Error("All video download attempts failed.");
  }

  if (audioStreams.length > 0) {
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
      } catch {}
    }
    if (!audioDownloaded) {
      console.log("Warning: Could not download audio stream, proceeding without audio.");
    }

    await browser.close();

    if (audioDownloaded) {
      console.log("Merging video + audio with ffmpeg...");
      try {
        await spawnAsync("ffmpeg", ["-y", "-i", tmpVideo, "-i", tmpAudio, "-c:v", "libx264", "-c:a", "copy", outputPath], { stdio: "pipe" });
      } catch (err) {
        throw new Error("ffmpeg merge failed: " + err.message);
      }
      fs.unlinkSync(tmpVideo);
      fs.unlinkSync(tmpAudio);
    } else {
      try {
        await spawnAsync("ffmpeg", ["-y", "-i", tmpVideo, "-c:v", "libx264", outputPath], { stdio: "pipe" });
      } catch (err) {
        throw new Error("ffmpeg failed: " + err.message);
      }
      fs.unlinkSync(tmpVideo);
    }
  } else {
    await browser.close();

    console.log("No separate audio stream found. Re-encoding video...");
    try {
      await spawnAsync("ffmpeg", ["-y", "-i", tmpVideo, "-c:v", "libx264", "-c:a", "copy", outputPath], { stdio: "pipe" });
    } catch (err) {
      throw new Error("ffmpeg failed: " + err.message);
    }
    fs.unlinkSync(tmpVideo);
  }

  console.log(`Done! Saved to ${path.basename(outputPath)}`);
}

async function downloadVideo(url, outputPath) {
  const platform = detectPlatform(url);
  if (!platform) throw new Error(`Unsupported URL: ${url}`);

  console.log(`\n[${platform}] Fetching: ${url}`);

  if (platform === "youtube") {
    await downloadWithYtDlp(url, outputPath);
    return;
  }

  await downloadWithBrowser(url, platform, outputPath);
}

async function combineVideos(videoPaths, outputPath, intermissionSecs = 3) {
  console.log(`\nCombining ${videoPaths.length} videos with ${intermissionSecs}s intermissions...`);

  const filters = [];
  const concatParts = [];
  let segmentCount = 0;

  for (let i = 0; i < videoPaths.length; i++) {
    filters.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[v${i}]`
    );
    filters.push(
      `[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`
    );

    if (i > 0) {
      filters.push(
        `color=c=black:s=1080x1920:d=${intermissionSecs}:r=30[black${i}]`
      );
      filters.push(
        `anullsrc=r=44100:cl=stereo,atrim=0:${intermissionSecs}[silence${i}]`
      );
      concatParts.push(`[black${i}][silence${i}]`);
      segmentCount++;
    }

    concatParts.push(`[v${i}][a${i}]`);
    segmentCount++;
  }

  filters.push(
    `${concatParts.join("")}concat=n=${segmentCount}:v=1:a=1[outv][outa]`
  );

  const filterComplex = filters.join(";");

  const ffmpegArgs = [];
  for (const p of videoPaths) {
    ffmpegArgs.push("-i", p);
  }
  ffmpegArgs.push("-filter_complex", filterComplex, "-map", "[outv]", "-map", "[outa]", "-c:v", "libx264", "-c:a", "aac", outputPath);

  try {
    await spawnAsync("ffmpeg", ["-y", ...ffmpegArgs], { timeout: 300000 });
  } catch (err) {
    throw new Error("ffmpeg combine failed: " + err.message);
  }

  console.log(`\nCombined video saved to ${path.basename(outputPath)}`);
}

module.exports = {
  downloadVideo,
  combineVideos,
  detectPlatform,
  getVideoId,
  getDefaultOutputName,
};
