// TikTok adapter. TikTok signs its item_list API requests (X-Bogus / msToken),
// which is painful to reproduce. Instead we let the page make its own signed
// calls: inject.js captures the item_list JSON responses while we auto-scroll
// the profile to force TikTok to load every post. We then normalize the captured
// items into the same export schema as Instagram.
(function () {
  const MS = (window.MS = window.MS || {});

  function stat(v) {
    return v != null ? v : "Not Available";
  }

  function mediaList(it) {
    const out = [];
    const isPhoto = !!(it.imagePost && Array.isArray(it.imagePost.images) && it.imagePost.images.length);

    if (!isPhoto && it.video && (it.video.playAddr || it.video.downloadAddr)) {
      out.push({ url: it.video.downloadAddr || it.video.playAddr, kind: "video" });
    }
    if (isPhoto) {
      for (const img of it.imagePost.images) {
        const url = img.imageURL && img.imageURL.urlList && img.imageURL.urlList[0];
        if (url) out.push({ url, kind: "image" });
      }
    }
    // Always keep the cover for video posts: it downloads reliably (normal image
    // CDN) even when the video URL is blocked, so a post never yields nothing.
    if (!isPhoto) {
      const cover = it.video && (it.video.cover || it.video.originCover);
      if (cover) out.push({ url: cover, kind: "image" });
    }
    return out;
  }

  function normalize(it) {
    const author = it.author || {};
    const stats = it.stats || {};
    const cover = (it.video && (it.video.cover || it.video.originCover)) || "";
    const isPhoto = !!(it.imagePost && it.imagePost.images && it.imagePost.images.length);
    const uid = author.uniqueId || "";
    return {
      id: it.id || "",
      "Post Author": uid,
      "Post Author Full Name": author.nickname || "",
      "Post Author Image": author.avatarLarger || author.avatarMedium || "",
      "Post Author URL": uid ? "https://www.tiktok.com/@" + uid : "",
      "Post Author Is Verified": author.verified ? "Yes" : "No",
      "Post Type": isPhoto ? "Photo" : "Video",
      "Post Text": it.desc || "",
      "Post Image": cover || (isPhoto && mediaList(it)[0] ? mediaList(it)[0].url : "Not Available"),
      "Post Video": it.video && it.video.playAddr ? it.video.playAddr : "Not Available",
      "Post Likes": stat(stats.diggCount),
      "Post Comments Count": stat(stats.commentCount),
      "Post Views": stat(stats.playCount),
      "Post Shares": stat(stats.shareCount),
      "Post Saves": stat(stats.collectCount),
      "Post URL": uid && it.id ? "https://www.tiktok.com/@" + uid + "/video/" + it.id : "",
      "Post Date": it.createTime ? new Date(it.createTime * 1000).toISOString() : "",
      "Is Comments Disabled": "Not Available",
      "Post Accessibility Caption": "Not Available",
      _shortcode: it.id,
      _media: mediaList(it),
    };
  }

  function drainCaptured(seen, posts, maxPosts) {
    let added = 0;
    for (const cap of MS.captureBuffer.splice(0)) {
      const list = (cap.body && (cap.body.itemList || cap.body.items)) || [];
      for (const it of list) {
        const n = normalize(it);
        if (n.id && !seen.has(n.id)) {
          seen.add(n.id);
          posts.push(n);
          added++;
          if (maxPosts && posts.length >= maxPosts) return added;
        }
      }
    }
    return added;
  }

  async function scrape(opts, onProgress, shouldStop) {
    MS.ensureInterceptor();
    MS.captureBuffer.length = 0;

    const posts = [];
    const seen = new Set();
    let idleRounds = 0;

    onProgress({ collected: 0, total: null, profile: opts.username });

    // Auto-scroll to force TikTok to request more posts; harvest as they arrive.
    while (idleRounds < 6) {
      if (shouldStop()) break;
      window.scrollTo(0, document.body.scrollHeight);
      await MS.sleep(1200 + Math.random() * 600);
      const before = posts.length;
      drainCaptured(seen, posts, opts.maxPosts);
      onProgress({ collected: posts.length, total: null, profile: opts.username });
      if (opts.maxPosts && posts.length >= opts.maxPosts) break;
      idleRounds = posts.length === before ? idleRounds + 1 : 0;
    }
    drainCaptured(seen, posts, opts.maxPosts);
    if (opts.maxPosts && posts.length > opts.maxPosts) posts.length = opts.maxPosts;

    return {
      platform: "tiktok",
      profile: { username: opts.username || (posts[0] && posts[0]["Post Author"]) || "", post_count: posts.length },
      posts,
    };
  }

  MS.tiktok = {
    matches: (host) => /(^|\.)tiktok\.com$/.test(host),
    usernameFromUrl: (url) => {
      try {
        const u = new URL(url);
        const seg = u.pathname.split("/").filter(Boolean)[0];
        return seg && seg.startsWith("@") ? seg.slice(1) : null;
      } catch (_) {
        return null;
      }
    },
    scrape,
  };
})();
