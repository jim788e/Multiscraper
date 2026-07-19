# Multiscraper User Guide

This guide walks you through installing, configuring, and using the Multiscraper extension to export feeds and download media files from Instagram and TikTok.

---

## 1. Installation

Since Multiscraper is a developer tool, you must load it as an "unpacked" extension:

1. Open Chrome and type `chrome://extensions` in the address bar.
2. In the top-right corner of the Extensions page, turn **ON** the **Developer mode** toggle.
3. Click the **Load unpacked** button in the top-left.
4. Select the `extension/` directory of the cloned Multiscraper repository.
5. For easier access, click the extensions puzzle piece icon next to your profile picture in the Chrome toolbar and pin **Multiscraper**.

---

## 2. Essential Chrome Settings (Required)

To download batches of media files without clicking "Save As" for every image or video, configure the following settings:

1. Open `chrome://settings/downloads`.
2. **Download Location**: Set this to your desired root folder (e.g., `Downloads`).
   * *Note: Chrome security rules prevent browser extensions from writing files outside this root folder.*
3. **Turn OFF** the toggle for **"Ask where to save each file before downloading"**.
   * *If left on, Chrome will open a dialog box for every single file in the scrape, and files will not be sorted into the target username subfolder automatically.*

### Troubleshooting Policy Locks
If the "Ask where to save..." setting is greyed out or keeps turning back on:
- Your computer is governed by an IT policy (common on corporate, school, or managed machines).
- Navigate to `chrome://policy` and search for:
  - **`PromptForDownloadLocation`**: Must be set to `false` or removed.
  - **`DownloadDirectory`**: Must be removed to allow custom subdirectories.
- Contact your system administrator to adjust these policies if they are locked.

---

## 3. Scraping a Profile

1. Open Instagram or TikTok in Chrome and make sure you are **logged in**.
2. Navigate to the profile page you want to scrape (e.g., `https://www.instagram.com/some_username/` or `https://www.tiktok.com/@some_username`).
3. Click the **Multiscraper** icon in your browser toolbar. The extension will automatically detect the platform and prefill the username.
4. Set the **Max posts** limit:
   * Enter `0` to scrape the **entire profile history**.
   * Enter a specific number (e.g., `50`) to limit the run to only the newest posts.
5. Click **Scrape profile**.
   * **Instagram**: Pages through the feed.
   * **TikTok**: Keeps the tab focused. The extension will automatically scroll the page to trigger signed requests and capture responses.

---

## 4. Exporting Data

Once scraping completes, you can choose from three export options:

### Export JSON
Saves a JSON file matching the export schema. All keys (like likes and comments) are preserved, and empty metadata values are set to `"Not Available"`.

### Export CSV
Generates a standard CSV file ready to import into Microsoft Excel, Google Sheets, or Apple Numbers.

### Export Performance Stats (CSV)
This is a compact, analytics-focused export designed for marketing analysis. It sorts posts **best-performing first** and calculates the following fields:

* **Engagement**: The absolute sum of user interactions (`Likes` + `Comments` + `Shares` + `Saves`).
* **Engagement %**: Calculated relative to video view counts (`(Engagement / Views) * 100`).
* **Summary Row**: The top of the file contains aggregate metrics including total posts, total engagement, average likes, average comments, and average engagement rate (calculated only over posts that have valid view and like metrics).

---

## 5. Downloading Media Files

Click the **Download media files** button to save all image and video attachments to your computer:

1. **Target Subfolder**: By default, the extension saves files into `multiscraper/<username>` inside your global Downloads folder. You can edit this path in the text box before clicking download.
2. **Live Progress**: The progress bar updates only when Chrome confirms that files are written to disk.
3. **Running in the Background**: If you close the popup window, the download task **continues running in the background**. Reopening the popup reconnects to the active run and restores the progress bar.
4. **Link Expiration & Retries**: 
   * Meta and TikTok CDN URLs are time-limited and expire after a few hours. If a large download takes time, some links might expire.
   * If any file fails to download, a **Retry failed downloads** button will appear. Click this to re-fetch just the failed items.
