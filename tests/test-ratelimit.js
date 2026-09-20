// Offline verification of the Instagram adapter's HTTP 429 handling: the run the
// user hit, where web_profile_info answered "Too Many Requests" over and over.
// Asserts we stop hammering the throttled endpoint, fall back to the profile
// HTML, keep reporting status while waiting, stay responsive to Stop, and still
// export whatever posts we paged before the feed got throttled too.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");

// Virtual clock: MS.sleep advances it instead of really waiting, so the adapter's
// minute-long backoff ladders run instantly.
let clock = 1777673000000;
class FakeDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [clock]));
  }
  static now() {
    return clock;
  }
}

function res(status, body, headers) {
  const h = headers || {};
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (h[k.toLowerCase()] == null ? null : h[k.toLowerCase()]) },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

const FEED_PAGE = {
  items: [
    {
      id: "1_9", pk: "1", code: "AAA", media_type: 1, taken_at: 1777672000,
      like_count: 5, comment_count: 1, caption: { text: "a" },
      user: { pk: "9", username: "bravozaxaroplasteio", full_name: "Bravo", is_verified: false, profile_pic_url: "u" },
      image_versions2: { candidates: [{ url: "https://cdn/a.jpg" }] },
    },
  ],
  more_available: true,
  next_max_id: "page2",
};

// Throttled exactly like the reported session: the profile API and search API
// both return 429, the profile page HTML still answers, and paging past the
// first feed page is throttled too.
function throttledFetch(calls) {
  return (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("web_profile_info")) return res(429, { message: "Please wait a few minutes" }, { "retry-after": "8" });
    if (u.includes("topsearch")) return res(429, { message: "rate limited" });
    if (u.includes("/feed/user/")) return u.includes("max_id=page2") ? res(429, { message: "rate limited" }) : res(200, FEED_PAGE);
    return res(200, "<html>x profilePage_76199453722 y</html>");
  };
}

// Fresh adapter instance per scenario so the session cooldown does not leak.
function loadAdapter(fetchStub) {
  const sandbox = {
    window: { addEventListener: () => {} },
    document: { cookie: "csrftoken=abc123;", createElement: () => ({ remove() {} }), head: { appendChild() {} }, documentElement: { appendChild() {} } },
    chrome: { runtime: { getURL: (p) => p } },
    console,
    setTimeout,
    URL,
    Date: FakeDate,
    fetch: fetchStub,
  };
  vm.createContext(sandbox);
  for (const f of ["common.js", "platforms/instagram.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), sandbox, { filename: f });
  }
  const MS = sandbox.window.MS;
  MS.sleep = (ms) => {
    clock += ms;
    return Promise.resolve();
  };
  return MS;
}

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", label);
  }
}

(async () => {
  // --- Scenario 1: throttled lookup + throttled paging ---
  const calls = [];
  const MS = loadAdapter(throttledFetch(calls));
  const progress = [];
  const started = clock;
  const result = await MS.instagram.scrape(
    { username: "bravozaxaroplasteio", maxPosts: 0 },
    (p) => progress.push(p),
    () => false
  );

  const profileInfoCalls = calls.filter((u) => u.includes("web_profile_info")).length;
  assert(profileInfoCalls <= 3, "gives up on the throttled profile endpoint quickly (was " + profileInfoCalls + " calls)");

  const htmlIdx = calls.findIndex((u) => !u.includes("/api/"));
  const searchIdx = calls.findIndex((u) => u.includes("topsearch"));
  assert(htmlIdx !== -1, "falls back to the profile HTML");
  assert(searchIdx === -1 || htmlIdx < searchIdx, "when rate-limited, HTML is tried before the throttled search API");

  assert(result.profile.id === "76199453722", "user id recovered from the HTML fallback");
  assert(result.posts.length === 1, "keeps the page of posts collected before the feed got throttled");
  assert(/429|rate-limit/i.test(String(result.warning)), "warns that the run stopped on a rate limit");
  assert(/Exported the 1 posts/.test(String(result.warning)), "warning says how much was kept");

  const statuses = progress.filter((p) => p.status).map((p) => p.status);
  assert(statuses.some((s) => /Looking up @bravozaxaroplasteio/.test(s)), "reports the lookup instead of sitting on 'Starting…'");
  assert(statuses.some((s) => /rate-limiting .* retrying in \d+s/.test(s)), "counts down the rate-limit wait in the popup");

  // Retry-After: 8 is honoured rather than the 5s+ guess the ladder would pick.
  assert(clock - started >= 8000, "honours the server's Retry-After delay");

  // --- Scenario 2: Stop pressed while waiting out a rate limit ---
  const calls2 = [];
  const MS2 = loadAdapter(throttledFetch(calls2));
  let stop = false;
  const progress2 = [];
  const stopped = await MS2.instagram.scrape(
    { username: "bravozaxaroplasteio", maxPosts: 0 },
    (p) => {
      progress2.push(p);
      // Stop as soon as the feed's rate-limit countdown starts ticking.
      if (p.status && /rate-limiting/.test(p.status) && p.collected > 0) stop = true;
    },
    () => stop
  );
  const waitTicks = progress2.filter((p) => p.status && /retrying in/.test(p.status) && p.collected > 0).length;
  assert(waitTicks <= 2, "Stop ends the rate-limit wait immediately (ticked " + waitTicks + " times)");
  assert(stopped.posts.length === 1, "stopping mid-wait still returns the collected posts");
  assert(!stopped.warning, "a user-initiated stop is not reported as a failure");

  // --- Scenario 3: HTTP 200 carrying an HTML soft-block instead of JSON ---
  // This is the `Unexpected token '<', "<!DOCTYPE "...` the user hit: IG serves
  // its own page rather than a payload once it decides to block the session.
  const SOFT_BLOCK = '<!DOCTYPE html><html><head><title>Instagram</title></head><body>please wait</body></html>';
  const calls3 = [];
  const MS3 = loadAdapter((url) => {
    const u = String(url);
    calls3.push(u);
    if (u.includes("/feed/user/")) return u.includes("max_id=page2") ? res(200, SOFT_BLOCK) : res(200, FEED_PAGE);
    if (u.includes("web_profile_info")) return res(200, { data: { user: { id: "76199453722", username: "bravozaxaroplasteio", full_name: "Bravo", is_private: false } } });
    return res(200, "<html>x profilePage_76199453722 y</html>");
  });
  let blockErr = null;
  const blocked = await MS3.instagram
    .scrape({ username: "bravozaxaroplasteio", maxPosts: 0 }, () => {}, () => false)
    .catch((e) => {
      blockErr = e;
      return null;
    });
  assert(blockErr === null, "an HTML soft-block does not blow up the scrape");
  assert(blocked && blocked.posts.length === 1, "posts collected before the soft-block are kept");
  assert(!/Unexpected token|not valid JSON/i.test(String(blocked && blocked.warning)), "the raw JSON parse error never reaches the user");
  assert(/rate-limiting/i.test(String(blocked && blocked.warning)), "an HTML block is reported as the throttle it is");
  const softBlockRetries = calls3.filter((u) => u.includes("max_id=page2")).length;
  assert(softBlockRetries > 1, "the soft-block is retried like a 429 (was " + softBlockRetries + " attempt)");

  // --- Scenario 4: the login wall ---
  const LOGIN_PAGE = '<!DOCTYPE html><html><body><form id="loginForm" action="/accounts/login/"></form></body></html>';
  const calls4 = [];
  const MS4 = loadAdapter((url) => {
    calls4.push(String(url));
    return res(200, LOGIN_PAGE);
  });
  let loginErr = null;
  await MS4.instagram
    .scrape({ username: "bravozaxaroplasteio", maxPosts: 0 }, () => {}, () => false)
    .catch((e) => (loginErr = e));
  assert(loginErr && /signed in/i.test(loginErr.message), "a login page is explained, not dumped as a parse error");
  assert(calls4.length <= 2, "a login wall aborts instead of retrying the fallback chain (was " + calls4.length + " calls)");

  // --- Scenario 5: the security checkpoint ---
  const MS5 = loadAdapter(() => res(200, '<!DOCTYPE html><html><body>window.location="/challenge/"</body></html>'));
  let challengeErr = null;
  await MS5.instagram
    .scrape({ username: "bravozaxaroplasteio", maxPosts: 0 }, () => {}, () => false)
    .catch((e) => (challengeErr = e));
  assert(challengeErr && /checkpoint/i.test(challengeErr.message), "a checkpoint page tells the user to clear the prompt");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
