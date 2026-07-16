const $ = (id) => document.getElementById(id);
let activeTabId = null;
let lastResult = null;

function setStatus(text, isErr) {
  const el = $("status");
  el.textContent = text || "";
  el.className = "status" + (isErr ? " err" : "");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const tab = await activeTab();
  activeTabId = tab && tab.id;
  const host = (() => {
    try {
      return new URL(tab.url).hostname.replace(/^www\./, "");
    } catch (_) {
      return "";
    }
  })();

  if (!/instagram\.com$|tiktok\.com$/.test(host)) {
    $("platform").textContent = "Open an Instagram or TikTok profile tab";
    $("platform").className = "platform bad";
    $("scrape").disabled = true;
    return;
  }

  let detected = { platform: null, username: null };
  try {
    detected = await chrome.tabs.sendMessage(activeTabId, { type: "detect" });
    $("platform").textContent = detected.platform + (detected.username ? " · @" + detected.username : "");
    $("platform").className = "platform ok";
    if (detected.username) $("username").value = detected.username;
  } catch (_) {
    // content script not ready (e.g. tab loaded before extension installed)
    $("platform").textContent = host.replace(".com", "");
    $("platform").className = "platform ok";
    setStatus("Reload the profile tab, then reopen this popup.", true);
  }

  // Only restore a saved result if it belongs to the profile in THIS tab —
  // otherwise the popup would show a previous profile's posts and download folder.
  const { lastResult: stored, lastDownload } = await chrome.storage.local.get(["lastResult", "lastDownload"]);
  const same =
    stored &&
    detected.username &&
    stored.platform === detected.platform &&
    (stored.profile.username || "").toLowerCase() === detected.username.toLowerCase();
  if (same) {
    lastResult = stored;
    await showResults(stored);
    // Surface the outcome of the previous media download (survives popup close),
    // including a retry button if some files failed / links had expired.
    if (lastDownload) {
      setMediaStatus("Last run: saved " + lastDownload.ok + " / " + lastDownload.total + (lastDownload.failed ? " · " + lastDownload.failed + " failed" : "") + ".");
      showRetry(lastDownload.failedFiles || []);
    }
  }
}

async function showResults(r) {
  $("results").classList.remove("hidden");
  const mediaCount = (r.media || []).length;
  $("summary").innerHTML =
    "<b>" + r.count + "</b> posts from @" + (r.profile.username || "profile") +
    " · " + mediaCount + " media files";

  // Always default to the profile currently loaded (not a remembered folder from
  // a previous, different profile). You can still edit it before downloading.
  $("folder").value = "multiscraper/" + (r.profile.username || "profile");
}

function currentFolder() {
  return $("folder").value.trim() || "multiscraper/profile";
}

$("scrape").addEventListener("click", async () => {
  const username = $("username").value.trim();
  const maxPosts = parseInt($("maxPosts").value, 10) || 0;
  setStatus("Starting…");
  $("progress").classList.remove("hidden");
  $("bar").style.width = "3%";
  $("scrape").disabled = true;
  $("stop").disabled = false;

  try {
    const resp = await chrome.tabs.sendMessage(activeTabId, { type: "scrape", username, maxPosts });
    if (resp && resp.ok === false) {
      setStatus(resp.error, true);
      resetButtons();
    }
  } catch (e) {
    setStatus("Could not reach the page. Reload the profile tab and try again.", true);
    resetButtons();
  }
});

$("stop").addEventListener("click", async () => {
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: "stop" });
  } catch (_) {}
  setStatus("Stopping…");
});

function resetButtons() {
  $("scrape").disabled = false;
  $("stop").disabled = true;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") {
    const pct = msg.total ? Math.min(99, Math.round((msg.collected / msg.total) * 100)) : null;
    $("bar").style.width = (pct != null ? pct : Math.min(95, 5 + msg.collected)) + "%";
    setStatus("Collected " + msg.collected + (msg.total ? " / " + msg.total : "") + " posts…");
  } else if (msg.type === "done") {
    $("bar").style.width = "100%";
    setStatus("Done — " + msg.count + " posts.");
    resetButtons();
    chrome.storage.local.get("lastResult").then(({ lastResult: r }) => {
      lastResult = r;
      showResults(r);
    });
  } else if (msg.type === "mediaProgress") {
    const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
    $("mediaBar").style.width = pct + "%";
    setMediaStatus("Saved " + msg.done + " / " + msg.total + (msg.fail ? " · " + msg.fail + " failed" : "") + "…");
  } else if (msg.type === "error") {
    setStatus(msg.error, true);
    resetButtons();
    $("progress").classList.add("hidden");
  }
});

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  // Same folder as the media, and no dialog — consistent with the batch download.
  const filename = currentFolder() + "/" + name;
  chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }, () =>
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  );
}

$("json").addEventListener("click", () => {
  if (!lastResult) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  download(
    (lastResult.profile.username || "profile") + "_" + stamp + ".json",
    JSON.stringify({ data: lastResult.rows }, null, 2),
    "application/json"
  );
});

$("csv").addEventListener("click", () => {
  if (!lastResult) return;
  // Rebuild CSV here to keep parity with the schema order used in common.js.
  const keys = Object.keys(lastResult.rows[0] || {});
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [keys.map(esc).join(",")];
  for (const row of lastResult.rows) lines.push(keys.map((k) => esc(row[k])).join(","));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  download((lastResult.profile.username || "profile") + "_" + stamp + ".csv", lines.join("\n"), "text/csv");
});

let lastFailedFiles = [];

function setMediaStatus(text) {
  $("mediaStatus").textContent = text || "";
}

function showRetry(files) {
  lastFailedFiles = files || [];
  const n = lastFailedFiles.length;
  if (n) {
    $("retry").textContent = "Retry " + n + " failed download" + (n > 1 ? "s" : "");
    $("retry").classList.remove("hidden");
  } else {
    $("retry").classList.add("hidden");
  }
}

async function runDownload(files) {
  const total = files.length;
  const folder = currentFolder();
  $("media").disabled = true;
  $("retry").disabled = true;
  $("retry").classList.add("hidden");
  $("mediaProgress").classList.remove("hidden");
  $("mediaBar").style.width = "0%";
  setMediaStatus("Saving 0 / " + total + "…");

  const resp = await chrome.runtime.sendMessage({ type: "downloadMedia", folder, files });
  $("media").disabled = false;
  $("retry").disabled = false;
  if (resp && resp.ok) {
    $("mediaBar").style.width = "100%";
    setMediaStatus("Saved " + resp.downloaded + " / " + total + " files" + (resp.failed ? " · " + resp.failed + " failed" : "") + ".");
    showRetry(resp.failedFiles || []);
  }
}

$("media").addEventListener("click", () => {
  if (!lastResult || !lastResult.media || !lastResult.media.length) {
    setMediaStatus("No media to download.");
    return;
  }
  runDownload(lastResult.media);
});

$("retry").addEventListener("click", () => {
  if (lastFailedFiles.length) runDownload(lastFailedFiles);
});

init();
