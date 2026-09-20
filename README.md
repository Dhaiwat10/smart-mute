# Smart Mute for X

A Chrome extension (Manifest V3) that hides whole **topics** on X/Twitter semantically — not just keywords. Powered by [Jev](https://docs.typesafe.ai/) (TypeSafe AI), which returns typed yes/no decisions instead of generated text, so classification is fast (~200ms) and cheap (fractions of a cent per thousand posts).

Two modes per mute:

- **Topic mute** — hides anything substantively about the topic (paraphrases and coded language included, no keyword lists needed).
- **Spoiler shield** — hides only revelations about the topic (deaths, endings, twists), lets other discussion through.

Each mute has its own sensitivity (high / medium / low) and duration (forever / 24h / 7d / 30d).

## How it works

```text
X page → content script (viewport-gated: only tweets you approach are checked)
       → background worker (dedupe + cache)
       → local backend → Jev (all mutes fanned out in one parallel call)
       → hide (blur + label bar) or leave alone
```

Measured on mock sets with real Jev: spoiler shield 100% recall / 96% precision; multi-topic attribution 15/15.

## Installation

Prereqs: Node.js 20+, Chrome, a [TypeSafe API key](https://console.typesafe.ai/keys).

```sh
# 1. Backend
cp server/.env.example server/.env   # add TYPESAFE_API_KEY=...
node server/src/server.js            # http://localhost:3000 (leave running)

# 2. Extension (no build step)
# chrome://extensions → Developer mode → Load unpacked → select extension/
```

## Usage

1. Click the extension icon → flip the toggle on.
2. Add a mute: topic name, mode, sensitivity, duration. It auto-saves and the open X tab updates live.
3. Browse X. Muted posts blur with a label bar (`Muted · Crypto`); **Show** restores any post.
4. Toggle off anytime to restore the whole page instantly.

Tip for testing: X search for your muted topic gives a dense page of hits.

## Evaluation

```sh
node eval/run.js         # spoiler shield: recall/precision/latency
node eval/run-mutes.js   # multi-topic fan-out correctness
```

See `eval/thresholds.md` for sensitivity tuning notes, including a real Jev wording trap we found and fixed (ask about *containment*, not *aboutness*).

`GET /fake-feed` on the backend serves a local mock X feed (fictional data, labels hidden from the DOM) so you can test without touching real Twitter.

## Cost

Jev list price is $0.042 per million input tokens, output free — roughly **$0.01 per 1,000 checks**. Viewport gating plus caching keeps real usage near that floor.

## Limitations

- **Text only.** Jev takes text; image/video-only posts pass through visibly. Known gap, flagged in the test feed.
- **X's DOM is unofficial** and changes periodically; selectors may need maintenance.
- Muted posts are readable for ~200ms before the verdict lands (no hide-first blurring, by design).
- Personal project: API key stays in your local `server/.env` (git-ignored, never shipped in the extension). No accounts, no tracking.
