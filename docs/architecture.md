# Multiscraper Architecture & Component Design

This document details the architectural layout, execution contexts, runtime lifecycle, and messaging protocol of Multiscraper.

---

## 1. Context Isolation & Components

As a Chrome Manifest V3 extension, Multiscraper operates across three distinct execution environments. This isolation is crucial to bypass network restrictions while ensuring a responsive UI and safe background downloading.

```mermaid
graph TD
    subgraph "Browser UI"
        Popup[popup.html / popup.js]
    end

    subgraph "Target Web Page (instagram.com or tiktok.com)"
        subgraph "Isolated Context"
            Content[content.js]
            Common[common.js]
            Adapters[platforms/instagram.js<br>platforms/tiktok.js]
        end
        subgraph "MAIN World Context"
            Inject[inject.js]
        end
    end

    subgraph "Extension Background"
        Worker[background.js Service Worker]
    end

    Popup <-->|chrome.runtime Messaging| Content
    Popup <-->|chrome.runtime Messaging| Worker
    Content <-->|window.postMessage| Inject
    Content <-->|chrome.runtime Messaging| Worker
    Worker -->|chrome.downloads| Disk[(User's Disk)]
```

### Execution Contexts

1. **Extension Popup UI Context** (`popup.html` / `popup.js`)
   - **Environment**: Runs inside the browser toolbar bubble. Closed when clicked away.
   - **Responsibilities**: Accepts user configurations (username, limit, subfolder), displays live progress bars, triggers CSV/JSON exports, and manages media download runs.
   - **Storage Access**: Reads and writes to `chrome.storage.local`.

2. **Content Script Isolated Context** (`common.js`, `platforms/*.js`, `content.js`)
   - **Environment**: Runs in a sandboxed, isolated JS world inside the active tab. It shares the DOM with the host page but has no access to the host page's javascript variables or functions.
   - **Responsibilities**: Detects URL states, runs the scraping loop (direct API requests or scroll-and-capture), normalizes raw JSON data, and handles TikTok video CORS-proxy blob fetching.
   - **Security Benefits**: Fetch requests carried out here automatically inherit the user's active session cookies (cookies are forwarded by Chrome as first-party requests).

3. **Page MAIN World Context** (`inject.js`)
   - **Environment**: Injected directly into the host page DOM via a `<script>` tag. It executes in the exact same scope as the site's own scripts.
   - **Responsibilities**: Intercepts requests by overriding `window.fetch` and `XMLHttpRequest.prototype.send`. Since TikTok signs all requests using anti-bot markers (`X-Bogus`/`msToken`), this interceptor lets TikTok's page do the signing, then copies the signed JSON response.

4. **Background Service Worker Context** (`background.js`)
   - **Environment**: Runs in the background on-demand. Persists across popup closures.
   - **Responsibilities**: Downloads media files sequentially using `chrome.downloads`. Updates dynamic routing rules via `chrome.declarativeNetRequest` to append `Referer: https://www.tiktok.com/` headers to TikTok CDN downloads (bypassing TikTok hotlinking protections).

---

## 2. Scraping Flow Diagrams

### Instagram Direct API Pagination
Instagram feeds are scraped using authenticated direct web API requests.

```mermaid
sequenceDiagram
    autonumber
    participant P as Popup (popup.js)
    participant C as Content (content.js)
    participant IG as Instagram Web API

    P->>C: chrome.tabs.sendMessage("scrape", {username, maxPosts})
    C->>IG: fetch(/api/v1/users/web_profile_info/?username=...)
    IG-->>C: profile details + userId
    Note over C: Resolve userId & start loop

    loop Until maxPosts reached OR no more pages
        C->>IG: fetch(/api/v1/feed/user/{userId}/?count=33&max_id=...)
        IG-->>C: JSON list of post objects
        C->>C: Normalize records into common schema
        C->>P: chrome.runtime.sendMessage("progress", {collected, total})
        Note over C: Wait 800-1500ms (rate-limit backoff jitter)
    end

    C->>C: Save export rows to chrome.storage.local
    C->>P: chrome.runtime.sendMessage("done", {count})
```

### TikTok Capture-and-Scroll Loop
TikTok feeds are intercepted since request parameters are cryptographically signed.

```mermaid
sequenceDiagram
    autonumber
    participant P as Popup (popup.js)
    participant C as Content (content.js)
    participant I as Injected (inject.js)
    participant TT as TikTok Web App

    P->>C: chrome.tabs.sendMessage("scrape", {username, maxPosts})
    Note over C: TikTok detected: call MS.ensureInterceptor()
    C->>I: Creates & appends script tag
    I->>TT: Patches window.fetch & XMLHttpRequest

    loop Scroll Loop (Until 6 idle rounds OR maxPosts reached)
        C->>C: window.scrollTo(0, document.body.scrollHeight)
        TT->>TT: Triggers signed API load request
        Note over I: Intercepts raw response text
        I->>C: window.postMessage({__ms: "capture", url, body})
        C->>C: Push into MS.captureBuffer
        Note over C: Wait 1200-1800ms
        C->>C: drainCaptured(): normalize posts, append to list
        C->>P: chrome.runtime.sendMessage("progress", {collected})
    end

    C->>C: Save export rows to chrome.storage.local
    C->>P: chrome.runtime.sendMessage("done", {count})
```

---

## 3. Media Download Pipeline

Downloading must bypass Content Security Policies (CSP) and hotlink checkers:
- **Instagram**: Popup contacts Background Script which calls `chrome.downloads`.
- **TikTok**: Videos require session cookies and origin headers. The content script fetches the video bytes inside the tab context, transforms the resulting binary blob into a JSON-serializable Data URL, and pipes it to the Background script to write to disk.

```mermaid
sequenceDiagram
    autonumber
    participant P as Popup (popup.js)
    participant C as Content (content.js)
    participant B as Background (background.js)
    participant CDN as TikTok / IG CDN

    P->>P: Read lastResult.media manifest
    
    alt Instagram Media
        P->>B: chrome.runtime.sendMessage("downloadMedia", {files, folder, platform})
        B->>CDN: chrome.downloads.download(file.url)
        CDN-->>B: Downloads file to disk
        B->>P: chrome.runtime.sendMessage("mediaProgress", {done, ok, fail})
    else TikTok Media
        P->>C: chrome.tabs.sendMessage("tiktokDownload", {files, folder})
        loop For each TikTok Video
            C->>CDN: fetch(video.url, {credentials: "include"})
            CDN-->>C: Returns video stream
            C->>C: Convert blob to DataURL (base64)
            C->>B: chrome.runtime.sendMessage("saveDownload", {url: dataUrl, filename})
            B->>B: chrome.downloads.download(dataUrl) (Write to file)
            B-->>C: {ok: true}
            C->>P: chrome.runtime.sendMessage("mediaProgress", {done})
        end
    end
```

---

## 4. Message Passing Protocol

All internal extension communications use the following runtime message schema:

### 1. Internal Message Interfaces (Extension Bus)

| Sender | Receiver | Message Object (`msg`) | Response Style / Actions |
| --- | --- | --- | --- |
| **Popup** | **Content** | `{ type: "detect" }` | Returns `{ platform: "instagram"\|"tiktok"\|null, username: string\|null }` |
| **Popup** | **Content** | `{ type: "scrape", username: string, maxPosts: number }` | Starts the platform scrape. Returns `{ ok: true, count: number }` or `{ ok: false, error: string }`. Runs asynchronously. |
| **Popup** | **Content** | `{ type: "stop" }` | Triggers stop flag, breaking active scrape loop. Returns `{ ok: true }`. |
| **Content** | **Popup** | `{ type: "progress", collected: number, total: number\|null, profile: string }` | Updates popup scrape progress status bar. |
| **Content** | **Popup** | `{ type: "done", platform: string, profile: object, count: number }` | Informs popup that scrape is complete and results are stored. |
| **Content** | **Popup** | `{ type: "error", error: string }` | Informs popup that scrape failed, resetting controls. |
| **Popup** | **Background** | `{ type: "downloadMedia", files: Array, folder: string, platform: string }` | Starts background sequential download task. Background responds asynchronously. |
| **Background** | **Popup** | `{ type: "mediaProgress", done: number, ok: number, fail: number, total: number }` | Updates popup media progress stats. |
| **Popup** | **Content** | `{ type: "tiktokDownload", folder: string, files: Array }` | Informs content script to start TikTok in-tab CORS-bypass download loop. |
| **Content** | **Background** | `{ type: "saveDownload", url: string, filename: string }` | Asks background worker to write data URL payload to disk. Returns `{ ok: boolean, id?: number, error?: string }`. |

### 2. Main-Isolated World Bridge

| Sender | Receiver | Window Message Payload | Description |
| --- | --- | --- | --- |
| **Injected Script** (MAIN) | **Common JS** (Isolated) | `{ __ms: "capture", url: string, body: object }` | Sent via `window.postMessage` when a matched URL response is parsed by `inject.js`. |
