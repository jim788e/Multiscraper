# Multiscraper API Reference

This reference details the internal JavaScript classes, global namespaces, platform contracts, network interception hooks, and Chrome runtime messaging protocols used throughout the Multiscraper extension.

---

## 1. Core Namespace & Shared Helpers (`common.js`)

All script files share a unified namespace `window.MS` (created dynamically in the content-script context).

### `MS.SCHEMA_KEYS`
An array of string keys representing the target export schema for social platforms (Instagram / TikTok):
```javascript
[
  "id", "Post Author", "Post Author Full Name", "Post Author Image",
  "Post Author URL", "Post Author Is Verified", "Post Type", "Post Text",
  "Post Image", "Post Video", "Post Likes", "Post Comments Count",
  "Post Views", "Post Shares", "Post Saves", "Post URL", "Post Date",
  "Is Comments Disabled", "Post Accessibility Caption"
]
```

### `MS.sleep(ms)`
- **Parameters**: `ms` (Number) - Milliseconds to delay.
- **Returns**: `Promise<void>`
- **Description**: Utility wrapper around `setTimeout` to await rate-limit backoffs.

### `MS.captureBuffer`
- **Type**: `Array<{ url: string, body: object }>`
- **Description**: Intermediate ring buffer (bounded to 100 entries) fed by `inject.js` via `window.postMessage`. TikTok and other scroll-and-capture adapters query and drain this buffer on each page scroll interval.

### `MS.flushBuffer()`
- **Returns**: `void`
- **Description**: Clears all pending entries from `MS.captureBuffer`.

### `MS.ensureInterceptor()`
- **Returns**: `void`
- **Description**: Injects `inject.js` as a `<script>` tag into the active page's DOM. Execution is guarded by `MS._injected` to run exactly once per tab instance.

### `MS.toExportRow(post, keys)`
- **Parameters**:
  - `post` (Object) - Normalized post or review object.
  - `keys` (Array<string>, optional) - Specific schema keys to project. Defaults to `MS.SCHEMA_KEYS`.
- **Returns**: `Object` - Schema-compliant row where missing or nullish fields default to `"Not Available"`.

### `MS.toCSV(posts, keys)`
- **Parameters**:
  - `posts` (Array<Object>) - Normalized posts or reviews list.
  - `keys` (Array<string>, optional) - Column schema keys.
- **Returns**: `string` - Raw RFC-4180-compliant CSV string with quotes around commas, double-quotes, and newlines.

### `MS.mediaManifest(result)`
- **Parameters**: `result` (Object) - Return object of a platform adapter's `scrape` function.
- **Returns**: `Array<{ url: string, shortcode: string, index: number, kind: "image"|"video" }>`
- **Description**: Flattens nested/carousel attachments across all posts into a single manifest of downloadable items. Assigns zero-indexed positions (`index`) to preserve carousel ordering.

---

## 2. Platform Adapter Interface

Every platform module placed under `extension/platforms/` attaches to `window.MS` and conforms to the following contract:

```typescript
interface PlatformAdapter {
  // Returns true if this adapter handles the target host name.
  matches(host: string): boolean;

  // Extracts the username or business identifier from the current tab URL.
  // Returns null if the URL is not a recognized profile/place page.
  usernameFromUrl(url: string): string | null;

  // Asynchronously paginates and extracts posts or reviews.
  scrape(
    opts: { username: string; maxPosts: number },
    onProgress: (progress: ScrapeProgress) => void,
    shouldStop: () => boolean
  ): Promise<ScrapeResult>;
}

interface ScrapeProgress {
  collected: number;      // Count of normalized items collected so far.
  total: number | null;   // Declared total count (if readable from header/subtitle).
  profile: string;        // Active profile username or business title.
}

interface ScrapeResult {
  platform: "instagram" | "tiktok" | "google";
  profile: {
    username: string;
    full_name?: string;
    id?: string;
    is_private?: boolean;
    post_count: number;
    [key: string]: any;
  };
  posts: Array<NormalizedPost | NormalizedReview>;
  schemaKeys?: Array<string>; // Specified when overriding MS.SCHEMA_KEYS (e.g. Google)
}
```

---

## 3. Platform Adapter Implementations

### A. Instagram Adapter (`platforms/instagram.js`)
- **Host Matching**: Matches `instagram.com`.
- **App ID Header**: `X-IG-App-ID: 936619743392459`.
- **Key Methods**:
  - `csrfToken()`: Reads `csrftoken` from `document.cookie`.
  - `getJSON(url, opts)`: Makes authenticated requests with exponential backoff on `429` / `500+` and immediate abort on `401` / `403`. Honours the `Retry-After` header, records a session-wide cooldown every other request waits out, and accepts `opts.maxRetries` so calls that have a working fallback do not burn the full ladder.
  - `resolveUser(username)`: Retrieves profile metadata and user ID via `/api/v1/users/web_profile_info/?username=...`, falling back to `/api/v1/web/search/topsearch/` and the profile page HTML. While rate-limited the HTML lookup is tried first, since it is not an `/api/` call and is usually still served.
  - `report(status)`: Per-scrape hook that pushes human-readable waiting states (rate-limit countdown, lookup retry) into the popup progress message.
  - `feedPage(userId, maxId)`: Retrieves feed increments from `/api/v1/feed/user/{userId}/?count=12`.
  - `normalize(item)`: Extracts highest-resolution media candidates, carousel slides, captions, and hidden likes/comments counts.

### B. TikTok Adapter (`platforms/tiktok.js`)
- **Host Matching**: Matches `tiktok.com`.
- **Key Methods**:
  - `drainCaptured(seen, posts, maxPosts)`: Drains `MS.captureBuffer`, removes duplicates, and parses `item_list` API responses.
  - `scrape(opts, onProgress, shouldStop)`: Automates window scrolling, monitors idle cycles (terminates if no new posts arrive after 6 consecutive scrolls), and returns normalized video and photo entries.

### C. Google Business Adapter (`platforms/google.js`)
- **Host Matching**: Matches `google.com` and international Google domains (e.g., `google.gr`, `google.de`, `google.co.uk`).
- **Feature ID (FID) Discovery**:
  - `findFid()`: Locates the `0x...:0x...` identifier from Search knowledge panel elements (`[data-fid]`), Google Maps URLs (`!1s0x...:0x...`), or page HTML regex.
  - `cidUrl(fid)`: Converts the second hexadecimal half of the FID to BigInt decimal notation to build canonical `https://www.google.com/maps?cid=...` links.
- **Knowledge Panel Metadata Extraction**:
  - `parseSubtitle()`: Extracts rating, total review count (via multi-language regex matching Greek, English, German, French, Spanish, Turkish, Russian, etc.), category, and price range.
  - `attrText(key)`: Extracts business name, address, phone, hours, and official website.
- **RPC Review Pagination**:
  - `fetchReviewsRpc(fid, pageToken)`: Issues POST requests to `/_/SearchUi/data/batched/GetLocalBoqProxy` using Google's nested array format `f.req=[[[...]]]`.
  - Strips Google's anti-XSS `)]}'` prefix and parses nested review arrays, review photos, timestamps, star ratings, translated texts, and owner responses.
- **Markdown Report Generation**:
  - `markdownReport(business, reviews)`: Generates a complete, publication-ready Markdown audit document containing business details, rating distributions, and structured review tables.
- **`EXPORT_KEYS`**:
  ```javascript
  [
    "id", "Business Name", "Business Rating", "Business Review Count",
    "Business Category", "Business Price Range", "Business Address",
    "Business Phone", "Business Hours", "Business Website",
    "Business Google Maps URL", "Review Author", "Review Author URL",
    "Review Rating", "Review Date", "Review Date (relative)",
    "Review Text", "Review Text (translated)", "Review Language",
    "Review Likes", "Owner Reply", "Review Images"
  ]
  ```

---

## 4. Chrome Runtime Message Bus

Multiscraper components communicate via `chrome.runtime.sendMessage` and `chrome.runtime.onMessage`:

| Message `type` | Sender | Receiver | Payload | Description |
| --- | --- | --- | --- | --- |
| `detect` | Popup | Content Script | `{ type: "detect" }` | Returns `{ platform, username }` for the active tab. |
| `scrape` | Popup | Content Script | `{ type: "scrape", username, maxPosts }` | Triggers scraping execution in the content script. |
| `stop` | Popup | Content Script | `{ type: "stop" }` | Signals active scraper to halt immediately. |
| `progress` | Content Script | Popup | `{ type: "progress", collected, total, profile }` | Emits live progress counters during scraping. |
| `done` | Content Script | Popup / Storage | `{ type: "done", platform, profile, count }` | Notifies scrape completion and triggers storage save. |
| `error` | Content Script | Popup | `{ type: "error", error: string }` | Reports fatal scraping error. |
| `downloadMedia` | Popup | Background | `{ type: "downloadMedia", platform, files, folder }` | Starts batch background downloading via `chrome.downloads`. |
| `mediaProgress` | Background / Content | Popup | `{ type: "mediaProgress", done, ok, fail, total }` | Live updates on files verified saved to disk. |
| `saveDownload` | Content Script | Background | `{ type: "saveDownload", url, filename }` | Saves in-page fetched blob data URLs to disk. |
| `tiktokDownload` | Popup | Content Script | `{ type: "tiktokDownload", files, folder }` | Triggers authenticated in-page video fetching for TikTok. |

---

## 5. Background Service Worker & DeclarativeNetRequest (`background.js`)

The background service worker executes media downloads and applies dynamic network header rules.

### Key Methods:
- `downloadOne(file, folder)`: Invokes `chrome.downloads.download` with `saveAs: false` and `conflictAction: "uniquify"`.
- `sanitizeFolder(s)`: Sanitizes user-supplied download folders, stripping illegal characters and preventing directory traversal (`..`).
- `extFromUrl(url, kind)`: Determines file extension (`jpg`, `mp4`, `webp`, `png`, `mov`) from URL path or fallback `kind`.
- `setTikTokReferer(on)`: Manages dynamic rule `9001` via `chrome.declarativeNetRequest.updateDynamicRules`:
  - **Condition**: Request domains matching `tiktok.com`, `tiktokcdn.com`, `byteoversea.com`, `muscdn.com`.
  - **Action**: Injects `Referer: https://www.tiktok.com/` (without `Origin`, which triggers TikTok CDN CORS rejection).

---

## 6. Network Interceptor (`inject.js`)

Injected into the target page's **MAIN world** to intercept network calls that require browser-generated security tokens:

- **Hooked APIs**: `window.fetch` and `XMLHttpRequest.prototype.send`.
- **URL Filters**: Matches `/(\/api\/v1\/feed\/user\/|\/graphql\/query|\/api\/post\/item_list|xdt_api__v1__feed)/i`.
- **Memory Safety**: Uses a private `WeakMap` (`xhrUrlMap`) for XHR URL tracking to prevent prototype pollution or object mutation.
- **Dispatch**: Posts intercepted JSON data to the isolated world via `window.postMessage` restricted strictly to `window.location.origin`.

---

## 7. Storage Schema (`chrome.storage.local`)

```typescript
interface StorageSchema {
  // Stored upon scrape completion
  lastResult?: {
    platform: "instagram" | "tiktok" | "google";
    profile: { username: string; [key: string]: any };
    count: number;
    rows: Array<object>; // Export-compliant rows
    media: Array<{ url: string; shortcode: string; index: number; kind: string }>;
    savedAt: string;     // ISO timestamp
  };

  // Stored upon media batch completion
  lastDownload?: {
    ok: number;
    failed: number;
    failedFiles: Array<object>; // Items available for one-click retry
    folder: string;
    total: number;
    at: string;
  };

  // Stored dynamically during download execution
  mediaLive?: {
    done: number;
    ok: number;
    fail: number;
    total: number;
    folder: string;
    running: boolean;
  };
}
```
