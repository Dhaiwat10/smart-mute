/* Smart-mute content script: hide-first, then classify via background -> backend -> Jev.
 * Matches X DOM and the local fake feed (both use article[data-testid="tweet"]).
 * Hardened: fallback whole-article blur if X changes internals, re-assertion
 * against React re-renders, debug logging via window.__jevDebug.
 */
(() => {
  "use strict";

  const DEBUG = true;
  const STYLE_ID = "jev-spoiler-shield-style";
  const CLS_PENDING = "jev-spoiler-pending";
  const CLS_HIDDEN = "jev-spoiler-hidden";
  const CLS_FALLBACK = "jev-spoiler-fallback"; // tweetText selector missed: blur harder

  const stats = { seen: 0, checked: 0, hidden: 0, revealed: 0, noText: 0, fallback: 0 };
  function log(...a) { if (DEBUG) console.info("[jev]", ...a); }
  window.__jevDebug = { stats };

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      article[data-testid="tweet"].${CLS_HIDDEN} {
        position: relative !important;
      }
      article[data-testid="tweet"].${CLS_HIDDEN} > :not(.jev-spoiler-veil) {
        filter: blur(18px) !important;
        pointer-events: none !important;
        user-select: none !important;
      }
      .jev-spoiler-veil {
        position: absolute !important;
        left: 12px !important; right: 12px !important; bottom: 12px !important;
        z-index: 10 !important;
        display: flex !important; gap: 12px !important;
        align-items: center !important; justify-content: flex-start !important;
        margin: 0 !important; padding: 9px 14px 9px 10px !important;
        font-family: -apple-system, "Segoe UI", system-ui, sans-serif !important;
        color: #e7e9ea !important;
        background: linear-gradient(180deg, #1a1e23 0%, #111417 100%) !important;
        border: 1px solid #2f3336 !important; border-radius: 16px !important;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45) !important;
      }
      .jev-spoiler-icon {
        flex-shrink: 0 !important;
        width: 30px !important; height: 30px !important; border-radius: 50% !important;
        display: flex !important; align-items: center !important; justify-content: center !important;
        background: rgba(29, 155, 240, 0.14) !important;
        color: #1d9bf0 !important; font-size: 15px !important; line-height: 1 !important;
      }
      .jev-spoiler-label { flex: 1 !important; min-width: 0 !important; }
      .jev-spoiler-label b {
        display: block !important; font-size: 13.5px !important; font-weight: 700 !important;
        white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
      }
      .jev-spoiler-label small {
        display: block !important; font-size: 11.5px !important; color: #71767b !important;
      }
      .jev-spoiler-veil button {
        flex-shrink: 0 !important;
        background: #1d9bf0 !important; color: #fff !important;
        border: 0 !important; border-radius: 20px !important;
        padding: 7px 16px !important; font-size: 13px !important; font-weight: 700 !important;
        cursor: pointer !important;
        transition: background 0.15s ease !important;
      }
      .jev-spoiler-veil button:hover { background: #1a8cd8 !important; }
    `;
    (document.head || document.documentElement).appendChild(s);
    log("css injected, styleEl=", !!document.getElementById(STYLE_ID));
  }

  function textOf(article, testid) {
    const el = article.querySelector(`[data-testid="${testid}"]`);
    return el ? (el.innerText || el.textContent || "").trim() : "";
  }

  function escHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function ensureVeil(article, names) {
    const title = names ? `Muted · ${names}` : "Muted";
    let veil = article.querySelector(":scope > .jev-spoiler-veil");
    if (!veil) {
      veil = document.createElement("div");
      veil.className = "jev-spoiler-veil";
      const icon = document.createElement("span");
      icon.className = "jev-spoiler-icon";
      icon.textContent = "⊘";
      const label = document.createElement("span");
      label.className = "jev-spoiler-label";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Show";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        reveal(article);
      });
      veil.append(icon, label, btn);
      article.appendChild(veil);
    }
    const label = veil.querySelector(".jev-spoiler-label");
    if (label) label.innerHTML = `<b>${escHtml(title)}</b><small>Hidden by Smart Mute</small>`;
    return veil;
  }

  function reveal(article) {
    if (viewIO) viewIO.unobserve(article);
    if (io) io.unobserve(article);
    article.classList.remove(CLS_HIDDEN, CLS_FALLBACK);
    article.dataset.jevDone = "revealed";
    stats.revealed++;
    const veil = article.querySelector(":scope > .jev-spoiler-veil");
    if (veil) veil.remove();
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < (window.innerHeight || 800);
  }

  // Verdict recorder: marks the hide decision but plays nothing until the
  // tweet is actually visible. Classification may finish 1000px early.
  function recordHide(article, names) {
    if (article.dataset.jevDone === "hidden" || article.dataset.jevDone === "decided-hide") return;
    article.dataset.jevDone = "decided-hide";
    article.dataset.jevNames = names || "";
    if (inViewport(article)) animateHidden(article);
  }

  // Applies the hidden end-state: full-tweet blur + veil bar. No animation.
  function animateHidden(article) {
    if (article.dataset.jevDone !== "decided-hide") return;
    article.dataset.jevDone = "hidden";
    if (viewIO) viewIO.unobserve(article);
    stats.hidden++;
    const names = article.dataset.jevNames || "";
    const useFallback = article.dataset.jevFallback === "1";
    article.classList.add(CLS_HIDDEN);
    if (useFallback) article.classList.add(CLS_FALLBACK);
    ensureVeil(article, names);
  }

  // Synchronously re-assert hiding after X's React re-renders wipe our
  // veil/classes. All actions are no-ops when state is already correct,
  // so this cannot loop with the MutationObserver below.
  // Pending tweets have no visual state, so only hidden ones need this.
  function reassert(article) {
    if (article.dataset.jevDone !== "hidden") return;
    if (!article.classList.contains(CLS_HIDDEN)) article.classList.add(CLS_HIDDEN);
    if (article.dataset.jevFallback === "1" && !article.classList.contains(CLS_FALLBACK)) {
      article.classList.add(CLS_FALLBACK);
    }
    if (!article.querySelector(":scope > .jev-spoiler-veil")) {
      ensureVeil(article, article.dataset.jevNames || "");
      stats.reasserts = (stats.reasserts || 0) + 1;
    }
  }

  // Viewport-gated classification: tweets mount untouched and cost zero
  // network until they're near the viewport. Scrolling past 200 tweets
  // you never see = 0 Jev calls instead of 200.
  // Applies the hidden end-state the moment a decided-hide tweet actually
  // enters the viewport (threshold, no prefetch margin — this one is about
  // visibility, not preloading).
  const viewIO = ("IntersectionObserver" in window) ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const a = e.target;
      if (e.isIntersecting && a instanceof HTMLElement && a.dataset.jevDone === "decided-hide") {
        animateHidden(a);
      }
    }
  }, { threshold: 0.2 }) : null;

  const io = ("IntersectionObserver" in window) ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.target instanceof HTMLElement) classify(e.target);
    }
  }, { rootMargin: "1000px 0px", threshold: 0 }) : null;

  function checkOne(article) {
    if (!(article instanceof HTMLElement)) return;
    if (article.dataset.jevDone) return;
    if (!article.matches('article[data-testid="tweet"]')) return;
    stats.seen++;

    let postText = textOf(article, "tweetText");
    const quotedText = textOf(article, "quotedText");
    let useFallback = false;
    if (!postText && !quotedText) {
      // tweetText selector missed (X changed internals?) — fall back to full
      // article text for classification AND whole-article blur for hiding.
      const all = (article.innerText || article.textContent || "").trim();
      if (!all) {
        article.dataset.jevDone = "no-text";
        stats.noText++;
        return;
      }
      postText = all.slice(0, 2000);
      useFallback = true;
      stats.fallback++;
      log("fallback path: tweetText selector missed, using article text", article.className);
    }

    // No visual change at mount: the tweet renders normally and is only
    // hidden if the verdict says hide. (A hide verdict lands ~200ms after
    // the tweet nears the viewport, so muted posts can flash briefly.)
    article.dataset.jevDone = "pending";
    article.dataset.jevPost = postText;
    article.dataset.jevQuoted = quotedText;
    if (useFallback) article.dataset.jevFallback = "1";
    if (io) io.observe(article);
    if (viewIO) viewIO.observe(article);
    else classify(article); // ancient browser without IntersectionObserver
  }

  function classify(article) {
    if (article.dataset.jevDone !== "pending" || article.dataset.jevSent) return;
    article.dataset.jevSent = "1";
    if (io) io.unobserve(article);
    stats.checked++;
    const postText = article.dataset.jevPost || "";
    const quotedText = article.dataset.jevQuoted || "";

    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      try {
        if (!msg || msg.hide) {
          const names = msg && Array.isArray(msg.hits) && msg.hits.length
            ? msg.hits.map((h) => h.name).join(", ")
            : "";
          recordHide(article, names);
        } else {
          reveal(article);
        }
      } catch {
        recordHide(article, "");
      }
    };

    try {
      chrome.runtime.sendMessage({ type: "CHECK_TWEET", postText, quotedText }, (resp) => {
        if (chrome.runtime.lastError) {
          recordHide(article, "");
          done = true;
          return;
        }
        finish(resp);
      });
      // Fail closed if background never answers (e.g. service worker asleep > timeout).
      setTimeout(() => {
        if (!done) {
          done = true;
          recordHide(article, "");
        }
      }, 4000);
    } catch {
      recordHide(article, "");
      done = true;
    }
  }

  function scan(root) {
    const scope = root instanceof HTMLElement ? root : document;
    if (scope.matches && scope.matches('article[data-testid="tweet"]')) checkOne(scope);
    const nodes = scope.querySelectorAll ? scope.querySelectorAll('article[data-testid="tweet"]') : [];
    for (const n of nodes) checkOne(n);
  }

  function resetArticle(a) {
    a.classList.remove(CLS_HIDDEN, CLS_FALLBACK);
    const v = a.querySelector(":scope > .jev-spoiler-veil");
    if (v) v.remove();
    delete a.dataset.jevDone;
    delete a.dataset.jevSent;
    delete a.dataset.jevNames;
    delete a.dataset.jevFallback;
    delete a.dataset.jevPost;
    delete a.dataset.jevQuoted;
    if (io) io.unobserve(a);
    if (viewIO) viewIO.unobserve(a);
  }

  // Real-time reaction to popup changes (auto-saved): the toggle and the
  // mute list update the open page instantly, no reload needed.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled && changes.enabled.newValue === false) {
      for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
        resetArticle(a);
        a.dataset.jevDone = "revealed"; // stay revealed until re-enabled
      }
      log("shield off: revealed all");
      return;
    }
    if (changes.enabled || changes.mutes) {
      for (const a of document.querySelectorAll('article[data-testid="tweet"]')) resetArticle(a);
      scan(document);
      log("config changed: rescanned");
    }
  });

  // Backstop: re-inject CSS and re-assert hidden tweets every few seconds.
  // The MutationObserver below handles the synchronous cases; this catches
  // anything it missed.
  setInterval(() => {
    injectCss();
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const a of articles) {
      if (!a.dataset.jevDone) { checkOne(a); continue; }
      reassert(a);
    }
    if (stats.seen) log("stats", JSON.stringify(stats));
  }, 3000);

  injectCss();
  if (document.body) scan(document);
  document.addEventListener("DOMContentLoaded", () => scan(document), { once: true });

  // Observe class changes too: X's React re-renders wipe our veil and extra
  // classes. Re-assertion is synchronous (pre-paint), so no visible flash.
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") {
        let reassertTarget = null;
        for (const n of m.addedNodes) {
          if (n instanceof HTMLElement) {
            if (n.matches('article[data-testid="tweet"]')) checkOne(n);
            else if (n.querySelectorAll) scan(n);
          }
        }
        const t = m.target;
        if (t instanceof HTMLElement && t.matches && t.matches('article[data-testid="tweet"]')) {
          reassertTarget = t;
        }
        if (reassertTarget) reassert(reassertTarget);
      } else if (m.type === "attributes" && m.target instanceof HTMLElement) {
        const t = m.target;
        if (t.matches && t.matches('article[data-testid="tweet"]')) reassert(t);
      }
    }
  });
  const start = () => {
    if (document.body) scan(document);
    obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
