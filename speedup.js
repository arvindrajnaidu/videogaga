#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const { speedUpVideo } = require("./index");

const args = process.argv.slice(2);

let inputFile = null;
let outputFile = null;
let speed = 2;

for (let i = 0; i < args.length; i++) {
  if ((args[i] === "-s" || args[i] === "--speed") && args[i + 1]) {
    speed = parseFloat(args[++i]);
  } else if ((args[i] === "-o" || args[i] === "--output") && args[i + 1]) {
    outputFile = args[++i];
  } else if (args[i] === "-h" || args[i] === "--help") {
    printUsage();
    process.exit(0);
  } else if (!inputFile) {
    inputFile = args[i];
  } else {
    console.error(`Unknown argument: ${args[i]}`);
    printUsage();
    process.exit(1);
  }
}

function printUsage() {
  console.log(`
  Speed up (or slow down) a video using ffmpeg.

  Usage:
    videogaga-speedup <input.mp4> [options]

  Options:
    -s, --speed <number>   Speed multiplier (default: 2)
    -o, --output <file>    Output filename (default: <input>_2x.mp4)
    -h, --help             Show this help

  Examples:
    videogaga-speedup clip.mp4                   2x speed → clip_2x.mp4
    videogaga-speedup clip.mp4 -s 3              3x speed → clip_3x.mp4
    videogaga-speedup clip.mp4 -s 0.5            Half speed (slow-mo)
    videogaga-speedup clip.mp4 -s 4 -o fast.mp4  4x speed → fast.mp4
`);
}

if (!inputFile) {
  printUsage();
  process.exit(1);
}

if (isNaN(speed) || speed <= 0) {
  console.error(`Error: Speed must be a positive number, got "${speed}"`);
  process.exit(1);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Error: File not found: ${inputFile}`);
  process.exit(1);
}

if (!outputFile) {
  const ext = path.extname(inputFile);
  const base = path.basename(inputFile, ext);
  const label = `${speed}x`;
  outputFile = `${base}_${label}.mp4`;
} else if (path.extname(outputFile).toLowerCase() === ".mov") {
  outputFile = outputFile.replace(/\.mov$/i, ".mp4");
}

const inputPath = path.resolve(inputFile);
const outputPath = path.resolve(outputFile);

speedUpVideo(inputPath, outputPath, speed).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
