/* Spoiler-shield content script: hide-first, then classify via background -> backend -> Jev.
 * Matches X DOM and the local fake feed (both use article[data-testid="tweet"]).
 */
(() => {
  "use strict";

  const STYLE_ID = "jev-spoiler-shield-style";
  const CLS_PENDING = "jev-spoiler-pending";
  const CLS_HIDDEN = "jev-spoiler-hidden";

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      article[data-testid="tweet"].${CLS_PENDING} [data-testid="tweetText"],
      article[data-testid="tweet"].${CLS_PENDING} [data-testid="quotedText"],
      article[data-testid="tweet"].${CLS_HIDDEN} [data-testid="tweetText"],
      article[data-testid="tweet"].${CLS_HIDDEN} [data-testid="quotedText"] {
        filter: blur(14px) !important;
        pointer-events: none !important;
        user-select: none !important;
      }
      .jev-spoiler-veil {
        margin-top: 8px; font-size: 13px; line-height: 1.4;
        border: 1px solid #536471; border-radius: 10px; padding: 8px 10px;
        background: rgba(29,155,240,0.08); color: inherit;
        display: flex; gap: 8px; align-items: center; justify-content: space-between;
      }
      .jev-spoiler-veil button {
        flex-shrink: 0; border: 1px solid #536471; background: transparent;
        color: inherit; border-radius: 16px; padding: 4px 12px; cursor: pointer; font-weight: 700;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function textOf(article, testid) {
    const el = article.querySelector(`[data-testid="${testid}"]`);
    return el ? (el.innerText || el.textContent || "").trim() : "";
  }

  function ensureVeil(article, label) {
    let veil = article.querySelector(":scope > .jev-spoiler-veil");
    if (!veil) {
      veil = document.createElement("div");
      veil.className = "jev-spoiler-veil";
      const span = document.createElement("span");
      span.className = "jev-spoiler-label";
      span.textContent = label;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Show anyway";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        reveal(article);
      });
      veil.appendChild(span);
      veil.appendChild(btn);
      article.appendChild(veil);
    } else {
      const span = veil.querySelector(".jev-spoiler-label");
      if (span) span.textContent = label;
    }
    return veil;
  }

  function reveal(article) {
    article.classList.remove(CLS_PENDING, CLS_HIDDEN);
    article.dataset.jevDone = "revealed";
    const veil = article.querySelector(":scope > .jev-spoiler-veil");
    if (veil) veil.remove();
  }

  function keepHidden(article, detail) {
    article.classList.remove(CLS_PENDING);
    article.classList.add(CLS_HIDDEN);
    article.dataset.jevDone = "hidden";
    ensureVeil(article, detail || "Potential GTA 6 spoiler — hidden");
  }

  function checkOne(article) {
    if (!(article instanceof HTMLElement)) return;
    if (article.dataset.jevDone) return;
    if (!article.matches('article[data-testid="tweet"]')) return;

    const postText = textOf(article, "tweetText");
    const quotedText = textOf(article, "quotedText");
    if (!postText && !quotedText) {
      // No text (e.g. image/video-only). Text-only MVP cannot judge this:
      // leave visible but mark done. Known gap, documented in README.
      article.dataset.jevDone = "no-text";
      return;
    }

    // Hide FIRST, before any network call.
    article.dataset.jevDone = "pending";
    article.classList.add(CLS_PENDING);
    ensureVeil(article, "Checking mutes…");

    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      try {
        if (!msg || msg.hide) {
          const names = msg && Array.isArray(msg.hits) && msg.hits.length
            ? msg.hits.map((h) => h.name).join(", ")
            : null;
          keepHidden(article, names ? `Muted (${names}) — hidden` : "Muted — hidden");
        } else {
          reveal(article);
        }
      } catch {
        keepHidden(article, "Muted — hidden");
      }
    };

    try {
      chrome.runtime.sendMessage({ type: "CHECK_TWEET", postText, quotedText }, (resp) => {
        if (chrome.runtime.lastError) {
          keepHidden(article, "Muted — hidden (extension error, fail closed)");
          done = true;
          return;
        }
        finish(resp);
      });
      // Fail closed if background never answers (e.g. service worker asleep > timeout).
      setTimeout(() => {
        if (!done) {
          done = true;
          keepHidden(article, "Muted — hidden (timeout, fail closed)");
        }
      }, 4000);
    } catch {
      keepHidden(article, "Muted — hidden");
      done = true;
    }
  }

  function scan(root) {
    const scope = root instanceof HTMLElement ? root : document;
    if (scope.matches && scope.matches('article[data-testid="tweet"]')) checkOne(scope);
    const nodes = scope.querySelectorAll ? scope.querySelectorAll('article[data-testid="tweet"]') : [];
    for (const n of nodes) checkOne(n);
  }

  injectCss();
  if (document.body) scan(document);
  document.addEventListener("DOMContentLoaded", () => scan(document), { once: true });

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n instanceof HTMLElement) scan(n);
      }
    }
  });
  const start = () => {
    if (document.body) scan(document);
    obs.observe(document.documentElement || document, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
