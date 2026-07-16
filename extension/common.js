// Shared helpers + unified schema. Runs in the content-script isolated world.
// All platform adapters normalize into MS.SCHEMA_KEYS so the exported JSON keeps
// the exact field names used by the original tool export (plus real likes/comments).
(function () {
  const MS = (window.MS = window.MS || {});

  MS.SCHEMA_KEYS = [
    "id",
    "Post Author",
    "Post Author Full Name",
    "Post Author Image",
    "Post Author URL",
    "Post Author Is Verified",
    "Post Type",
    "Post Text",
    "Post Image",
    "Post Video",
    "Post Likes",
    "Post Comments Count",
    "Post Views",
    "Post Shares",
    "Post Saves",
    "Post URL",
    "Post Date",
    "Is Comments Disabled",
    "Post Accessibility Caption",
  ];

  MS.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Buffer that inject.js (MAIN world) feeds via window.postMessage. Platform
  // adapters read from it when using the scroll-and-capture strategy.
  MS.captureBuffer = [];
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__ms !== "capture") return;
    MS.captureBuffer.push({ url: d.url, body: d.body });
  });

  // Inject the MAIN-world network interceptor exactly once.
  MS.ensureInterceptor = function () {
    if (MS._injected) return;
    MS._injected = true;
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("inject.js");
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn("[Multiscraper] interceptor injection failed", e);
    }
  };

  // Reduce a full post record to just the export schema (drops internal _media).
  MS.toExportRow = function (post) {
    const row = {};
    for (const k of MS.SCHEMA_KEYS) row[k] = post[k] != null ? post[k] : "Not Available";
    return row;
  };

  MS.toCSV = function (posts) {
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [MS.SCHEMA_KEYS.map(esc).join(",")];
    for (const p of posts) {
      lines.push(MS.SCHEMA_KEYS.map((k) => esc(p[k])).join(","));
    }
    return lines.join("\n");
  };

  // Flatten every downloadable media URL across all posts, tagged for filenames.
  MS.mediaManifest = function (result) {
    const files = [];
    for (const p of result.posts) {
      const list = p._media || [];
      list.forEach((m, i) => {
        files.push({
          url: m.url,
          shortcode: p._shortcode || p.id,
          index: i,
          kind: m.kind, // "image" | "video"
        });
      });
    }
    return files;
  };
})();
