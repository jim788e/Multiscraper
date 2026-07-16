// Integration test for background.js download handler: exact completion counting,
// the "completed before we registered it" race, immediate start failures, and the
// failed-files list used by the Retry button.
const fs = require("fs");
const vm = require("vm");

const path = require("path");
const EXT = path.join(__dirname, "..", "extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let onChangedListener = null;
let messageHandler = null;
const progress = [];
const storageWrites = [];
let nextId = 100;

const plan = { u0: "race", u1: "complete", u2: "failstart", u3: "complete", u4: "interrupt" };

const chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (cb) => (messageHandler = cb) },
    sendMessage: (msg) => {
      if (msg && msg.type === "mediaProgress") progress.push(msg);
      return Promise.resolve();
    },
  },
  storage: { local: { set: (obj) => storageWrites.push(obj) } },
  downloads: {
    onChanged: { addListener: (fn) => (onChangedListener = fn), removeListener: () => {} },
    download: (opts, cb) => {
      const p = plan[opts.url];
      const id = nextId++;
      if (p === "failstart") {
        chrome.runtime.lastError = { message: "could not start" };
        cb(undefined);
        chrome.runtime.lastError = undefined;
        return;
      }
      if (p === "race") {
        // Chrome reports it complete before the handler registers the id.
        onChangedListener({ id, state: { current: "complete" } });
        cb(id);
        return;
      }
      cb(id); // normal: id first, terminal state arrives later
      setTimeout(() => onChangedListener({ id, state: { current: p === "interrupt" ? "interrupted" : "complete" } }), 10);
    },
  },
};

const sandbox = { chrome, console, setTimeout, Promise, URL, Date };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(EXT + "/background.js", "utf8"), sandbox, { filename: "background.js" });

const files = ["u0", "u1", "u2", "u3", "u4"].map((u, i) => ({ url: u, shortcode: "s" + i, index: i, kind: "image" }));

let pass = 0, fail = 0;
const assert = (c, label) => (c ? pass++ : (fail++, console.log("  FAIL:", label)));

(async () => {
  let response = null;
  messageHandler({ type: "downloadMedia", folder: "multiscraper/test", files }, {}, (r) => (response = r));

  await sleep(400); // let the loop + delayed onChanged events drain

  assert(response !== null, "handler responded");
  assert(response.ok === true, "response ok");
  assert(response.downloaded === 3, "3 files saved (u0 race + u1 + u3) — got " + response.downloaded);
  assert(response.failed === 2, "2 failed (u2 failstart + u4 interrupt) — got " + response.failed);
  assert(response.failedFiles.length === 2, "failedFiles has 2 entries for retry");
  const failedUrls = response.failedFiles.map((f) => f.url).sort();
  assert(failedUrls.join(",") === "u2,u4", "failed files are u2 and u4 — got " + failedUrls.join(","));

  // Every file accounted for exactly once (no race undercount, no double count).
  assert(response.downloaded + response.failed === files.length, "all files counted exactly once");

  // Progress was emitted and the final storage write marks the run finished.
  assert(progress.length > 0, "progress events emitted");
  const lastDl = storageWrites.map((w) => w.lastDownload).filter(Boolean).pop();
  assert(lastDl && lastDl.ok === 3 && lastDl.failed === 2, "lastDownload persisted for popup restore");
  const liveFinal = storageWrites.map((w) => w.mediaLive).filter(Boolean).pop();
  assert(liveFinal && liveFinal.running === false, "mediaLive marked not running at finish");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
