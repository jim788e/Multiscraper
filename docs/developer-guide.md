# Multiscraper Developer Guide

This guide describes code style conventions, test environments, platform expansion patterns, and developer tools for the Multiscraper project.

---

## 1. Project Layout & Architecture Philosophy

Multiscraper is built with **zero runtime dependencies**. It executes natively within the browser sandbox using vanilla JavaScript (ES6+), standard CSS, and native Web APIs without bundlers or compilers.

```
Multiscraper/
├── docs/                     # Documentation files
│   ├── api-reference.md      # API & message bus specifications
│   ├── architecture.md       # Architectural layout & sequence diagrams
│   ├── developer-guide.md    # Developer workflows & test setup
│   ├── security-audit.md     # Security posture & vulnerability checklist
│   ├── user-guide.md         # End-user operation guide
│   └── FULL_DOCUMENTATION.md # Single-source master documentation
├── extension/                # Chrome Extension source (Manifest V3)
│   ├── manifest.json         # Extension configuration & host permissions
│   ├── common.js             # Shared helpers, CSV builder, schema definitions
│   ├── inject.js             # MAIN-world network listener (fetch/XHR hook)
│   ├── content.js            # Isolated-world orchestrator & media proxy
│   ├── background.js         # Service worker downloading media & DNR rules
│   ├── popup.html            # Extension popup markup
│   ├── popup.css             # Extension popup styling
│   ├── popup.js              # Extension popup controller
│   └── platforms/            # Platform-specific scraping adapters
│       ├── instagram.js      # Instagram scraper
│       ├── tiktok.js         # TikTok scraper
│       └── google.js         # Google Business & reviews scraper
├── tests/                    # Offline unit test suites (Node.js vm sandbox)
│   ├── test-normalizer.js    # Instagram normalization & schema tests
│   ├── test-download.js      # Background download manager tests
│   └── test-google.js        # Google Business RPC normalizer tests
├── tools/
│   └── generate-icons.js     # PNG generator for extension icons (zero deps)
├── CHANGELOG.md              # Keep a Changelog release history
├── llms.txt                  # AI-friendly documentation index
└── package.json              # Developer scripts & repository metadata
```

### Coding Guidelines
- **Zero Runtime Dependencies**: The extension runtime must never rely on npm packages. Node dependencies are only permitted in standalone developer tools or test scripts.
- **No Bundlers / Transpilers**: Write standard, modern ES6+ JavaScript. Code is loaded directly by the browser without Webpack, Vite, or Babel.
- **Code Readability**: Use early returns for readability, descriptive function/variable naming, and comprehensive JSDoc annotations.

---

## 2. Test Verification Workflow

Offline unit testing uses Node.js's built-in `vm` (Virtual Machine) module to stub out browser and Chrome extension globals (`window`, `document`, `chrome`, `fetch`, `location`) and execute source scripts in an isolated sandbox.

### Running the Test Suite
Execute the entire test suite by running:
```bash
npm test
```

### Test Suite Breakdown

#### 1. Normalizer Unit Tests ([`tests/test-normalizer.js`](file:///d:/dev/Multiscraper/tests/test-normalizer.js))
- **Scope**: Stubs cookies, DOM structures, and loads [`common.js`](file:///d:/dev/Multiscraper/extension/common.js) and [`platforms/instagram.js`](file:///d:/dev/Multiscraper/extension/platforms/instagram.js).
- **Assertions**:
  - Validates `MS.SCHEMA_KEYS` field presence.
  - Verifies highest-resolution candidate selection for images and videos.
  - Tests formatting for hidden like/comment counts.
  - Asserts carousel array flattening and 0-indexed ordering.

#### 2. Download Manager Tests ([`tests/test-download.js`](file:///d:/dev/Multiscraper/tests/test-download.js))
- **Scope**: Stubs `chrome.downloads`, `chrome.storage.local`, and Chrome messaging events in [`background.js`](file:///d:/dev/Multiscraper/extension/background.js).
- **Assertions**:
  - Tests immediate start failure handling.
  - Asserts fast pre-resolution (files completing before download ID registration).
  - Verifies live progress calculation and disk write confirmation.
  - Verifies that failed items are preserved for one-click popup retries.

#### 3. Google Business Normalizer Tests ([`tests/test-google.js`](file:///d:/dev/Multiscraper/tests/test-google.js))
- **Scope**: Stubs DOM selectors and executes [`platforms/google.js`](file:///d:/dev/Multiscraper/extension/platforms/google.js) with mock `GetLocalBoqProxy` RPC payloads.
- **Assertions**:
  - Verifies Feature ID extraction from DOM `data-fid` and Maps URLs.
  - Asserts proper extraction of ratings, relative dates, ISO timestamps, and review images.
  - Verifies owner reply detection and disambiguation against guided Q&A blocks and auto-translations.
  - Ensures export rows strictly adhere to `EXPORT_KEYS`.

---

## 3. Adding a New Platform Adapter

To add support for a new platform, follow these steps:

### Step 1: Create the Adapter Script
Create `extension/platforms/yourplatform.js` and register the adapter on the `window.MS` namespace:

```javascript
(function () {
  const MS = (window.MS = window.MS || {});

  function normalize(item) {
    return {
      id: item.id,
      "Post Author": item.user_name,
      "Post Type": item.is_video ? "Video" : "Image",
      "Post Text": item.description || "",
      "Post Image": item.image_url || "Not Available",
      "Post Video": item.video_url || "Not Available",
      "Post Likes": item.likes ?? "Not Available",
      "Post Comments Count": item.comments_count ?? "Not Available",
      _shortcode: item.id,
      _media: [{ url: item.image_url, kind: "image" }]
    };
  }

  async function scrape(opts, onProgress, shouldStop) {
    // 1. Paginate platform endpoint or drain MS.captureBuffer
    // 2. Normalize records
    // 3. Emit progress: onProgress({ collected: posts.length, total: totalCount, profile: opts.username })
    // 4. Return { platform: "yourplatform", profile: { username: opts.username }, posts }
  }

  MS.yourplatform = {
    matches: (host) => /(^|\.)yourplatform\.com$/.test(host),
    usernameFromUrl: (url) => {
      // Extract username string or null if not on profile page
    },
    scrape,
  };
})();
```

### Step 2: Register in Content Orchestrator
Open [`extension/content.js`](file:///d:/dev/Multiscraper/extension/content.js) and add the check to `pickAdapter()`:

```javascript
function pickAdapter() {
  const host = location.hostname.replace(/^www\./, "");
  if (MS.instagram.matches(host)) return { name: "instagram", api: MS.instagram };
  if (MS.tiktok.matches(host)) return { name: "tiktok", api: MS.tiktok };
  if (MS.google && MS.google.matches(host)) return { name: "google", api: MS.google };
  if (MS.yourplatform && MS.yourplatform.matches(host)) return { name: "yourplatform", api: MS.yourplatform };
  return null;
}
```

### Step 3: Update Permissions in Manifest
Open [`extension/manifest.json`](file:///d:/dev/Multiscraper/extension/manifest.json):
- Add `platforms/yourplatform.js` to `content_scripts[0].js`.
- Add URL pattern match to `content_scripts[0].matches`.
- Add target domains and CDNs to `host_permissions`.

### Step 4: Write Offline Unit Tests
Add a test script under `tests/test-yourplatform.js` and register it in [`package.json`](file:///d:/dev/Multiscraper/package.json).

---

## 4. Asset Compilation (Icon Generator)

Extension icons are rendered using [`tools/generate-icons.js`](file:///d:/dev/Multiscraper/tools/generate-icons.js). This script generates valid PNG images directly using Node's built-in `zlib.deflateSync` without third-party graphics packages:

- Renders icons at sizes: 16x16, 32x32, 48x48, and 128x128.
- To re-generate icons:
  ```bash
  node tools/generate-icons.js
  ```
