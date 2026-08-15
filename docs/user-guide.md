# Multiscraper User Guide

This guide walks you through installing, configuring, and using the Multiscraper extension to export feeds, listings, reviews, and media files from **Instagram**, **TikTok**, and **Google Business**.

---

## 1. Installation

Since Multiscraper is a developer tool, you must load it as an "unpacked" extension:

1. Open Google Chrome and navigate to `chrome://extensions`.
2. In the top-right corner of the page, toggle **Developer mode** to **ON**.
3. Click the **Load unpacked** button in the top-left toolbar.
4. Select the [`extension/`](file:///d:/dev/Multiscraper/extension/) directory from your cloned repository.
5. For convenient access, click the extensions puzzle piece icon in your Chrome toolbar and pin **Multiscraper**.

---

## 2. Essential Chrome Settings (Required for Silent Downloads)

To download batches of images and videos without receiving a separate "Save As" file prompt for each file:

1. Open `chrome://settings/downloads`.
2. **Download Location**: Set this to your preferred base folder (e.g. `Downloads`).
   > [!NOTE]
   > Chrome security policies restrict browser extensions to saving files inside your selected base Downloads directory.
3. **Turn OFF** the toggle for **"Ask where to save each file before downloading"**.
   > [!WARNING]
   > If this toggle is left on, Chrome will open a dialog box for every individual image/video in the batch, and files will not sort into subfolders automatically.

### Troubleshooting IT Policy Locks
If the "Ask where to save..." toggle is greyed out or reverts to ON:
- Open `chrome://policy` and check for:
  - **`PromptForDownloadLocation`**: Must be set to `false` or removed.
  - **`DownloadDirectory`**: Must be removed to allow custom subdirectories.
- Contact your system administrator if these policies are enforced by managed organizational profiles.

---

## 3. Scraping Guides by Platform

### A. Instagram
1. Ensure you are **logged in** to `instagram.com` in Chrome.
2. Open the profile page you wish to export (e.g. `https://www.instagram.com/some_username/`).
3. Click the **Multiscraper** toolbar icon. The platform indicator will display `instagram · @some_username`.
4. Configure **Max posts** (`0` = export entire feed, or enter a limit like `50`).
5. Click **Scrape profile**. The live counter will report collected posts as feed pages load.

### B. TikTok
1. Ensure you are **logged in** to `tiktok.com` in Chrome.
2. Open the creator profile page (e.g. `https://www.tiktok.com/@some_username`).
3. Click the **Multiscraper** toolbar icon.
4. Set your post limit and click **Scrape profile**.
5. **Keep the tab focused**: The extension will auto-scroll the page to trigger signed network requests and harvest items. Scraping stops automatically when all posts are loaded or after 6 consecutive scrolls with no new content.

### C. Google Business (Listings & Reviews)
1. Open a Google Business place page on `google.com`. Supported pages include:
   - Google Search knowledge panels (e.g. searching for a restaurant, store, or business name).
   - Direct `share.google/...` links.
   - Google Maps place pages (`https://www.google.com/maps/place/...`).
2. Click the **Multiscraper** toolbar icon. The platform indicator will display `google · <Business Name>`.
3. Set **Max posts** to specify the number of reviews to extract (`0` = extract all available reviews).
4. Click **Scrape profile**. Multiscraper extracts business overview attributes from the panel, then calls Google's `GetLocalBoqProxy` RPC to paginate through user reviews, timestamps, star ratings, translated texts, and owner responses.

---

## 4. Exporting Data

Once scraping completes, choose from the available export formats:

### Export JSON
Exports a complete JSON document. 
- For Instagram / TikTok: `{ "platform": "...", "profile": { ... }, "data": [ ... ] }`.
- For Google Business: Includes full business metadata and review lists. Empty fields default to `"Not Available"`.

### Export CSV
Generates a standard RFC-4180 CSV file ready for Microsoft Excel, Google Sheets, or Apple Numbers.

### Export Performance Stats (Social Feeds Only)
Available for Instagram and TikTok. Exports a compact analytics CSV sorted **best-performing first**:
- **Engagement**: Absolute sum (`Likes + Comments + Shares + Saves`).
- **Engagement %**: Calculated relative to video views (`(Engagement / Views) * 100`).
- **Summary Header**: Displays total posts, aggregate engagement, average likes, average comments, and average engagement rate.

### Export Markdown Report (Google Business Only)
Available when scraping Google Business listings. Generates a structured Markdown report containing:
- **Business Overview**: Name, category, rating, review count, price range, address, phone, hours, website, and Google Maps link.
- **Rating Summary**: Visual breakdown of 5-star to 1-star review distributions.
- **Review Log**: Formatted cards/tables for each review including author, star rating, publication date, relative date, review text, Google auto-translation, and owner response.

---

## 5. Downloading Media Files

Click the **Download media files** button to save all image and video attachments locally:

1. **Target Subfolder**: By default, files are saved to `multiscraper/<username>` inside your Downloads directory. You can customize this folder path in the input field prior to starting the download.
2. **Real-Time Disk Verification**: The progress bar increments only when Chrome confirms that a file is successfully written to disk.
3. **Background Execution**: You can safely close the popup window while downloading; the task continues in the background service worker. Reopening the popup reconnects to the active run.
4. **Link Expiration & Retries**: CDN URLs expire after several hours. If any downloads fail due to expired links or network drops, click the **Retry failed downloads** button to re-download only the missing items.
