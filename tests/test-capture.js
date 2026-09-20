// Offline verification of the Instagram scroll-and-capture path — the one that
// actually runs since IG blocked its /api/v1 endpoints (web_profile_info 429s,
// feed/user serves an HTML page). The adapter no longer calls Instagram at all:
// it scrolls the profile and harvests the page's own /graphql/query replies,
// which inject.js forwards into MS.captureBuffer.
//
// The response shape below matches a real capture taken from a live profile:
// data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[].node, with
// nodes in the same shape as the old v1 feed items.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");

function node(i, username) {
  return {
    id: i + "_9", pk: String(i), code: "CODE" + i, media_type: 1, taken_at: 1777672000 + i,
    like_count: 10 + i, comment_count: i, caption: { text: "post " + i },
    user: { pk: "9", username, full_name: "Bravo", is_verified: false, profile_pic_url: "u" },
    image_versions2: { candidates: [{ url: "https://cdn/" + i + ".jpg" }] },
  };
}

function connection(nodes, endCursor) {
  return {
    data: {
      xdt_api__v1__feed__user_timeline_graphql_connection: {
        edges: nodes.map((n) => ({ node: n })),
        page_info: { end_cursor: endCursor, has_next_page: !!endCursor, has_previous_page: false, start_cursor: null },
      },
    },
  };
}

// A page of posts arrives on every second scroll; the profile has 5 in total.
const PAGES = [connection([node(1, "bravozaxaroplasteio"), node(2, "bravozaxaroplasteio")], "c1"),
               connection([node(3, "bravozaxaroplasteio"), node(4, "bravozaxaroplasteio")], "c2"),
               connection([node(5, "bravozaxaroplasteio")], null)];

function loadAdapter(opts) {
  const o = opts || {};
  let scrolls = 0;
  const sandbox = {
    window: { addEventListener: () => {} },
    document: {
      cookie: "csrftoken=abc;",
      body: { scrollHeight: 10000 },
      createElement: () => ({ remove() {} }),
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      querySelectorAll: (sel) =>
        sel.includes("application/json") && o.mediaCount != null
          ? [{ textContent: '{"media_count":' + o.mediaCount + '}' }]
          : [],
    },
    location: (() => {
      const pathname = o.pathname || "/bravozaxaroplasteio/";
      return { pathname, hostname: "www.instagram.com", href: "https://www.instagram.com" + pathname };
    })(),
    chrome: { runtime: { getURL: (p) => p } },
    console, setTimeout, URL, Date, fetch: () => Promise.reject(new Error("the adapter must not call Instagram directly")),
  };
  sandbox.window.scrollTo = () => {
    // Each scroll delivers the next captured page, the way the page's own XHR
    // would land in the buffer.
    if (scrolls < PAGES.length) sandbox.window.MS.captureBuffer.push({ url: "/graphql/query", body: PAGES[scrolls] });
    scrolls++;
  };
  vm.createContext(sandbox);
  for (const f of ["common.js", "platforms/instagram.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), sandbox, { filename: f });
  }
  const MS = sandbox.window.MS;
  MS.sleep = () => Promise.resolve();
  MS.ensureInterceptor = () => {};
  return { MS, scrollCount: () => scrolls };
}

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) pass++;
  else { fail++; console.log("  FAIL:", label); }
}

(async () => {
  // --- The happy path: scroll, harvest, export ---
  const { MS } = loadAdapter({ mediaCount: 5 });
  const progress = [];
  const r = await MS.instagram.scrape({ username: "bravozaxaroplasteio", maxPosts: 0 }, (p) => progress.push(p), () => false);

  assert(r.posts.length === 5, "collects every post the page delivered (got " + r.posts.length + ")");
  assert(r.posts[0]["Post Likes"] === 11 && r.posts[0]["Post Comments Count"] === 1, "real engagement counts survive the GraphQL shape");
  assert(r.posts[0]["Post URL"] === "https://www.instagram.com/p/CODE1/", "post URL built from the node's code");
  assert(new Set(r.posts.map((p) => p.id)).size === 5, "no duplicates across overlapping captures");
  assert(r.profile.post_count === 5, "total post count read from the page's preloaded JSON");
  assert(progress.some((p) => p.total === 5), "progress reports a total so the bar can fill");

  // --- maxPosts is honoured ---
  const capped = await loadAdapter({}).MS.instagram.scrape({ username: "bravozaxaroplasteio", maxPosts: 3 }, () => {}, () => false);
  assert(capped.posts.length === 3, "maxPosts caps the export (got " + capped.posts.length + ")");

  // --- Stop ---
  const stopHarness = loadAdapter({});
  let stop = false;
  const stopped = await stopHarness.MS.instagram.scrape(
    { username: "bravozaxaroplasteio", maxPosts: 0 },
    (p) => { if (p.collected > 0) stop = true; },
    () => stop
  );
  assert(stopped.posts.length > 0 && stopped.posts.length < 5, "Stop ends the scroll early and keeps what was collected");

  // --- Wrong tab: capture would silently export someone else's posts ---
  let mismatch = null;
  await loadAdapter({ pathname: "/someoneelse/" }).MS.instagram
    .scrape({ username: "bravozaxaroplasteio", maxPosts: 0 }, () => {}, () => false)
    .catch((e) => (mismatch = e));
  assert(mismatch && /someoneelse/.test(mismatch.message), "refuses to scrape when the tab shows a different profile");

  let notProfile = null;
  await loadAdapter({ pathname: "/explore/" }).MS.instagram
    .scrape({ username: "bravozaxaroplasteio", maxPosts: 0 }, () => {}, () => false)
    .catch((e) => (notProfile = e));
  assert(notProfile && /profile page/i.test(notProfile.message), "asks the user to open a profile page when the tab isn't one");

  // --- The parser itself ---
  const { itemsFromCapture } = loadAdapter({}).MS.instagram._test;
  assert(itemsFromCapture(PAGES[0]).length === 2, "reads nodes out of the GraphQL connection");
  assert(itemsFromCapture({ items: [node(1, "x")] }).length === 1, "still reads the legacy /api/v1 items array");
  // IG renames these connections regularly, so the parser matches on shape.
  assert(itemsFromCapture({ data: { some_future_name: { edges: [{ node: node(1, "x") }] } } }).length === 1, "matches the connection by shape, not by name");
  assert(itemsFromCapture({ data: { users: { edges: [{ node: { username: "suggested" } }] } } }).length === 0, "ignores non-media connections on the same page");

  // --- Posts from another account on the same page are dropped ---
  const strayHarness = loadAdapter({});
  strayHarness.MS.captureBuffer.push({ url: "/graphql/query", body: connection([node(99, "someone_else")], null) });
  const stray = await strayHarness.MS.instagram.scrape({ username: "bravozaxaroplasteio", maxPosts: 0 }, () => {}, () => false);
  assert(!stray.posts.some((p) => p["Post Author"] === "someone_else"), "drops posts belonging to another account");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
