/**
 * Smart-mute eval: multi-topic fan-out in ONE /api/check call per post.
 * Requires the backend running (node server/src/server.js).
 *
 * Usage: node eval/run-mutes.js [http://localhost:3000]
 */
const fs = require("node:fs");
const path = require("node:path");

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const MOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, "smart-mute-mocks.json"), "utf8"));

const MUTES = [
  { id: "crypto", name: "Crypto", aliases: ["Bitcoin", "BTC", "ETH", "Ethereum"], mode: "topic", sensitivity: "medium" },
  { id: "worldcup", name: "World Cup", aliases: ["FIFA World Cup", "football", "soccer"], mode: "topic", sensitivity: "medium" },
  { id: "gta6", name: "GTA 6", aliases: ["GTA VI", "Grand Theft Auto 6", "GTA6"], mode: "spoiler", sensitivity: "high" },
];

(async () => {
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
  console.log(`Backend: ${BASE}  jev=${health ? (health.jevConfigured ? "configured" : "heuristic-fallback") : "UNREACHABLE"}`);
  console.log(`Mutes: ${MUTES.map((m) => `${m.id}(${m.mode}/${m.sensitivity})`).join(", ")} — one Jev call per post, all questions in parallel\n`);
  let ok = 0, bad = 0;
  const lat = [];
  for (const t of MOCKS) {
    const t0 = Date.now();
    const r = await fetch(`${BASE}/api/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postText: t.text || "", quotedText: t.quotedText || "", mutes: MUTES }),
    }).then((x) => x.json());
    lat.push(Date.now() - t0);
    const gotMutes = (r.hits || []).map((h) => h.id).sort();
    const wantMutes = [...t.expectMutes].sort();
    const hideOk = (r.hide === true) === t.expectHide;
    const mutesOk = JSON.stringify(gotMutes) === JSON.stringify(wantMutes);
    if (hideOk && mutesOk) { ok++; console.log(`PASS ${t.id} hide=${r.hide} mutes=[${gotMutes}] (${r.source})`); }
    else {
      bad++;
      console.log(`FAIL ${t.id} want hide=${t.expectHide} [${wantMutes}] got hide=${r.hide} [${gotMutes}] :: ${t.text.slice(0, 80)}`);
    }
  }
  lat.sort((a, b) => a - b);
  console.log(`\n${ok}/${ok + bad} correct · p50=${lat[Math.floor(lat.length * 0.5)]}ms p95=${lat[Math.floor(lat.length * 0.95)]}ms`);
  console.log("Known heuristic gaps (no API key): c03/w02 paraphrases miss without keywords — Jev should catch them.");
})().catch((e) => { console.error(e); process.exit(1); });
