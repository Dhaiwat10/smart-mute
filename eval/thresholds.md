# Thresholds (conservative, fail-closed)

Backend decision (`server/src/server.js`):

```text
hide if revealing >= 0.35
hide if related >= 0.7 AND revealing >= 0.3
else reveal
```

Any error, timeout, or bad score shape → `hide=true`.

## Why these values

- MVP policy per user: don't take risks. A missed spoiler (false
  negative) is worse than hiding a safe post (false positive), because
  the user can click "Show anyway" but cannot unsee a spoiler.
- Jev `noul` has no separate confidence — values near 0.5 are the
  uncertainty band, so the whole band hides.
- Ambiguous GTA 6 reactions ("that airport scene broke me") are labeled
  spoiler in the mock set and should hide.

## How to tune

1. Start backend: `node server/src/server.js` (with `server/.env` key for Jev, else heuristic).
2. Run eval: `node eval/run.js`.
3. Fix misses first:
   - If a direct spoiler reveals, lower `REVEALING_HIDE` (e.g. 0.35 → 0.3)
     or sharpen the `revealing` question wording.
   - If coded language ("unalives", initials) misses, add a Jev
     criteria line about slang/coded references rather than lowering
     thresholds globally.
4. Accept some false positives on GTA 6 release-date/platform chat —
   that is the documented cost of fail-closed. Do NOT tune thresholds up
   to fix those if it creates misses.
5. Never tune to hide GTA V / GTA Online / RDR2 / business news: those
   are out of scope and must reveal. Fix with the `related` question
   wording ("only GTA 6, not GTA V/Online/Rockstar business").

## Findings from real-Jev runs (2026-09-19)

- Spoiler set (56 scored): recall 100%, precision 96.2%, p50 ~185ms.
  Only FP is `t02` negation ("NOT about Jason dying" hides) — known
  literal-reading jaggedness, fail-closed direction, accepted.
- Reaction-only posts with zero plot content ("sobbing at 2am",
  "POV: chapter 5") are labeled safe: Jev scores them low and that is
  correct. Hiding all emotion would make the shield unusable; the
  ambiguous-hide label is reserved for posts implying a specific event.
- Topic-mode questions must ask about CONTAINMENT ("does this discuss X
  in any substantive way, even as one of several subjects"), not
  aboutness ("is this post about X"). The aboutness phrasing scores
  secondary topics ~0.2 (verified stable over repeats); containment
  scores the same content 0.89+. Smart-mute set: 15/15 after the fix.
- Multi-topic fan-out works: one call per post, all questions parallel,
  p50 ~178ms for 3 mutes (5 questions).
