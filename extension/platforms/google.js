// Google Business adapter. Runs on google.com — both the Search knowledge
// panel (where share.google links land) and Google Maps place pages. Business
// info comes from the page itself; reviews come from the GetLocalBoqProxy RPC,
// the same endpoint the panel's own "reviews" dialog uses, so it works with the
// user's session and pages far past what the panel renders.
(function () {
  const MS = (window.MS = window.MS || {});

  // ---- identity -----------------------------------------------------------

  // The "0x…:0x…" feature id every review RPC needs. Present as data-fid on
  // the Search panel, in the raw HTML, or inside a Maps place URL (!1s…).
  function findFid() {
    const el = document.querySelector("[data-fid]");
    if (el) return el.getAttribute("data-fid");
    const urlM = location.href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    if (urlM) return urlM[1];
    const htmlM = document.documentElement.innerHTML.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
    return htmlM ? htmlM[0] : null;
  }

  // Stable canonical Maps link: the CID is the decimal form of the fid's
  // second hex half.
  function cidUrl(fid) {
    try {
      return "https://www.google.com/maps?cid=" + BigInt(fid.split(":")[1]).toString();
    } catch (_) {
      return "";
    }
  }

  function businessNameFromPage() {
    const t = document.querySelector('[data-attrid="title"]');
    if (t && t.textContent.trim()) return t.textContent.trim();
    const mapsM = location.pathname.match(/\/maps\/place\/([^/]+)/);
    if (mapsM) return decodeURIComponent(mapsM[1]).replace(/\+/g, " ");
    const q = new URLSearchParams(location.search).get("q");
    return q ? q.trim() : null;
  }

  // ---- business info (knowledge panel DOM) --------------------------------

  function attrText(key) {
    const el = document.querySelector('[data-attrid="' + key + '"]');
    return el ? el.innerText.replace(/\s+/g, " ").trim() : "";
  }

  // "Label: value" panel rows are localized; strip everything up to the first
  // colon so we keep just the value in any language.
  function stripLabel(s) {
    const i = s.indexOf(":");
    return i > -1 && i < 30 ? s.slice(i + 1).trim() : s;
  }

  // Localized "N reviews" labels for the markets Google Search ships in; the
  // count link/label is the only place the panel shows the review total.
  const REVIEW_WORDS = /αξιολογήσε|κριτικ|reviews?|ratings?|Rezension|avis|reseñ|recensio|recensen|yorum|отзыв|recenzj/i;

  function parseSubtitle() {
    // e.g. "4,4 · 15–25 € ‧ Μεζεδοπωλείο" spread over spans
    const raw = attrText("subtitle");
    const out = { rating: null, reviewCount: null, category: "", price: "" };
    const el = document.querySelector('[data-attrid="subtitle"]');
    if (el) {
      for (const s of el.querySelectorAll("span")) {
        const t = s.textContent.trim();
        if (out.rating == null && /^\d[.,]\d$/.test(t)) out.rating = parseFloat(t.replace(",", "."));
        if (!out.price && /^[\d.,–\-+   ]+[€$£¥₺]\+?$|^[€$£¥₺]{1,4}\+?$/.test(t)) out.price = t.replace(/[  ]/g, " ");
      }
      // category is usually the trailing segment after the "‧" separator
      const seg = raw.split("‧").pop().trim();
      if (seg && !/\d/.test(seg)) out.category = seg;
    }
    for (const cand of document.querySelectorAll("a, span")) {
      const t = (cand.textContent || "").trim();
      if (!t || t.length > 40 || !REVIEW_WORDS.test(t)) continue;
      const m = t.match(/^\(?([\d.,   ]+)\)?\s*\S/);
      if (m) {
        const n = parseInt(m[1].replace(/[^\d]/g, ""), 10);
        if (n > 0) {
          out.reviewCount = n;
          break;
        }
      }
    }
    return out;
  }

  function websiteUrl() {
    // The panel's action bar links straight to the business site.
    const a = document.querySelector('a[href*="/url?"], [data-attrid="kc:/local:unified_actions"] a[href^="http"]');
    for (const link of document.querySelectorAll('[data-attrid="kc:/local:unified_actions"] a[href], a.n1obkb, a[ssk="44:website"]')) {
      const href = link.href || "";
      if (/^https?:/.test(href) && !/google\.[a-z.]+\//.test(href)) return href;
      const m = href.match(/[?&]q=(https?[^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    if (a) {
      const m = (a.href || "").match(/[?&]q=(https?[^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return "";
  }

  function collectBusiness(fid) {
    const sub = parseSubtitle();
    return {
      name: businessNameFromPage() || "business",
      category: sub.category,
      rating: sub.rating,
      review_count: sub.reviewCount,
      description: stripLabel(attrText("kc:/local:merchant_description")).replace(/^[^"]*"?|"$/g, "").trim() || attrText("kc:/local:merchant_description"),
      address: stripLabel(attrText("kc:/location/location:address")),
      phone: stripLabel(attrText("kc:/local:alt phone") || attrText("kc:/local:phone")),
      hours: stripLabel(attrText("kc:/location/location:hours")),
      // Prefer the compact subtitle price ("15–25 €") over the verbose
      // panel row ("15–25 € Αναφέρθηκε από 333 άτομα").
      price_range: sub.price || stripLabel(attrText("kc:/local:concrete_price_range") || attrText("kc:/local:price range")),
      website: websiteUrl(),
      maps_url: cidUrl(fid),
      fid,
    };
  }

  // ---- reviews (GetLocalBoqProxy RPC) -------------------------------------

  function boqUrl(fid, sort, pageToken) {
    const inner = pageToken
      ? [null, sort, null, null, null, null, null, null, null, null, null, [fid], null, null, null, null, null, null, null, pageToken]
      : [null, sort, null, null, null, null, null, null, null, 10, null, [fid]];
    const reqpld = [null, [null, null, null, null, null, null, null, null, null, inner]];
    return (
      "https://www.google.com/httpservice/web/PrivateLocalSearchUiDataService/GetLocalBoqProxy?msc=gwsrpc&reqpld=" +
      encodeURIComponent(JSON.stringify(reqpld))
    );
  }

  async function fetchPage(fid, pageToken, attempt = 0) {
    let res;
    try {
      res = await fetch(boqUrl(fid, 2 /* newest */, pageToken), { credentials: "include" });
    } catch (e) {
      if (attempt < 4) {
        await MS.sleep(1000 * Math.pow(2, attempt));
        return fetchPage(fid, pageToken, attempt + 1);
      }
      throw new Error("Network error contacting Google — check your connection and try again.");
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 5) {
        await MS.sleep(3000 * Math.pow(2, attempt));
        return fetchPage(fid, pageToken, attempt + 1);
      }
      throw new Error("Google is rate-limiting (HTTP " + res.status + "). Wait a few minutes, then retry.");
    }
    if (!res.ok) throw new Error("Google reviews request failed: HTTP " + res.status);
    const text = await res.text();
    const parts = text.split(")]}'");
    let data;
    try {
      data = JSON.parse(parts.length > 1 ? parts[1] : parts[0]);
    } catch (e) {
      throw new Error("Google returned an unexpected response format.");
    }
    const node = data && Array.isArray(data[1]) ? data[1][10] : null;
    if (!node) return { reviews: [], next: "" };
    return {
      reviews: Array.isArray(node[2]) ? node[2] : [],
      next: typeof node[6] === "string" ? node[6] : "",
    };
  }

  // Owner replies are NOT included in GetLocalBoqProxy responses (verified
  // against businesses that answer every review), so we only report one if a
  // future schema adds it in the strict shape [text, [relative, ?, epoch]] —
  // never via loose string scanning: the tail indices 37/38 hold the
  // auto-TRANSLATED review text, which reads exactly like another review and
  // must not be mistaken for a reply.
  function findOwnerReply(r, reviewText) {
    for (let i = 31; i < r.length; i++) {
      const el = r[i];
      if (!Array.isArray(el)) continue;
      const txt = el.find((y) => typeof y === "string" && y.length > 15 && !/^https?:|^\/\//.test(y));
      const hasOwnDate = el.some(
        (y) => Array.isArray(y) && typeof y[2] === "string" && /^\d{12,}$/.test(y[2])
      );
      if (txt && hasOwnDate && txt !== reviewText) return txt;
    }
    return "";
  }

  // Foreign-language reviews carry Google's auto-translation at 37/38 and the
  // source-language name at 36.
  function translationOf(r, originalText) {
    const t = typeof r[37] === "string" && r[37] ? r[37] : typeof r[38] === "string" ? r[38] : "";
    return t && t !== originalText ? t : "";
  }

  function reviewImages(r) {
    const urls = [];
    (function walk(x) {
      if (typeof x === "string" && x.includes("googleusercontent") && /^https?:|^\/\//.test(x)) {
        const u = x.startsWith("//") ? "https:" + x : x;
        if (!urls.includes(u) && !/=s(32|40|64|120)-/.test(u)) urls.push(u);
      } else if (Array.isArray(x)) x.forEach(walk);
    })(r.slice(6, 30));
    return urls.slice(0, 10);
  }

  function normalize(r) {
    const author = Array.isArray(r[3]) ? r[3] : [];
    const dateArr = Array.isArray(r[2]) ? r[2] : [];
    const epochMs = dateArr[2] ? parseInt(dateArr[2], 10) : null;
    const text = typeof r[27] === "string" && r[27] ? r[27] : typeof r[28] === "string" ? r[28] : "";
    const images = reviewImages(r);
    return {
      id: typeof r[5] === "string" ? r[5] : String(Math.random()).slice(2),
      "Review Author": author[0] || "A Google User",
      "Review Author Image": author[1] || "",
      "Review Author URL": author[2] || "",
      "Review Rating": typeof r[1] === "number" ? r[1] : "Not Available",
      "Review Text": text,
      "Review Date": epochMs ? new Date(epochMs).toISOString() : "",
      "Review Date (relative)": dateArr[0] || "",
      "Review Language": typeof r[36] === "string" ? r[36] : "",
      "Review Text (translated)": translationOf(r, text),
      "Owner Reply": findOwnerReply(r, text) || "Not Available",
      "Review Images": images.join(" "),
      _shortcode: typeof r[5] === "string" ? r[5].slice(-12) : "review",
      _media: images.map((u) => ({ url: u, kind: "image" })),
    };
  }

  const EXPORT_KEYS = [
    "id",
    "Review Author",
    "Review Author Image",
    "Review Author URL",
    "Review Rating",
    "Review Text",
    "Review Date",
    "Review Date (relative)",
    "Review Language",
    "Review Text (translated)",
    "Owner Reply",
    "Review Images",
  ];

  async function scrape(opts, onProgress, shouldStop) {
    const fid = findFid();
    if (!fid)
      throw new Error(
        "No Google business found on this page. Open the business panel (a share.google link or a Google Maps place) and try again."
      );
    const business = collectBusiness(fid);
    const total = business.review_count;
    const reviews = [];
    const seen = new Set();
    let token = "";

    onProgress({ collected: 0, total, profile: business.name });

    do {
      if (shouldStop()) break;
      const page = await fetchPage(fid, token);
      for (const raw of page.reviews) {
        if (!Array.isArray(raw)) continue;
        const n = normalize(raw);
        if (!seen.has(n.id)) {
          seen.add(n.id);
          reviews.push(n);
        }
      }
      onProgress({ collected: reviews.length, total, profile: business.name });
      if (opts.maxPosts && reviews.length >= opts.maxPosts) break;
      token = page.next && page.next !== token ? page.next : "";
      if (token) await MS.sleep(600 + Math.random() * 500); // be gentle
    } while (token);

    if (opts.maxPosts && reviews.length > opts.maxPosts) reviews.length = opts.maxPosts;

    return {
      platform: "google",
      schemaKeys: EXPORT_KEYS,
      profile: {
        username: business.name, // popup uses profile.username for folder/file names
        ...business,
      },
      posts: reviews,
    };
  }

  MS.google = {
    matches: (host) => /(^|\.)google\.[a-z.]+$/.test(host),
    usernameFromUrl: () => businessNameFromPage(),
    scrape,
    _test: { normalize, findOwnerReply, EXPORT_KEYS },
  };
})();
