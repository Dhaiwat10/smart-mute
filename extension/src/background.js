/* Smart-mute background service worker: mutes list + dedupe + cache + backend calls. */
"use strict";

const DEFAULT_MUTES = [
  {
    id: "gta6",
    name: "GTA 6",
    aliases: ["GTA VI", "Grand Theft Auto 6", "GTA6"],
    mode: "spoiler", // "spoiler" | "topic"
    sensitivity: "high", // "high" | "medium" | "low"
    duration: "forever",
    expiresAt: 0,
  },
];
const DEFAULTS = { enabled: true, backendUrl: "http://localhost:3000" };

const cache = new Map(); // hash -> result
const MAX_CACHE = 2000;

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return "h" + (h >>> 0).toString(16);
}

async function getConfig() {
  try {
    const stored = await chrome.storage.local.get(["enabled", "backendUrl", "mutes", "topic"]);
    let mutes = stored.mutes;
    if (!Array.isArray(mutes)) {
      // Migrate legacy single-topic config.
      const t = stored.topic;
      mutes = t && t.name
        ? [{ id: "gta6", name: t.name, aliases: t.aliases || [], mode: "spoiler", sensitivity: "high", duration: "forever", expiresAt: 0 }]
        : DEFAULT_MUTES;
      await chrome.storage.local.set({ mutes });
    }
    return {
      enabled: stored.enabled ?? DEFAULTS.enabled,
      backendUrl: stored.backendUrl || DEFAULTS.backendUrl,
      mutes,
    };
  } catch {
    return { ...DEFAULTS, mutes: DEFAULT_MUTES };
  }
}

function activeMutes(mutes) {
  const now = Date.now();
  return (mutes || []).filter((m) => m && m.name && (!m.expiresAt || m.expiresAt > now));
}

async function checkTweet(postText, quotedText) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { hide: false, hits: [], source: "disabled", reason: "shield off" };
  const mutes = activeMutes(cfg.mutes);
  if (!mutes.length) return { hide: false, hits: [], source: "no-mutes", reason: "no active mutes" };
  const sig = mutes.map((m) => `${m.id}:${m.name}:${(m.aliases || []).join(",")}:${m.mode}:${m.sensitivity}`).join("|");
  const key = hashStr(`${sig}::${postText}::${quotedText}`);
  if (cache.has(key)) return { ...cache.get(key), cached: true };

  const url = `${cfg.backendUrl.replace(/\/$/, "")}/api/check`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postText, quotedText, mutes }),
    });
    if (!res.ok) throw new Error(`backend-http-${res.status}`);
    const data = await res.json();
    const out = {
      hide: data.hide !== false,
      hits: data.hits || [],
      results: data.results || {},
      reason: data.reason || "backend",
      source: data.source || "backend",
    };
    cache.set(key, out);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return out;
  } catch (e) {
    // Fail closed on any backend/network error.
    return { hide: true, hits: [], source: "error-fail-closed", reason: `backend unreachable (${String((e && e.message) || e).slice(0, 80)})` };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== "object") return sendResponse({ hide: true, hits: [], reason: "bad-msg" });
    switch (msg.type) {
      case "CHECK_TWEET":
        sendResponse(await checkTweet(String(msg.postText || ""), String(msg.quotedText || "")));
        break;
      case "CONFIG_GET":
        sendResponse(await getConfig());
        break;
      case "CONFIG_SET":
        cache.clear(); // clear first: content scripts rescan off the storage
        await chrome.storage.local.set({ // write, content reacts live (see onChanged)
          enabled: Boolean(msg.enabled),
          backendUrl: String(msg.backendUrl || DEFAULTS.backendUrl),
          mutes: Array.isArray(msg.mutes) ? msg.mutes.slice(0, 20) : DEFAULT_MUTES,
        });
        sendResponse({ ok: true });
        break;
      case "CACHE_CLEAR":
        cache.clear();
        sendResponse({ ok: true, size: 0 });
        break;
      default:
        sendResponse({ hide: true, hits: [], reason: "unknown-msg-fail-closed" });
    }
  })();
  return true; // async response
});
