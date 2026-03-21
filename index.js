const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { promisify } = require("util");
const { exec } = require("child_process");

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
  const reelMatch = url.match(/\/reel\/([^/?]+)/);
  if (reelMatch) return reelMatch[1];
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

async function downloadVideo(url, outputPath) {
  const platform = detectPlatform(url);
  if (!platform) throw new Error(`Unsupported URL: ${url}`);

  try {
    await execAsync("which yt-dlp");
  } catch {
    throw new Error("yt-dlp is not installed. Install it with: brew install yt-dlp");
  }

  console.log(`\n[${platform}] Fetching: ${url}`);
  console.log(`Output: ${outputPath}`);

  const tmpPath = outputPath.replace(/\.mp4$/, "_tmp.mp4");

  try {
    // Download best quality with yt-dlp
    await spawnAsync("yt-dlp", [
      "--merge-output-format", "mp4",
      "-o", tmpPath,
      url,
    ]);

    // Transcode to H.264 + AAC for universal compatibility
    console.log("Transcoding to H.264...");
    await spawnAsync("ffmpeg", [
      "-y", "-i", tmpPath,
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2M",
      "-c:a", "aac",
      outputPath,
    ], { stdio: "pipe", timeout: 300000 });

    fs.unlinkSync(tmpPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(`Download failed: ${err.message}`);
  }

  console.log(`Done! Saved to ${path.basename(outputPath)}`);
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

async function speedUpVideo(inputPath, outputPath, speed = 2) {
  if (speed <= 0) throw new Error("Speed must be greater than 0");
  if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);

  console.log(`\nSpeeding up video ${speed}x: ${path.basename(inputPath)}`);

  const atempoFilters = [];
  let remaining = speed;
  while (remaining > 2) {
    atempoFilters.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    atempoFilters.push("atempo=0.5");
    remaining /= 0.5;
  }
  atempoFilters.push(`atempo=${remaining}`);

  const videoFilter = `setpts=${(1 / speed).toFixed(10)}*PTS`;
  const audioFilter = atempoFilters.join(",");

  try {
    await spawnAsync("ffmpeg", [
      "-y", "-i", inputPath,
      "-filter:v", videoFilter,
      "-filter:a", audioFilter,
      "-c:v", "libx264",
      "-c:a", "aac",
      outputPath,
    ], { timeout: 300000 });
  } catch (err) {
    throw new Error("ffmpeg speed-up failed: " + err.message);
  }

  console.log(`Done! Saved to ${path.basename(outputPath)}`);
}

module.exports = {
  downloadVideo,
  combineVideos,
  speedUpVideo,
  detectPlatform,
  getVideoId,
  getDefaultOutputName,
};
