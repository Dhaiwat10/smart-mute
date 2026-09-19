/**
 * Eval runner: scores the local backend against eval/mock-tweets.json.
 * Requires the backend running (node server/src/server.js).
 * Backend uses Jev when TYPESAFE_API_KEY is set, else the heuristic fallback.
 *
 * Usage: node eval/run.js [http://localhost:3000]
 */
const fs = require("node:fs");
const path = require("node:path");

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const MOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, "mock-tweets.json"), "utf8"));

async function check(t) {
  const res = await fetch(`${BASE}/api/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      postText: t.text || "",
      quotedText: t.quotedText || "",
      topic: { name: "GTA 6", aliases: ["GTA VI", "Grand Theft Auto 6", "GTA6"] },
    }),
  });
  return res.json();
}

(async () => {
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
  console.log(`Backend: ${BASE}  jev=${health ? (health.jevConfigured ? "configured" : "heuristic-fallback") : "UNREACHABLE"}`);
  let TP = 0, TN = 0, FP = 0, FN = 0;
  const misses = [], falsePos = [];
  const lat = [];
  for (const t of MOCKS) {
    if (!t.text && !t.quotedText && t.imageOnly) {
      console.log(`SKIP ${t.id} (no text — known text-only gap, extension leaves visible)`);
      continue;
    }
    const t0 = Date.now();
    let r;
    try { r = await check(t); }
    catch (e) { console.log(`ERROR ${t.id}: ${e.message} (server counts this as hide/fail-closed)`); FN += t.label === "spoiler" ? 1 : 0; continue; }
    lat.push(Date.now() - t0);
    const wantHide = t.label === "spoiler";
    const gotHide = r.hide !== false;
    if (wantHide && gotHide) TP++;
    else if (!wantHide && !gotHide) TN++;
    else if (!wantHide && gotHide) { FP++; falsePos.push({ id: t.id, cat: t.category, text: (t.text || "") + (t.quotedText ? ` [quote: ${t.quotedText}]` : ""), reason: r.reason }); }
    else { FN++; misses.push({ id: t.id, cat: t.category, text: (t.text || "") + (t.quotedText ? ` [quote: ${t.quotedText}]` : ""), related: r.related, revealing: r.revealing }); }
  }
  const total = TP + TN + FP + FN;
  const recall = TP + FN ? TP / (TP + FN) : 0;
  const precision = TP + FP ? TP / (TP + FP) : 0;
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length * 0.5)] || 0;
  const p95 = lat[Math.floor(lat.length * 0.95)] || 0;
  console.log(`\nScored: ${total}  TP=${TP} TN=${TN} FP=${FP} FN=${FN}`);
  console.log(`Recall (spoiler catch rate): ${(recall * 100).toFixed(1)}%   <-- optimize this; misses are the worst outcome`);
  console.log(`Precision (hide accuracy):   ${(precision * 100).toFixed(1)}%   <-- expect lower; conservative policy over-hides`);
  console.log(`Latency: p50=${p50}ms p95=${p95}ms (includes network; Jev itself is ~70-500ms per docs)`);
  if (misses.length) {
    console.log(`\nMISSES (spoiler shown — fix these first), n=${misses.length}:`);
    for (const m of misses) console.log(`  - ${m.id} [${m.cat}] r=${m.related} v=${m.revealing}: ${m.text}`);
  } else console.log("\nNo misses. Spoiler catch rate 100% on this mock set.");
  if (falsePos.length) {
    console.log(`\nFALSE POSITIVES (safe hidden — accepted cost of fail-closed), n=${falsePos.length}:`);
    for (const f of falsePos) console.log(`  - ${f.id} [${f.cat}] (${f.reason}): ${f.text}`);
  }
  console.log("\nNote: ambiguous GTA6 reactions are labeled spoiler (policy: hide). GTA V/RDR2/Online labeled safe (must not hide).");
})().catch((e) => { console.error(e); process.exit(1); });
