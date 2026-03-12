#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const { downloadVideo, combineVideos, detectPlatform, getVideoId, getDefaultOutputName } = require("./index");

const args = process.argv.slice(2);
const urls = [];
let outputArg = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-o" && args[i + 1]) {
    outputArg = args[++i];
  } else if (detectPlatform(args[i])) {
    urls.push(args[i]);
  } else if (urls.length === 1 && !outputArg && i === args.length - 1) {
    outputArg = args[i];
  } else {
    console.error(`Unrecognized argument: ${args[i]}`);
    process.exit(1);
  }
}

if (urls.length === 0) {
  console.error("Usage:");
  console.error("  videogaga <url> [output-filename]");
  console.error("  videogaga <url1> <url2> <url3> [-o combined-output.mp4]");
  console.error("\nSupports Instagram, Facebook, and YouTube.");
  console.error("Multiple URLs are combined into one video with 3s black intermissions.");
  process.exit(1);
}

async function main() {
  if (urls.length === 1) {
    const url = urls[0];
    const platform = detectPlatform(url);
    const videoId = getVideoId(url, platform);
    const finalOutput = outputArg || getDefaultOutputName(platform, videoId);
    const outputPath = path.join(process.cwd(), finalOutput);
    await downloadVideo(url, outputPath);
  } else {
    const tempFiles = [];
    try {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const platform = detectPlatform(url);
        const videoId = getVideoId(url, platform);
        const defaultName = getDefaultOutputName(platform, videoId);
        const tmpPath = path.join(process.cwd(), `_tmp_clip${i}_${defaultName}`);
        await downloadVideo(url, tmpPath);
        tempFiles.push(tmpPath);
      }

      const finalOutput = outputArg || `combined_${Date.now()}.mp4`;
      const outputPath = path.join(process.cwd(), finalOutput);
      await combineVideos(tempFiles, outputPath, 3);
    } finally {
      for (const tmp of tempFiles) {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
