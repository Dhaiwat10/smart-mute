/* Popup: manage the smart-mute list in chrome.storage.local via the background worker. */
"use strict";
const $ = (id) => document.getElementById(id);
let mutes = [];

function durToExpiresAt(dur) {
  const now = Date.now();
  if (dur === "24h") return now + 24 * 3600e3;
  if (dur === "7d") return now + 7 * 24 * 3600e3;
  if (dur === "30d") return now + 30 * 24 * 3600e3;
  return 0;
}

function fmtExpiry(m) {
  if (!m.expiresAt) return "forever";
  const ms = m.expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.round(ms / 3600e3);
  return h < 48 ? `expires in ~${h}h` : `expires in ~${Math.round(h / 24)}d`;
}

function render() {
  const box = $("mutes");
  box.innerHTML = "";
  if (!mutes.length) {
    box.innerHTML = '<div class="note">No mutes yet. Add one below.</div>';
    return;
  }
  mutes.forEach((m, i) => {
    const expired = m.expiresAt && m.expiresAt <= Date.now();
    const div = document.createElement("div");
    div.className = "mute" + (expired ? " expired" : "");
    const top = document.createElement("div");
    top.className = "top";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = m.name;
    const del = document.createElement("button");
    del.textContent = "Remove";
    del.addEventListener("click", () => { mutes.splice(i, 1); render(); });
    top.appendChild(name);
    top.appendChild(del);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${m.mode === "topic" ? "topic mute" : "spoiler shield"} · ${m.sensitivity} · ${fmtExpiry(m)}${m.aliases && m.aliases.length ? " · aka " + m.aliases.join(", ") : ""}`;
    div.appendChild(top);
    div.appendChild(meta);
    box.appendChild(div);
  });
}

async function load() {
  const cfg = await chrome.runtime.sendMessage({ type: "CONFIG_GET" });
  $("enabled").checked = cfg.enabled ?? true;
  $("backendUrl").value = cfg.backendUrl || "http://localhost:3000";
  mutes = cfg.mutes || [];
  render();
  try {
    const r = await fetch(`${$("backendUrl").value.replace(/\/$/, "")}/health`);
    const j = await r.json();
    $("status").textContent = `Backend: ok, jev=${j.jevConfigured ? "configured" : "MISSING (heuristic)"} · ${mutes.length} mute(s)`;
  } catch {
    $("status").textContent = "Backend unreachable — start it (`node server/src/server.js`). Extension will fail closed (hide).";
  }
}

$("add").addEventListener("click", () => {
  const name = $("fName").value.trim();
  if (!name) { $("status").textContent = "Enter a topic name first."; return; }
  mutes.push({
    id: "m" + Date.now().toString(36),
    name,
    aliases: $("fAliases").value.split(",").map((s) => s.trim()).filter(Boolean),
    mode: $("fMode").value,
    sensitivity: $("fSens").value,
    duration: $("fDur").value,
    expiresAt: durToExpiresAt($("fDur").value),
  });
  $("fName").value = "";
  $("fAliases").value = "";
  render();
  $("status").textContent = "Mute added (not saved yet — hit Save all).";
});

$("save").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "CONFIG_SET",
    enabled: $("enabled").checked,
    backendUrl: $("backendUrl").value.trim() || "http://localhost:3000",
    mutes,
  });
  $("status").textContent = `Saved ${mutes.length} mute(s). Cache cleared.`;
});

$("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CACHE_CLEAR" });
  $("status").textContent = "Cache cleared.";
});

load();
