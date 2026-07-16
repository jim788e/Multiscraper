# Multiscraper — Instagram / TikTok profile exporter

A Chrome extension (Manifest V3) that exports **all** posts from a profile you can
view — not the 10-post preview a third-party tool gives you — including the real
like/comment counts, and optionally downloads every image/video.

## Why this works where a direct request doesn't

Meta blocks *external, session-less* requests to its data. This extension runs
**inside your logged-in tab** on `instagram.com`, so its requests carry your own
session cookies and are treated as first-party. It calls Instagram's own web API
(`/api/v1/feed/user/...`) and pages through the entire feed. The "10 posts" and
`PREMIUM FIELD` limits you hit before were the *other tool's* paywall, not a
technical limit of Instagram.

TikTok signs its API requests, so instead of forging signatures the extension
lets the page make its own signed calls and **captures the responses while
auto-scrolling** the profile.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder in this repo.
4. Pin the "Multiscraper" extension for easy access.

## Chrome download settings (do this once)

For silent, no-prompt downloads that land in the right place, adjust two settings
at `chrome://settings/downloads`:

1. **Location** → set to where you want files, e.g. `C:\Users\<you>\Downloads`.
   The extension saves into a `multiscraper/<profile>` subfolder *of this
   location*. (It cannot save outside your Downloads folder — a Chrome rule.)
2. **Turn OFF** "Ask where to save each file before downloading."
   If this is **on**, Chrome pops a **Save As** dialog for *every* file and
   anchors the path to the last folder you picked — so you'll see repeated
   prompts and files landing in an unexpected folder (e.g. a stray `mooz-cool/`).
   The extension asks Chrome to save silently, but this global setting overrides
   that, so it must be off.

**If the toggle is greyed out or keeps turning itself back on**, a policy is
forcing it (common on managed/work machines or with some bundled software).
Check `chrome://policy` for `PromptForDownloadLocation` (forces the prompt) or
`DownloadDirectory` (forces the folder) — those must be removed by whoever
manages the policy before the setting will stick.

## Use

1. Log in to Instagram (or TikTok) in Chrome.
2. Open the **profile page** you want to export (e.g.
   `https://www.instagram.com/afesouspritzeria/`).
3. Click the Multiscraper toolbar icon. The username auto-fills from the tab.
4. Set **Max posts** (`0` = every post) and click **Scrape profile**. Watch the
   live count.
5. When it finishes: **Export JSON**, **Export CSV**, or **Download media files**.
   - JSON matches your original tool's schema: `{ "data": [ { ...same field
     names... } ] }`, with `Post Likes` / `Post Comments Count` now filled in.
   - **Save to folder**: set it once per batch (defaults to
     `multiscraper/<username>`, and remembers your last choice). Everything —
     media, JSON, CSV — goes there under your Downloads folder with **no
     per-file "Save As" prompt**. Change the folder anytime for the next batch.
   - Chrome can only save silently *inside* Downloads, so the destination is a
     subfolder of Downloads rather than an arbitrary location.

## Reliability features

- **Live progress bar** while downloading media: "Saved 14 / 60…", counting only
  files Chrome confirms are actually on disk.
- **Retry failed downloads**: Instagram's CDN links expire, so a big batch can
  leave a few misses — a one-click **Retry** button re-downloads just those.
- **Rate-limit resilience**: the Instagram scraper auto-retries with exponential
  backoff on `429` / server / network errors, so long profiles don't die midway.
  Real auth failures (`401`/`403`) stop immediately with a clear message.
- **Survives popup close**: downloads keep running in the background; reopening
  the popup shows the last run's result (and any Retry button).

## Notes & limits

- **Private profiles**: only work if the logged-in account can view them.
- **Rate limits**: the Instagram scraper pauses ~1s between pages to stay gentle.
  If you see `HTTP 401/403`, you're logged out or rate-limited — wait and retry.
- **CDN URLs expire**: exported image/video links are time-limited by Meta/TikTok.
  Use **Download media** to keep the files.
- **TikTok** relies on auto-scroll capture; keep the tab focused while it runs.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 config, permissions, content scripts |
| `common.js` | Shared schema, CSV, capture buffer, interceptor loader |
| `inject.js` | MAIN-world fetch/XHR patch that harvests feed responses |
| `platforms/instagram.js` | Resolve user + paginate full feed + normalize |
| `platforms/tiktok.js` | Auto-scroll + capture `item_list` + normalize |
| `content.js` | Orchestrates a scrape for the active tab |
| `background.js` | Downloads media via `chrome.downloads` |
| `popup.*` | UI: scrape, progress, export JSON/CSV, download media |

## Legal / ethical

Only scrape profiles you're permitted to view, and use exported data in line with
each platform's Terms of Service and applicable law (copyright, privacy/GDPR).
This tool is for your own data, public research, and archival of content you have
the right to use.

## Contributing

Going public soon — forks and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, and how to run the
tests. Quick start:

```bash
# fork + clone, then:
npm test              # run the offline test suites (needs only Node, no install)
# load extension/ as an unpacked extension at chrome://extensions
```

Please only build features for data a logged-in user can already view, and keep
`npm test` green.

## License

MIT © 2026 Dimitrios Misios. See [LICENSE](LICENSE).
