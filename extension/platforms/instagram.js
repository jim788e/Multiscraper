// Instagram adapter. Runs in the content-script isolated world on instagram.com,
// so fetch() carries the logged-in session cookies and Instagram treats it as
// first-party. This is what lets us page past the third-party tool's 10-post cap
// and read the real like/comment counts it hides behind "PREMIUM FIELD".
(function () {
  const MS = (window.MS = window.MS || {});
  const IG_APP_ID = "936619743392459"; // public web app id IG's own site sends
  const TYPE = { 1: "Image", 2: "Video", 8: "Carousel" };

  function csrfToken() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : "";
  }

  function headers() {
    const h = { "X-IG-App-ID": IG_APP_ID, "X-Requested-With": "XMLHttpRequest" };
    const t = csrfToken();
    if (t) h["X-CSRFToken"] = t;
    return h;
  }

  // Progress reporter for the scrape in flight. Waiting on a rate limit can take
  // minutes; without this the popup would sit on "Starting…" with no explanation.
  let report = () => {};

  // Stop button state for the scrape in flight. A rate-limit cooldown can be
  // minutes long, so every wait loop polls this instead of ignoring the user.
  let stopped = () => false;

  function stopError() {
    const e = new Error("Stopped.");
    e.stopped = true;
    return e;
  }

  // A 429 from instagram.com applies to the browser session, not to the single
  // request that tripped it, so every other endpoint (search, feed, the profile
  // HTML) is throttled too. Remember when we may talk to IG again and make all
  // callers honour it instead of hammering their way through the fallback chain.
  let cooldownUntil = 0;

  // Exponential backoff with jitter; longer waits when actively rate-limited.
  function backoff(attempt, rateLimited) {
    const base = rateLimited ? 5000 : 700;
    return Math.min(30000, base * Math.pow(2, attempt)) + Math.random() * 600;
  }

  // Instagram sends Retry-After on some 429s; obeying it beats guessing.
  function retryAfterMs(res) {
    let raw = "";
    try {
      raw = res.headers.get("Retry-After") || "";
    } catch (_) {}
    if (!raw) return 0;
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 300000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 300000) : 0;
  }

  // Sleep while ticking the remaining seconds into the popup status line.
  async function waitWithStatus(ms, why) {
    const end = Date.now() + ms;
    for (let left = end - Date.now(); left > 0; left = end - Date.now()) {
      if (stopped()) throw stopError();
      report(why + " — retrying in " + Math.ceil(left / 1000) + "s…");
      await MS.sleep(Math.min(1000, left));
    }
  }

  // Each 429 also slows the paging loop down: IG hands out the next throttle
  // faster if we go straight back to the previous rhythm.
  let rateLimitHits = 0;

  function noteRateLimit(ms) {
    rateLimitHits++;
    cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
  }

  function pageDelay() {
    return (800 + Math.random() * 700) * Math.min(4, 1 + rateLimitHits);
  }

  async function awaitCooldown() {
    const left = cooldownUntil - Date.now();
    if (left > 0) await waitWithStatus(left, "Instagram is rate-limiting");
  }

  // Instagram answers 200 with an HTML page instead of JSON in three cases: the
  // logged-out login wall, a pending security checkpoint, and the "soft block"
  // it serves to a session it is throttling. Parsing that as JSON is what
  // produced the raw `Unexpected token '<'` users saw.
  function htmlBlockKind(text) {
    if (/\/challenge\/|checkpoint_required|\bchallenge_required\b/i.test(text)) return "challenge";
    if (/accounts\/login|LoginAndSignupPage|loginForm|"is_logged_in"\s*:\s*false/i.test(text)) return "login";
    return "block";
  }

  function authBlockError(kind) {
    const e = new Error(
      kind === "challenge"
        ? "Instagram wants you to confirm it's you (security checkpoint). Open instagram.com, clear the prompt, then try again."
        : "Instagram served its login page instead of data — open instagram.com, make sure you're still signed in, then try again."
    );
    e.authBlocked = true;
    return e;
  }

  function rateLimitError() {
    const e = new Error(
      "Instagram is rate-limiting this browser (HTTP 429). Wait a few minutes, close other Instagram tabs, then resume."
    );
    e.rateLimited = true;
    return e;
  }

  // Fetch JSON with retries. Auth failures (401/403) abort immediately with a
  // clear message; rate limits (429) and server/network errors back off and
  // retry so a long scrape survives transient hiccups instead of dying.
  // `maxRetries` is tunable because it is not worth spending a two-minute retry
  // ladder on a call we have a working fallback for.
  async function getJSON(url, opts) {
    const maxRetries = opts && opts.maxRetries != null ? opts.maxRetries : 5;
    for (let attempt = 0; ; attempt++) {
      await awaitCooldown();
      let res;
      try {
        res = await fetch(url, { headers: headers(), credentials: "include" });
      } catch (e) {
        if (attempt < Math.min(maxRetries, 4)) {
          await waitWithStatus(backoff(attempt), "Network hiccup");
          continue;
        }
        throw new Error("Network error contacting Instagram — check your connection and try again.");
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "Instagram returned " + res.status + " — log in on instagram.com, and make sure you can view this profile (private accounts require you to follow them)."
        );
      }
      if (res.status === 429) {
        const wait = retryAfterMs(res) || backoff(attempt, true);
        noteRateLimit(wait);
        if (attempt < maxRetries) {
          await awaitCooldown();
          continue;
        }
        throw rateLimitError();
      }
      if (res.status >= 500) {
        if (attempt < maxRetries) {
          await waitWithStatus(backoff(attempt), "Instagram server error (HTTP " + res.status + ")");
          continue;
        }
        throw new Error("Instagram is failing (HTTP " + res.status + "). Wait a few minutes, then resume.");
      }
      if (!res.ok) {
        // Surface Instagram's own error message — a bare status code hides
        // server-side breakage (e.g. deleted schemas) from the user.
        let detail = "";
        try {
          const body = await res.text();
          const j = JSON.parse(body);
          detail = j && j.message ? " — " + j.message : "";
        } catch (_) {}
        throw new Error("Instagram request failed: HTTP " + res.status + detail);
      }
      // Read as text and parse ourselves: a 200 carrying HTML is a block, not
      // a payload, and must not surface as a JSON syntax error.
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (_) {
        const kind = htmlBlockKind(text);
        if (kind !== "block") throw authBlockError(kind);
        // The soft-block interstitial: same shape as a 429, so treat it as one.
        const wait = backoff(attempt, true);
        noteRateLimit(wait);
        if (attempt < maxRetries) {
          await awaitCooldown();
          continue;
        }
        throw rateLimitError();
      }
    }
  }

  // Primary lookup. Instagram intermittently breaks this endpoint server-side
  // (e.g. the 2026 "ig_business_category_subvertical has been deleted" 400s) and
  // rate-limits it harder than anything else, so callers must be prepared to
  // fall back. Two retries, not five: the fallbacks are cheaper than the ladder.
  async function resolveUserProfileInfo(username) {
    const url =
      "https://www.instagram.com/api/v1/users/web_profile_info/?username=" +
      encodeURIComponent(username);
    const j = await getJSON(url, { maxRetries: 2 });
    const user = j && j.data && j.data.user;
    if (!user) throw new Error('Profile "' + username + '" not found.');
    return user;
  }

  // Fallback 1: topsearch returns the numeric user id without touching the
  // broken profile-info schema.
  async function resolveUserViaSearch(username) {
    const url =
      "https://www.instagram.com/api/v1/web/search/topsearch/?query=" +
      encodeURIComponent(username);
    const j = await getJSON(url, { maxRetries: 1 });
    const hit = (j.users || []).find(
      (u) => u.user && u.user.username.toLowerCase() === username.toLowerCase()
    );
    return hit ? hit.user : null;
  }

  // Fallback 2: the profile page HTML embeds the user id ("profilePage_<id>").
  // It is a plain page load rather than an /api/ call, so it is the one lookup
  // that often still answers while the API endpoints are throttled.
  async function resolveUserViaHtml(username) {
    await awaitCooldown();
    const res = await fetch("https://www.instagram.com/" + encodeURIComponent(username) + "/", {
      credentials: "include",
    });
    if (res.status === 429) {
      noteRateLimit(retryAfterMs(res) || 30000);
      return null;
    }
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/profilePage_(\d+)/) || html.match(/"profile_id"\s*:\s*"(\d+)"/);
    return m ? { pk: m[1], username } : null;
  }

  async function resolveUser(username) {
    report("Looking up @" + username + "…");
    let primaryErr;
    try {
      return await resolveUserProfileInfo(username);
    } catch (e) {
      if (e.stopped) throw e; // Stop pressed during a wait — don't start over
      if (e.authBlocked) throw e; // No fallback can fix a login wall or checkpoint
      primaryErr = e;
    }
    // When we are throttled the search API will just hand us another 429, so try
    // the profile HTML first; otherwise search is the more reliable of the two.
    const order = primaryErr.rateLimited
      ? [resolveUserViaHtml, resolveUserViaSearch]
      : [resolveUserViaSearch, resolveUserViaHtml];
    let user = null;
    for (const fn of order) {
      if (user) break;
      report("Retrying profile lookup for @" + username + "…");
      try {
        user = await fn(username);
      } catch (e) {
        if (e.stopped || e.authBlocked) throw e;
      }
    }
    if (!user) throw primaryErr;
    // Normalize the leaner fallback shape to what scrape() expects.
    return {
      id: String(user.pk || user.pk_id || user.id),
      username: user.username || username,
      full_name: user.full_name || "",
      is_private: !!user.is_private,
    };
  }

  async function feedPage(userId, maxId) {
    const url = new URL("https://www.instagram.com/api/v1/feed/user/" + userId + "/");
    url.searchParams.set("count", "33");
    if (maxId) url.searchParams.set("max_id", maxId);
    return getJSON(url.toString());
  }

  function bestImage(node) {
    const c = node.image_versions2 && node.image_versions2.candidates;
    return c && c.length ? c[0].url : null; // candidates[0] is highest resolution
  }
  function bestVideo(node) {
    const v = node.video_versions;
    return v && v.length ? v[0].url : null;
  }

  // Every downloadable file for a post (carousels expand to one entry per child).
  function mediaList(item) {
    const out = [];
    const children = item.media_type === 8 && item.carousel_media ? item.carousel_media : [item];
    for (const ch of children) {
      const vid = bestVideo(ch);
      if (vid) out.push({ url: vid, kind: "video" });
      const img = bestImage(ch);
      if (img) out.push({ url: img, kind: "image" });
    }
    return out;
  }

  function normalize(item) {
    const user = item.user || {};
    const caption = item.caption && item.caption.text ? item.caption.text : "";
    const cover =
      item.media_type === 8 && item.carousel_media && item.carousel_media[0]
        ? bestImage(item.carousel_media[0])
        : bestImage(item);
    const video = item.media_type === 8 ? null : bestVideo(item);
    return {
      id: item.id || item.pk + "_" + (user.pk || ""),
      "Post Author": user.username || "",
      "Post Author Full Name": user.full_name || "",
      "Post Author Image": user.profile_pic_url || "",
      "Post Author URL": user.username ? "https://www.instagram.com/" + user.username + "/" : "",
      "Post Author Is Verified": user.is_verified ? "Yes" : "No",
      "Post Type": TYPE[item.media_type] || "Unknown",
      "Post Text": caption,
      "Post Image": cover || "Not Available",
      "Post Video": video || "Not Available",
      // When a creator hides like counts, IG returns a misleading small facepile
      // number instead of the real total, so report "Hidden" rather than fake data.
      "Post Likes": item.like_and_view_counts_disabled
        ? "Hidden"
        : item.like_count != null
        ? item.like_count
        : "Not Available",
      "Post Comments Count": item.comment_count != null ? item.comment_count : "Not Available",
      // IG reports view/play counts on videos & reels; shares/saves aren't exposed.
      "Post Views": item.play_count != null ? item.play_count : item.view_count != null ? item.view_count : "Not Available",
      "Post Shares": "Not Available",
      "Post Saves": "Not Available",
      "Post URL": item.code ? "https://www.instagram.com/p/" + item.code + "/" : "",
      "Post Date": item.taken_at ? new Date(item.taken_at * 1000).toISOString() : "",
      "Is Comments Disabled": item.comments_disabled ? "Yes" : "No",
      "Post Accessibility Caption": item.accessibility_caption || "Not Available",
      _shortcode: item.code || item.pk,
      _media: mediaList(item),
    };
  }

  // Legacy path: IG's own /api/v1 endpoints. Kept as a fallback in case they
  // come back, but as of 2026-09 web_profile_info answers 429 and feed/user
  // serves an HTML block page, so scrapeViaCapture() is what actually runs.
  async function scrapeViaApi(opts, onProgress, shouldStop) {
    let user = null;
    const total = () =>
      user && user.edge_owner_to_timeline_media?.count != null
        ? user.edge_owner_to_timeline_media.count
        : null;
    const posts = [];
    const seen = new Set();
    let maxId = null;
    let warning = null;

    // Route the adapter's status lines (rate-limit countdowns, lookup retries)
    // into the popup so a long wait never looks like a hang.
    report = (status) =>
      onProgress({ collected: posts.length, total: total(), profile: user ? user.username : opts.username, status });
    stopped = shouldStop;

    try {
      user = await resolveUser(opts.username);

      onProgress({ collected: 0, total: total(), profile: user.username });

      do {
        if (shouldStop()) break;
        let data;
        try {
          data = await feedPage(user.id, maxId);
        } catch (e) {
          // Losing an hour of paging to one 429 helps nobody: keep what we have,
          // tell the user why it stopped, and let them resume later. Pressing
          // Stop during a wait lands here too, and keeps the posts as well.
          if (!posts.length) throw e;
          if (!e.stopped) {
            warning = String(e.message || e) + " Exported the " + posts.length + " posts collected so far.";
          }
          break;
        }
        const items = data.items || [];
        for (const it of items) {
          const n = normalize(it);
          if (!seen.has(n.id)) {
            seen.add(n.id);
            posts.push(n);
          }
        }
        onProgress({ collected: posts.length, total: total(), profile: user.username });

        if (opts.maxPosts && posts.length >= opts.maxPosts) break;
        maxId = data.more_available && data.next_max_id ? data.next_max_id : null;
        if (maxId) await MS.sleep(pageDelay()); // be gentle; avoid rate limits
      } while (maxId);

      if (opts.maxPosts && posts.length > opts.maxPosts) posts.length = opts.maxPosts;

      return {
        platform: "instagram",
        warning,
        profile: {
          username: user.username,
          full_name: user.full_name,
          id: user.id,
          is_private: user.is_private,
          post_count: total() ?? posts.length,
        },
        posts,
      };
    } finally {
      report = () => {};
      stopped = () => false;
    }
  }


  // --- Scroll-and-capture (primary path) ------------------------------------
  //
  // Instagram retired the /api/v1 endpoints this adapter was built on: as of
  // 2026-09 web_profile_info answers 429 on the very first call and feed/user
  // returns an HTML block page with status 200. Verified from inside a live
  // logged-in tab, so it is not a rate limit we can wait out.
  //
  // The profile page itself pages posts with POST /graphql/query
  // (PolarisProfilePostsTabContentQuery_connection) over XHR. Replaying that by
  // hand needs the full set of session params the page sends — a hand-built
  // request with fb_dtsg + lsd gets 403. So we do what the TikTok adapter does:
  // let the page make its own requests while we scroll, and harvest the replies
  // that inject.js captures. Nothing we send can be fingerprinted, because we
  // send nothing.

  // Pull media items out of a captured response. The GraphQL connection is
  // matched on shape rather than on its name (`xdt_api__v1__feed__user_
  // timeline_graphql_connection`), because Instagram renames these regularly.
  function itemsFromCapture(body) {
    if (!body) return [];
    if (Array.isArray(body.items)) return body.items; // legacy /api/v1 shape
    if (!body.data) return [];
    const out = [];
    for (const value of Object.values(body.data)) {
      if (value && Array.isArray(value.edges)) {
        for (const edge of value.edges) {
          const node = edge && edge.node;
          // A profile page also loads connections that aren't posts (suggested
          // accounts, reels trays); keep only things shaped like media.
          if (node && (node.code || node.image_versions2 || node.media_type != null)) out.push(node);
        }
      }
    }
    return out;
  }

  function drainCaptured(seen, posts, opts) {
    let added = 0;
    for (const cap of MS.captureBuffer.splice(0)) {
      for (const item of itemsFromCapture(cap.body)) {
        const n = normalize(item);
        // Guard against posts from someone else's connection on the same page.
        const author = (n["Post Author"] || "").toLowerCase();
        if (opts.username && author && author !== opts.username.toLowerCase()) continue;
        if (!n.id || seen.has(n.id)) continue;
        seen.add(n.id);
        posts.push(n);
        added++;
        if (opts.maxPosts && posts.length >= opts.maxPosts) return added;
      }
    }
    return added;
  }

  // /username/ from a profile URL, ignoring reserved first-level paths. Used
  // both to label the popup and to check that the tab is showing the profile
  // we are about to capture.
  const RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "direct", "accounts", "tv"]);
  function usernameFromUrl(url) {
    try {
      const u = new URL(url);
      if (!/instagram\.com$/.test(u.hostname.replace(/^www\./, ""))) return null;
      const seg = u.pathname.split("/").filter(Boolean)[0];
      return seg && !RESERVED.has(seg) ? seg : null;
    } catch (_) {
      return null;
    }
  }

  // Total post count, so the progress bar has something to aim at. It sits in
  // the page's preloaded JSON; absent is fine.
  function postCountFromPage() {
    try {
      for (const el of document.querySelectorAll('script[type="application/json"]')) {
        const m = (el.textContent || "").match(/"media_count"\s*:\s*(\d+)/);
        if (m) return Number(m[1]);
      }
    } catch (_) {}
    return null;
  }

  async function scrapeViaCapture(opts, onProgress, shouldStop) {
    MS.ensureInterceptor();
    MS.flushBuffer();

    const posts = [];
    const seen = new Set();
    const total = postCountFromPage();
    let idleRounds = 0;

    const tick = (status) =>
      onProgress({ collected: posts.length, total, profile: opts.username, status });

    tick("Reading posts from the page…");

    // Scroll to make Instagram request the next page; harvest what comes back.
    // Six idle rounds is the same terminator the TikTok adapter uses.
    while (idleRounds < 6) {
      if (shouldStop()) break;
      window.scrollTo(0, document.body.scrollHeight);
      await MS.sleep(1200 + Math.random() * 600);
      const before = posts.length;
      drainCaptured(seen, posts, opts);
      tick();
      if (opts.maxPosts && posts.length >= opts.maxPosts) break;
      idleRounds = posts.length === before ? idleRounds + 1 : 0;
    }
    drainCaptured(seen, posts, opts);
    if (opts.maxPosts && posts.length > opts.maxPosts) posts.length = opts.maxPosts;

    const first = posts[0] || {};
    return {
      platform: "instagram",
      profile: {
        username: opts.username || first["Post Author"] || "",
        full_name: first["Post Author Full Name"] || "",
        post_count: total != null ? total : posts.length,
      },
      posts,
    };
  }

  async function scrape(opts, onProgress, shouldStop) {
    const onPage = usernameFromUrl(location.href);
    const wanted = (opts.username || "").toLowerCase();

    // Capture reads whatever profile the tab is showing, so a mismatch would
    // quietly export the wrong account's posts. Say so instead.
    if (!onPage) {
      throw new Error(
        "Open the profile page you want to export (instagram.com/<username>/) and run the scrape from there."
      );
    }
    if (wanted && wanted !== onPage.toLowerCase()) {
      throw new Error(
        'This tab is showing @' + onPage + ', not @' + opts.username + ". Open @" + opts.username + "'s profile and try again."
      );
    }

    const result = await scrapeViaCapture({ ...opts, username: onPage }, onProgress, shouldStop);
    if (result.posts.length || shouldStop()) return result;

    // Nothing captured — the page made no post requests we could read. Fall
    // back to the old API path, which still reports its own failure clearly.
    onProgress({ collected: 0, total: null, profile: opts.username, status: "Nothing captured — trying Instagram's API…" });
    return scrapeViaApi({ ...opts, username: onPage }, onProgress, shouldStop);
  }

  MS.instagram = {
    matches: (host) => /(^|\.)instagram\.com$/.test(host),
    usernameFromUrl,
    scrape,
    // Exposed for the offline tests: the capture parser, and the legacy API
    // path, whose 429 / HTML-block handling is verified on its own.
    _test: { normalize, mediaList, itemsFromCapture, scrapeViaApi },
  };
})();
