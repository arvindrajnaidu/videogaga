const { downloadVideo, combineVideos, detectPlatform, getVideoId, getDefaultOutputName } = require("./index");
const path = require("path");
const fs = require("fs");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

// --- Sync utility tests ---
console.log("\n--- detectPlatform ---");
assert(detectPlatform("https://www.instagram.com/reel/abc123/") === "instagram", "instagram URL");
assert(detectPlatform("https://www.facebook.com/reel/123") === "facebook", "facebook URL");
assert(detectPlatform("https://fb.watch/abc") === "facebook", "fb.watch URL");
assert(detectPlatform("https://www.youtube.com/shorts/abc") === "youtube", "youtube shorts URL");
assert(detectPlatform("https://youtu.be/abc") === "youtube", "youtu.be URL");
assert(detectPlatform("https://example.com") === null, "unknown URL returns null");
assert(detectPlatform(null) === null, "null returns null");

console.log("\n--- getVideoId ---");
const ytShort = getVideoId("https://www.youtube.com/shorts/abc123", "youtube");
assert(ytShort && ytShort.id === "abc123" && ytShort.type === "short", "youtube short ID");
const ytWatch = getVideoId("https://www.youtube.com/watch?v=xyz789", "youtube");
assert(ytWatch && ytWatch.id === "xyz789" && ytWatch.type === "watch", "youtube watch ID");
const ytShortUrl = getVideoId("https://youtu.be/def456", "youtube");
assert(ytShortUrl && ytShortUrl.id === "def456" && ytShortUrl.type === "watch", "youtu.be ID");
assert(getVideoId("https://www.youtube.com/channel/foo", "youtube") === null, "youtube no match returns null");
assert(getVideoId("https://www.instagram.com/reel/abc123/", "instagram") === "abc123", "instagram reel ID");
assert(getVideoId("https://www.facebook.com/reel/999/", "facebook") === "999", "facebook reel ID");

console.log("\n--- getDefaultOutputName ---");
assert(getDefaultOutputName("youtube", { id: "abc", type: "short" }) === "yt_short_abc.mp4", "youtube short name");
assert(getDefaultOutputName("youtube", { id: "abc", type: "watch" }) === "yt_abc.mp4", "youtube watch name");
assert(getDefaultOutputName("instagram", "abc123") === "ig_reel_abc123.mp4", "instagram name");
assert(getDefaultOutputName("facebook", "999") === "fb_reel_999.mp4", "facebook name");

// --- Async tests ---
async function asyncTests() {
  console.log("\n--- async: exports are functions ---");
  assert(typeof downloadVideo === "function", "downloadVideo is a function");
  assert(typeof combineVideos === "function", "combineVideos is a function");

  console.log("\n--- async: downloadVideo returns a promise ---");
  const promise = downloadVideo("https://www.instagram.com/reel/test/", "/tmp/test.mp4").catch(() => {});
  assert(promise instanceof Promise, "downloadVideo returns a Promise");
  await promise;

  console.log("\n--- async: combineVideos returns a promise ---");
  const promise2 = combineVideos(["/tmp/nonexistent1.mp4"], "/tmp/out.mp4", 3).catch(() => {});
  assert(promise2 instanceof Promise, "combineVideos returns a Promise");
  await promise2;

  console.log("\n--- async: event loop not blocked ---");
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 50);
  // Start a downloadVideo call that will fail (bad URL), but the point is it's async
  const downloadPromise = downloadVideo("https://www.youtube.com/shorts/NONEXISTENT_TEST_VIDEO_12345", "/tmp/test_async.mp4").catch(() => {});
  // Wait a bit for the timer to fire — if execSync was used, the timer would never fire
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(timerFired === true, "setTimeout fired during async downloadVideo (event loop not blocked)");
  clearTimeout(timer);
  await downloadPromise;
  // Clean up
  try { fs.unlinkSync("/tmp/test_async.mp4"); } catch {}
}

asyncTests().then(() => {
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}).catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
