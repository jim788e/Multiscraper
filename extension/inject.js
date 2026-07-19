// MAIN-world network interceptor. Patches fetch + XHR so the page's own feed
// responses (which the site signs for us) can be harvested by the content script.
// Used as a resilience fallback for Instagram and as the primary path for TikTok.
(function () {
  if (window.__msPatched) return;
  window.__msPatched = true;

  const INTERESTING = /(\/api\/v1\/feed\/user\/|\/graphql\/query|\/api\/post\/item_list|xdt_api__v1__feed)/i;
  const xhrUrlMap = new WeakMap();

  const forward = (url, text) => {
    try {
      if (!INTERESTING.test(url)) return;
      // Only forward JSON we can parse; ignore everything else quietly.
      const body = JSON.parse(text);
      window.postMessage({ __ms: "capture", url: String(url), body }, window.location.origin);
    } catch (_) {
      /* not JSON or not relevant */
    }
  };

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then((res) => {
      try {
        const url = res.url || (args[0] && args[0].url) || String(args[0]);
        if (INTERESTING.test(url)) {
          res.clone().text().then((t) => forward(url, t)).catch(() => {});
        }
      } catch (_) {}
      return res;
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    xhrUrlMap.set(this, url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        const savedUrl = xhrUrlMap.get(this);
        if (!savedUrl) return;
        if (!INTERESTING.test(savedUrl)) return;
        forward(savedUrl, this.responseText);
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };
})();

