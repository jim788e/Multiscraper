# Multiscraper Developer Guide

This guide describes the code style conventions, test environments, asset compilation, and platform expansion patterns of the Multiscraper project.

---

## 1. Project Layout & Design Philosophy

Multiscraper is built with zero runtime dependencies. It runs completely within the browser sandbox using vanilla JavaScript, standard CSS, and native Web APIs.

```
Multiscraper/
├── docs/                     # Documentation files
├── extension/                # The Chrome Extension source files
│   ├── manifest.json         # Extension MV3 configuration & permissions
│   ├── common.js             # Shared helpers, CSV builder, schema definitions
│   ├── inject.js             # MAIN-world network listener (fetch/XHR patch)
│   ├── content.js            # Isolated-world orchestrator & TikTok downloader
│   ├── background.js         # Service worker downloading media files
│   ├── popup.html            # UI Structure
│   ├── popup.css             # UI styling
│   ├── popup.js              # UI interaction logic
│   └── platforms/            # Platform-specific scraping adapters
│       ├── instagram.js      # Instagram scraper
│       └── tiktok.js         # TikTok scraper
├── tests/                    # Offline stub tests
│   ├── test-normalizer.js    # Verifies adapter normalizers & schema coverage
│   └── test-download.js      # Verifies background download state logic
└── tools/
    └── generate-icons.js     # PNG generator for extension icons (no deps)
```

### Coding Guidelines
- **No Bundler / Frameworks**: Write standard modern ES. Do not use build steps (like Webpack or Vite) or TypeScript compilation.
- **Dependency-Free**: Keep the runtime extension free of external npm packages. Node dependencies are only permitted in developer tool scripts.
- **Design Tokens**: Standard UI colors and spacing rules must match the popup CSS theme (e.g., `#7a5af8` accent).

---

## 2. Test Verification Workflow

Offline unit testing uses Node's built-in `vm` (Virtual Machine) module to stub out browser-specific objects (`window`, `document`, `chrome`) and run the source JavaScript in a simulated environment.

### Running Tests
Execute the tests locally by running:
```bash
npm test
```
This runs the full test suite consisting of two separate test scripts.

### 1. Normalizer Unit Tests (`tests/test-normalizer.js`)
- **Stubs**: Stubs the document cookies, runtime configurations, and DOM creation structures.
- **Process**: Loads `common.js` and `platforms/instagram.js` inside the sandbox, feeds mock feed payloads representing videos, carousels, and hidden-like posts, and asserts:
  - All target export fields are present.
  - Normalization extracts highest-resolution image candidates.
  - Correct formatting for hidden engagement counts.
  - Correct flattening order for carousel arrays.

### 2. Download Engine Tests (`tests/test-download.js`)
- **Stubs**: Stubs `chrome.downloads.download`, storage state, and messaging handlers.
- **Process**: Tests that `background.js` handles all async conditions correctly, including:
  - Immediate start failures.
  - Rapid completions (where files finish downloading before the ID is registered).
  - Proper tracking and reporting of progress statistics.
  - Outputting failed items for the popup's retry queue.

---

## 3. Adding a New Platform Adapter

To support scraping a new website, follow these four steps:

### Step 1: Create the Adapter Script
Create `extension/platforms/yourplatform.js`. Add an IIFE that attaches the adapter definition to the shared `window.MS` namespace:

```javascript
(function () {
  const MS = (window.MS = window.MS || {});

  function normalize(item) {
    // Transform raw platform items to match MS.SCHEMA_KEYS
    return {
      id: item.id,
      "Post Author": item.user_name,
      "Post Type": item.is_video ? "Video" : "Image",
      "Post Text": item.description || "",
      "Post Image": item.image_url || "Not Available",
      "Post Video": item.video_url || "Not Available",
      "Post Likes": item.likes ?? "Not Available",
      // ... populate remaining SCHEMA_KEYS
      _shortcode: item.id,
      _media: [{ url: item.image_url, kind: "image" }]
    };
  }

  async function scrape(opts, onProgress, shouldStop) {
    // 1. Fetch data from platform endpoint or capture buffer
    // 2. Parse and normalize items
    // 3. Call onProgress({ collected: posts.length, total: totalPosts, profile: opts.username })
    // 4. Return { platform: "yourplatform", profile: { username: opts.username }, posts }
  }

  MS.yourplatform = {
    matches: (host) => /(^|\.)yourplatform\.com$/.test(host),
    usernameFromUrl: (url) => {
      // Extract and return username string, or null if not a profile URL
    },
    scrape,
  };
})();
```

### Step 2: Register the Adapter in the Orchestrator
Open `extension/content.js` and modify `pickAdapter()` to check your platform:

```javascript
function pickAdapter() {
  const host = location.hostname.replace(/^www\./, "");
  if (MS.instagram.matches(host)) return { name: "instagram", api: MS.instagram };
  if (MS.tiktok.matches(host)) return { name: "tiktok", api: MS.tiktok };
  if (MS.yourplatform.matches(host)) return { name: "yourplatform", api: MS.yourplatform };
  return null;
}
```

### Step 3: Update permissions in Manifest
Open `extension/manifest.json` and add the host patterns to:
- **`content_scripts[0].js`**: Load your script before `content.js` (e.g. `platforms/yourplatform.js`).
- **`content_scripts[0].matches`**: Add access rules (e.g. `*://*.yourplatform.com/*`).
- **`host_permissions`**: Grant network connection permissions for target endpoints and CDNs.

### Step 4: Add Unit Tests
Extend `tests/test-normalizer.js` to load your new script, define raw platform mocks, and verify schema output.

---

## 4. Asset Compilation (Icon Generator)

Extension icons are rendered using `tools/generate-icons.js`. This script encodes PNG files directly without external libraries (like Canvas or sharp).

### PNG Encoder Details
- Uses Node's built-in `zlib.deflateSync` to compress raw pixel buffers.
- Generates required IHDR, IDAT, and IEND chunks.
- Computes standard CRC-32 checksum tables to build compliant files.

### Drawing Customizations
The script renders a purple rounded square containing a 3x3 grid motif:
- Modify `BG` (`[r, g, b]`) on line 9 to update the background color.
- Modify `FG` (`[r, g, b]`) on line 10 to update the grid motif color.
- Re-generate the icons after making changes:
  ```bash
  node tools/generate-icons.js
  ```
