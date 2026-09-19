/**
 * Local smart-mute backend (personal MVP, no deps, Node 20+).
 *
 * Endpoints:
 *   GET  /health            -> { ok, jevConfigured, uptime }
 *   POST /api/check         -> { hide, hits, results, source }
 *   GET  /api/mock-tweets   -> mock tweet JSON (labels; extension never reads this)
 *   GET  /fake-feed         -> local fake X feed for testing (labels NOT rendered in DOM)
 *
 * Request body for /api/check:
 *   { postText, quotedText, mutes: [{ id, name, aliases, mode, sensitivity }] }
 *   mode: "spoiler" (hide plot revelations about the topic)
 *       | "topic"   (hide anything substantively about the topic = smart mute)
 *   sensitivity: "high" | "medium" | "low"  (per-mute; controls thresholds)
 * Legacy: { postText, quotedText, topic: {name, aliases} } -> single high spoiler mute.
 *
 * Env (server/.env):
 *   TYPESAFE_API_KEY=...   (without it: conservative heuristic fallback)
 *   PORT=3000
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT = path.join(__dirname, "..", "..");
const ENV_PATH = path.join(__dirname, "..", ".env");
const MOCK_PATH = path.join(ROOT, "eval", "mock-tweets.json");

// ---- tiny .env loader (no deps) ----
function loadEnvFile(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* no .env yet — fine */ }
}
loadEnvFile(ENV_PATH);

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TYPESAFE_API_KEY || "";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

// ---- per-sensitivity thresholds. High = fail closed (hide on doubt). ----
const SENS = {
  high:   { about: 0.35, revealing: 0.35 },
  medium: { about: 0.55, revealing: 0.55 },
  low:    { about: 0.75, revealing: 0.75 },
};
const RELATED_GATE = 0.7; // spoiler mode: related>=gate && revealing>=0.3 -> hide
const REVEAL_MED = 0.3;

function normMutes(body) {
  if (Array.isArray(body.mutes)) {
    return body.mutes
      .filter((m) => m && m.name)
      .slice(0, 8) // cap fan-out per request
      .map((m, i) => ({
        id: String(m.id || `mute${i}`),
        name: String(m.name).slice(0, 80),
        aliases: Array.isArray(m.aliases) ? m.aliases.map(String).slice(0, 10) : [],
        mode: m.mode === "topic" ? "topic" : "spoiler",
        sensitivity: SENS[m.sensitivity] ? m.sensitivity : "high",
      }));
  }
  if (body.topic && body.topic.name) {
    return [{
      id: "legacy",
      name: String(body.topic.name).slice(0, 80),
      aliases: Array.isArray(body.topic.aliases) ? body.topic.aliases.map(String).slice(0, 10) : [],
      mode: "spoiler",
      sensitivity: "high",
    }];
  }
  return [];
}

function decideMute(mute, scores) {
  const t = SENS[mute.sensitivity];
  if (mute.mode === "topic") {
    const a = Number(scores.about);
    if (!Number.isFinite(a)) return { hide: true, reason: `${mute.name}: bad-score-fail-closed` };
    return a >= t.about
      ? { hide: true, reason: `${mute.name}: about=${a.toFixed(2)}>=${t.about}` }
      : { hide: false, reason: `${mute.name}: safe (${a.toFixed(2)})` };
  }
  const r = Number(scores.related), v = Number(scores.revealing);
  if (!Number.isFinite(r) || !Number.isFinite(v)) return { hide: true, reason: `${mute.name}: bad-score-fail-closed` };
  if (v >= t.revealing) return { hide: true, reason: `${mute.name}: revealing=${v.toFixed(2)}>=${t.revealing}` };
  if (r >= RELATED_GATE && v >= REVEAL_MED) {
    return { hide: true, reason: `${mute.name}: related=${r.toFixed(2)}+revealing=${v.toFixed(2)}` };
  }
  return { hide: false, reason: `${mute.name}: safe` };
}

// ---- heuristic fallback when no API key (conservative, offline) ----
const SPOILER_SIGNALS = [
  "dies", "die ", "death", "killed", "kills", "ending", "endings", "finale",
  "twist", "betray", "betrays", "boss fight", "final mission", "last mission",
  "map leak", "leaked", "spoiler", "post-credit", "post credit", "epilogue",
  "protagonist", "chapter ", "mission ", "heist", "buries", "funeral", "sacrifice",
  "secret ending", "true ending", "mid-credit",
];

function heuristicScores(postText, quotedText, mute) {
  const full = `${postText}\n${quotedText}`.toLowerCase();
  const names = [mute.name, ...mute.aliases].map((s) => String(s).toLowerCase()).filter(Boolean);
  const match = names.some((a) => a && full.includes(a));
  if (!match) return { about: 0.05, related: 0.05, revealing: 0.02 };
  if (mute.mode === "topic") return { about: 0.8, related: 0.8, revealing: 0.0 };
  const hits = SPOILER_SIGNALS.filter((s) => full.includes(s));
  if (hits.length > 0) return { about: 0.92, related: 0.92, revealing: 0.85 };
  return { about: 0.8, related: 0.8, revealing: 0.45 }; // ambiguous mention, fail-closed at high
}

function jevQuestions(mutes) {
  const questions = {};
  const keys = [];
  mutes.forEach((m, i) => {
    const aliasStr = m.aliases.length ? ` (also called: ${m.aliases.join(", ")})` : "";
    if (m.mode === "topic") {
      const k = `about_${i}`;
      questions[k] = {
        type: "noul",
        instructions: `Does this post discuss ${m.name}${aliasStr} in any substantive way — even as one of several subjects? Answer by containment, not by main theme: yes if a reader muting all ${m.name} content would want this hidden. A joke or pun using the words without the subject (e.g. "World Cup of coffee") is no.`,
      };
      keys.push({ mute: m, aboutKey: k });
    } else {
      const rk = `related_${i}`, vk = `revealing_${i}`;
      questions[rk] = {
        type: "noul",
        instructions: `Is this post substantively about ${m.name}${aliasStr}? Reply yes only if it is really about ${m.name}.`,
      };
      questions[vk] = {
        type: "noul",
        instructions: `Does this post reveal or strongly imply a ${m.name} plot event, mission outcome, death, ending, twist, betrayal, unlock, or other story development? Slang, initials, and coded references ("unalives", "ch5") count if the meaning is clear.`,
        criteria: {
          true: "Names or clearly implies a story event, outcome, death, ending, twist, or unlock.",
          false: "Hype, opinion, release-date/platform talk, or unrelated titles with no story detail.",
        },
      };
      keys.push({ mute: m, relatedKey: rk, revealingKey: vk });
    }
  });
  return { questions, keys };
}

async function jevCheck(postText, quotedText, mutes) {
  const { questions, keys } = jevQuestions(mutes);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: { postText: postText || "", quotedText: quotedText || "" },
        questions,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`jev-http-${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return keys.map(({ mute, aboutKey, relatedKey, revealingKey }) => {
      if (mute.mode === "topic") {
        const about = data?.answers?.[aboutKey]?.noul;
        if (typeof about !== "number") throw new Error("jev-bad-shape");
        return { mute, scores: { about }, source: "jev" };
      }
      const related = data?.answers?.[relatedKey]?.noul;
      const revealing = data?.answers?.[revealingKey]?.noul;
      if (typeof related !== "number" || typeof revealing !== "number") throw new Error("jev-bad-shape");
      return { mute, scores: { related, revealing }, source: "jev" };
    });
  } finally {
    clearTimeout(timer);
  }
}

function loadMocks() {
  try {
    return JSON.parse(fs.readFileSync(MOCK_PATH, "utf8"));
  } catch {
    return [];
  }
}

function fakeFeedHtml() {
  // NOTE: labels are intentionally NOT rendered — the extension only sees tweet text.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Fake X Feed — smart-mute test (mock data, labels hidden)</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #000; color: #e7e9ea; margin: 0; }
  header { position: sticky; top: 0; background: #000; border-bottom: 1px solid #2f3336; padding: 12px 16px; z-index: 5; }
  header h1 { font-size: 16px; margin: 0 0 4px; }
  header p { font-size: 12px; color: #71767b; margin: 0 0 8px; }
  .controls button { background: #1d9bf0; border: 0; color: #fff; border-radius: 20px; padding: 6px 14px; margin-right: 8px; cursor: pointer; font-weight: 700; }
  .controls button.secondary { background: transparent; border: 1px solid #536471; color: #e7e9ea; }
  #status { font-size: 12px; color: #71767b; margin-top: 8px; }
  main { max-width: 600px; margin: 0 auto; border-left: 1px solid #2f3336; border-right: 1px solid #2f3336; min-height: 100vh; }
  article[data-testid="tweet"] { border-bottom: 1px solid #2f3336; padding: 12px 16px; }
  .handle { color: #71767b; font-size: 13px; margin-bottom: 4px; }
  [data-testid="tweetText"] { font-size: 15px; line-height: 1.4; white-space: pre-wrap; }
  [data-testid="quotedText"] { margin-top: 8px; border: 1px solid #2f3336; border-radius: 12px; padding: 8px 12px; font-size: 14px; color: #d7dbdc; }
  .imgflag { margin-top: 8px; font-size: 13px; color: #71767b; border: 1px dashed #536471; border-radius: 12px; padding: 8px; }
</style>
</head>
<body>
<header>
  <h1>Fake X Feed — smart-mute test</h1>
  <p>Mock data only (fictional). Labels are hidden from the DOM so the extension is tested fairly. Add mutes in the extension popup, then scroll.</p>
  <div class="controls">
    <button id="more">Load 20 more</button>
    <button id="burst" class="secondary">Burst: add 50 at once</button>
    <button id="reset" class="secondary">Reset</button>
  </div>
  <div id="status">…</div>
</header>
<main id="timeline"></main>
<script>
  let ALL = [];
  let shown = 0;
  const timeline = document.getElementById('timeline');
  const status = document.getElementById('status');

  function tweetEl(t) {
    const a = document.createElement('article');
    a.setAttribute('data-testid', 'tweet');
    a.setAttribute('data-tweet-id', t.id);
    const h = document.createElement('div');
    h.className = 'handle';
    h.textContent = '@mockuser · ' + t.id;
    a.appendChild(h);
    if (t.text) {
      const d = document.createElement('div');
      d.setAttribute('data-testid', 'tweetText');
      d.setAttribute('dir', 'auto');
      d.textContent = t.text;
      a.appendChild(d);
    }
    if (t.quotedText) {
      const q = document.createElement('div');
      q.setAttribute('data-testid', 'quotedText');
      q.textContent = t.quotedText;
      a.appendChild(q);
    }
    if (t.imageOnly) {
      const f = document.createElement('div');
      f.className = 'imgflag';
      f.textContent = '[image/video attached — no text; text-only MVP cannot judge this]';
      a.appendChild(f);
    }
    return a;
  }

  function render(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n && shown < ALL.length; i++, shown++) frag.appendChild(tweetEl(ALL[shown]));
    timeline.appendChild(frag);
    status.textContent = shown + ' / ' + ALL.length + ' mock posts in DOM';
  }

  document.getElementById('more').onclick = () => render(20);
  document.getElementById('burst').onclick = () => render(50);
  document.getElementById('reset').onclick = () => { timeline.innerHTML = ''; shown = 0; render(30); window.scrollTo(0, 0); };

  fetch('/api/mock-tweets').then(r => r.json()).then(j => {
    ALL = j.tweets || j || [];
    render(30);
  }).catch(e => { status.textContent = 'failed to load mocks: ' + e; });
  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY > document.body.scrollHeight - 800 && shown < ALL.length) render(10);
  }, { passive: true });
</script>
</body>
</html>`;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("body-too-large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (u.pathname === "/health" || u.pathname === "/api/health")) {
    sendJson(res, 200, { ok: true, jevConfigured: Boolean(API_KEY), model: JEV_MODEL, sens: SENS });
    return;
  }
  if (req.method === "GET" && u.pathname === "/api/mock-tweets") {
    const mocks = loadMocks();
    sendJson(res, 200, { tweets: mocks, count: mocks.length, note: "mock/fictional data for local testing" });
    return;
  }
  if (req.method === "GET" && (u.pathname === "/fake-feed" || u.pathname === "/fake-feed/")) {
    sendHtml(res, fakeFeedHtml());
    return;
  }
  if (req.method === "GET" && u.pathname === "/") {
    sendHtml(res, `<html><body style="font-family:sans-serif"><h3>Smart-mute backend (local)</h3><ul><li><a href="/fake-feed">/fake-feed</a> — fake X feed</li><li><a href="/health">/health</a></li></ul><p>Jev configured: <b>${API_KEY ? "yes" : "no (heuristic fallback)"}</b></p></body></html>`);
    return;
  }
  if (req.method === "POST" && u.pathname === "/api/check") {
    let body;
    try { body = await readBody(req); }
    catch { sendJson(res, 413, { hide: true, hits: [], source: "error-fail-closed", reason: "bad-body" }); return; }
    const postText = String(body.postText || "").slice(0, 4000);
    const quotedText = String(body.quotedText || "").slice(0, 4000);
    const mutes = normMutes(body);
    if (!postText && !quotedText) {
      sendJson(res, 200, { hide: false, hits: [], results: {}, source: "empty", reason: "no text" });
      return;
    }
    if (!mutes.length) {
      sendJson(res, 200, { hide: false, hits: [], results: {}, source: "no-mutes", reason: "no active mutes" });
      return;
    }
    if (!API_KEY) {
      const results = {}, hits = [];
      for (const m of mutes) {
        const scores = heuristicScores(postText, quotedText, m);
        const d = decideMute(m, scores);
        results[m.id] = { ...d, scores };
        if (d.hide) hits.push({ id: m.id, name: m.name, mode: m.mode, reason: d.reason });
      }
      const top = hits[0];
      sendJson(res, 200, {
        hide: hits.length > 0,
        hits,
        results,
        source: "heuristic",
        reason: top ? top.reason : "safe",
      });
      return;
    }
    try {
      const per = await jevCheck(postText, quotedText, mutes);
      const results = {}, hits = [];
      for (const { mute, scores } of per) {
        const d = decideMute(mute, scores);
        results[mute.id] = { ...d, scores };
        if (d.hide) hits.push({ id: mute.id, name: mute.name, mode: mute.mode, reason: d.reason });
      }
      const top = hits[0];
      sendJson(res, 200, {
        hide: hits.length > 0,
        hits,
        results,
        source: "jev",
        model: JEV_MODEL,
        reason: top ? top.reason : "safe",
      });
    } catch (e) {
      // Fail closed: hide on any backend/model error.
      sendJson(res, 200, { hide: true, hits: [], source: "error-fail-closed", reason: String((e && e.message) || e).slice(0, 200) });
    }
    return;
  }
  sendJson(res, 404, { error: "not-found" });
});

server.listen(PORT, () => {
  console.log(`[smart-mute] http://localhost:${PORT}  jev=${API_KEY ? "configured" : "MISSING (heuristic fallback)"}`);
  console.log(`[smart-mute] fake feed: http://localhost:${PORT}/fake-feed`);
});
