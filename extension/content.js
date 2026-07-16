// Orchestrator (isolated world). Receives commands from the popup, picks the
// platform adapter for the current tab, runs the scrape with live progress, and
// hands the result back. Loaded last so MS.instagram / MS.tiktok already exist.
(function () {
  const MS = window.MS;
  let running = false;
  let stopFlag = false;

  function pickAdapter() {
    const host = location.hostname.replace(/^www\./, "");
    if (MS.instagram.matches(host)) return { name: "instagram", api: MS.instagram };
    if (MS.tiktok.matches(host)) return { name: "tiktok", api: MS.tiktok };
    return null;
  }

  function detect() {
    const adapter = pickAdapter();
    if (!adapter) return { platform: null, username: null };
    return {
      platform: adapter.name,
      username: adapter.api.usernameFromUrl(location.href),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "detect") {
      sendResponse(detect());
      return; // sync
    }

    if (msg.type === "stop") {
      stopFlag = true;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "scrape") {
      if (running) {
        sendResponse({ ok: false, error: "A scrape is already running in this tab." });
        return true;
      }
      const adapter = pickAdapter();
      if (!adapter) {
        sendResponse({ ok: false, error: "Open an Instagram or TikTok profile tab first." });
        return true;
      }
      const username = msg.username || adapter.api.usernameFromUrl(location.href);
      if (!username) {
        sendResponse({ ok: false, error: "Could not determine the profile username. Open the profile page or type the username." });
        return true;
      }

      running = true;
      stopFlag = false;
      const onProgress = (p) =>
        chrome.runtime.sendMessage({ type: "progress", ...p }).catch(() => {});

      adapter.api
        .scrape({ username, maxPosts: msg.maxPosts || 0 }, onProgress, () => stopFlag)
        .then((result) => {
          running = false;
          const exportRows = result.posts.map(MS.toExportRow);
          const mediaFiles = MS.mediaManifest(result);
          chrome.storage.local.set({
            lastResult: {
              platform: result.platform,
              profile: result.profile,
              count: result.posts.length,
              rows: exportRows,
              media: mediaFiles,
              savedAt: new Date().toISOString(),
            },
          });
          chrome.runtime
            .sendMessage({ type: "done", platform: result.platform, profile: result.profile, count: result.posts.length })
            .catch(() => {});
          sendResponse({ ok: true, count: result.posts.length });
        })
        .catch((err) => {
          running = false;
          chrome.runtime.sendMessage({ type: "error", error: String(err.message || err) }).catch(() => {});
          sendResponse({ ok: false, error: String(err.message || err) });
        });

      return true; // async response
    }
  });

  // Prime the interceptor on TikTok so early item_list responses aren't missed.
  if (/tiktok\.com$/.test(location.hostname.replace(/^www\./, ""))) MS.ensureInterceptor();

  // TikTok media download, driven from the page context. TikTok video URLs are
  // signed and gated by the tt_chain_token session cookie, which only a request
  // from inside tiktok.com carries — so we fetch the bytes here (same as the
  // player, which is why it produces a blob:) and hand them to the background to
  // save into the chosen folder. Images use the direct URL (no CORS to read).
  const sane = (s) => String(s || "x").replace(/[^a-z0-9._@-]+/gi, "_").slice(0, 60);
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error("read failed"));
      fr.readAsDataURL(blob);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "tiktokDownload") return;
    const files = msg.files || [];
    const total = files.length;
    (async () => {
      let ok = 0,
        fail = 0;
      const failedFiles = [];
      for (const f of files) {
        try {
          let saveUrl = f.url;
          if (f.kind === "video") {
            const res = await fetch(f.url, { credentials: "include" });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const blob = await res.blob();
            if (!blob.size) throw new Error("empty response");
            saveUrl = await blobToDataURL(blob); // data: URL is JSON-safe for messaging
          }
          const ext = f.kind === "video" ? "mp4" : "jpg";
          const filename = msg.folder + "/" + sane(f.shortcode) + "_" + f.index + "." + ext;
          const r = await chrome.runtime.sendMessage({ type: "saveDownload", url: saveUrl, filename });
          if (r && r.ok) ok++;
          else {
            fail++;
            failedFiles.push(f);
          }
        } catch (e) {
          fail++;
          failedFiles.push(f);
        }
        chrome.runtime.sendMessage({ type: "mediaProgress", done: ok + fail, ok, fail, total }).catch(() => {});
      }
      chrome.storage.local.set({
        lastDownload: { ok, failed: fail, failedFiles, folder: msg.folder, total, at: new Date().toISOString() },
      });
      sendResponse({ ok: true, downloaded: ok, failed: fail, failedFiles });
    })();
    return true; // async
  });
})();
