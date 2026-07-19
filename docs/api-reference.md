# Multiscraper API Reference

This reference details the internal JavaScript classes, global namespaces, platform contracts, and network interception hooks used throughout the Multiscraper extension.

---

## 1. Core Namespace & Shared Helpers (`common.js`)

All script files share a unified namespace `window.MS` (created dynamically in the content-script context).

### `MS.SCHEMA_KEYS`
An array of string keys representing the target export schema. Platform adapters must normalize raw payloads to match this exact vocabulary:
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
- **Description**: Intermediate buffer fed by `inject.js` via `window.postMessage`. TikTok and other scroll-and-capture adapters query and drain this buffer on each page scroll interval.

### `MS.ensureInterceptor()`
- **Returns**: `void`
- **Description**: Injector function that appends `inject.js` as a `<script>` element inside the active page's DOM. Execution is restricted to run exactly once per tab instance.

### `MS.toExportRow(post)`
- **Parameters**: `post` (Object) - Normalized post object.
- **Returns**: `Object` - Schema-compliant row.
- **Description**: Drops internal adapter keys (like `_media` and `_shortcode`) and sets missing properties to the default `"Not Available"` string.

### `MS.toCSV(posts)`
- **Parameters**: `posts` (Array<Object>) - Normalized posts list.
- **Returns**: `string` - Raw CSV content.
- **Description**: Compiles a fully-escaped CSV string mapped to `MS.SCHEMA_KEYS`. Quotes values containing commas, double-quotes, or newlines.

### `MS.mediaManifest(result)`
- **Parameters**: `result` (Object) - Return object of a platform adapter's `scrape` function.
- **Returns**: `Array<{ url: string, shortcode: string, index: number, kind: "image"|"video" }>`
- **Description**: Flattens nested/carousel attachments across all posts into a single manifest of downloadable items. Assigns zero-indexed positions (`index`) to preserve multi-image carousel orders.

---

## 2. Platform Adapter Interface

Every scraper module placed under `extension/platforms/` must export an adapter object conforming to this interface:

```typescript
interface PlatformAdapter {
  // Returns true if this adapter handles the target host name.
  matches(host: string): boolean;

  // Extracts the username identifier from the current tab URL.
  // Returns null if the URL is not a profile feed page.
  usernameFromUrl(url: string): string | null;

  // Asynchronously paginates and extracts posts.
  scrape(
    opts: { username: string; maxPosts: number },
    onProgress: (progress: ScrapeProgress) => void,
    shouldStop: () => boolean
  ): Promise<ScrapeResult>;
}

interface ScrapeProgress {
  collected: number;      // Count of normalized posts collected so far.
  total: number | null;   // Total post count declared by profile header (if readable).
  profile: string;        // Active profile username.
}

interface ScrapeResult {
  platform: string;       // e.g. "instagram" or "tiktok"
  profile: {
    username: string;
    full_name?: string;
    id?: string;
    is_private?: boolean;
    post_count: number;
  };
  posts: Array<NormalizedPost>;
}
```

### Adapter Implementations

#### Instagram (`platforms/instagram.js`)
- **App ID**: `936619743392459` (Hardcoded header `X-IG-App-ID`).
- **Internal Helper APIs**:
  - `csrfToken()`: Extracts `csrftoken` from cookie storage.
  - `headers()`: Merges token and App ID keys.
  - `getJSON(url, attempt)`: Implements network retry logic. Handles rate limits (`429`) and server errors (`500+`) using exponential backoff with random jitter. Aborts immediately on auth codes (`401`, `403`).
  - `resolveUser(username)`: Calls `/api/v1/users/web_profile_info/` to get user metadata.
  - `feedPage(userId, maxId)`: Retrieves feed increments.

#### TikTok (`platforms/tiktok.js`)
- **Scraping Strategy**: Captures network logs rather than paging requests directly to prevent complex signature verification (`X-Bogus`/`msToken`).
- **Internal Helper APIs**:
  - `drainCaptured(seen, posts, maxPosts)`: Clears items from `MS.captureBuffer`, filters duplicates, and normalizes payloads.
  - `scrape(opts, onProgress, shouldStop)`: Automates body scrolling to trigger TikTok's internal fetch routines. Ends when `idleRounds` exceeds 6 (meaning scroll-downs no longer fetch new posts).

---

## 3. Network Interceptor (`inject.js`)

Injected directly into the MAIN-world context. Overrides browser networking APIs to capture XHR and Fetch calls silently.

### Interception Patterns
Overridden methods check request URLs against the regex `/(\/api\/v1\/feed\/user\/|\/graphql\/query|\/api\/post\/item_list|xdt_api__v1__feed)/i`.

- **`window.fetch` Override**: Clones the response stream using `.clone()`, reads raw text, parses it, and forwards JSON payloads.
- **`XMLHttpRequest.prototype.send` Override**: Listens for the `load` event, checks internal URLs, and parses responses.
- **Message Dispatch**:
  ```javascript
  window.postMessage({ __ms: "capture", url: String(url), body: parsedJSON }, window.location.origin);
  ```

---

## 4. Background Service Worker (`background.js`)

The background service worker implements download routines and updates dynamic referer headers.

### Download Pipeline Methods

- `downloadOne(file, folder)`: Invokes `chrome.downloads.download` with `saveAs: false` to suppress prompt windows.
- `setTikTokReferer(on)`: Updates `chrome.declarativeNetRequest` dynamic rules.
  - **Dynamic Rule ID**: `9001`
  - **Rule Condition**: Matches domain patterns such as `tiktok.com`, `tiktokcdn.com`, etc.
  - **Rule Action**: Modifies request headers to set `referer: https://www.tiktok.com/`. Crucial to prevent CDNs from rejecting requests with empty bodies.

---

## 5. Storage Schema

The extension persists runs in `chrome.storage.local` to survive popup closures.

### Keys Saved

```typescript
interface StorageSchema {
  // Saved on scrape completion
  lastResult?: {
    platform: string;
    profile: { username: string; [key: string]: any };
    count: number;
    rows: Array<object>; // Export-schema rows
    media: Array<object>; // Media manifest files
    savedAt: string; // ISO date
  };

  // Saved on download completion or failure
  lastDownload?: {
    ok: number;          // Successful count
    failed: number;      // Failed count
    failedFiles: Array<object>; // Files to display in "Retry"
    folder: string;
    total: number;
    at: string;
  };

  // Emitted dynamically to track live progress
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
