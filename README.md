# Jev Smart Mute — local MVP (multi-topic, fake feed)

Personal prototype. Mute whole topics semantically, shield spoilers per
topic. Tests on a local fake feed with fictional mock data.

## Layout

```text
server/src/server.js      local backend: /api/check (Jev fan-out or heuristic), /fake-feed, /health
server/.env               YOUR key here (not committed): TYPESAFE_API_KEY=...
extension/                unpacked Chrome MV3 extension (content + background + popup)
eval/mock-tweets.json     fictional GTA 6 spoiler set (legacy single-topic eval)
eval/run.js               scores spoiler shield: recall/precision/latency
eval/smart-mute-mocks.json  multi-topic set (crypto, World Cup, GTA 6)
eval/run-mutes.js         scores multi-mute fan-out: one call/post, all topics in parallel
```

## Setup

1. Add your key:
   ```sh
   cp server/.env.example server/.env
   # edit server/.env, set TYPESAFE_API_KEY
   ```
   Without a key the backend uses a conservative keyword heuristic so you
   can still test end-to-end (eval will show lower precision).

2. Start the backend:
   ```sh
   node server/src/server.js
   # -> http://localhost:3000, fake feed at /fake-feed
   ```

3. Load the extension (unpacked, personal use only):
   - Open `chrome://extensions`, enable Developer mode
   - Load unpacked → select the `extension/` folder
   - Open the popup, add mutes (topic mute and/or spoiler shield,
     sensitivity low/medium/high, duration 24h/7d/30d/forever)
   - Open `http://localhost:3000/fake-feed`, scroll, use Load-more/Burst buttons
   - Matches hide behind "Muted (names)" veils; safe posts reveal

4. Run the evals:
   ```sh
   node eval/run.js        # spoiler shield: target 100% recall, some FPs expected
   node eval/run-mutes.js  # smart mute fan-out: correct mute attribution per post
   ```

## Modes and sensitivity

- Topic mute: hides anything substantively about the topic.
- Spoiler shield: hides only revelations (deaths, endings, twists).
- Sensitivity per mute: high ≥0.35 (hide on doubt), medium ≥0.55,
  low ≥0.75. High behaves like the original fail-closed spoiler shield;
  low only hides clear hits.

## Policy

Hide-first, fail closed: posts hide before classification; API errors,
timeouts, and uncertain scores all hide. Sensitivity fixed to High.
Text only — image/video-only posts are a known gap (left visible, flagged
in fake feed and eval).

## Cost

Jev list price $0.042/M input tokens, output free. ~250–700 input tokens
per check → 1,000 checks ≈ $0.01–$0.03. Cache + dedupe keep scroll bursts cheap.
