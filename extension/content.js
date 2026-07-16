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
})();
