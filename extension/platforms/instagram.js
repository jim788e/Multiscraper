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

  // Exponential backoff with jitter; longer waits when actively rate-limited.
  function backoff(attempt, rateLimited) {
    const base = rateLimited ? 5000 : 700;
    return Math.min(30000, base * Math.pow(2, attempt)) + Math.random() * 600;
  }

  // Fetch JSON with retries. Auth failures (401/403) abort immediately with a
  // clear message; rate limits (429) and server/network errors back off and
  // retry so a long scrape survives transient hiccups instead of dying.
  async function getJSON(url, attempt = 0) {
    let res;
    try {
      res = await fetch(url, { headers: headers(), credentials: "include" });
    } catch (e) {
      if (attempt < 4) {
        await MS.sleep(backoff(attempt));
        return getJSON(url, attempt + 1);
      }
      throw new Error("Network error contacting Instagram — check your connection and try again.");
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "Instagram returned " + res.status + " — log in on instagram.com, and make sure you can view this profile (private accounts require you to follow them)."
      );
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 5) {
        await MS.sleep(backoff(attempt, res.status === 429));
        return getJSON(url, attempt + 1);
      }
      throw new Error("Instagram is rate-limiting (HTTP " + res.status + "). Wait a few minutes, then resume.");
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
    return res.json();
  }

  // Primary lookup. Instagram intermittently breaks this endpoint server-side
  // (e.g. the 2026 "ig_business_category_subvertical has been deleted" 400s),
  // so callers must be prepared to fall back to resolveUserFallback().
  async function resolveUserProfileInfo(username) {
    const url =
      "https://www.instagram.com/api/v1/users/web_profile_info/?username=" +
      encodeURIComponent(username);
    const j = await getJSON(url);
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
    const j = await getJSON(url);
    const hit = (j.users || []).find(
      (u) => u.user && u.user.username.toLowerCase() === username.toLowerCase()
    );
    return hit ? hit.user : null;
  }

  // Fallback 2: the profile page HTML embeds the user id ("profilePage_<id>").
  async function resolveUserViaHtml(username) {
    const res = await fetch("https://www.instagram.com/" + encodeURIComponent(username) + "/", {
      credentials: "include",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/profilePage_(\d+)/) || html.match(/"profile_id"\s*:\s*"(\d+)"/);
    return m ? { pk: m[1], username } : null;
  }

  async function resolveUser(username) {
    let primaryErr;
    try {
      return await resolveUserProfileInfo(username);
    } catch (e) {
      primaryErr = e;
    }
    let user = null;
    try {
      user = await resolveUserViaSearch(username);
    } catch (_) {}
    if (!user) {
      try {
        user = await resolveUserViaHtml(username);
      } catch (_) {}
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

  async function scrape(opts, onProgress, shouldStop) {
    const user = await resolveUser(opts.username);
    const posts = [];
    const seen = new Set();
    let maxId = null;

    onProgress({ collected: 0, total: user.edge_owner_to_timeline_media?.count ?? null, profile: user.username });

    do {
      if (shouldStop()) break;
      const data = await feedPage(user.id, maxId);
      const items = data.items || [];
      for (const it of items) {
        const n = normalize(it);
        if (!seen.has(n.id)) {
          seen.add(n.id);
          posts.push(n);
        }
      }
      onProgress({
        collected: posts.length,
        total: user.edge_owner_to_timeline_media?.count ?? null,
        profile: user.username,
      });

      if (opts.maxPosts && posts.length >= opts.maxPosts) break;
      maxId = data.more_available && data.next_max_id ? data.next_max_id : null;
      if (maxId) await MS.sleep(800 + Math.random() * 700); // be gentle; avoid rate limits
    } while (maxId);

    if (opts.maxPosts && posts.length > opts.maxPosts) posts.length = opts.maxPosts;

    return {
      platform: "instagram",
      profile: {
        username: user.username,
        full_name: user.full_name,
        id: user.id,
        is_private: user.is_private,
        post_count: user.edge_owner_to_timeline_media?.count ?? posts.length,
      },
      posts,
    };
  }

  MS.instagram = {
    matches: (host) => /(^|\.)instagram\.com$/.test(host),
    // /username/ from a profile URL, ignoring reserved first-level paths.
    usernameFromUrl: (url) => {
      try {
        const u = new URL(url);
        if (!/instagram\.com$/.test(u.hostname.replace(/^www\./, ""))) return null;
        const seg = u.pathname.split("/").filter(Boolean)[0];
        const reserved = new Set(["p", "reel", "reels", "explore", "stories", "direct", "accounts", "tv"]);
        return seg && !reserved.has(seg) ? seg : null;
      } catch (_) {
        return null;
      }
    },
    scrape,
    _test: { normalize, mediaList }, // exposed for the offline normalizer test
  };
})();
