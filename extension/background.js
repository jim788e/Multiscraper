// Service worker: performs media downloads on request from the popup.
// chrome.downloads runs from the extension context and fetches the public CDN
// URLs directly, so it isn't affected by page CSP or referrer checks.

function extFromUrl(url, kind) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.(jpg|jpeg|png|webp|mp4|mov|heic)(?:$|\?)/i);
    if (m) return m[1].toLowerCase();
  } catch (_) {}
  return kind === "video" ? "mp4" : "jpg";
}

function sanitize(s) {
  return String(s || "unknown").replace(/[^a-z0-9._@-]+/gi, "_").slice(0, 60);
}

// Sanitize a user-supplied relative folder path: keep the slashes as subfolder
// separators, clean each segment, and strip any ".." so it can't escape Downloads.
function sanitizeFolder(s) {
  const parts = String(s || "")
    .split(/[\\/]+/)
    .map((seg) => sanitize(seg))
    .filter((seg) => seg && seg !== "unknown" && seg !== "." && seg !== "..");
  return parts.length ? parts.join("/") : "multiscraper";
}

async function downloadOne(file, folder) {
  const ext = extFromUrl(file.url, file.kind);
  const name = `${folder}/${sanitize(file.shortcode)}_${file.index}.${ext}`;
  return new Promise((resolve) => {
    // saveAs:false suppresses the per-file "Save As" dialog even when Chrome's
    // global "ask where to save each file" setting is on. The whole batch lands
    // silently in Downloads/<folder>/.
    chrome.downloads.download({ url: file.url, filename: name, conflictAction: "uniquify", saveAs: false }, (id) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true, id });
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "downloadMedia") {
    const files = msg.files || [];
    const folder = sanitizeFolder(msg.folder);
    const total = files.length;
    let started = 0,
      ok = 0,
      fail = 0,
      done = false;

    const pending = new Map(); // downloadId -> file, while it is still saving
    const preResolved = new Map(); // id -> state, if it finished before we registered it
    const failedFiles = []; // files to offer for one-click retry

    function emit() {
      chrome.storage.local.set({ mediaLive: { done: ok + fail, ok, fail, total, folder, running: !done } });
      chrome.runtime.sendMessage({ type: "mediaProgress", done: ok + fail, ok, fail, total }).catch(() => {});
    }

    function count(state, file) {
      if (state === "complete") ok++;
      else {
        fail++;
        if (file) failedFiles.push(file);
      }
      emit();
      finish();
    }

    function finish() {
      if (done || started !== total || pending.size !== 0) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      chrome.storage.local.set({
        lastDownload: { ok, failed: fail, failedFiles, folder, total, at: new Date().toISOString() },
        mediaLive: { done: ok + fail, ok, fail, total, folder, running: false },
      });
      sendResponse({ ok: true, downloaded: ok, failed: fail, failedFiles });
    }

    // Registering a just-started download. If Chrome already reported it complete
    // (fast files can finish before we get here), consume that instead of waiting.
    function register(id, file) {
      const early = preResolved.get(id);
      if (early) {
        preResolved.delete(id);
        count(early, file);
      } else {
        pending.set(id, file);
      }
    }

    // Count a file only when Chrome confirms it saved/interrupted, so the tally
    // reflects files actually on disk.
    function onChanged(delta) {
      if (!delta.state) return;
      const st = delta.state.current;
      if (st !== "complete" && st !== "interrupted") return;
      if (pending.has(delta.id)) {
        const file = pending.get(delta.id);
        pending.delete(delta.id);
        count(st, file);
      } else {
        preResolved.set(delta.id, st); // finished before register(); consumed there
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);

    (async () => {
      for (let i = 0; i < files.length; i++) {
        const r = await downloadOne(files[i], folder);
        started++;
        if (r.ok) register(r.id, files[i]);
        else count("interrupted", files[i]); // couldn't even start (e.g. expired URL)
        if (i % 5 === 4) await new Promise((res) => setTimeout(res, 250));
      }
      finish(); // handles the case where everything already drained
    })();

    return true; // async
  }
});
