/* Popup: mute list with instant auto-save. Every change persists immediately
 * and the open X page reacts in real time via storage sync (see content.js).
 * No save button.
 */
"use strict";
const $ = (id) => document.getElementById(id);
let mutes = [];
let saveTimer = null;

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
  return h < 48 ? `~${h}h left` : `~${Math.round(h / 24)}d left`;
}

function flash(msg, ok) {
  const s = $("status");
  s.textContent = msg;
  s.classList.toggle("ok", !!ok);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { s.textContent = ""; s.classList.remove("ok"); }, 2500);
}

async function persist() {
  await chrome.runtime.sendMessage({
    type: "CONFIG_SET",
    enabled: $("enabled").checked,
    backendUrl: $("backendUrl").value.trim() || "http://localhost:3000",
    mutes,
  });
  flash("Saved", true);
}

function render() {
  const box = $("mutes");
  box.innerHTML = "";
  const active = mutes.filter((m) => !m.expiresAt || m.expiresAt > Date.now());
  $("subline").textContent = mutes.length
    ? `${active.length} mute${active.length === 1 ? "" : "s"} active.`
    : "Hide whole topics, semantically.";
  if (!mutes.length) {
    box.innerHTML = '<div class="empty">No mutes yet — add one below.</div>';
    return;
  }
  mutes.forEach((m) => {
    const expired = m.expiresAt && m.expiresAt <= Date.now();
    const div = document.createElement("div");
    div.className = "mute" + (expired ? " expired" : "");
    const top = document.createElement("div");
    top.className = "top";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = m.name;
    const del = document.createElement("button");
    del.className = "x";
    del.textContent = "✕";
    del.title = `Remove mute "${m.name}"`;
    del.addEventListener("click", () => {
      mutes = mutes.filter((x) => x !== m);
      render();
      persist();
    });
    top.appendChild(name);
    top.appendChild(del);
    const meta = document.createElement("div");
    meta.className = "meta";
    const b = document.createElement("b");
    b.textContent = m.mode === "topic" ? "topic" : "spoilers";
    meta.append(b, document.createTextNode(` · ${m.sensitivity} · ${fmtExpiry(m)}`));
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
    flash(j.jevConfigured ? "Connected" : "Backend up, Jev key missing", j.jevConfigured);
  } catch {
    flash("Backend unreachable — start it first", false);
  }
}

$("add").addEventListener("click", () => {
  const name = $("fName").value.trim();
  if (!name) { flash("Name the topic first", false); return; }
  mutes.push({
    id: "m" + Date.now().toString(36),
    name,
    aliases: [], // Jev resolves name variants itself.
    mode: $("fMode").value,
    sensitivity: $("fSens").value,
    duration: $("fDur").value,
    expiresAt: durToExpiresAt($("fDur").value),
  });
  $("fName").value = "";
  render();
  persist();
});

$("enabled").addEventListener("change", persist);

let backendTimer = null;
$("backendUrl").addEventListener("input", () => {
  clearTimeout(backendTimer);
  backendTimer = setTimeout(persist, 800);
});

$("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CACHE_CLEAR" });
  flash("Cache cleared", true);
});

load();
