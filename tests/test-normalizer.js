// Offline verification of the Instagram normalizer. Stubs the browser globals,
// loads the real adapter files, feeds realistic raw IG feed items, and asserts
// the output matches the target export schema with real likes/comments.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");

const sandbox = {
  window: { addEventListener: () => {} },
  document: { cookie: "csrftoken=abc123;", createElement: () => ({ remove() {} }), head: { appendChild() {} }, documentElement: { appendChild() {} } },
  chrome: { runtime: { getURL: (p) => p } },
  console,
  setTimeout,
  URL,
};
sandbox.window = sandbox.window || {};
vm.createContext(sandbox);

for (const f of ["common.js", "platforms/instagram.js"]) {
  const code = fs.readFileSync(path.join(EXT, f), "utf8");
  vm.runInContext(code, sandbox, { filename: f });
}

const MS = sandbox.window.MS;
const { normalize, mediaList } = MS.instagram._test;

// --- Realistic raw items from IG's /api/v1/feed/user endpoint ---
const rawVideo = {
  id: "3887374449119716565_76199453722",
  pk: "3887374449119716565",
  code: "DXyunccteTV",
  media_type: 2,
  taken_at: 1777673218, // -> ISO
  like_count: 421,
  comment_count: 33,
  play_count: 9876,
  comments_disabled: false,
  accessibility_caption: null,
  caption: { text: "hello,\n#example" },
  user: { pk: "76199453722", username: "example_user", full_name: "Example User", is_verified: false, profile_pic_url: "https://cdn/pp.jpg" },
  image_versions2: { candidates: [{ url: "https://cdn/cover_hi.jpg" }, { url: "https://cdn/cover_lo.jpg" }] },
  video_versions: [{ url: "https://cdn/video.mp4" }],
};

const rawCarousel = {
  id: "3890993276522426041_76199453722",
  pk: "3890993276522426041",
  code: "DX_lcUGjW65",
  media_type: 8,
  taken_at: 1777673000,
  like_count: 0,
  comment_count: 5,
  caption: { text: "coffee" },
  user: { pk: "76199453722", username: "example_user", full_name: "Example User", is_verified: true, profile_pic_url: "https://cdn/pp.jpg" },
  carousel_media: [
    { image_versions2: { candidates: [{ url: "https://cdn/c1.jpg" }] } },
    { image_versions2: { candidates: [{ url: "https://cdn/c2.jpg" }] }, video_versions: [{ url: "https://cdn/c2.mp4" }] },
  ],
};

const rawHiddenLikes = {
  id: "1_2", pk: "1", code: "ABC", media_type: 1, taken_at: 1777673000,
  like_count: 3, like_and_view_counts_disabled: true, comment_count: 19,
  caption: { text: "x" },
  user: { pk: "2", username: "stergiana.jackets", full_name: "S", is_verified: false, profile_pic_url: "u" },
  image_versions2: { candidates: [{ url: "https://cdn/i.jpg" }] },
};

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; } else { fail++; console.log("  FAIL:", label); }
}

const v = normalize(rawVideo);
const c = normalize(rawCarousel);

// Schema completeness: every export key present.
const rowV = MS.toExportRow(v);
assert(Object.keys(rowV).length === MS.SCHEMA_KEYS.length, "export row has all schema keys");
assert(MS.SCHEMA_KEYS.every((k) => k in rowV), "no missing schema keys");

// Field correctness (video)
assert(v["Post Type"] === "Video", "video type");
assert(v["Post Likes"] === 421, "likes filled (not PREMIUM FIELD)");
assert(v["Post Comments Count"] === 33, "comments filled");
assert(v["Post Views"] === 9876, "IG view/play count filled");
assert(v["Post Shares"] === "Not Available", "IG shares Not Available");
assert(c["Post Views"] === "Not Available", "IG carousel has no views");
assert(v["Post Image"] === "https://cdn/cover_hi.jpg", "highest-res cover");
assert(v["Post Video"] === "https://cdn/video.mp4", "video url");
assert(v["Post URL"] === "https://www.instagram.com/p/DXyunccteTV/", "post url");
assert(v["Post Author Is Verified"] === "No", "verified No");
assert(/^2026-/.test(v["Post Date"]) && v["Post Date"].endsWith("Z"), "ISO date");
assert(v["Post Accessibility Caption"] === "Not Available", "null a11y -> Not Available");

// Field correctness (carousel)
assert(c["Post Type"] === "Carousel", "carousel type");
assert(c["Post Likes"] === 0, "zero likes preserved (not Not Available)");
assert(c["Post Author Is Verified"] === "Yes", "verified Yes");
assert(c["Post Image"] === "https://cdn/c1.jpg", "carousel cover = first child");
assert(c["Post Video"] === "Not Available", "carousel top-level video N/A");

// Media manifest (downloads): carousel expands, video before image per child.
const media = mediaList(rawCarousel);
assert(media.length === 3, "carousel media count = 3 (1 img + 1 vid + 1 img)");
assert(media[1].kind === "video" && media[1].url === "https://cdn/c2.mp4", "child video captured");
const vMedia = mediaList(rawVideo);
assert(vMedia[0].kind === "video" && vMedia[1].kind === "image", "single video: mp4 + cover");

const h = normalize(rawHiddenLikes);
assert(h["Post Likes"] === "Hidden", "hidden like counts -> 'Hidden' not facepile 3");
assert(h["Post Comments Count"] === 19, "comments still real when likes hidden");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
