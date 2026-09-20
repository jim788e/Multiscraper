# Changelog

All notable changes to the Multiscraper project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-09-21

### Fixed
- **Instagram HTTP 429 handling** ([`extension/platforms/instagram.js`](file:///d:/dev/Multiscraper/extension/platforms/instagram.js)): a rate-limited `web_profile_info` lookup no longer burns a two-minute retry ladder and then repeats it on every fallback. Retries now honour `Retry-After`, a single session-wide cooldown is shared by all requests, and while throttled the profile-page HTML lookup runs before the equally throttled search API.
- **Rate limits mid-run no longer discard the scrape**: if paging is throttled after the first page, the posts already collected are exported with a warning instead of failing the whole run.

### Changed
- **Stop** now interrupts a rate-limit wait instead of being ignored until the countdown ends; a user-initiated stop keeps the posts collected so far and is no longer shown as an error.
- Scrape progress now carries a `status` string, so a rate-limit wait shows a countdown in the popup instead of a frozen "Starting…". Paging slows down after each 429.
- Added [`tests/test-ratelimit.js`](file:///d:/dev/Multiscraper/tests/test-ratelimit.js) to the `npm test` suite, covering the 429 fallback chain, partial export, and status reporting on a virtual clock.

## [0.3.0] - 2026-08-15

### Added
- **Google Business Adapter** ([`extension/platforms/google.js`](file:///d:/dev/Multiscraper/extension/platforms/google.js)):
  - Feature ID (FID) auto-discovery from Search knowledge panel DOM (`[data-fid]`), Maps place URLs (`!1s...`), and raw page HTML.
  - Integration with Google's `GetLocalBoqProxy` RPC endpoint for paginated review extraction beyond DOM limits.
  - Multi-language subtitle parser for business metadata (rating, review count, category, price range, address, hours, website).
  - Review translation and source language extraction.
  - Markdown business audit report generator (`markdownReport`) rendering business metadata, review summary tables, and full review logs.
- **Google Adapter Test Suite** ([`tests/test-google.js`](file:///d:/dev/Multiscraper/tests/test-google.js)): Offline Node.js `vm` sandbox test verifying RPC normalization, owner reply disambiguation, date conversions, and schema formatting.
- **Dedicated Export Schema** for Google Reviews (`EXPORT_KEYS`), decoupling business review schemas from social post schemas.

### Changed
- Updated [`manifest.json`](file:///d:/dev/Multiscraper/extension/manifest.json) to include `https://www.google.com/*` in `host_permissions` and `content_scripts`.
- Updated popup UI ([`popup.html`](file:///d:/dev/Multiscraper/extension/popup.html), [`popup.js`](file:///d:/dev/Multiscraper/extension/popup.js)) with contextual button toggling between **Export Performance Stats** (for social platforms) and **Export Markdown Report** (for Google Business).
- Enhanced download folder sanitization to support localized Greek and Unicode business titles.

---

## [0.2.0] - 2026-07-20

### Added
- **TikTok Platform Adapter** ([`extension/platforms/tiktok.js`](file:///d:/dev/Multiscraper/extension/platforms/tiktok.js)):
  - Auto-scroll engine with progress tracking and termination triggers.
  - Interception buffer drainage for native signed `item_list` API calls.
  - Extraction of video URLs, animated covers, like counts, comment counts, share counts, play counts, and collect counts.
- **MAIN-World Network Interceptor** ([`extension/inject.js`](file:///d:/dev/Multiscraper/extension/inject.js)):
  - Patched `window.fetch` and `XMLHttpRequest.prototype.send` inside the host page execution context.
  - Origin-restricted `window.postMessage` bridge forwarding intercepted API responses to the isolated content script.
  - `WeakMap` instance mapping for native XHR URLs to prevent prototype pollution.
- **Declarative Net Request Dynamic Rule** (Rule ID `9001`): Injects `Referer: https://www.tiktok.com/` on TikTok CDN requests to bypass anti-hotlinking protections.
- **In-Page Video Blob Proxy**: Downloads TikTok video streams in the page context via session-authenticated fetch and converts them to data URLs to preserve `tt_chain_token` cookies.

---

## [0.1.0] - 2026-06-10

### Added
- **Instagram Platform Adapter** ([`extension/platforms/instagram.js`](file:///d:/dev/Multiscraper/extension/platforms/instagram.js)):
  - Resolves profile user IDs from DOM and web profile info endpoints.
  - Paginates `/api/v1/feed/user/{user_id}/` using first-party session cookies and `X-IG-App-ID`.
  - Exponential backoff with random jitter on HTTP `429` and `500+` error codes.
  - Normalizes photos, videos, carousels, accessibility captions, and hidden engagement counts.
- **Background Download Manager** ([`extension/background.js`](file:///d:/dev/Multiscraper/extension/background.js)):
  - Sequential file downloads via `chrome.downloads` into customizable `Downloads/multiscraper/<username>` folders.
  - Real-time disk write tracking using `chrome.downloads.onChanged`.
  - Automatic failed file collection with one-click retry support.
- **Multi-Format Exporters** ([`extension/common.js`](file:///d:/dev/Multiscraper/extension/common.js), [`extension/popup.js`](file:///d:/dev/Multiscraper/extension/popup.js)):
  - Full JSON export matching standard schema.
  - Standard CSV export with RFC 4180 escaping.
  - Performance Stats CSV export calculating absolute engagement and engagement percentage against views.
- **Offline Test Suite** ([`tests/test-normalizer.js`](file:///d:/dev/Multiscraper/tests/test-normalizer.js), [`tests/test-download.js`](file:///d:/dev/Multiscraper/tests/test-download.js)):
  - Zero-dependency unit testing via Node.js `vm`.
- **Icon Generator Tool** ([`tools/generate-icons.js`](file:///d:/dev/Multiscraper/tools/generate-icons.js)): Dependency-free PNG generator for extension toolbar assets.
