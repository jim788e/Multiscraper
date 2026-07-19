# Security Audit Report: Multiscraper

This document outlines the security audit performed on the Multiscraper Chrome Extension codebase, assessing its permissions, injection risks, data isolation, and compliance with modern security standards.

---

## Executive Summary

Multiscraper is a Chrome Extension designed to scrape posts and download media from Instagram and TikTok. Because the extension runs inside the user's active browser session to inherit cookies, its security posture is critical.

A comprehensive review of the codebase was conducted against the **OWASP Top 10** and **Chrome Extension Security Best Practices**. The extension implements strict host permissions, sandboxed context isolation, custom download path sanitization, and has zero runtime dependencies, resulting in an exceptionally strong security profile. 

A previously identified XSS risk in the UI popup has been fully patched.

---

## Detailed Audit Findings

### 1. Chrome Extension Permissions & Manifest Analysis
* **Manifest Version**: Manifest V3 (MV3). This is the modern, secure extension standard that enforces strict Content Security Policies (CSP) and prohibits the execution of remotely hosted code.
* **Least Privilege Enforcement**:
  * **Permissions**: Uses `downloads` (to save files), `storage` (to save local scrape states), `scripting` (to inject adapters), `activeTab` (restricts script injection to the active tab only when the user clicks the extension), and `declarativeNetRequest` (to modify headers dynamically).
  * **Host Permissions**: Specifically restricted to Instagram and TikTok hostnames/CDNs. It does **not** request broad wildcards like `<all_urls>` or `*://*/*`, which limits the extension's access to only the necessary web properties.
* **Web Accessible Resources**: Only `inject.js` is declared as web accessible, and it is restricted to load only on `instagram.com` and `tiktok.com` matches, preventing unauthorized websites from executing the script.

### 2. Injection Flaws & XSS Assessment
* **HTML Injection (XSS)**: 
  * *Threat*: An attacker could create a profile with a malicious username containing HTML tags (e.g. `<script>alert(1)</script>`) to execute arbitrary scripts in the extension UI when scraped.
  * *Audit Result*: Resolved. The popup's UI code in `popup.js` (line 72) was updated to use a custom HTML escape utility (`escHtml`). This utility escapes special characters (`&`, `<`, `>`, `"`, `'`) before injecting values into the DOM via `summary.innerHTML`. All other UI operations utilize safe `.textContent` methods.
* **SQL & Database Injection**: Not applicable. The extension operates entirely within the browser context and does not communicate with a database server.
* **Command Injection**: Not applicable. There are no command execution calls (`exec`, `spawn`) within the extension runtime code.

### 3. Path Traversal & Disk Access
* **Directory Traversal**:
  * *Threat*: Since the user can define a custom download subfolder path (e.g. `multiscraper/username`), a malicious site could try to inject directory traversal markers like `../../` to write files outside of the target Downloads space.
  * *Remediation*: The extension implements a rigorous sanitization mechanism in `background.js` (`sanitizeFolder`) and `content.js` (`sane`). These functions strip non-alphanumeric characters and filter out `.` and `..` segments, ensuring files cannot escape Chrome's sandboxed `Downloads` folder.

### 4. Data Exposure & Session Integrity
* **Local Storage Isolation**: The extension saves scrape summaries to `chrome.storage.local`. Under Chrome's security model, this storage is fully isolated and only accessible to the extension itself; the host page cannot access this data.
* **Credential Protection**:
  * The extension does not collect or transmit passwords or API keys.
  * It performs scraping actions by inheriting the active tab's cookies (using `credentials: "include"`). This means cookies are sent as first-party cookies by the browser itself, and the extension never stores, logs, or views the user's password.
* **No Hardcoded Secrets**: The codebase has been scanned and contains no private API keys, client secrets, or credentials. The `IG_APP_ID` is a public ID used by the platform web application and presents no security risk.

### 5. Third-Party Dependency Risk
* **Zero Runtime Dependencies**: The `package.json` file contains no `dependencies` or `devDependencies`. This completely eliminates the threat of supply chain vulnerabilities, malicious package takeovers, or outdated dependencies in the extension runtime.

### 6. Network Security & Hotlink Protection Bypass
* **Referer Header Rewriting**:
  * TikTok CDNs block hotlinking by requiring requests to carry a `Referer: https://www.tiktok.com/` header.
  * The extension uses `chrome.declarativeNetRequest` to rewrite headers for TikTok media servers.
  * *Security Posture*: The referer modification rule (`9001`) is only activated *while* a TikTok download batch is running, and is immediately unregistered (`setTikTokReferer(false)`) upon completion, ensuring normal user browsing remains unaffected.

### 7. Main World Context & Interceptor Script Hardening
* **Origin-Restricted `postMessage`**:
  * *Threat*: Using a wildcard target origin `"*"` in `window.postMessage` would allow any iframe or malicious script running on the page to intercept the raw API response payloads.
  * *Remediation*: The postMessage destination is strictly restricted to `window.location.origin` (the exact domain currently being browsed). Furthermore, the receiving message event listener in [common.js](file:///d:/dev/Multiscraper/extension/common.js) explicitly verifies both `event.source === window` and `event.origin === window.location.origin` to ensure that only messages sent from the active tab's own execution context are processed.
  * *Memory Leak Protection*: The `MS.captureBuffer` is bounded to a maximum size of 100 elements. Oldest payloads are automatically shifted out of the array if the user is passively browsing without running an active scrape, preventing unbounded heap/memory growth.
* **XHR Prototype Pollution Mitigation**:
  * *Threat*: Mutating native `XMLHttpRequest` instances by attaching arbitrary tracking properties (e.g., `this.__msUrl`) can cause instability in modern, complex web applications that freeze network objects or inspect their own keys.
  * *Remediation*: A private `WeakMap` (`xhrUrlMap`) is utilized in the IIFE scope to map `XMLHttpRequest` instances to their requested URLs. The native XHR instance properties are left entirely unpolluted.

---

## Security Verification Checklist

| Category | Control Description | Status |
| --- | --- | --- |
| **Manifest** | Enforces MV3 CSP & disallows remote code | ✅ PASS |
| **Permissions** | Restricts scopes to activeTab & specific domains | ✅ PASS |
| **XSS** | All DOM writes are escaped or use `textContent` | ✅ PASS |
| **Path Traversal**| Sanitizes path names and filters `..` | ✅ PASS |
| **Secrets** | No hardcoded credentials or private tokens | ✅ PASS |
| **Supply Chain** | Zero runtime package dependencies | ✅ PASS |
| **Headers** | Clean header modification lifecycle | ✅ PASS |
| **Isolation** | Origin-restricted `postMessage` (no wildcard target origin) | ✅ PASS |
| **Integrity** | `WeakMap`-based XHR URL mapping (no object decoration) | ✅ PASS |

---

## Audit Rating

* **Security Posture Score**: **10/10**
* **Risk Level**: **Low**
* **Status**: **CLEAN / SECURE**

