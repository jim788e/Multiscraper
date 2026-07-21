// Offline verification of the Google Business review normalizer. Stubs the
// browser globals, loads the real adapter, feeds a raw review array shaped like
// the GetLocalBoqProxy response, and asserts the export fields come out right.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");

const sandbox = {
  window: { addEventListener: () => {} },
  document: {
    cookie: "",
    createElement: () => ({ remove() {} }),
    head: { appendChild() {} },
    documentElement: { appendChild() {}, innerHTML: "" },
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  chrome: { runtime: { getURL: (p) => p } },
  console,
  setTimeout,
  URL,
  URLSearchParams,
  BigInt,
};
vm.createContext(sandbox);

for (const f of ["common.js", "platforms/google.js"]) {
  const code = fs.readFileSync(path.join(EXT, f), "utf8");
  vm.runInContext(code, sandbox, { filename: f });
}

const MS = sandbox.window.MS;
const { normalize, findOwnerReply, EXPORT_KEYS } = MS.google._test;

// --- Raw review shaped like a real GetLocalBoqProxy entry (observed live):
// [1]=rating, [2]=[relative, ?, epoch-ms], [3]=[name, avatar, contribUrl],
// [5]=review id, [27]/[28]=full/short text, [30]=guided Q&A, tail may hold an
// owner reply.
function rawReview({ rating, text, reply }) {
  const r = new Array(35).fill(null);
  r[1] = rating;
  r[2] = ["πριν από 2 εβδομάδες", 2, "1783000000000"];
  r[3] = [
    "Maria P.",
    "https://lh3.googleusercontent.com/a-/avatar=s64",
    "https://www.google.com/maps/contrib/110000000000000000000/reviews?hl=el-GR",
  ];
  r[5] = "ChdDSUhNMG9nS0VJQ0FnSUNBcTVhYnlnRRAB";
  r[10] = "https://www.google.com/local/content/rap?some=thing";
  r[15] = [["https://lh5.googleusercontent.com/p/AF1QipBigPhoto=w1200", null, null, "photoid1"]];
  if (text) {
    r[27] = text;
    r[28] = text.slice(0, 20);
  }
  r[30] = [[["GUIDED_DINING_MEAL_TYPE"], "Τι παραγγείλατε;", [["E:DINING_MEAL_TYPE_DINNER"], 1], null, null, "Τύπος γεύματος"]];
  // 36/37/38: Google's auto-translation block for foreign-language reviews.
  r[36] = "Αγγλικά";
  if (text) {
    r[37] = "Μετάφραση: " + text;
    r[38] = r[37];
  }
  if (reply) r[33] = [reply, ["πριν από 1 εβδομάδα", 2, "1783500000000"]];
  return r;
}

let pass = 0,
  fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL: " + name);
  }
}

const full = normalize(
  rawReview({
    rating: 5,
    text: "Απολαυστικό φαγητό, φιλόξενο μέρος με μοναδικές γεύσεις. Θα ξαναέρθουμε σίγουρα!",
    reply: "Σας ευχαριστούμε πολύ για τα καλά σας λόγια! Θα χαρούμε να σας ξαναδούμε στον χώρο μας.",
  })
);

check("id extracted", full.id === "ChdDSUhNMG9nS0VJQ0FnSUNBcTVhYnlnRRAB");
check("author name", full["Review Author"] === "Maria P.");
check("author url", /contrib\/110000000000000000000/.test(full["Review Author URL"]));
check("rating", full["Review Rating"] === 5);
check("text is full text", full["Review Text"].startsWith("Απολαυστικό φαγητό"));
check("date ISO from epoch ms", full["Review Date"] === new Date(1783000000000).toISOString());
check("relative date kept", full["Review Date (relative)"] === "πριν από 2 εβδομάδες");
check("owner reply found", full["Owner Reply"].startsWith("Σας ευχαριστούμε"));
check("review photo collected", /AF1QipBigPhoto/.test(full["Review Images"]));
check("media manifest entry", full._media.length === 1 && full._media[0].kind === "image");

const bare = normalize(rawReview({ rating: 3 }));
check("rating-only review: empty text", bare["Review Text"] === "");
check("rating-only review: no reply", bare["Owner Reply"] === "Not Available");

// Q&A labels, enum codes, and the auto-TRANSLATED text at 37/38 must never be
// mistaken for an owner reply.
const noReply = rawReview({ rating: 4, text: "Καλό φαγητό, γρήγορο σέρβις, λογικές τιμές." });
check("qa/translation not misread as reply", findOwnerReply(noReply, noReply[27]) === "");
const norm2 = normalize(noReply);
check("translated text captured", norm2["Review Text (translated)"] === "Μετάφραση: " + noReply[27]);
check("source language captured", norm2["Review Language"] === "Αγγλικά");

// Export rows keep the Google schema, not the social-post schema.
const row = MS.toExportRow(full, EXPORT_KEYS);
check("row uses google schema", Object.keys(row).join(",") === EXPORT_KEYS.join(","));
check("row has no _media leak", !("_media" in row));

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
