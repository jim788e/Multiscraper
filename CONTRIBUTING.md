# Contributing to Multiscraper

Thanks for your interest! This project is a Manifest V3 Chrome extension that
exports posts (media, captions, real engagement metrics) from an Instagram or
TikTok profile you can view. It's going public soon — forks, issues, and pull
requests are welcome.

## Ground rules

- **Only build features for data a logged-in user can already see.** No bypassing
  auth, paywalls beyond a public profile's own content, private accounts you
  can't view, mass automation, or anything against the platforms' Terms.
- Keep changes focused and well described. One logical change per pull request.
- No new runtime dependencies. The extension is intentionally dependency-free and
  runs entirely in the browser; the only Node use is for tests and icon
  generation, both using built-in modules.

## Getting set up

1. **Fork** this repo and clone your fork.
2. Load the extension unpacked:
   - Open `chrome://extensions`, enable **Developer mode**.
   - **Load unpacked** → select the `extension/` folder.
3. Make changes, then click **↻ reload** on the extension card to pick them up.
   - Editing `manifest.json` (permissions, etc.) always needs a reload.
   - To test on a profile: log in to Instagram/TikTok, open a profile page, click
     the toolbar icon, and Scrape.

You only need **Node.js** (any recent version) to run the tests — no `npm install`.

## Project layout

| Path | Role |
| --- | --- |
| `extension/manifest.json` | MV3 config, permissions, content scripts |
| `extension/common.js` | Shared export schema, CSV, capture buffer, interceptor loader |
| `extension/inject.js` | MAIN-world `fetch`/`XHR` patch that harvests feed responses |
| `extension/platforms/instagram.js` | Resolve user → paginate full feed → normalize |
| `extension/platforms/tiktok.js` | Auto-scroll + capture `item_list` → normalize |
| `extension/content.js` | Orchestrates a scrape; drives TikTok in-page media download |
| `extension/background.js` | Media downloads via `chrome.downloads`; progress/retry |
| `extension/popup.*` | UI: scrape, progress, exports (JSON/CSV/stats), download |
| `tools/generate-icons.js` | Dependency-free PNG icon generator |
| `tests/` | Offline tests (Node, no deps) |

### How it works, briefly

Code runs inside your logged-in tab, so requests are first-party. Instagram is
paged directly through its private web API (`/api/v1/feed/user/...`). TikTok's
signed `item_list` responses are captured while auto-scrolling, and TikTok
**videos are fetched in the page context** (they're gated by the `tt_chain_token`
session cookie that only an in-page request carries). All adapters normalize into
one export schema defined in `common.js` (`MS.SCHEMA_KEYS`).

## Tests

```bash
npm test            # runs both suites
node tests/test-normalizer.js   # Instagram normalizer → export schema
node tests/test-download.js     # background download state machine
```

The tests load the real extension files in a stubbed browser sandbox — no Chrome
needed. If you change the export schema or a normalizer, update
`tests/test-normalizer.js`. If you touch the download/progress logic in
`background.js`, update `tests/test-download.js`. **Please keep tests green.**

Instagram's internal fields are exposed for testing via `MS.instagram._test`
(`normalize`, `mediaList`) — safe to use from tests, harmless in production.

## Adding a new platform

1. Create `extension/platforms/<name>.js` exposing `MS.<name>` with `matches(host)`,
   `usernameFromUrl(url)`, and `scrape(opts, onProgress, shouldStop)` returning
   `{ platform, profile, posts }` where each post uses the `common.js` schema keys.
2. Register it in `content.js` `pickAdapter()` and add its host to `manifest.json`
   (`content_scripts.matches`, `host_permissions`, `web_accessible_resources`).
3. Add a normalizer test.

## Pull requests

- Branch from `main`, keep the diff minimal, run `npm test`.
- Describe what changed and how you verified it (which profile/flow you tested).
- Match the existing code style (plain ES, no build step, comments only where the
  code can't speak for itself).

## Coding style

- Vanilla JavaScript, no framework, no bundler.
- Prefer clarity over cleverness; keep functions small.
- Comments should explain *why* (a platform quirk, a constraint), not narrate the code.
